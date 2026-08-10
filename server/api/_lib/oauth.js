import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * OAuth 2.1 authorization server for the MCP endpoint.
 *
 * Cirqle is both the resource server (/api/mcp) and the authorization server.
 * The MCP specification requires PKCE, exact redirect-URI matching, dynamic
 * client registration, resource indicators (RFC 8707), and audience-validated
 * tokens; each of those is implemented here rather than assumed.
 *
 * Identity still comes from Firebase. The consent screen is the existing login,
 * so this module never sees a password and no new credential surface exists —
 * it only converts an already-authenticated Firebase session into a token
 * scoped to this MCP server.
 *
 * Access tokens are self-contained HS256 JWTs so /api/mcp can verify one
 * without a database read on every call. Refresh tokens are opaque, stored
 * hashed, single-use, and rotated, because they are long-lived and a leaked
 * one is worth far more.
 */

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

export const SUPPORTED_SCOPES = Object.freeze(['cirqle.read', 'cirqle.write']);
export const DEFAULT_SCOPE = SUPPORTED_SCOPES.join(' ');

const CLIENTS = '_oauthClients';
const CODES = '_oauthCodes';
const REFRESH = '_oauthTokens';

const MAX_REDIRECT_URIS = 8;
const MAX_CLIENT_NAME = 120;

export class OAuthError extends Error {
  constructor({
    code = 'invalid_request',
    message = 'The request is invalid.',
    status = 400,
  } = {}) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}

function oauthError(code, message, status = 400) {
  return new OAuthError({ code, message, status });
}

/**
 * No default and no fallback, matching litellm-config.js. A signing secret that
 * silently defaults would let a preview deployment mint tokens accepted by
 * production.
 */
export function getOAuthConfig(env = process.env) {
  const secret = env?.MCP_OAUTH_SIGNING_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw oauthError(
      'server_error',
      'OAuth is not configured.',
      503,
    );
  }
  const issuer = (env?.MCP_OAUTH_ISSUER || 'https://cirqle-taupe.vercel.app')
    .trim()
    .replace(/\/+$/, '');
  return {
    secret,
    issuer,
    // The canonical resource identifier clients must request a token for, and
    // the audience every token is bound to.
    resource: `${issuer}/api/mcp`,
  };
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hashToken(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// --- access tokens ---------------------------------------------------------

export function signAccessToken({
  config,
  uid,
  clientId,
  scope,
  now = new Date(),
  ttlSeconds = ACCESS_TOKEN_TTL_SECONDS,
}) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: config.issuer,
      sub: uid,
      // RFC 8707: the token is only valid at this resource. /api/mcp rejects
      // anything with a different audience, which is what stops a token minted
      // for somewhere else being replayed here.
      aud: config.resource,
      client_id: clientId,
      scope,
      iat: issuedAt,
      exp: issuedAt + ttlSeconds,
      jti: randomBytes(16).toString('hex'),
    }),
  );
  const signature = createHmac('sha256', config.secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifyAccessToken({ config, token, now = new Date() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    throw oauthError('invalid_token', 'Malformed access token.', 401);
  }
  const [header, payload, signature] = parts;
  const expected = createHmac('sha256', config.secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  if (!safeEqual(signature, expected)) {
    throw oauthError('invalid_token', 'Token signature is invalid.', 401);
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw oauthError('invalid_token', 'Token payload is unreadable.', 401);
  }

  const seconds = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp <= seconds) {
    throw oauthError('invalid_token', 'Token has expired.', 401);
  }
  if (claims.iss !== config.issuer) {
    throw oauthError('invalid_token', 'Token issuer is not recognised.', 401);
  }
  // The audience check the MCP spec calls mandatory.
  if (claims.aud !== config.resource) {
    throw oauthError(
      'invalid_token',
      'Token was not issued for this server.',
      401,
    );
  }
  if (typeof claims.sub !== 'string' || !claims.sub) {
    throw oauthError('invalid_token', 'Token has no subject.', 401);
  }
  return claims;
}

// --- PKCE ------------------------------------------------------------------

export function verifyPkce({ verifier, challenge, method = 'S256' }) {
  if (method !== 'S256') {
    throw oauthError(
      'invalid_grant',
      'Only the S256 code challenge method is supported.',
    );
  }
  const candidate = String(verifier || '');
  if (candidate.length < 43 || candidate.length > 128) {
    throw oauthError('invalid_grant', 'The code verifier is malformed.');
  }
  const computed = createHash('sha256').update(candidate, 'utf8').digest('base64url');
  if (!safeEqual(computed, String(challenge || ''))) {
    throw oauthError('invalid_grant', 'The code verifier does not match.');
  }
}

// --- clients ---------------------------------------------------------------

/**
 * Redirect URIs are matched exactly at authorize time, so what is accepted here
 * is the entire trust boundary against open redirection. Only HTTPS and
 * loopback are allowed, per OAuth 2.1.
 */
export function normalizeRedirectUris(value) {
  const list = Array.isArray(value) ? value : [];
  if (list.length === 0 || list.length > MAX_REDIRECT_URIS) {
    throw oauthError(
      'invalid_redirect_uri',
      'Register between 1 and 8 redirect URIs.',
    );
  }
  const uris = [];
  for (const candidate of list) {
    let url;
    try {
      url = new URL(String(candidate));
    } catch {
      throw oauthError('invalid_redirect_uri', 'Redirect URI is not a URL.');
    }
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw oauthError(
        'invalid_redirect_uri',
        'Redirect URIs must use HTTPS, or HTTP only on loopback.',
      );
    }
    if (url.hash) {
      throw oauthError(
        'invalid_redirect_uri',
        'Redirect URIs must not contain a fragment.',
      );
    }
    uris.push(url.toString());
  }
  return [...new Set(uris)];
}

export async function registerClient({ db, body, now = new Date() }) {
  const redirectUris = normalizeRedirectUris(body?.redirect_uris);
  const clientName = String(body?.client_name || 'MCP client')
    .normalize('NFKC')
    .trim()
    .slice(0, MAX_CLIENT_NAME) || 'MCP client';

  const clientId = `cirqle-${randomBytes(16).toString('hex')}`;
  await db.doc(`${CLIENTS}/${clientId}`).set({
    clientId,
    clientName,
    redirectUris,
    // Public client: no secret is issued, which is why PKCE is mandatory and
    // refresh tokens are rotated on every use.
    tokenEndpointAuthMethod: 'none',
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    scope: DEFAULT_SCOPE,
    createdAt: now,
  });

  return {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: DEFAULT_SCOPE,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
  };
}

export async function getClient({ db, clientId }) {
  const id = String(clientId || '').trim();
  if (!id || id.includes('/') || id.length > 200) {
    throw oauthError('invalid_client', 'Unknown client.', 401);
  }
  const snapshot = await db.doc(`${CLIENTS}/${id}`).get();
  if (!snapshot.exists) {
    throw oauthError('invalid_client', 'Unknown client.', 401);
  }
  return snapshot.data();
}

export function assertRedirectUriAllowed(client, redirectUri) {
  const candidate = String(redirectUri || '');
  // Exact string comparison, as OAuth 2.1 requires. Prefix or origin matching
  // is how open-redirect bugs get in.
  if (!(client.redirectUris || []).includes(candidate)) {
    throw oauthError(
      'invalid_redirect_uri',
      'That redirect URI is not registered for this client.',
    );
  }
  return candidate;
}

export function normalizeScope(requested) {
  const asked = String(requested || '')
    .split(/\s+/)
    .filter(Boolean);
  if (asked.length === 0) return DEFAULT_SCOPE;
  const granted = asked.filter((scope) => SUPPORTED_SCOPES.includes(scope));
  if (granted.length === 0) {
    throw oauthError('invalid_scope', 'No supported scopes were requested.');
  }
  return granted.join(' ');
}

// --- authorization codes ---------------------------------------------------

export async function createAuthorizationCode({
  db,
  uid,
  clientId,
  redirectUri,
  codeChallenge,
  codeChallengeMethod = 'S256',
  scope,
  resource,
  now = new Date(),
}) {
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    throw oauthError(
      'invalid_request',
      'A S256 code_challenge is required.',
    );
  }
  const code = randomBytes(32).toString('base64url');
  await db.doc(`${CODES}/${hashToken(code)}`).set({
    uid,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope,
    resource: resource || null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1_000),
  });
  return code;
}

/**
 * Redeem once, then delete.
 *
 * The delete happens inside the transaction that reads it, so two simultaneous
 * redemptions cannot both succeed — an intercepted code is worthless the moment
 * the legitimate client uses it.
 */
export async function redeemAuthorizationCode({
  db,
  code,
  clientId,
  redirectUri,
  codeVerifier,
  now = new Date(),
}) {
  const ref = db.doc(`${CODES}/${hashToken(code)}`);
  const record = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      throw oauthError('invalid_grant', 'That authorization code is not valid.');
    }
    const data = snapshot.data();
    transaction.delete(ref);
    return data;
  });

  const expiresAt =
    typeof record.expiresAt?.toDate === 'function'
      ? record.expiresAt.toDate()
      : new Date(record.expiresAt);
  if (!(expiresAt instanceof Date) || expiresAt.getTime() <= now.getTime()) {
    throw oauthError('invalid_grant', 'That authorization code has expired.');
  }
  if (record.clientId !== clientId) {
    throw oauthError('invalid_grant', 'That code belongs to another client.');
  }
  if (record.redirectUri !== redirectUri) {
    throw oauthError('invalid_grant', 'The redirect URI does not match.');
  }
  verifyPkce({
    verifier: codeVerifier,
    challenge: record.codeChallenge,
    method: record.codeChallengeMethod,
  });
  return record;
}

// --- refresh tokens --------------------------------------------------------

export async function issueRefreshToken({
  db,
  uid,
  clientId,
  scope,
  now = new Date(),
}) {
  const token = randomBytes(32).toString('base64url');
  await db.doc(`${REFRESH}/${hashToken(token)}`).set({
    uid,
    clientId,
    scope,
    createdAt: now,
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1_000),
  });
  return token;
}

/**
 * Rotate on every use, as OAuth 2.1 requires for public clients: the presented
 * token is destroyed and a new one issued, so a stolen refresh token stops
 * working as soon as the real client refreshes.
 */
export async function rotateRefreshToken({
  db,
  refreshToken,
  clientId,
  now = new Date(),
}) {
  const ref = db.doc(`${REFRESH}/${hashToken(refreshToken)}`);
  const record = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      throw oauthError('invalid_grant', 'That refresh token is not valid.');
    }
    const data = snapshot.data();
    transaction.delete(ref);
    return data;
  });

  const expiresAt =
    typeof record.expiresAt?.toDate === 'function'
      ? record.expiresAt.toDate()
      : new Date(record.expiresAt);
  if (!(expiresAt instanceof Date) || expiresAt.getTime() <= now.getTime()) {
    throw oauthError('invalid_grant', 'That refresh token has expired.');
  }
  if (record.clientId !== clientId) {
    throw oauthError('invalid_grant', 'That token belongs to another client.');
  }
  return record;
}

/**
 * Drop every refresh token for an account.
 *
 * Called from "Sign out everywhere" and from account deletion. Without it a
 * connected agent would keep working after the owner revoked their sessions,
 * which is precisely when they expect it to stop.
 */
export async function revokeAllRefreshTokens({ db, uid, batchSize = 300 }) {
  let removed = 0;
  for (;;) {
    const page = await db
      .collection(REFRESH)
      .where('uid', '==', uid)
      .limit(batchSize)
      .get();
    if (page.empty) break;
    const batch = db.batch();
    for (const document of page.docs) batch.delete(document.ref);
    await batch.commit();
    removed += page.size;
    if (page.size < batchSize) break;
  }
  return removed;
}

export const OAUTH_COLLECTIONS = Object.freeze({
  clients: CLIENTS,
  codes: CODES,
  refreshTokens: REFRESH,
});
