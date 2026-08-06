import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  requireRecentAuthentication,
  revokeGoogleCredential,
  sanitizeAccountExport,
} from '../server/api/_lib/account-admin.js';
import {
  ACCOUNT_DELETION_STEPS,
  deleteLiteLLMIdentity,
  runAccountDeletion,
} from '../server/api/_lib/account-lifecycle.js';
import { LiteLLMRequestError } from '../server/api/_lib/litellm.js';
import { createAccountExportHandler } from '../server/api/account/export.js';
import {
  createDeleteAccountHandler,
  createDurableAccountDeletionServices,
} from '../server/api/account/delete.js';
import {
  createRevokeSessionsHandler,
  deleteRegisteredBrowserSessions,
} from '../server/api/account/revoke-sessions.js';

const IDENTITY = Object.freeze({
  uid: 'owner-uid',
  email: 'owner@cirqle.test',
  emailVerified: true,
  authTime: 1_800_000_000,
});
const ENV = Object.freeze({
  LITELLM_MASTER_KEY: 'sk-test-master-key-long-enough',
  LITELLM_KEY_DERIVATION_SECRET:
    'account-deletion-test-derivation-secret',
  LITELLM_GATEWAY_URL: 'https://gateway.example.test',
});
const QUIET_LOGGER = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

function request({
  method = 'POST',
  body = {},
  authorization = 'Bearer owner-token',
} = {}) {
  return {
    method,
    body,
    headers: authorization ? { authorization } : {},
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function createDeletionProgressDb(initialData = {}) {
  let data = { ...initialData };
  const ref = {
    async get() {
      return {
        exists: Object.keys(data).length > 0,
        data: () => data,
      };
    },
  };

  return {
    doc(path) {
      assert.equal(path, `_accountSecurity/${IDENTITY.uid}`);
      return ref;
    },
    async runTransaction(operation) {
      const transaction = {
        async get(candidateRef) {
          assert.equal(candidateRef, ref);
          return ref.get();
        },
        set(candidateRef, patch, options) {
          assert.equal(candidateRef, ref);
          assert.deepEqual(options, { merge: true });
          data = { ...data, ...patch };
        },
      };
      return operation(transaction);
    },
    read() {
      return data;
    },
  };
}

test('recent-login boundary accepts a fresh token and rejects stale or missing auth_time', () => {
  assert.doesNotThrow(() =>
    requireRecentAuthentication(IDENTITY, {
      nowSeconds: 1_800_000_120,
      maxAgeSeconds: 300,
    }),
  );
  assert.throws(
    () =>
      requireRecentAuthentication(
        { ...IDENTITY, authTime: 1_799_999_000 },
        { nowSeconds: 1_800_000_120, maxAgeSeconds: 300 },
      ),
    (error) =>
      error.code === 'recent_login_required' && error.status === 401,
  );
  assert.throws(
    () =>
      requireRecentAuthentication(
        { ...IDENTITY, authTime: null },
        { nowSeconds: 1_800_000_120 },
      ),
    (error) => error.code === 'recent_login_required',
  );
});

test('export sanitizer recursively removes credentials without dropping normal user data', () => {
  const safe = sanitizeAccountExport({
    name: 'Owner',
    apiKey: 'sk-must-not-export',
    nested: {
      refreshToken: 'standing-oauth-secret',
      access_token: 'short-lived-oauth-secret',
      note: 'Keep this relationship note.',
    },
    tokens: [{ id_token: 'secret' }, { count: 2 }],
  });

  assert.deepEqual(safe, {
    name: 'Owner',
    nested: { note: 'Keep this relationship note.' },
    tokens: [{}, { count: 2 }],
  });
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(JSON.stringify(safe).includes('sk-'), false);
});

test('account export denies a cross-user body before reading any data', async () => {
  let exportCalled = false;
  const handler = createAccountExportHandler({
    verifyIdentity: async () => IDENTITY,
    assertRecent() {},
    exportAccount: async () => {
      exportCalled = true;
      return {};
    },
    logger: QUIET_LOGGER,
  });
  const res = response();

  await handler(
    request({
      method: 'POST',
      body: { userId: 'another-user' },
    }),
    res,
  );

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error.code, 'identity_mismatch');
  assert.equal(exportCalled, false);
});

test('account endpoints reject a missing Firebase Bearer token without initializing services', async () => {
  const handlers = [
    {
      handler: createAccountExportHandler({ logger: QUIET_LOGGER }),
      method: 'GET',
    },
    {
      handler: createDeleteAccountHandler({ logger: QUIET_LOGGER }),
      method: 'DELETE',
    },
    {
      handler: createRevokeSessionsHandler({ logger: QUIET_LOGGER }),
      method: 'POST',
    },
  ];

  for (const { handler, method } of handlers) {
    const res = response();
    await handler(request({ method, authorization: null }), res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.payload.error, {
      code: 'unauthorized',
      message: 'Authentication required.',
    });
    assert.equal(
      res.headers['cache-control'],
      'private, no-store, max-age=0',
    );
  }
});

test('authenticated export is an attachment and contains only service output', async () => {
  const handler = createAccountExportHandler({
    verifyIdentity: async () => IDENTITY,
    assertRecent() {},
    exportAccount: async (identity) => ({
      schemaVersion: 1,
      account: { uid: identity.uid },
    }),
    logger: QUIET_LOGGER,
  });
  const res = response();

  await handler(request({ method: 'GET' }), res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-disposition'], /^attachment;/);
  assert.deepEqual(JSON.parse(res.payload), {
    schemaVersion: 1,
    account: { uid: IDENTITY.uid },
  });
});

test('account export requires a recent sign-in before reading private data', async () => {
  let exportCalled = false;
  const handler = createAccountExportHandler({
    verifyIdentity: async () => IDENTITY,
    assertRecent() {
      throw Object.assign(new Error('stale'), {
        code: 'recent_login_required',
      });
    },
    exportAccount: async () => {
      exportCalled = true;
      return {};
    },
    logger: QUIET_LOGGER,
  });
  const res = response();

  await handler(request({ method: 'GET' }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.error.code, 'recent_login_required');
  assert.equal(exportCalled, false);
});

test('account deletion always runs Auth last and is safe to retry', async () => {
  const calls = [];
  const deleted = new Set();
  const service = (name) => async () => {
    calls.push(name);
    deleted.add(name);
  };
  const services = {
    deleteLiteLLMIdentity: service('aiIdentity'),
    deleteOAuthIdentity: service('oauthIdentity'),
    deletePublicCards: service('publicCards'),
    deletePrivateUserData: service('privateData'),
    deleteAuthUser: service('firebaseAuth'),
  };

  const first = await runAccountDeletion({
    identity: IDENTITY,
    legacyApiKey: null,
    services,
  });
  const second = await runAccountDeletion({
    identity: IDENTITY,
    legacyApiKey: null,
    services,
  });

  assert.deepEqual(first.completed, ACCOUNT_DELETION_STEPS);
  assert.deepEqual(second.completed, ACCOUNT_DELETION_STEPS);
  assert.deepEqual(calls.slice(0, 5), ACCOUNT_DELETION_STEPS);
  assert.deepEqual(calls.slice(5), ACCOUNT_DELETION_STEPS);
  assert.equal(deleted.size, 5);
});

test('a failed cleanup step preserves private data and Firebase Auth for retry', async () => {
  const calls = [];
  await assert.rejects(
    runAccountDeletion({
      identity: IDENTITY,
      services: {
        async deleteLiteLLMIdentity() {
          calls.push('aiIdentity');
        },
        async deleteOAuthIdentity() {
          calls.push('oauthIdentity');
          throw Object.assign(new Error('provider private detail'), {
            code: 'oauth_revoke_failed',
          });
        },
        async deletePublicCards() {
          calls.push('publicCards');
        },
        async deletePrivateUserData() {
          calls.push('privateData');
        },
        async deleteAuthUser() {
          calls.push('firebaseAuth');
        },
      },
    }),
  );

  assert.deepEqual(calls, ['aiIdentity', 'oauthIdentity']);
});

test('an Auth deletion failure keeps the non-expiring lock and never finalizes it', async () => {
  let finalized = false;
  await assert.rejects(
    runAccountDeletion({
      identity: IDENTITY,
      services: {
        async deleteLiteLLMIdentity() {},
        async deleteOAuthIdentity() {},
        async deletePublicCards() {},
        async deletePrivateUserData() {},
        async deleteAuthUser() {
          throw Object.assign(new Error('auth unavailable'), {
            code: 'auth/internal-error',
          });
        },
        async finalizeAccountLock() {
          finalized = true;
        },
      },
    }),
  );
  assert.equal(finalized, false);
});

test('durable account deletion resumes after the last recorded successful step', async () => {
  const db = createDeletionProgressDb();
  const calls = [];
  let failOAuth = true;
  const services = {
    async deleteLiteLLMIdentity() {
      calls.push('aiIdentity');
    },
    async deleteOAuthIdentity() {
      calls.push('oauthIdentity');
      if (failOAuth) {
        throw Object.assign(new Error('private provider detail'), {
          code: 'oauth_revoke_failed',
        });
      }
    },
    async deletePublicCards() {
      calls.push('publicCards');
    },
    async deletePrivateUserData() {
      calls.push('privateData');
    },
    async deleteAuthUser() {
      calls.push('firebaseAuth');
    },
    async finalizeAccountLock() {
      calls.push('accountLock');
    },
  };

  await assert.rejects(
    runAccountDeletion({
      identity: IDENTITY,
      services: createDurableAccountDeletionServices({
        db,
        uid: IDENTITY.uid,
        services,
        logger: QUIET_LOGGER,
      }),
    }),
    (error) => error.code === 'oauth_revoke_failed',
  );

  assert.deepEqual(db.read().deletionJob.completedSteps, [
    'aiIdentity',
  ]);
  assert.equal(db.read().deletionJob.status, 'incomplete');
  assert.equal(
    db.read().deletionJob.currentStep,
    'oauthIdentity',
  );
  assert.equal(
    db.read().deletionJob.lastFailureCode,
    'oauth_revoke_failed',
  );

  failOAuth = false;
  const result = await runAccountDeletion({
    identity: IDENTITY,
    services: createDurableAccountDeletionServices({
      db,
      uid: IDENTITY.uid,
      services,
      logger: QUIET_LOGGER,
    }),
  });

  assert.deepEqual(calls, [
    'aiIdentity',
    'oauthIdentity',
    'oauthIdentity',
    'publicCards',
    'privateData',
    'firebaseAuth',
    'accountLock',
  ]);
  assert.deepEqual(result.completed, ACCOUNT_DELETION_STEPS);
  assert.equal(result.accountLockStatus, 'deleted');
  assert.deepEqual(
    db.read().deletionJob.completedSteps,
    ACCOUNT_DELETION_STEPS,
  );
  assert.equal(db.read().deletionJob.status, 'completed');
  assert.equal(db.read().deletionJob.currentStep, null);
  assert.equal(db.read().deletionJob.lastFailureCode, null);
  assert.equal(db.read().deletionJob.schemaVersion, 1);
});

test('durable deletion records the irreversible Auth handoff before deleting Auth', async () => {
  const db = createDeletionProgressDb();
  let finalized = false;
  const services = {
    async deleteLiteLLMIdentity() {},
    async deleteOAuthIdentity() {},
    async deletePublicCards() {},
    async deletePrivateUserData() {},
    async deleteAuthUser() {
      const job = db.read().deletionJob;
      assert.equal(job.status, 'committing');
      assert.equal(job.currentStep, 'firebaseAuth');
      assert.deepEqual(job.completedSteps, [
        'aiIdentity',
        'oauthIdentity',
        'publicCards',
        'privateData',
      ]);
      throw Object.assign(new Error('Auth unavailable'), {
        code: 'auth/internal-error',
      });
    },
    async finalizeAccountLock() {
      finalized = true;
    },
  };

  await assert.rejects(
    runAccountDeletion({
      identity: IDENTITY,
      services: createDurableAccountDeletionServices({
        db,
        uid: IDENTITY.uid,
        services,
        logger: QUIET_LOGGER,
      }),
    }),
    (error) => error.code === 'auth/internal-error',
  );

  assert.equal(finalized, false);
  assert.equal(db.read().deletionJob.status, 'incomplete');
  assert.equal(
    db.read().deletionJob.currentStep,
    'firebaseAuth',
  );
  assert.deepEqual(db.read().deletionJob.completedSteps, [
    'aiIdentity',
    'oauthIdentity',
    'publicCards',
    'privateData',
  ]);
  assert.equal(
    db.read().deletionJob.lastFailureCode,
    'auth/internal-error',
  );
});

test('a final tombstone failure does not misreport a completed account deletion', async () => {
  const result = await runAccountDeletion({
    identity: IDENTITY,
    services: {
      async deleteLiteLLMIdentity() {},
      async deleteOAuthIdentity() {},
      async deletePublicCards() {},
      async deletePrivateUserData() {},
      async deleteAuthUser() {},
      async finalizeAccountLock() {
        throw new Error('transient tombstone write failure');
      },
    },
  });

  assert.deepEqual(result.completed, ACCOUNT_DELETION_STEPS);
  assert.equal(result.accountLockStatus, 'deleting');
});

test('delete endpoint returns the opaque receipt and terminal lock status', async () => {
  const handler = createDeleteAccountHandler({
    verifyIdentity: async () => IDENTITY,
    assertRecent() {},
    deleteAccount: async () => ({
      receiptId: 'deletion_receipt_123456',
      receiptStatus: 'completed',
      accountLockStatus: 'deleted',
    }),
    logger: QUIET_LOGGER,
  });
  const res = response();
  await handler(
    request({ method: 'DELETE', body: { confirmation: 'DELETE' } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    deleted: true,
    accountLockStatus: 'deleted',
    receipt: {
      id: 'deletion_receipt_123456',
      status: 'completed',
      accountLockStatus: 'deleted',
    },
  });
});

test('delete endpoint removes the deterministic AI identity even when the user root is already absent', async () => {
  const liteLLMDeletes = [];
  const progressDb = createDeletionProgressDb();
  const handler = createDeleteAccountHandler({
    env: ENV,
    verifyIdentity: async () => IDENTITY,
    assertRecent() {},
    beginAccountLock: async () => undefined,
    adminServicesFactory: () => ({
      auth: { async deleteUser() {} },
      db: {
        doc(path) {
          if (path === `users/${IDENTITY.uid}`) {
            return {
              async get() {
                return { exists: false, data: () => undefined };
              },
            };
          }
          if (path === `_accountSecurity/${IDENTITY.uid}`) {
            return progressDb.doc(path);
          }
          return {
            async set() {},
          };
        },
        runTransaction(operation) {
          return progressDb.runTransaction(operation);
        },
      },
    }),
    deleteLiteLLM: async (input) => {
      liteLLMDeletes.push(input);
    },
    runDeletion: async ({ identity, services }) => {
      await services.deleteLiteLLMIdentity({
        uid: identity.uid,
        email: identity.email,
        legacyApiKeys: [],
      });
      return {
        accountLockStatus: 'deleted',
        receiptId: null,
      };
    },
    logger: QUIET_LOGGER,
  });
  const res = response();

  await handler(
    request({ method: 'DELETE', body: { confirmation: 'DELETE' } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(liteLLMDeletes.length, 1);
  assert.equal(liteLLMDeletes[0].uid, IDENTITY.uid);
  assert.deepEqual(liteLLMDeletes[0].legacyApiKeys, []);
  assert.deepEqual(
    progressDb.read().deletionJob.completedSteps,
    ['aiIdentity'],
  );
});

test('delete endpoint denies cross-user requests and requires exact confirmation', async () => {
  let deleteCalled = false;
  const handler = createDeleteAccountHandler({
    verifyIdentity: async () => IDENTITY,
    assertRecent() {},
    deleteAccount: async () => {
      deleteCalled = true;
    },
    logger: QUIET_LOGGER,
  });

  const crossUser = response();
  await handler(
    request({
      method: 'DELETE',
      body: { userId: 'another-user', confirmation: 'DELETE' },
    }),
    crossUser,
  );
  assert.equal(crossUser.statusCode, 403);

  const unconfirmed = response();
  await handler(
    request({ method: 'DELETE', body: { confirmation: 'delete' } }),
    unconfirmed,
  );
  assert.equal(unconfirmed.statusCode, 400);
  assert.equal(unconfirmed.payload.error.code, 'confirmation_required');
  assert.equal(deleteCalled, false);
});

test('delete endpoint accepts only the destructive DELETE method', async () => {
  let deleteCalled = false;
  const handler = createDeleteAccountHandler({
    verifyIdentity: async () => IDENTITY,
    assertRecent() {},
    deleteAccount: async () => {
      deleteCalled = true;
    },
    logger: QUIET_LOGGER,
  });
  const res = response();

  await handler(
    request({ method: 'POST', body: { confirmation: 'DELETE' } }),
    res,
  );

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'DELETE');
  assert.equal(deleteCalled, false);
});

test('delete endpoint returns a sanitized retryable failure and never provider details', async () => {
  const privateMessage =
    'sk-provider-secret Traceback private oauth response body';
  const logs = [];
  const handler = createDeleteAccountHandler({
    verifyIdentity: async () => IDENTITY,
    assertRecent() {},
    deleteAccount: async () => {
      throw Object.assign(new Error(privateMessage), {
        code: 'oauth_revoke_failed',
      });
    },
    logger: {
      error(...args) {
        logs.push(args);
      },
    },
  });
  const res = response();

  await handler(
    request({ method: 'DELETE', body: { confirmation: 'DELETE' } }),
    res,
  );

  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error.code, 'account_deletion_incomplete');
  assert.equal(JSON.stringify(res.payload).includes(privateMessage), false);
  assert.equal(JSON.stringify(logs).includes(privateMessage), false);
  assert.equal(JSON.stringify(res.payload).includes('stack'), false);
});

test('session revocation requires recent login and denies cross-user claims', async () => {
  let revoked = 0;
  const staleHandler = createRevokeSessionsHandler({
    verifyIdentity: async () => IDENTITY,
    assertRecent() {
      throw Object.assign(new Error('stale'), {
        code: 'recent_login_required',
      });
    },
    revokeSessions: async () => {
      revoked += 1;
    },
    logger: QUIET_LOGGER,
  });
  const stale = response();
  await staleHandler(request(), stale);
  assert.equal(stale.statusCode, 401);
  assert.equal(stale.payload.error.code, 'recent_login_required');

  const crossHandler = createRevokeSessionsHandler({
    verifyIdentity: async () => IDENTITY,
    assertRecent() {},
    revokeSessions: async () => {
      revoked += 1;
    },
    logger: QUIET_LOGGER,
  });
  const cross = response();
  await crossHandler(
    request({ body: { userId: 'another-user' } }),
    cross,
  );
  assert.equal(cross.statusCode, 403);
  assert.equal(revoked, 0);
});

test('session revocation can clear the privacy-safe browser registry in bounded batches', async () => {
  const deleted = [];
  let reads = 0;
  const db = {
    collection(path) {
      assert.equal(path, `users/${IDENTITY.uid}/sessions`);
      return {
        limit(value) {
          assert.equal(value, 200);
          return {
            async get() {
              reads += 1;
              const docs =
                reads === 1
                  ? [{ ref: { path: 'session/a' } }, { ref: { path: 'session/b' } }]
                  : [];
              return { docs, size: docs.length, empty: docs.length === 0 };
            },
          };
        },
      };
    },
    batch() {
      return {
        delete(ref) {
          deleted.push(ref.path);
        },
        async commit() {},
      };
    },
  };

  assert.equal(
    await deleteRegisteredBrowserSessions(db, IDENTITY.uid),
    2,
  );
  assert.deepEqual(deleted, ['session/a', 'session/b']);
});

test('Google token revocation treats an already-invalid credential as idempotent', async () => {
  let requests = 0;
  await revokeGoogleCredential('test-oauth-token', {
    fetchImpl: async (_url, init) => {
      requests += 1;
      assert.equal(init.method, 'POST');
      assert.equal(
        new URLSearchParams(init.body).get('token'),
        'test-oauth-token',
      );
      return new Response('', { status: 400 });
    },
  });
  assert.equal(requests, 1);
});

test('Google token revocation times out without exposing the credential', async () => {
  await assert.rejects(
    revokeGoogleCredential('private-timeout-token', {
      timeoutMs: 1,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('private provider timeout detail')),
          );
        }),
    }),
    (error) =>
      error.code === 'oauth_revoke_timeout' &&
      !error.message.includes('private-timeout-token') &&
      !error.message.includes('provider timeout'),
  );
});

test('LiteLLM cleanup removes managed and legacy keys before both user identities', async () => {
  const legacyKey = 'sk-legacy-user-key';
  const keyOwners = new Map();
  const requests = [];
  let managedHash;

  const client = {
    async getKey(hash) {
      if (!managedHash) managedHash = hash;
      if (hash === managedHash) return { user_id: IDENTITY.uid };
      return keyOwners.get(hash) || { info: { user_id: 'legacy-user-id' } };
    },
    async getUser(userId) {
      return {
        user_id: userId,
        ...(userId === 'legacy-user-id'
          ? { user_email: IDENTITY.email }
          : {}),
      };
    },
    async request(path, options) {
      requests.push([path, options]);
      if (path === '/key/delete') {
        // Mark key reads absent after successful deletion.
        const key = options.body.keys[0];
        const hash = (await import('../server/api/_lib/litellm.js')).hashLiteLLMKey(
          key,
        );
        if (hash === managedHash) {
          this.getKey = async (candidate) =>
            candidate === managedHash
              ? null
              : keyOwners.get(candidate) ||
                { info: { user_id: 'legacy-user-id' } };
        }
      }
      return {};
    },
  };

  await deleteLiteLLMIdentity({
    uid: IDENTITY.uid,
    email: IDENTITY.email,
    legacyApiKey: legacyKey,
    env: ENV,
    client,
    logger: QUIET_LOGGER,
  });

  assert.deepEqual(
    requests.map(([path]) => path),
    ['/key/delete', '/key/delete', '/user/delete', '/user/delete'],
  );
  assert.equal(requests[0][1].body.keys.length, 1);
  assert.deepEqual(
    new Set(requests.slice(2).map(([, options]) => options.body.user_ids[0])),
    new Set([IDENTITY.uid, 'legacy-user-id']),
  );
});

test('LiteLLM cleanup fails closed without explicit independent server configuration', async () => {
  const configurations = [
    {
      LITELLM_MASTER_KEY: ENV.LITELLM_MASTER_KEY,
      LITELLM_KEY_DERIVATION_SECRET:
        ENV.LITELLM_KEY_DERIVATION_SECRET,
      VITE_GATEWAY_URL:
        'https://litellm-production-2a63.up.railway.app',
    },
    {
      LITELLM_MASTER_KEY: ENV.LITELLM_MASTER_KEY,
      LITELLM_GATEWAY_URL: ENV.LITELLM_GATEWAY_URL,
    },
    {
      LITELLM_MASTER_KEY: ENV.LITELLM_MASTER_KEY,
      LITELLM_GATEWAY_URL: ENV.LITELLM_GATEWAY_URL,
      LITELLM_KEY_DERIVATION_SECRET: ENV.LITELLM_MASTER_KEY,
    },
  ];

  for (const candidateEnv of configurations) {
    let contacted = false;
    await assert.rejects(
      deleteLiteLLMIdentity({
        uid: IDENTITY.uid,
        env: candidateEnv,
        client: {
          async getKey() {
            contacted = true;
          },
        },
        logger: QUIET_LOGGER,
      }),
      (error) =>
        error.code === 'account_cleanup_not_configured',
    );
    assert.equal(contacted, false);
  }
});

test('LiteLLM cleanup refuses a legacy key owned by another Firebase identity', async () => {
  const requests = [];
  const client = {
    async getKey() {
      return {
        user_id: 'different-user',
        metadata: { firebase_uid: 'different-firebase-uid' },
      };
    },
    async getUser() {
      return {
        user_id: 'different-user',
        user_email: 'somebody-else@cirqle.test',
        metadata: { firebase_uid: 'different-firebase-uid' },
      };
    },
    async request(...args) {
      requests.push(args);
    },
  };

  await assert.rejects(
    deleteLiteLLMIdentity({
      uid: IDENTITY.uid,
      email: IDENTITY.email,
      env: ENV,
      client,
      logger: QUIET_LOGGER,
    }),
    (error) => error.code === 'litellm_key_owner_mismatch',
  );
  assert.equal(requests.length, 0);
});

test('LiteLLM concurrent-delete races are accepted only after absence is verified', async () => {
  let reads = 0;
  const client = {
    async getKey() {
      reads += 1;
      return reads === 1 ? { user_id: IDENTITY.uid } : null;
    },
    async request(path) {
      if (path === '/key/delete') {
        throw new LiteLLMRequestError({
          code: 'litellm_http_error',
          status: 404,
        });
      }
      return {};
    },
    async getUser() {
      return null;
    },
  };

  await deleteLiteLLMIdentity({
    uid: IDENTITY.uid,
    env: ENV,
    client,
    logger: QUIET_LOGGER,
  });

  assert.equal(reads, 2);
});
