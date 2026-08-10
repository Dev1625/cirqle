import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRegisterUserHandler,
} from '../server/api/register-user.js';
import {
  AuthError,
  verifyBearerFirebaseToken,
} from '../server/api/_lib/firebase-admin.js';
import { getTrustedClientIp } from '../server/api/_lib/http.js';
import {
  createLiteLLMClient,
  hashLiteLLMKey,
  LiteLLMRequestError,
} from '../server/api/_lib/litellm.js';
import {
  BUDGET_DURATION,
  BUDGET_LIMIT_USD,
  deriveManagedVirtualKey,
  MANAGED_USER_ROLE,
  PRODUCTION_MODEL_ALIASES,
  provisionLiteLLMIdentity,
} from '../server/api/_lib/provisioning.js';
import {
  createProvisioningRateLimiter,
  DistributedRateLimitUnavailableError,
  ProvisioningRateLimitError,
} from '../server/api/_lib/rate-limit.js';
import {
  LEGACY_AI_KEY_FIELDS,
  scrubLegacyAIKeyFields,
} from '../server/api/_lib/legacy-key-scrub.js';

const ENV = Object.freeze({
  LITELLM_MASTER_KEY: 'sk-master-key-long-enough-for-tests',
  LITELLM_GATEWAY_URL: 'https://gateway.example.test',
  LITELLM_KEY_DERIVATION_SECRET:
    'test-only-virtual-key-derivation-secret',
});
const IDENTITY = Object.freeze({
  uid: 'firebase-owner-123',
  email: 'owner@cirqle.test',
  emailVerified: true,
});
const MANAGED_METADATA = Object.freeze({
  app: 'cirqle-web',
  firebase_uid: IDENTITY.uid,
  managed_by: 'cirqle-provisioner',
  credential_version: 2,
});
const ALLOWED_RATE = Object.freeze({
  async check() {
    return { limit: 6, remaining: 5, resetAt: 1_800_000_000 };
  },
});
const QUIET_LOGGER = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

function createRequest({
  method = 'POST',
  authorization = 'Bearer valid-owner-token',
  body = {},
  vercelIp = '203.0.113.7',
} = {}) {
  return {
    method,
    body,
    headers: {
      ...(authorization ? { authorization } : {}),
      'x-request-id': 'req_contract_test',
      ...(vercelIp
        ? { 'x-vercel-forwarded-for': vercelIp }
        : {}),
    },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function createHandler({
  verifyIdentity = async () => IDENTITY,
  client,
  logger = QUIET_LOGGER,
  scrubLegacyKeys = async () => {},
  issuanceLimiter = ALLOWED_RATE,
} = {}) {
  return createRegisterUserHandler({
    env: ENV,
    logger,
    verifyIdentity,
    rateLimiter: ALLOWED_RATE,
    issuanceLimiter,
    scrubLegacyKeys,
    liteLLMClientFactory: () => client,
  });
}

test('returns 401 when the Firebase Bearer token is missing', async () => {
  const handler = createRegisterUserHandler({
    env: ENV,
    logger: QUIET_LOGGER,
    rateLimiter: ALLOWED_RATE,
    verifyIdentity: (req) =>
      verifyBearerFirebaseToken(req, {
        verifyIdToken: async () => {
          throw new Error('must not be called');
        },
      }),
  });
  const res = createResponse();

  await handler(createRequest({ authorization: null }), res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.payload.error, {
    code: 'unauthorized',
    message: 'Authentication required.',
  });
  assert.equal(res.headers['cache-control'], 'private, no-store, max-age=0');
});

test('returns 401 for a forged or expired Firebase token', async () => {
  const handler = createHandler({
    verifyIdentity: (req) =>
      verifyBearerFirebaseToken(req, {
        verifyIdToken: async (token, checkRevoked) => {
          assert.equal(token, 'forged-token');
          assert.equal(checkRevoked, true);
          const error = new Error(
            'invalid signature details must stay private',
          );
          error.code = 'auth/invalid-id-token';
          throw error;
        },
      }),
  });
  const res = createResponse();

  await handler(
    createRequest({ authorization: 'Bearer forged-token' }),
    res,
  );

  assert.equal(res.statusCode, 401);
  assert.equal(JSON.stringify(res.payload).includes('signature'), false);
});

test('returns a sanitized 503 when Firebase Admin is unavailable', async () => {
  const handler = createHandler({
    verifyIdentity: (req) =>
      verifyBearerFirebaseToken(req, {
        verifyIdToken: async () => {
          const error = new Error(
            'private service-account credential details',
          );
          error.code = 'app/invalid-credential';
          throw error;
        },
      }),
  });
  const res = createResponse();

  await handler(createRequest(), res);

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.payload.error, {
    code: 'authentication_unavailable',
    message: 'Authentication is temporarily unavailable.',
  });
  assert.equal(
    JSON.stringify(res.payload).includes('service-account'),
    false,
  );
});

test('rejects a cross-user body claim and never contacts LiteLLM', async () => {
  let clientFactoryCalled = false;
  const handler = createRegisterUserHandler({
    env: ENV,
    logger: QUIET_LOGGER,
    verifyIdentity: async () => IDENTITY,
    rateLimiter: ALLOWED_RATE,
    liteLLMClientFactory: () => {
      clientFactoryCalled = true;
      return {};
    },
  });
  const res = createResponse();

  await handler(createRequest({ body: { userId: 'somebody-else' } }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error.code, 'identity_mismatch');
  assert.equal(clientFactoryCalled, false);
});

test('does not provision paid AI for an unverified email account', async () => {
  let clientFactoryCalled = false;
  const handler = createRegisterUserHandler({
    env: ENV,
    logger: QUIET_LOGGER,
    verifyIdentity: async () => ({
      uid: IDENTITY.uid,
      email: IDENTITY.email,
      emailVerified: false,
    }),
    rateLimiter: ALLOWED_RATE,
    liteLLMClientFactory: () => {
      clientFactoryCalled = true;
      return {};
    },
  });
  const res = createResponse();

  await handler(createRequest(), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error.code, 'email_verification_required');
  assert.equal(clientFactoryCalled, false);
});

test('does not provision paid AI when the verified token has no email identity', async () => {
  let clientFactoryCalled = false;
  const handler = createRegisterUserHandler({
    env: ENV,
    logger: QUIET_LOGGER,
    verifyIdentity: async () => ({
      uid: IDENTITY.uid,
      email: null,
      emailVerified: false,
    }),
    rateLimiter: ALLOWED_RATE,
    liteLLMClientFactory: () => {
      clientFactoryCalled = true;
      return {};
    },
  });
  const res = createResponse();

  await handler(createRequest(), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error.code, 'email_verification_required');
  assert.equal(clientFactoryCalled, false);
});

test('consumes independent UID and trusted-IP provisioning buckets', async () => {
  const subjects = [];
  const handler = createRegisterUserHandler({
    env: ENV,
    logger: QUIET_LOGGER,
    verifyIdentity: async () => IDENTITY,
    rateLimiter: {
      async check(subject) {
        subjects.push(subject);
        if (subjects.length === 2) {
          throw new ProvisioningRateLimitError(30);
        }
        return { limit: 6, remaining: 5, resetAt: 1_800_000_000 };
      },
    },
    scrubLegacyKeys: async () => {},
  });
  const res = createResponse();

  await handler(
    createRequest({ vercelIp: '198.51.100.42' }),
    res,
  );

  assert.deepEqual(subjects, [
    `uid:${IDENTITY.uid}`,
    'ip:198.51.100.42',
  ]);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '30');
});

test('ignores client-controlled forwarding headers for IP security buckets', () => {
  assert.equal(
    getTrustedClientIp({
      headers: { 'x-forwarded-for': '198.51.100.99' },
    }),
    'unavailable',
  );
  assert.equal(
    getTrustedClientIp({
      headers: {
        'x-vercel-forwarded-for': 'not-an-ip, 198.51.100.2',
      },
    }),
    'unavailable',
  );
});

test('provisioning fails closed without every dedicated server setting', async () => {
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
    let clientFactoryCalled = false;
    const handler = createRegisterUserHandler({
      env: candidateEnv,
      logger: QUIET_LOGGER,
      verifyIdentity: async () => IDENTITY,
      rateLimiter: ALLOWED_RATE,
      scrubLegacyKeys: async () => {},
      liteLLMClientFactory: () => {
        clientFactoryCalled = true;
        return {};
      },
    });
    const res = createResponse();

    await handler(createRequest(), res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.error.code, 'provisioning_unavailable');
    assert.equal(clientFactoryCalled, false);
  }
});

test('creates one capped key using token identity and only production aliases', async () => {
  const calls = [];
  const issuanceSubjects = [];
  let scrubInput;
  const client = {
    async getUser(uid) {
      calls.push(['getUser', uid]);
      return null;
    },
    async createUser(payload) {
      calls.push(['createUser', payload]);
      return { user_id: payload.user_id };
    },
    async updateUser() {
      assert.fail('a newly created user does not need an update');
    },
    async getKey(keyHash) {
      calls.push(['getKey', keyHash]);
      return null;
    },
    async createKey(payload) {
      calls.push(['createKey', payload]);
      return { key: payload.key };
    },
    async updateKey() {
      assert.fail('a newly created key does not need an update');
    },
  };
  const handler = createHandler({
    client,
    issuanceLimiter: {
      async check(subject) {
        issuanceSubjects.push(subject);
        return { limit: 25, remaining: 24, resetAt: 1_800_000_000 };
      },
    },
    scrubLegacyKeys: async (input) => {
      scrubInput = input;
    },
  });
  const res = createResponse();

  await handler(
    createRequest({
      body: {
        userId: IDENTITY.uid,
        email: 'attacker-controlled@example.test',
      },
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.provisioned, true);
  assert.equal(res.payload.reused, false);
  assert.deepEqual(res.payload.models, PRODUCTION_MODEL_ALIASES);
  assert.deepEqual(res.payload.budget, {
    limitUsd: BUDGET_LIMIT_USD,
    duration: BUDGET_DURATION,
  });
  assert.equal('apiKey' in res.payload, false);
  assert.equal(scrubInput.uid, IDENTITY.uid);
  assert.equal(scrubInput.email, IDENTITY.email);
  assert.equal(scrubInput.env, ENV);
  assert.equal(scrubInput.client, client);
  assert.deepEqual(
    Object.keys(scrubInput).sort(),
    ['client', 'email', 'env', 'uid'],
  );

  const userPayload = calls.find(([name]) => name === 'createUser')[1];
  const keyPayload = calls.find(([name]) => name === 'createKey')[1];
  assert.equal(userPayload.user_id, IDENTITY.uid);
  assert.equal(userPayload.user_email, IDENTITY.email);
  assert.equal(userPayload.auto_create_key, false);
  assert.equal(keyPayload.user_id, IDENTITY.uid);
  assert.equal(keyPayload.max_budget, 5);
  assert.equal(keyPayload.budget_duration, '30d');
  assert.deepEqual(keyPayload.models, PRODUCTION_MODEL_ALIASES);
  assert.equal(keyPayload.key_alias.includes(IDENTITY.uid), false);
  assert.equal('tags' in userPayload, false);
  assert.equal('tags' in keyPayload, false);
  assert.deepEqual(issuanceSubjects, ['new-managed-key:global:v1']);
  assert.equal(
    calls.find(([name]) => name === 'getKey')[1],
    hashLiteLLMKey(
      deriveManagedVirtualKey(
        IDENTITY.uid,
        ENV.LITELLM_KEY_DERIVATION_SECRET,
      ),
    ),
  );
});

test('legacy key migration revokes every known raw-key field before scrubbing it', async () => {
  const updates = [];
  const revokeInputs = [];
  const legacyValues = Object.fromEntries(
    LEGACY_AI_KEY_FIELDS.map((field, index) => [
      field,
      `sk-legacy-${index}`,
    ]),
  );
  const db = {
    doc(path) {
      assert.equal(path, `users/${IDENTITY.uid}`);
      return {
        async get() {
          return {
            exists: true,
            data: () => legacyValues,
          };
        },
        async update(patch) {
          updates.push(patch);
        },
      };
    },
  };

  await scrubLegacyAIKeyFields({
    uid: IDENTITY.uid,
    email: IDENTITY.email,
    db,
    client: { kind: 'test-client' },
    revokeLegacyKeys: async (input) => {
      revokeInputs.push(input);
    },
    deleteField: () => 'DELETE_FIELD',
  });

  assert.equal(revokeInputs.length, 1);
  assert.deepEqual(
    new Set(revokeInputs[0].legacyApiKeys),
    new Set(Object.values(legacyValues)),
  );
  assert.equal(revokeInputs[0].uid, IDENTITY.uid);
  assert.equal(revokeInputs[0].email, IDENTITY.email);
  assert.equal(updates.length, 1);
  assert.deepEqual(
    Object.keys(updates[0]).sort(),
    [...LEGACY_AI_KEY_FIELDS].sort(),
  );
  assert.ok(
    Object.values(updates[0]).every(
      (value) => value === 'DELETE_FIELD',
    ),
  );
  assert.equal(JSON.stringify(updates).includes('sk-legacy'), false);
});

test('legacy key migration preserves retry material when revocation is incomplete', async () => {
  let updated = false;
  await assert.rejects(
    scrubLegacyAIKeyFields({
      uid: IDENTITY.uid,
      db: {
        doc() {
          return {
            async get() {
              return {
                exists: true,
                data: () => ({ apiKey: 'sk-legacy-retry' }),
              };
            },
            async update() {
              updated = true;
            },
          };
        },
      },
      revokeLegacyKeys: async () => {
        throw new Error('private gateway detail');
      },
      deleteField: () => 'DELETE_FIELD',
    }),
    (error) =>
      error.code === 'legacy_key_scrub_failed' &&
      !error.message.includes('gateway'),
  );
  assert.equal(updated, false);
});

test('legacy key scrub treats an absent root document as a safe no-op', async () => {
  const result = await scrubLegacyAIKeyFields({
    uid: IDENTITY.uid,
    db: {
      doc() {
        return {
          async get() {
            return { exists: false };
          },
        };
      },
    },
    deleteField: () => 'DELETE_FIELD',
  });
  assert.deepEqual(result, { scrubbed: false, revoked: 0 });
});

test('reuses and reconciles the deterministic key without creating another', async () => {
  const apiKey = deriveManagedVirtualKey(
    IDENTITY.uid,
    ENV.LITELLM_KEY_DERIVATION_SECRET,
  );
  const keyHash = hashLiteLLMKey(apiKey);
  let createCount = 0;
  const updates = [];
  const client = {
    async getUser() {
      return { user_id: IDENTITY.uid };
    },
    async createUser() {
      createCount += 1;
    },
    async updateUser(payload) {
      updates.push(['user', payload]);
    },
    async getKey(receivedHash) {
      assert.equal(receivedHash, keyHash);
      return {
        info: {
          user_id: IDENTITY.uid,
          metadata: MANAGED_METADATA,
        },
      };
    },
    async createKey() {
      createCount += 1;
    },
    async updateKey(payload) {
      updates.push(['key', payload]);
    },
  };
  const handler = createHandler({
    client,
    issuanceLimiter: {
      async check() {
        assert.fail('Existing managed keys must not consume new-key capacity.');
      },
    },
  });
  const res = createResponse();

  await handler(createRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.provisioned, true);
  assert.equal('apiKey' in res.payload, false);
  assert.equal(res.payload.reused, true);
  assert.equal(createCount, 0);
  assert.equal(updates.length, 2);
  assert.equal(updates[1][1].key, keyHash);
  assert.deepEqual(updates[1][1].models, PRODUCTION_MODEL_ALIASES);
});

test('global issuance circuit breaker pauses only brand-new managed keys', async () => {
  let createCount = 0;
  const client = {
    async getUser() {
      return { user_id: IDENTITY.uid };
    },
    async updateUser() {},
    async getKey() {
      return null;
    },
    async createKey() {
      createCount += 1;
    },
  };
  const handler = createHandler({
    client,
    issuanceLimiter: {
      async check() {
        throw new ProvisioningRateLimitError(3_600);
      },
    },
  });
  const res = createResponse();

  await handler(createRequest(), res);

  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '3600');
  assert.equal(res.payload.error.code, 'ai_enrollment_paused');
  assert.equal(createCount, 0);
});

test('revokes an older managed key before provisioning a rotated credential', async () => {
  const apiKey = deriveManagedVirtualKey(
    IDENTITY.uid,
    ENV.LITELLM_KEY_DERIVATION_SECRET,
  );
  const currentHash = hashLiteLLMKey(apiKey);
  const staleHash = 'a'.repeat(64);
  const calls = [];
  let staleDeleted = false;
  const client = {
    async getUser() {
      return { user_id: IDENTITY.uid };
    },
    async updateUser() {},
    async listUserKeys(uid) {
      assert.equal(uid, IDENTITY.uid);
      return {
        keys: [
          {
            hashed_token: staleHash,
            user_id: IDENTITY.uid,
            metadata: {
              app: 'cirqle-web',
              firebase_uid: IDENTITY.uid,
              managed_by: 'cirqle-provisioner',
              credential_version: 1,
            },
          },
        ],
      };
    },
    async deleteKeys(keys) {
      calls.push(['delete', [...keys]]);
      staleDeleted = true;
    },
    async getKey(hash) {
      if (hash === staleHash) return staleDeleted ? null : { user_id: IDENTITY.uid };
      assert.equal(hash, currentHash);
      return null;
    },
    async createKey(payload) {
      calls.push(['create', payload.key]);
      return { key: payload.key };
    },
  };

  const result = await provisionLiteLLMIdentity({
    client,
    identity: IDENTITY,
    apiKey,
  });

  assert.equal(result.reused, false);
  assert.equal(result.rotatedKeys, 1);
  assert.deepEqual(calls[0], ['delete', [staleHash]]);
  assert.deepEqual(calls[1], ['create', apiKey]);
});

test('never claims ownerless or foreign-metadata deterministic keys', async () => {
  const apiKey = deriveManagedVirtualKey(
    IDENTITY.uid,
    ENV.LITELLM_KEY_DERIVATION_SECRET,
  );
  const candidates = [
    {
      keyInfo: { metadata: MANAGED_METADATA },
      code: 'managed_key_owner_mismatch',
    },
    {
      keyInfo: {
        user_id: IDENTITY.uid,
        metadata: {
          ...MANAGED_METADATA,
          firebase_uid: 'different-firebase-user',
        },
      },
      code: 'managed_key_metadata_mismatch',
    },
    {
      keyInfo: {
        user_id: IDENTITY.uid,
        metadata: {
          app: 'foreign-app',
          firebase_uid: IDENTITY.uid,
          managed_by: 'somebody-else',
          credential_version: 2,
        },
      },
      code: 'managed_key_metadata_mismatch',
    },
  ];
  for (const candidate of candidates) {
    let updated = false;
    await assert.rejects(
      provisionLiteLLMIdentity({
        identity: IDENTITY,
        apiKey,
        client: {
          async getUser() {
            return { user_id: IDENTITY.uid };
          },
          async updateUser() {},
          async getKey() {
            return candidate.keyInfo;
          },
          async updateKey() {
            updated = true;
          },
        },
      }),
      (error) => error.code === candidate.code,
    );
    assert.equal(updated, false);
  }
});

test('accepts only ownership-verified nested LiteLLM key response shapes', async () => {
  const apiKey = deriveManagedVirtualKey(
    IDENTITY.uid,
    ENV.LITELLM_KEY_DERIVATION_SECRET,
  );
  let update = null;
  const result = await provisionLiteLLMIdentity({
    identity: IDENTITY,
    apiKey,
    client: {
      async getUser() {
        return { user_id: IDENTITY.uid };
      },
      async updateUser() {},
      async getKey() {
        return {
          key_info: {
            user_id: IDENTITY.uid,
            metadata: MANAGED_METADATA,
          },
        };
      },
      async updateKey(payload) {
        update = payload;
      },
    },
  });
  assert.equal(result.reused, true);
  assert.equal(update.user_id, IDENTITY.uid);
});

test('recovers a concurrent key-creation race by re-reading the same key', async () => {
  const apiKey = deriveManagedVirtualKey(
    IDENTITY.uid,
    ENV.LITELLM_KEY_DERIVATION_SECRET,
  );
  let keyReads = 0;
  let keyCreates = 0;
  const client = {
    async getUser() {
      return { user_id: IDENTITY.uid };
    },
    async updateUser() {},
    async getKey() {
      keyReads += 1;
      return keyReads === 1
        ? null
        : {
            user_id: IDENTITY.uid,
            metadata: MANAGED_METADATA,
          };
    },
    async createKey() {
      keyCreates += 1;
      throw new LiteLLMRequestError({
        code: 'litellm_http_error',
        status: 409,
      });
    },
    async updateKey() {},
  };

  const result = await provisionLiteLLMIdentity({
    client,
    identity: IDENTITY,
    apiKey,
  });

  assert.deepEqual(result, {
    reused: true,
    keyHash: hashLiteLLMKey(apiKey),
  });
  assert.equal(keyCreates, 1);
  assert.equal(keyReads, 2);
});

test('recovers a concurrent user-creation race before reusing its key', async () => {
  const apiKey = deriveManagedVirtualKey(
    IDENTITY.uid,
    ENV.LITELLM_KEY_DERIVATION_SECRET,
  );
  let userReads = 0;
  let userUpdates = 0;
  let userCreates = 0;
  const client = {
    async getUser() {
      userReads += 1;
      return userReads === 1 ? null : { user_id: IDENTITY.uid };
    },
    async createUser() {
      userCreates += 1;
      throw new LiteLLMRequestError({
        code: 'litellm_http_error',
        status: 409,
      });
    },
    async updateUser() {
      userUpdates += 1;
    },
    async getKey() {
      return {
        user_id: IDENTITY.uid,
        metadata: MANAGED_METADATA,
      };
    },
    async updateKey() {},
  };

  const result = await provisionLiteLLMIdentity({
    client,
    identity: IDENTITY,
    apiKey,
  });

  assert.equal(result.reused, true);
  assert.equal(userCreates, 1);
  assert.equal(userReads, 2);
  assert.equal(userUpdates, 1);
});

test('returns a sanitized 502 when LiteLLM provisioning fails', async () => {
  const providerBody =
    'provider-secret: sk-upstream; Traceback: private stack body';
  const logged = [];
  const logger = {
    info(...args) {
      logged.push(args);
    },
    warn(...args) {
      logged.push(args);
    },
    error(...args) {
      logged.push(args);
    },
  };
  const client = {
    async getUser() {
      throw new LiteLLMRequestError({
        message: providerBody,
        code: 'litellm_http_error',
        status: 403,
      });
    },
  };
  const handler = createHandler({ client, logger });
  const res = createResponse();

  await handler(createRequest(), res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.payload.error, {
    code: 'provisioning_unavailable',
    message: 'AI setup is temporarily unavailable.',
  });
  assert.equal(JSON.stringify(res.payload).includes(providerBody), false);
  assert.equal(JSON.stringify(logged).includes(providerBody), false);
  assert.equal(JSON.stringify(res.payload).includes('stack'), false);
});

test('LiteLLM client does not read or expose a rejected gateway body', async () => {
  const providerBody =
    'upstream body contains sk-sensitive-provider-key and traceback';
  const client = createLiteLLMClient({
    baseUrl: 'https://gateway.example.test',
    masterKey: ENV.LITELLM_MASTER_KEY,
    requestId: 'req_body_sanitization',
    logger: QUIET_LOGGER,
    fetchImpl: async () =>
      new Response(providerBody, {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      }),
  });

  await assert.rejects(
    client.getUser(IDENTITY.uid),
    (error) =>
      error instanceof LiteLLMRequestError &&
      error.status === 500 &&
      !error.message.includes(providerBody),
  );
});

test('local provisioning limiter caps repeated requests per hashed subject', async () => {
  const limiter = createProvisioningRateLimiter({
    env: {},
    logger: QUIET_LOGGER,
    now: () => 1_000,
    limit: 2,
    windowSeconds: 60,
  });

  assert.equal((await limiter.check('rate-limit-user')).remaining, 1);
  assert.equal((await limiter.check('rate-limit-user')).remaining, 0);
  await assert.rejects(
    limiter.check('rate-limit-user'),
    (error) =>
      error instanceof ProvisioningRateLimitError &&
      error.retryAfter === 60,
  );
});

test('distributed provisioning limiter hashes UID and IP subjects before storage', async () => {
  const requestBodies = [];
  const limiter = createProvisioningRateLimiter({
    env: {
      VERCEL_ENV: 'preview',
      UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN: 'redis-test-token',
    },
    logger: QUIET_LOGGER,
    fetchImpl: async (_url, init) => {
      requestBodies.push(init.body);
      return new Response(
        JSON.stringify([
          { result: 1 },
          { result: 1 },
          { result: 60 },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });

  await limiter.check(`uid:${IDENTITY.uid}`);
  await limiter.check('ip:198.51.100.42');

  const serialized = requestBodies.join('\n');
  assert.equal(serialized.includes(IDENTITY.uid), false);
  assert.equal(serialized.includes('198.51.100.42'), false);
  assert.match(serialized, /cirqle:provision:v1:[a-f0-9]{32}/);
});

test('preview and production provisioning fail closed without distributed limiting', async () => {
  for (const vercelEnv of ['preview', 'production']) {
    const unconfigured = createProvisioningRateLimiter({
      env: { VERCEL_ENV: vercelEnv },
      logger: QUIET_LOGGER,
    });
    await assert.rejects(
      unconfigured.check('uid:test'),
      (error) =>
        error instanceof DistributedRateLimitUnavailableError,
    );

    const unavailable = createProvisioningRateLimiter({
      env: {
        VERCEL_ENV: vercelEnv,
        UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
        UPSTASH_REDIS_REST_TOKEN: 'redis-test-token',
      },
      logger: QUIET_LOGGER,
      fetchImpl: async () =>
        new Response('', { status: 503 }),
    });
    await assert.rejects(
      unavailable.check('ip:198.51.100.42'),
      (error) =>
        error instanceof DistributedRateLimitUnavailableError,
    );
  }
});

test('AuthError remains a stable public authentication boundary', () => {
  const error = new AuthError();
  assert.equal(error.code, 'unauthorized');
  assert.equal(error.status, 401);
  assert.equal('stack' in JSON.parse(JSON.stringify(error)), false);
});

// LiteLLM's NewUserRequest/UpdateUserRequest restrict `user_role` to these
// four values. Anything else — `customer` included — is rejected by pydantic
// with a 422 before provisioning runs, which leaves every account without a
// virtual key and takes down /api/ai/chat and /api/ai/usage together. The
// fake clients below accept any payload, so assert the contract explicitly.
const LITELLM_ACCEPTED_USER_ROLES = Object.freeze([
  'proxy_admin',
  'proxy_admin_viewer',
  'internal_user',
  'internal_user_viewer',
]);

test('sends a user_role LiteLLM actually accepts on create and update', async () => {
  assert.ok(
    LITELLM_ACCEPTED_USER_ROLES.includes(MANAGED_USER_ROLE),
    `MANAGED_USER_ROLE must be one of ${LITELLM_ACCEPTED_USER_ROLES.join(', ')}`,
  );

  const apiKey = deriveManagedVirtualKey(
    IDENTITY.uid,
    ENV.LITELLM_KEY_DERIVATION_SECRET,
  );
  const observedRoles = [];
  const baseClient = {
    async listUserKeys() {
      return { keys: [] };
    },
    async deleteKeys() {},
    async getKey() {
      return null;
    },
    async createKey(payload) {
      return { key: payload.key };
    },
  };

  // A brand-new account goes through /user/new.
  await provisionLiteLLMIdentity({
    client: {
      ...baseClient,
      async getUser() {
        return null;
      },
      async createUser(payload) {
        observedRoles.push(payload.user_role);
      },
      async updateUser(payload) {
        observedRoles.push(payload.user_role);
      },
    },
    identity: IDENTITY,
    apiKey,
  });

  // An existing account goes through /user/update on every sign-in.
  await provisionLiteLLMIdentity({
    client: {
      ...baseClient,
      async getUser() {
        return { user_id: IDENTITY.uid };
      },
      async createUser(payload) {
        observedRoles.push(payload.user_role);
      },
      async updateUser(payload) {
        observedRoles.push(payload.user_role);
      },
    },
    identity: IDENTITY,
    apiKey,
  });

  assert.ok(observedRoles.length >= 2, 'both provisioning paths must run');
  for (const role of observedRoles) {
    assert.ok(
      LITELLM_ACCEPTED_USER_ROLES.includes(role),
      `LiteLLM rejects user_role "${role}" with a 422`,
    );
  }
});
