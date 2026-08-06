import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createGoogleIntegrationHandlers,
  IntegrationRequestError,
  normalizeRecipient,
  normalizeSubject,
  normalizeThreadIds,
} from '../functions/integrations.js';
import { deleteOAuthIdentity } from '../server/api/_lib/account-admin.js';
import {
  openGoogleTokens,
  readGoogleTokenEncryptionKey,
  sealGoogleTokens,
} from '../server/api/_lib/google-token-envelope.js';

const ENV = Object.freeze({
  NODE_ENV: 'production',
  INTEGRATIONS_LIVE_ENABLED: 'true',
  INTEGRATIONS_APP_ORIGIN: 'https://cirqle.example',
  GOOGLE_CLIENT_ID: '123456.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'GOCSPX_test-secret-not-real',
  GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
});
const IDENTITY = Object.freeze({
  uid: 'verified-firebase-user',
  email: 'owner@example.com',
  emailVerified: true,
});
const NOW = new Date('2026-07-29T12:00:00.000Z');
const QUIET_LOGGER = Object.freeze({
  error() {},
  warn() {},
  info() {},
});

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function request({
  method = 'POST',
  body = {},
  query = {},
  origin = ENV.INTEGRATIONS_APP_ORIGIN,
  headers = {},
} = {}) {
  return {
    method,
    body,
    query,
    headers: {
      ...(origin ? { origin } : {}),
      'content-type': 'application/json',
      authorization: 'Bearer verified',
      ...headers,
    },
  };
}

function memoryRepository() {
  const states = new Map();
  const credentials = new Map();
  const statuses = new Map();
  const sentThreads = new Map();
  const gmailSends = new Map();
  const contacts = new Map();
  const outreaches = new Map();
  const threads = new Map();
  const key = (uid, provider) => `${uid}:${provider}`;
  return {
    states,
    credentials,
    statuses,
    sentThreads,
    gmailSends,
    contacts,
    outreaches,
    threads,
    deletedCredentials: [],
    async createState(hash, data) {
      if (states.has(hash)) throw new Error('collision');
      states.set(hash, structuredClone(data));
    },
    async consumeState(hash) {
      if (!states.has(hash)) {
        const error = new Error('oauth_state_invalid');
        error.code = 'oauth_state_invalid';
        error.status = 400;
        throw error;
      }
      const value = states.get(hash);
      states.delete(hash);
      return structuredClone(value);
    },
    async getCredential(uid, provider) {
      return structuredClone(credentials.get(key(uid, provider)) || null);
    },
    async setCredential(uid, provider, value) {
      credentials.set(key(uid, provider), {
        ...(credentials.get(key(uid, provider)) || {}),
        ...structuredClone(value),
      });
    },
    async deleteCredential(uid, provider) {
      credentials.delete(key(uid, provider));
      this.deletedCredentials.push(key(uid, provider));
    },
    async getAllCredentials(uid) {
      return Object.fromEntries(
        ['calendar', 'gmail'].map((provider) => [
          provider,
          structuredClone(credentials.get(key(uid, provider)) || null),
        ]),
      );
    },
    async deleteAllCredentials(uid) {
      for (const provider of ['calendar', 'gmail']) {
        credentials.delete(key(uid, provider));
        this.deletedCredentials.push(key(uid, provider));
      }
    },
    async setStatus(uid, provider, value) {
      statuses.set(key(uid, provider), {
        ...(statuses.get(key(uid, provider)) || {}),
        ...structuredClone(value),
      });
    },
    async recordSentThread(uid, value) {
      sentThreads.set(
        `${uid}:${value.threadId}`,
        structuredClone(value),
      );
    },
    async beginGmailSend(uid, value) {
      const receiptKey = `${uid}:${value.idempotencyKey}`;
      const existing = gmailSends.get(receiptKey);
      if (existing) {
        if (existing.requestDigest !== value.requestDigest) {
          throw new IntegrationRequestError('idempotency_conflict', 409);
        }
        if (existing.status === 'completed') {
          return {
            status: 'completed',
            threadId: existing.threadId,
            messageId: existing.messageId,
          };
        }
        throw new IntegrationRequestError('send_status_unknown', 409);
      }
      const outreachKey = `${uid}:${value.idempotencyKey}`;
      const outreach = outreaches.get(outreachKey);
      const contact = outreach
        ? contacts.get(`${uid}:${outreach.contactId}`)
        : null;
      if (
        !outreach ||
        outreach.userId !== uid ||
        outreach.subject !== value.subject ||
        outreach.body !== value.message ||
        outreach.status !== 'Drafted' ||
        outreach.verification !== 'none' ||
        outreach.threadId != null ||
        outreach.providerSendState != null ||
        !contact ||
        contact.purgeFence != null ||
        contact.mergedIntoId != null ||
        ['deleted', 'merged'].includes(contact.lifecycleStatus) ||
        String(contact.email || '').toLowerCase() !== value.to.toLowerCase()
      ) {
        throw new IntegrationRequestError('outreach_not_sendable', 409);
      }
      gmailSends.set(receiptKey, {
        ...structuredClone(value),
        outreachId: value.idempotencyKey,
        contactId: outreach.contactId,
        status: 'pending',
      });
      outreaches.set(outreachKey, {
        ...outreach,
        providerSendState: 'reserved',
        providerRequestDigest: value.requestDigest,
        providerReservationAt: value.createdAt,
        updatedAt: value.createdAt,
      });
      return { status: 'reserved' };
    },
    async completeGmailSend(uid, value) {
      const receiptKey = `${uid}:${value.idempotencyKey}`;
      const existing = gmailSends.get(receiptKey);
      const outreachKey = `${uid}:${value.idempotencyKey}`;
      const outreach = outreaches.get(outreachKey);
      if (
        !existing ||
        !outreach ||
        outreach.providerSendState !== 'reserved' ||
        outreach.providerRequestDigest !== value.requestDigest ||
        outreach.contactId !== existing.contactId
      ) {
        throw new IntegrationRequestError('send_status_unknown', 409);
      }
      gmailSends.set(receiptKey, {
        ...existing,
        ...structuredClone(value),
        status: 'completed',
      });
      sentThreads.set(`${uid}:${value.threadId}`, {
        threadId: value.threadId,
        messageId: value.messageId,
        sentAt: value.completedAt,
      });
      outreaches.set(outreachKey, {
        ...outreach,
        status: 'Sent (Provider Verified)',
        verification: 'provider-verified',
        responseReceived: 'No',
        threadId: value.threadId,
        provider: 'gmail',
        deliveryMode: 'provider',
        providerSendState: 'completed',
        providerMessageId: value.messageId,
        aiSummary:
          'Sent through the connected provider and verified by thread id.',
        sentAt: value.completedAt,
        providerVerifiedAt: value.completedAt,
        updatedAt: value.completedAt,
      });
      threads.set(`${uid}:${value.threadId}`, {
        userId: uid,
        threadId: value.threadId,
        contactId: existing.contactId,
        contactName: outreach.contactName || '',
        subject: outreach.subject,
        outreachId: value.idempotencyKey,
        status: 'sent',
        sentAt: value.completedAt,
        lastCheckedAt: value.completedAt,
        mode: 'live',
        providerVerified: true,
        createdAt: value.completedAt,
        updatedAt: value.completedAt,
      });
    },
    async recordGmailPoll(uid, value) {
      for (const [threadId, status] of Object.entries(value.statuses)) {
        const threadKey = `${uid}:${threadId}`;
        const thread = threads.get(threadKey);
        if (!thread) {
          throw new IntegrationRequestError('send_status_unknown', 409);
        }
        threads.set(threadKey, {
          ...thread,
          status,
          lastCheckedAt: value.checkedAt,
          updatedAt: value.checkedAt,
        });
      }
      statuses.set(`${uid}:gmail`, {
        ...(statuses.get(`${uid}:gmail`) || {}),
        provider: 'gmail',
        mode: 'live',
        connected: true,
        historyId: value.historyId,
        lastSyncedAt: value.checkedAt,
        updatedAt: value.checkedAt,
      });
    },
    async allowedSentThreadIds(uid, requestedThreadIds) {
      return requestedThreadIds.filter((threadId) =>
        sentThreads.has(`${uid}:${threadId}`),
      );
    },
  };
}

function seedGmailDraft(
  repository,
  {
    idempotencyKey,
    to,
    subject,
    body,
    contactId = `contact-${idempotencyKey}`,
  },
) {
  repository.contacts.set(`${IDENTITY.uid}:${contactId}`, {
    name: 'Provider recipient',
    email: to,
    lifecycleStatus: 'active',
  });
  repository.outreaches.set(`${IDENTITY.uid}:${idempotencyKey}`, {
    userId: IDENTITY.uid,
    contactId,
    contactName: 'Provider recipient',
    subject,
    body,
    status: 'Drafted',
    verification: 'none',
    threadId: null,
  });
}

function handlers({
  env = ENV,
  repository = memoryRepository(),
  fetchImpl = async () => {
    throw new Error('unexpected provider call');
  },
  verifyIdentity = async () => IDENTITY,
  logger = QUIET_LOGGER,
} = {}) {
  return {
    repository,
    api: createGoogleIntegrationHandlers({
      env,
      repository,
      fetchImpl,
      verifyIdentity,
      logger,
      now: () => new Date(NOW),
      randomBytesImpl(size) {
        return Buffer.alloc(size, size);
      },
      requestIdFactory: () => 'integration-test-request',
    }),
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('live integrations fail closed until every server setting is explicit', async () => {
  let verified = false;
  const { api } = handlers({
    env: {},
    verifyIdentity: async () => {
      verified = true;
      return IDENTITY;
    },
  });
  const res = responseRecorder();
  await api.oauthStart(request({ body: { provider: 'gmail' } }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error, 'integration_disabled');
  assert.equal(verified, false);
  assert.equal(res.headers['cache-control'], 'private, no-store, max-age=0');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('OAuth start requires a verified identity and rejects browser identity fields', async () => {
  const unverified = handlers({
    verifyIdentity: async () => ({
      uid: IDENTITY.uid,
      email: IDENTITY.email,
      emailVerified: false,
    }),
  });
  const unverifiedResponse = responseRecorder();
  await unverified.api.oauthStart(
    request({ body: { provider: 'gmail' } }),
    unverifiedResponse,
  );
  assert.equal(unverifiedResponse.statusCode, 403);
  assert.equal(
    unverifiedResponse.payload.error,
    'email_verification_required',
  );
  assert.equal(unverified.repository.states.size, 0);

  const injected = handlers();
  const injectedResponse = responseRecorder();
  await injected.api.oauthStart(
    request({
      body: { provider: 'gmail', uid: 'browser-selected-user' },
    }),
    injectedResponse,
  );
  assert.equal(injectedResponse.statusCode, 400);
  assert.equal(injectedResponse.payload.error, 'invalid_request');
  assert.equal(injected.repository.states.size, 0);
});

test('OAuth start binds opaque single-use state and PKCE to verified identity', async () => {
  const { api, repository } = handlers();
  const res = responseRecorder();
  await api.oauthStart(request({ body: { provider: 'gmail' } }), res);

  assert.equal(res.statusCode, 200);
  const authorization = new URL(res.payload.authorizationUrl);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.pathname, '/o/oauth2/v2/auth');
  assert.equal(
    authorization.searchParams.get('redirect_uri'),
    'https://cirqle.example/api/integrations/oauth/callback',
  );
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('login_hint'), IDENTITY.email);
  assert.equal(
    authorization.searchParams.get('prompt'),
    'select_account consent',
  );
  assert.deepEqual(
    new Set(authorization.searchParams.get('scope').split(' ')),
    new Set([
      'openid',
      'email',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.metadata',
    ]),
  );

  const state = authorization.searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{40,128}$/);
  assert.equal(state.includes(IDENTITY.uid), false);
  assert.equal(state.startsWith('{'), false);
  const hash = createHash('sha256').update(state).digest('hex');
  const saved = repository.states.get(hash);
  assert.equal(saved.uid, IDENTITY.uid);
  assert.equal(saved.provider, 'gmail');
  assert.equal(saved.redirectUri, ENV.INTEGRATIONS_APP_ORIGIN + '/api/integrations/oauth/callback');
  assert.equal(
    authorization.searchParams.get('code_challenge'),
    createHash('sha256').update(saved.codeVerifier, 'ascii').digest('base64url'),
  );
  assert.equal(
    saved.expiresAt.getTime() - saved.createdAt.getTime(),
    10 * 60 * 1000,
  );
});

test('OAuth callback consumes state once and trusts no callback identity field', async () => {
  const repository = memoryRepository();
  let tokenRequest = null;
  const { api } = handlers({
    repository,
    fetchImpl: async (url, init) => {
      if (
        String(url) ===
        'https://openidconnect.googleapis.com/v1/userinfo'
      ) {
        assert.equal(
          init.headers.Authorization,
          'Bearer access-token-private',
        );
        return jsonResponse({
          sub: 'google-subject-123',
          email: 'Chosen.Account@gmail.com',
          email_verified: true,
        });
      }
      assert.equal(String(url), 'https://oauth2.googleapis.com/token');
      tokenRequest = new URLSearchParams(init.body);
      return jsonResponse({
        access_token: 'access-token-private',
        refresh_token: 'refresh-token-private',
        expires_in: 3600,
        scope: [
          'openid',
          'email',
          'https://www.googleapis.com/auth/gmail.send',
          'https://www.googleapis.com/auth/gmail.metadata',
        ].join(' '),
      });
    },
  });
  const start = responseRecorder();
  await api.oauthStart(request({ body: { provider: 'gmail' } }), start);
  const state = new URL(start.payload.authorizationUrl).searchParams.get('state');
  const stateHash = createHash('sha256').update(state).digest('hex');
  const pending = structuredClone(repository.states.get(stateHash));

  const callback = responseRecorder();
  await api.oauthCallback(
    request({
      method: 'GET',
      origin: null,
      query: {
        code: 'google-code',
        state,
        uid: 'attacker-controlled-uid',
        provider: 'calendar',
      },
    }),
    callback,
  );
  assert.equal(callback.statusCode, 302);
  assert.equal(
    callback.headers.location,
    'https://cirqle.example/app/settings?connect=ok&provider=gmail',
  );
  assert.equal(tokenRequest.get('code_verifier'), pending.codeVerifier);
  assert.equal(
    tokenRequest.get('redirect_uri'),
    'https://cirqle.example/api/integrations/oauth/callback',
  );
  assert.equal(repository.states.has(stateHash), false);
  assert.equal(
    repository.credentials.has(`${IDENTITY.uid}:gmail`),
    true,
  );
  const storedCredential = repository.credentials.get(
    `${IDENTITY.uid}:gmail`,
  );
  assert.equal(storedCredential.accessToken, null);
  assert.equal(storedCredential.refreshToken, null);
  assert.ok(storedCredential.tokenEnvelope);
  assert.deepEqual(
    openGoogleTokens(storedCredential, {
      key: readGoogleTokenEncryptionKey(ENV),
      context: `${IDENTITY.uid}:gmail`,
    }),
    {
      accessToken: 'access-token-private',
      refreshToken: 'refresh-token-private',
      legacyPlaintext: false,
    },
  );
  assert.equal(
    repository.statuses.get(`${IDENTITY.uid}:gmail`).email,
    'chosen.account@gmail.com',
  );
  assert.equal(
    repository.credentials.has('attacker-controlled-uid:calendar'),
    false,
  );

  const replay = responseRecorder();
  await api.oauthCallback(
    request({
      method: 'GET',
      origin: null,
      query: { code: 'replayed-code', state },
    }),
    replay,
  );
  assert.equal(replay.statusCode, 302);
  assert.equal(
    replay.headers.location,
    'https://cirqle.example/app/settings?connect=error',
  );
});

test('expired OAuth state is consumed without contacting Google', async () => {
  const repository = memoryRepository();
  let contacted = false;
  const { api } = handlers({
    repository,
    fetchImpl: async () => {
      contacted = true;
    },
  });
  const start = responseRecorder();
  await api.oauthStart(request({ body: { provider: 'calendar' } }), start);
  const state = new URL(start.payload.authorizationUrl).searchParams.get('state');
  const hash = createHash('sha256').update(state).digest('hex');
  repository.states.get(hash).expiresAt = new Date(NOW.getTime() - 1);

  const callback = responseRecorder();
  await api.oauthCallback(
    request({
      method: 'GET',
      origin: null,
      query: { code: 'unused-code', state },
    }),
    callback,
  );
  assert.equal(callback.statusCode, 302);
  assert.equal(
    callback.headers.location,
    'https://cirqle.example/app/settings?connect=error&provider=calendar',
  );
  assert.equal(repository.states.has(hash), false);
  assert.equal(contacted, false);
});

test('authenticated endpoints reject cross-site requests before provider access', async () => {
  let verified = false;
  let contacted = false;
  const { api } = handlers({
    verifyIdentity: async () => {
      verified = true;
      return IDENTITY;
    },
    fetchImpl: async () => {
      contacted = true;
    },
  });
  const res = responseRecorder();
  await api.disconnect(
    request({
      origin: 'https://attacker.example',
      body: { provider: 'gmail' },
      headers: { 'sec-fetch-site': 'cross-site' },
    }),
    res,
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error, 'origin_not_allowed');
  assert.equal(verified, false);
  assert.equal(contacted, false);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('Gmail validation blocks header injection, oversized fields and bad thread ids', async () => {
  assert.throws(
    () => normalizeRecipient('safe@example.com\r\nBcc: victim@example.com'),
    /invalid_recipient/,
  );
  assert.throws(
    () => normalizeSubject('Hello\r\nX-Injected: yes'),
    /invalid_subject/,
  );
  assert.throws(
    () => normalizeSubject('x'.repeat(201)),
    /invalid_subject/,
  );
  assert.throws(
    () => normalizeThreadIds(['valid-thread', '../other-user']),
    /invalid_thread_ids/,
  );

  let contacted = false;
  const repository = memoryRepository();
  repository.credentials.set(`${IDENTITY.uid}:gmail`, {
    accessToken: 'server-access-token',
    accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000),
  });
  const { api } = handlers({
    repository,
    fetchImpl: async () => {
      contacted = true;
    },
  });
  const res = responseRecorder();
  await api.gmailSend(
    request({
      body: {
        to: 'safe@example.com\r\nBcc: victim@example.com',
        subject: 'Hello',
        body: 'Body',
      },
    }),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'invalid_recipient');
  assert.equal(contacted, false);
});

test('Gmail refuses an invented or browser-altered outreach before provider access', async () => {
  const repository = memoryRepository();
  repository.credentials.set(`${IDENTITY.uid}:gmail`, {
    accessToken: 'server-access-token',
    accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000),
  });
  let providerCalls = 0;
  const { api } = handlers({
    repository,
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({ threadId: 'should_not_send', id: 'not_sent' });
    },
  });
  const body = {
    to: 'person@example.com',
    subject: 'Changed in a modified browser',
    body: 'This does not match the saved draft.',
    idempotencyKey: 'outreach_untrusted_12345',
  };
  seedGmailDraft(repository, {
    ...body,
    subject: 'The actual saved subject',
  });

  const response = responseRecorder();
  await api.gmailSend(request({ body }), response);

  assert.equal(response.statusCode, 409);
  assert.equal(response.payload.error, 'outreach_not_sendable');
  assert.equal(providerCalls, 0);
  assert.equal(
    repository.gmailSends.has(
      `${IDENTITY.uid}:outreach_untrusted_12345`,
    ),
    false,
  );
});

test('Gmail sends only normalized MIME and returns bounded provider ids', async () => {
  const repository = memoryRepository();
  repository.credentials.set(`${IDENTITY.uid}:gmail`, {
    accessToken: 'server-access-token',
    accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000),
  });
  seedGmailDraft(repository, {
    idempotencyKey: 'outreach_record_12345',
    to: 'person@example.com',
    subject: 'A safe subject',
    body: 'Hello there.',
  });
  let rawMime = null;
  const { api } = handlers({
    repository,
    fetchImpl: async (url, init) => {
      assert.equal(
        String(url),
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      );
      assert.equal(init.headers.Authorization, 'Bearer server-access-token');
      rawMime = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString(
        'utf8',
      );
      return jsonResponse({ threadId: 'thread_123', id: 'message_456' });
    },
  });
  const res = responseRecorder();
  await api.gmailSend(
    request({
      body: {
        to: 'person@example.com',
        subject: 'A safe subject',
        body: 'Hello there.',
        idempotencyKey: 'outreach_record_12345',
      },
    }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    threadId: 'thread_123',
    messageId: 'message_456',
    replayed: false,
    recorded: true,
  });
  assert.match(rawMime, /^To: person@example\.com\r\n/);
  assert.doesNotMatch(rawMime, /server-access-token/);
  assert.deepEqual(
    repository.sentThreads.get(`${IDENTITY.uid}:thread_123`),
    {
      threadId: 'thread_123',
      messageId: 'message_456',
      sentAt: NOW,
    },
  );
  assert.equal(
    repository.outreaches.get(
      `${IDENTITY.uid}:outreach_record_12345`,
    ).verification,
    'provider-verified',
  );
  assert.equal(
    repository.threads.get(`${IDENTITY.uid}:thread_123`).providerVerified,
    true,
  );
});

test('Gmail send receipts replay one provider result without sending twice', async () => {
  const repository = memoryRepository();
  repository.credentials.set(`${IDENTITY.uid}:gmail`, {
    accessToken: 'server-access-token',
    accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000),
  });
  let providerCalls = 0;
  const { api } = handlers({
    repository,
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({ threadId: 'thread_once', id: 'message_once' });
    },
  });
  const body = {
    to: 'person@example.com',
    subject: 'Send once',
    body: 'A retry must not duplicate this message.',
    idempotencyKey: 'outreach_record_once_123',
  };
  seedGmailDraft(repository, body);
  const first = responseRecorder();
  const replay = responseRecorder();

  await api.gmailSend(request({ body }), first);
  await api.gmailSend(request({ body }), replay);

  assert.equal(providerCalls, 1);
  assert.deepEqual(first.payload, {
    threadId: 'thread_once',
    messageId: 'message_once',
    replayed: false,
    recorded: true,
  });
  assert.deepEqual(replay.payload, {
    threadId: 'thread_once',
    messageId: 'message_once',
    replayed: true,
    recorded: true,
  });
});

test('Gmail idempotency keys cannot be reused for different content', async () => {
  const repository = memoryRepository();
  repository.credentials.set(`${IDENTITY.uid}:gmail`, {
    accessToken: 'server-access-token',
    accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000),
  });
  let providerCalls = 0;
  const { api } = handlers({
    repository,
    fetchImpl: async () => {
      providerCalls += 1;
      return jsonResponse({ threadId: 'thread_original', id: 'message_original' });
    },
  });
  const base = {
    to: 'person@example.com',
    subject: 'Original',
    body: 'Original body.',
    idempotencyKey: 'outreach_conflict_12345',
  };
  seedGmailDraft(repository, base);
  await api.gmailSend(request({ body: base }), responseRecorder());
  const conflict = responseRecorder();
  await api.gmailSend(
    request({ body: { ...base, subject: 'Changed after send' } }),
    conflict,
  );

  assert.equal(providerCalls, 1);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.payload.error, 'idempotency_conflict');
});

test('Gmail polling rejects caller-invented thread ids before Google access', async () => {
  const repository = memoryRepository();
  repository.credentials.set(`${IDENTITY.uid}:gmail`, {
    accessToken: 'server-access-token',
    accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000),
  });
  repository.sentThreads.set(
    `${IDENTITY.uid}:cirqle-sent-thread`,
    {
      threadId: 'cirqle-sent-thread',
      messageId: 'message-1',
      sentAt: NOW,
    },
  );
  let contacted = false;
  const { api } = handlers({
    repository,
    fetchImpl: async () => {
      contacted = true;
      throw new Error('must not contact Google');
    },
  });
  const res = responseRecorder();
  await api.gmailPoll(
    request({
      body: {
        threadIds: ['cirqle-sent-thread', 'caller-invented-thread'],
      },
    }),
    res,
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error, 'untrusted_thread_ids');
  assert.equal(contacted, false);
});

test('Gmail polling records live thread status and cursor on the server', async () => {
  const repository = memoryRepository();
  repository.credentials.set(`${IDENTITY.uid}:gmail`, {
    accessToken: 'server-access-token',
    accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000),
  });
  repository.sentThreads.set(`${IDENTITY.uid}:thread_polled`, {
    threadId: 'thread_polled',
    messageId: 'message-original',
    sentAt: NOW,
  });
  repository.threads.set(`${IDENTITY.uid}:thread_polled`, {
    userId: IDENTITY.uid,
    threadId: 'thread_polled',
    contactId: 'contact-1',
    status: 'sent',
    mode: 'live',
  });
  const { api } = handlers({
    repository,
    fetchImpl: async (url) => {
      if (String(url).includes('/threads/thread_polled')) {
        return jsonResponse({
          messages: [
            { id: 'message-original', labelIds: ['SENT'] },
            { id: 'message-reply', labelIds: ['INBOX'] },
          ],
        });
      }
      if (String(url).endsWith('/profile')) {
        return jsonResponse({ historyId: '987654321' });
      }
      throw new Error(`Unexpected Gmail URL: ${url}`);
    },
  });

  const response = responseRecorder();
  await api.gmailPoll(
    request({ body: { threadIds: ['thread_polled'] } }),
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    statuses: { thread_polled: 'replied' },
    historyId: '987654321',
  });
  assert.equal(
    repository.threads.get(`${IDENTITY.uid}:thread_polled`).status,
    'replied',
  );
  assert.equal(
    repository.statuses.get(`${IDENTITY.uid}:gmail`).historyId,
    '987654321',
  );
});

test('disconnect revokes the shared Google grant and clears both provider states', async () => {
  const repository = memoryRepository();
  repository.credentials.set(`${IDENTITY.uid}:gmail`, {
    refreshToken: 'refresh-token-private',
  });
  repository.credentials.set(`${IDENTITY.uid}:calendar`, {
    accessToken: 'calendar-token-private',
  });
  const revoked = [];
  const { api } = handlers({
    repository,
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'https://oauth2.googleapis.com/revoke');
      revoked.push(new URLSearchParams(init.body).get('token'));
      return new Response('', { status: 200 });
    },
  });
  const res = responseRecorder();
  await api.disconnect(request({ body: { provider: 'gmail' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { disconnected: true });
  assert.deepEqual(
    new Set(revoked),
    new Set(['refresh-token-private', 'calendar-token-private']),
  );
  assert.equal(repository.credentials.has(`${IDENTITY.uid}:gmail`), false);
  assert.equal(repository.credentials.has(`${IDENTITY.uid}:calendar`), false);
  assert.equal(JSON.stringify(res.payload).includes('refresh-token-private'), false);
  assert.equal(
    repository.statuses.get(`${IDENTITY.uid}:gmail`).connected,
    false,
  );
  assert.equal(
    repository.statuses.get(`${IDENTITY.uid}:calendar`).connected,
    false,
  );
});

test('provider failures are sanitized and preserve credentials for retry', async () => {
  const repository = memoryRepository();
  repository.credentials.set(`${IDENTITY.uid}:gmail`, {
    refreshToken: 'refresh-token-private',
  });
  const logs = [];
  const { api } = handlers({
    repository,
    logger: {
      error(event, details) {
        logs.push({ event, details });
      },
      warn(event, details) {
        logs.push({ event, details });
      },
    },
    fetchImpl: async () =>
      jsonResponse(
        {
          error: 'server_error',
          error_description:
            'raw provider secret refresh-token-private owner@example.com',
        },
        500,
      ),
  });
  const res = responseRecorder();
  await api.disconnect(request({ body: { provider: 'gmail' } }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.payload.error, 'provider_unavailable');
  assert.equal(repository.credentials.has(`${IDENTITY.uid}:gmail`), true);
  const serialized = JSON.stringify({ payload: res.payload, logs });
  assert.doesNotMatch(serialized, /refresh-token-private/);
  assert.doesNotMatch(serialized, /owner@example\.com/);
  assert.doesNotMatch(serialized, /raw provider secret/);
  assert.match(serialized, /"providerStatus":500/);
});

test('token envelopes are bound to their owner/provider and reject tampering', () => {
  const key = readGoogleTokenEncryptionKey(ENV);
  const envelope = sealGoogleTokens(
    {
      accessToken: 'access-token-private',
      refreshToken: 'refresh-token-private',
    },
    {
      key,
      context: `${IDENTITY.uid}:gmail`,
      randomBytesImpl: () => Buffer.alloc(12, 3),
    },
  );
  assert.deepEqual(
    openGoogleTokens(
      { tokenEnvelope: envelope },
      { key, context: `${IDENTITY.uid}:gmail` },
    ),
    {
      accessToken: 'access-token-private',
      refreshToken: 'refresh-token-private',
      legacyPlaintext: false,
    },
  );
  assert.throws(
    () =>
      openGoogleTokens(
        { tokenEnvelope: envelope },
        { key, context: `${IDENTITY.uid}:calendar` },
      ),
    /credential envelope is unavailable/i,
  );
  const tampered = {
    ...envelope,
    ciphertext:
      envelope.ciphertext.slice(0, -1) +
      (envelope.ciphertext.endsWith('A') ? 'B' : 'A'),
  };
  assert.throws(
    () =>
      openGoogleTokens(
        { tokenEnvelope: tampered },
        { key, context: `${IDENTITY.uid}:gmail` },
      ),
    /credential envelope is unavailable/i,
  );
});

test('account deletion revokes encrypted and legacy provider credentials before recursive deletion', async () => {
  const calls = [];
  const encryptedGmail = sealGoogleTokens(
    {
      accessToken: 'gmail-access-token',
      refreshToken: 'gmail-provider-token',
    },
    {
      key: readGoogleTokenEncryptionKey(ENV),
      context: `${IDENTITY.uid}:gmail`,
      randomBytesImpl: () => Buffer.alloc(12, 5),
    },
  );
  const rootRef = {
    async get() {
      return {
        exists: true,
        data: () => ({ refreshToken: 'legacy-root-token' }),
      };
    },
    collection(name) {
      assert.equal(name, 'providers');
      return {
        async get() {
          return {
            empty: false,
            docs: [
              {
                id: 'gmail',
                data: () => ({
                  tokenEnvelope: encryptedGmail,
                  accessToken: null,
                  refreshToken: null,
                }),
              },
              {
                id: 'calendar',
                data: () => ({ accessToken: 'calendar-provider-token' }),
              },
            ],
          };
        },
      };
    },
  };
  const db = {
    doc(path) {
      assert.equal(path, `oauthTokens/${IDENTITY.uid}`);
      return rootRef;
    },
    async recursiveDelete(ref) {
      assert.equal(ref, rootRef);
      calls.push('recursive-delete');
    },
  };

  await deleteOAuthIdentity({
    db,
    uid: IDENTITY.uid,
    env: ENV,
    fetchImpl: async (_url, init) => {
      calls.push(new URLSearchParams(init.body).get('token'));
      return new Response('', { status: 200 });
    },
  });

  assert.deepEqual(calls, [
    'legacy-root-token',
    'gmail-provider-token',
    'calendar-provider-token',
    'recursive-delete',
  ]);
});

test('source wiring has no legacy browser state or duplicate Firebase callback', async () => {
  const [
    statusSource,
    functionsIndex,
    functionSource,
    firebaseAuthSource,
    rules,
  ] = await Promise.all([
    readFile(new URL('../src/lib/integrations/status.ts', import.meta.url), 'utf8'),
    readFile(new URL('../functions/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../functions/integrations.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/api/_lib/firebase-admin.js', import.meta.url), 'utf8'),
    readFile(new URL('../firestore.rules', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(statusSource, /JSON\.stringify\(\{\s*uid/);
  assert.doesNotMatch(statusSource, /VITE_GOOGLE_CLIENT_ID/);
  assert.doesNotMatch(functionsIndex, /export\s+\{\s*oauthCallback/);
  assert.doesNotMatch(
    functionsIndex,
    /console\.(?:warn|error)\(`[^`]*\$\{(?:cardId|captureId|ownerUid)\}/,
  );
  assert.doesNotMatch(
    functionsIndex,
    /console\.(?:warn|error)\([^,\n]+,\s*error\s*\)/,
  );
  assert.match(functionsIndex, /opaqueLogRef\(captureId\)/);
  assert.match(functionsIndex, /stableErrorCode\(error\)/);
  assert.doesNotMatch(functionSource, /verifyIdToken\([^,)]*\)/);
  assert.match(firebaseAuthSource, /verifyIdToken\(token, true\)/);
  assert.match(functionSource, /code_challenge_method', 'S256'/);
  assert.match(functionSource, /consumeState/);
  assert.match(rules, /match \/_oauthStates\/\{stateId\}/);
  assert.match(rules, /match \/\{credentialDocument=\*\*\}/);
});
