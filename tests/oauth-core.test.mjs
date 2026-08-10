import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  assertRedirectUriAllowed,
  createAuthorizationCode,
  getOAuthConfig,
  issueRefreshToken,
  normalizeRedirectUris,
  normalizeScope,
  redeemAuthorizationCode,
  registerClient,
  revokeAllRefreshTokens,
  rotateRefreshToken,
  signAccessToken,
  verifyAccessToken,
  verifyPkce,
} from '../server/api/_lib/oauth.js';

const ENV = {
  MCP_OAUTH_SIGNING_SECRET: 'a'.repeat(48),
  MCP_OAUTH_ISSUER: 'https://cirqle.test',
};
const NOW = new Date('2026-08-10T12:00:00.000Z');
const UID = 'oauth-owner';

function fakeDb() {
  const docs = new Map();
  const ref = (path) => ({
    path,
    async get() {
      const data = docs.get(path);
      return {
        exists: data !== undefined,
        ref: ref(path),
        data: () => (data === undefined ? undefined : { ...data }),
      };
    },
    async set(value) {
      docs.set(path, value);
    },
    async delete() {
      docs.delete(path);
    },
  });

  return {
    docs,
    doc: ref,
    collection: (base) => ({
      where: (field, _op, value) => ({
        limit: (max) => ({
          async get() {
            const hits = [...docs.entries()]
              .filter(([path, data]) => path.startsWith(`${base}/`) && data[field] === value)
              .slice(0, max);
            return {
              empty: hits.length === 0,
              size: hits.length,
              docs: hits.map(([path]) => ({ ref: ref(path) })),
            };
          },
        }),
      }),
    }),
    batch() {
      const ops = [];
      return {
        delete: (r) => ops.push(r.path),
        async commit() {
          for (const path of ops) docs.delete(path);
        },
      };
    },
    async runTransaction(fn) {
      return fn({
        get: (r) => r.get(),
        delete: (r) => docs.delete(r.path),
      });
    },
  };
}

function pkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return { verifier, challenge };
}

const config = getOAuthConfig(ENV);

test('refuses to run without a strong signing secret', () => {
  for (const env of [{}, { MCP_OAUTH_SIGNING_SECRET: 'short' }]) {
    assert.throws(
      () => getOAuthConfig(env),
      (error) => error.code === 'server_error' && error.status === 503,
      'a missing or weak secret must fail closed, never fall back to a default',
    );
  }
});

test('an access token round-trips and carries its audience', () => {
  const token = signAccessToken({
    config,
    uid: UID,
    clientId: 'client-1',
    scope: 'cirqle.read',
    now: NOW,
  });
  const claims = verifyAccessToken({ config, token, now: NOW });

  assert.equal(claims.sub, UID);
  assert.equal(claims.aud, 'https://cirqle.test/api/mcp');
  assert.equal(claims.iss, 'https://cirqle.test');
  assert.equal(claims.scope, 'cirqle.read');
});

// The MCP spec calls this mandatory: a token minted for somewhere else must not
// be usable here, or the server becomes a confused deputy.
test('rejects a token issued for a different resource', () => {
  const foreign = signAccessToken({
    config: { ...config, resource: 'https://elsewhere.test/api/mcp' },
    uid: UID,
    clientId: 'client-1',
    scope: 'cirqle.read',
    now: NOW,
  });
  assert.throws(
    () => verifyAccessToken({ config, token: foreign, now: NOW }),
    (error) => error.code === 'invalid_token' && error.status === 401,
  );
});

test('rejects tampered, expired, and foreign-issuer tokens', () => {
  const token = signAccessToken({
    config,
    uid: UID,
    clientId: 'client-1',
    scope: 'cirqle.read',
    now: NOW,
  });

  const [header, payload] = token.split('.');
  const forged = `${header}.${payload}.${'x'.repeat(43)}`;
  assert.throws(() => verifyAccessToken({ config, token: forged, now: NOW }));

  const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1_000);
  assert.throws(
    () => verifyAccessToken({ config, token, now: later }),
    (error) => /expired/i.test(error.message),
  );

  const otherIssuer = signAccessToken({
    config: { ...config, issuer: 'https://evil.test' },
    uid: UID,
    clientId: 'client-1',
    scope: 'cirqle.read',
    now: NOW,
  });
  assert.throws(() => verifyAccessToken({ config, token: otherIssuer, now: NOW }));

  assert.throws(() => verifyAccessToken({ config, token: 'not.a.jwt', now: NOW }));
});

test('PKCE accepts the matching verifier and nothing else', () => {
  const { verifier, challenge } = pkcePair();
  assert.doesNotThrow(() => verifyPkce({ verifier, challenge }));

  assert.throws(
    () => verifyPkce({ verifier: randomBytes(48).toString('base64url'), challenge }),
    (error) => error.code === 'invalid_grant',
  );
  // 'plain' would defeat the point of PKCE entirely.
  assert.throws(
    () => verifyPkce({ verifier, challenge, method: 'plain' }),
    (error) => error.code === 'invalid_grant',
  );
  assert.throws(() => verifyPkce({ verifier: 'tooshort', challenge }));
});

// Exact matching is the whole defence against open redirection.
test('redirect URIs must be HTTPS or loopback, and match exactly', () => {
  assert.deepEqual(
    normalizeRedirectUris(['https://claude.ai/api/mcp/auth_callback']),
    ['https://claude.ai/api/mcp/auth_callback'],
  );
  assert.equal(normalizeRedirectUris(['http://localhost:9000/cb']).length, 1);

  for (const bad of [
    ['http://evil.test/cb'],
    ['https://claude.ai/cb#fragment'],
    ['not-a-url'],
    [],
  ]) {
    assert.throws(
      () => normalizeRedirectUris(bad),
      (error) => error.code === 'invalid_redirect_uri',
      JSON.stringify(bad),
    );
  }

  const client = { redirectUris: ['https://claude.ai/cb'] };
  assert.equal(assertRedirectUriAllowed(client, 'https://claude.ai/cb'), 'https://claude.ai/cb');
  for (const attempt of [
    'https://claude.ai/cb/../evil',
    'https://claude.ai/cb?x=1',
    'https://claude.ai.evil.test/cb',
  ]) {
    assert.throws(
      () => assertRedirectUriAllowed(client, attempt),
      (error) => error.code === 'invalid_redirect_uri',
      attempt,
    );
  }
});

test('registration issues a public client with no secret', async () => {
  const db = fakeDb();
  const registered = await registerClient({
    db,
    body: {
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    },
    now: NOW,
  });

  assert.match(registered.client_id, /^cirqle-/);
  assert.equal(registered.token_endpoint_auth_method, 'none');
  assert.equal(registered.client_secret, undefined, 'public clients get no secret');
});

// An intercepted code must be worthless the moment the real client uses it.
test('an authorization code works once and only once', async () => {
  const db = fakeDb();
  const { verifier, challenge } = pkcePair();
  const code = await createAuthorizationCode({
    db,
    uid: UID,
    clientId: 'client-1',
    redirectUri: 'https://claude.ai/cb',
    codeChallenge: challenge,
    scope: 'cirqle.read',
    now: NOW,
  });

  const record = await redeemAuthorizationCode({
    db,
    code,
    clientId: 'client-1',
    redirectUri: 'https://claude.ai/cb',
    codeVerifier: verifier,
    now: NOW,
  });
  assert.equal(record.uid, UID);

  await assert.rejects(
    () =>
      redeemAuthorizationCode({
        db,
        code,
        clientId: 'client-1',
        redirectUri: 'https://claude.ai/cb',
        codeVerifier: verifier,
        now: NOW,
      }),
    (error) => error.code === 'invalid_grant',
    'replaying a code must fail',
  );
});

test('a code is refused when expired, replayed by another client, or PKCE fails', async () => {
  const attempts = [
    {
      name: 'expired',
      now: new Date(NOW.getTime() + 5 * 60 * 1_000),
      clientId: 'client-1',
      redirectUri: 'https://claude.ai/cb',
      useVerifier: true,
    },
    {
      name: 'different client',
      now: NOW,
      clientId: 'client-2',
      redirectUri: 'https://claude.ai/cb',
      useVerifier: true,
    },
    {
      name: 'different redirect',
      now: NOW,
      clientId: 'client-1',
      redirectUri: 'https://claude.ai/other',
      useVerifier: true,
    },
    {
      name: 'wrong verifier',
      now: NOW,
      clientId: 'client-1',
      redirectUri: 'https://claude.ai/cb',
      useVerifier: false,
    },
  ];

  for (const attempt of attempts) {
    const db = fakeDb();
    const { verifier, challenge } = pkcePair();
    const code = await createAuthorizationCode({
      db,
      uid: UID,
      clientId: 'client-1',
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: challenge,
      scope: 'cirqle.read',
      now: NOW,
    });

    await assert.rejects(
      () =>
        redeemAuthorizationCode({
          db,
          code,
          clientId: attempt.clientId,
          redirectUri: attempt.redirectUri,
          codeVerifier: attempt.useVerifier
            ? verifier
            : randomBytes(48).toString('base64url'),
          now: attempt.now,
        }),
      (error) => error.code === 'invalid_grant',
      attempt.name,
    );
  }
});

// OAuth 2.1 requires rotation for public clients: a stolen refresh token must
// stop working as soon as the real client refreshes.
test('refresh tokens rotate and the old one dies', async () => {
  const db = fakeDb();
  const first = await issueRefreshToken({
    db,
    uid: UID,
    clientId: 'client-1',
    scope: 'cirqle.read',
    now: NOW,
  });

  const record = await rotateRefreshToken({
    db,
    refreshToken: first,
    clientId: 'client-1',
    now: NOW,
  });
  assert.equal(record.uid, UID);

  await assert.rejects(
    () => rotateRefreshToken({ db, refreshToken: first, clientId: 'client-1', now: NOW }),
    (error) => error.code === 'invalid_grant',
  );
});

test('refresh tokens are stored hashed, never in the clear', async () => {
  const db = fakeDb();
  const token = await issueRefreshToken({
    db,
    uid: UID,
    clientId: 'client-1',
    scope: 'cirqle.read',
    now: NOW,
  });

  const serialized = JSON.stringify([...db.docs.entries()]);
  assert.ok(
    !serialized.includes(token),
    'a database dump must not hand over usable refresh tokens',
  );
});

// Revoking sessions has to stop connected agents too, or "sign out everywhere"
// quietly means "everywhere except the AI".
test('signing out everywhere drops every refresh token for the account', async () => {
  const db = fakeDb();
  for (let index = 0; index < 3; index += 1) {
    await issueRefreshToken({
      db,
      uid: UID,
      clientId: `client-${index}`,
      scope: 'cirqle.read',
      now: NOW,
    });
  }
  await issueRefreshToken({
    db,
    uid: 'someone-else',
    clientId: 'client-x',
    scope: 'cirqle.read',
    now: NOW,
  });

  const removed = await revokeAllRefreshTokens({ db, uid: UID });
  assert.equal(removed, 3);

  const survivors = [...db.docs.values()].filter((row) => row.uid);
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].uid, 'someone-else', 'other accounts are untouched');
});

test('scopes are filtered to what the server actually supports', () => {
  assert.equal(normalizeScope('cirqle.read'), 'cirqle.read');
  assert.equal(normalizeScope(''), 'cirqle.read cirqle.write');
  assert.equal(normalizeScope('cirqle.read admin.everything'), 'cirqle.read');
  assert.throws(
    () => normalizeScope('admin.everything'),
    (error) => error.code === 'invalid_scope',
  );
});
