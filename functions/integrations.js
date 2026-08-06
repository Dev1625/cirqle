import {
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  openGoogleTokens,
  readGoogleTokenEncryptionKey,
  sealGoogleTokens,
} from '../server/api/_lib/google-token-envelope.js';
import {
  createProvisioningRateLimiter,
  ProvisioningRateLimitError,
} from '../server/api/_lib/rate-limit.js';

/**
 * Shared server implementation for the Vercel Google integration routes.
 *
 * This module intentionally has no firebase-functions dependency. Vercel API
 * routes inject Firebase Admin authentication and Firestore services, while
 * Firebase no longer exports the legacy OAuth HTTP functions. Keeping one
 * implementation prevents an older, less-protected callback from remaining
 * reachable after the Vercel routes are deployed.
 */

const GOOGLE_AUTHORIZATION_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_USERINFO_URL =
  'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_CALENDAR_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const GOOGLE_GMAIL_BASE =
  'https://gmail.googleapis.com/gmail/v1/users/me';

const OAUTH_STATE_COLLECTION = '_oauthStates';
const OAUTH_TOKEN_COLLECTION = 'oauthTokens';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const PROVIDERS = new Set(['calendar', 'gmail']);
const THREAD_ID = /^[A-Za-z0-9_-]{1,200}$/;
const HISTORY_ID = /^[0-9]{1,40}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const OPAQUE_STATE = /^[A-Za-z0-9_-]{40,128}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const SAFE_EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const GOOGLE_INTEGRATION_SCOPES = Object.freeze({
  calendar: Object.freeze([
    'https://www.googleapis.com/auth/calendar.events.readonly',
  ]),
  gmail: Object.freeze([
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.metadata',
  ]),
});
const GOOGLE_IDENTITY_SCOPES = Object.freeze(['openid', 'email']);
const REVIEWED_GOOGLE_SCOPES = new Set(
  [
    ...GOOGLE_IDENTITY_SCOPES,
    ...Object.values(GOOGLE_INTEGRATION_SCOPES).flat(),
  ],
);
const GOOGLE_SCOPE_ALIASES = Object.freeze({
  'https://www.googleapis.com/auth/userinfo.email': 'email',
});

function validateGrantedScopes(value, provider) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4096
  ) {
    throw new IntegrationRequestError('oauth_scope_invalid', 400);
  }
  const scopes = [
    ...new Set(
      value
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((scope) => GOOGLE_SCOPE_ALIASES[scope] || scope),
    ),
  ];
  const expected = [
    ...GOOGLE_IDENTITY_SCOPES,
    ...GOOGLE_INTEGRATION_SCOPES[provider],
  ];
  if (
    expected.some((scope) => !scopes.includes(scope)) ||
    scopes.some((scope) => !REVIEWED_GOOGLE_SCOPES.has(scope))
  ) {
    throw new IntegrationRequestError('oauth_scope_invalid', 400);
  }
  return scopes.sort().join(' ');
}

export class IntegrationRequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'IntegrationRequestError';
    this.code = code;
    this.status = status;
  }
}

class GoogleProviderError extends IntegrationRequestError {
  constructor({
    providerCode = 'provider_error',
    providerStatus = 0,
    code = 'provider_unavailable',
    status = 502,
  } = {}) {
    super(code, status);
    this.name = 'GoogleProviderError';
    this.providerCode = providerCode;
    this.providerStatus = Number(providerStatus) || 0;
  }
}

function readHeader(req, name) {
  if (typeof req?.get === 'function') {
    return req.get(name) || req.get(name.toLowerCase()) || undefined;
  }
  const headers = req?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  }
  const lower = name.toLowerCase();
  const value =
    headers[lower] ??
    headers[name] ??
    Object.entries(headers).find(
      ([candidate]) => candidate.toLowerCase() === lower,
    )?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function queryValue(req, name) {
  const value = req?.query?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function canonicalOrigin(value, { allowLocalhost = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new IntegrationRequestError('integration_not_configured', 503);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new IntegrationRequestError('integration_not_configured', 503);
  }
  const local =
    allowLocalhost &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new IntegrationRequestError('integration_not_configured', 503);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== '/')
  ) {
    throw new IntegrationRequestError('integration_not_configured', 503);
  }
  return url.origin;
}

export function readGoogleIntegrationConfig(env = process.env) {
  if (env.INTEGRATIONS_LIVE_ENABLED !== 'true') {
    throw new IntegrationRequestError('integration_disabled', 503);
  }

  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (
    !clientId ||
    !clientId.endsWith('.apps.googleusercontent.com') ||
    !clientSecret ||
    clientSecret.length < 12
  ) {
    throw new IntegrationRequestError('integration_not_configured', 503);
  }

  const appOrigin = canonicalOrigin(env.INTEGRATIONS_APP_ORIGIN, {
    allowLocalhost:
      env.NODE_ENV !== 'production' &&
      env.INTEGRATIONS_ALLOW_LOCALHOST === 'true',
  });

  return Object.freeze({
    clientId,
    clientSecret,
    appOrigin,
    callbackUrl: `${appOrigin}/api/integrations/oauth/callback`,
    testMode: env.GOOGLE_OAUTH_TEST_MODE === 'true',
    tokenEncryptionKey: readGoogleTokenEncryptionKey(env),
  });
}

export function normalizeProvider(value) {
  if (typeof value !== 'string' || !PROVIDERS.has(value)) {
    throw new IntegrationRequestError('provider_not_allowed', 400);
  }
  return value;
}

export function normalizeRecipient(value) {
  if (
    typeof value !== 'string' ||
    value.length > 320 ||
    /[\r\n\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new IntegrationRequestError('invalid_recipient', 400);
  }
  const email = value.trim();
  if (!email || email.length > 320 || !SAFE_EMAIL.test(email)) {
    throw new IntegrationRequestError('invalid_recipient', 400);
  }
  return email;
}

export function normalizeSubject(value) {
  if (
    typeof value !== 'string' ||
    /[\r\n\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new IntegrationRequestError('invalid_subject', 400);
  }
  const subject = value.trim();
  if (
    !subject ||
    [...subject].length > 200 ||
    Buffer.byteLength(subject, 'utf8') > 500
  ) {
    throw new IntegrationRequestError('invalid_subject', 400);
  }
  return subject;
}

export function normalizeMessageBody(value) {
  if (
    typeof value !== 'string' ||
    [...value].length > 50_000 ||
    Buffer.byteLength(value, 'utf8') > 100_000 ||
    value.includes('\u0000')
  ) {
    throw new IntegrationRequestError('invalid_message_body', 400);
  }
  return value;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new IntegrationRequestError('invalid_idempotency_key', 400);
  }
  return value;
}

function gmailSendDigest({ to, subject, message }) {
  return createHash('sha256')
    .update(JSON.stringify({ to, subject, message }))
    .digest('base64url');
}

function assertProviderSendDraft({
  uid,
  idempotencyKey,
  to,
  subject,
  message,
  outreach,
  contact,
}) {
  const contactId =
    typeof outreach?.contactId === 'string' ? outreach.contactId : '';
  const contactEmail =
    typeof contact?.email === 'string' ? contact.email.trim() : '';
  if (
    !outreach ||
    outreach.userId !== uid ||
    contactId.length === 0 ||
    contactId.length > 300 ||
    contactId.includes('/') ||
    outreach.subject !== subject ||
    outreach.body !== message ||
    outreach.status !== 'Drafted' ||
    outreach.verification !== 'none' ||
    outreach.threadId != null ||
    outreach.providerSendState != null ||
    !contact ||
    contact.purgeFence != null ||
    contact.mergedIntoId != null ||
    ['deleted', 'merged'].includes(contact.lifecycleStatus) ||
    !contactEmail ||
    contactEmail.toLowerCase() !== to.toLowerCase()
  ) {
    throw new IntegrationRequestError('outreach_not_sendable', 409);
  }
  return {
    outreachId: idempotencyKey,
    contactId,
    contactName:
      typeof contact.name === 'string' ? contact.name.slice(0, 240) : '',
  };
}

export function normalizeThreadIds(value) {
  if (!Array.isArray(value) || value.length > 50) {
    throw new IntegrationRequestError('invalid_thread_ids', 400);
  }
  const unique = [];
  const seen = new Set();
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !THREAD_ID.test(candidate)) {
      throw new IntegrationRequestError('invalid_thread_ids', 400);
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      unique.push(candidate);
    }
  }
  return unique;
}

function normalizeHistoryId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !HISTORY_ID.test(value)) {
    throw new IntegrationRequestError('invalid_history_id', 400);
  }
  return value;
}

function exactObject(value, allowedKeys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowedKeys.includes(key))
  ) {
    throw new IntegrationRequestError('invalid_request', 400);
  }
  return value;
}

function requestBody(req, allowedKeys) {
  const contentType = String(readHeader(req, 'content-type') || '')
    .toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new IntegrationRequestError('content_type_required', 415);
  }
  const length = Number(readHeader(req, 'content-length'));
  if (Number.isFinite(length) && length > 120_000) {
    throw new IntegrationRequestError('request_too_large', 413);
  }

  let body = req?.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > 120_000) {
      throw new IntegrationRequestError('request_too_large', 413);
    }
    try {
      body = JSON.parse(body);
    } catch {
      throw new IntegrationRequestError('invalid_request', 400);
    }
  }
  return exactObject(body || {}, allowedKeys);
}

function assertMethod(req, expected) {
  if (req?.method !== expected) {
    const error = new IntegrationRequestError('method_not_allowed', 405);
    error.allow = expected;
    throw error;
  }
}

function assertSameOrigin(req, appOrigin) {
  const origin = readHeader(req, 'origin');
  if (origin) {
    let normalized;
    try {
      normalized = new URL(String(origin)).origin;
    } catch {
      throw new IntegrationRequestError('origin_not_allowed', 403);
    }
    if (normalized !== appOrigin) {
      throw new IntegrationRequestError('origin_not_allowed', 403);
    }
  }
  const fetchSite = String(readHeader(req, 'sec-fetch-site') || '')
    .toLowerCase();
  if (fetchSite === 'cross-site') {
    throw new IntegrationRequestError('origin_not_allowed', 403);
  }
}

function requireVerifiedIdentity(identity) {
  if (!identity || typeof identity.uid !== 'string' || !identity.uid) {
    throw new IntegrationRequestError('unauthorized', 401);
  }
  if (identity.emailVerified !== true) {
    throw new IntegrationRequestError('email_verification_required', 403);
  }
  return identity;
}

function dateMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? NaN : parsed.getTime();
}

function stateHash(state) {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function pkceChallenge(verifier) {
  return createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');
}

function credentialContext(uid, provider) {
  return `${uid}:${provider}`;
}

function sealedTokenPatch({
  accessToken,
  refreshToken,
  uid,
  provider,
  config,
}) {
  return {
    tokenEnvelope: sealGoogleTokens(
      { accessToken, refreshToken },
      {
        key: config.tokenEncryptionKey,
        context: credentialContext(uid, provider),
      },
    ),
    // Explicit nulls scrub credentials left by pre-envelope deployments even
    // though the Firestore repository uses merge writes for metadata.
    accessToken: null,
    refreshToken: null,
  };
}

async function verifiedGooglePrincipal(fetchImpl, accessToken) {
  const response = await fetchWithTimeout(fetchImpl, GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new GoogleProviderError({
      providerStatus: response.status,
      code: 'google_identity_unavailable',
      status: 502,
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new GoogleProviderError({
      code: 'google_identity_unavailable',
      status: 502,
    });
  }
  const email =
    typeof payload?.email === 'string'
      ? payload.email.trim().toLocaleLowerCase()
      : '';
  if (
    payload?.email_verified !== true ||
    !email ||
    email.length > 320 ||
    !SAFE_EMAIL.test(email) ||
    typeof payload?.sub !== 'string' ||
    !THREAD_ID.test(payload.sub)
  ) {
    throw new IntegrationRequestError('google_identity_invalid', 409);
  }
  return Object.freeze({
    email,
    subject: payload.sub,
  });
}

function stableProviderCode(value) {
  return typeof value === 'string' && /^[a-z_]{1,50}$/.test(value)
    ? value
    : 'provider_error';
}

function responseHeaders(res, requestId) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Authorization, Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Request-Id', requestId);
}

function sendJSON(res, status, payload) {
  return res.status(status).json(payload);
}

function redirect(res, destination) {
  res.setHeader('Location', destination);
  if (typeof res.status === 'function') res.status(302);
  else res.statusCode = 302;
  if (typeof res.end === 'function') return res.end();
  return res;
}

function callbackRedirect(config, status, provider) {
  const target = new URL('/app/settings', config.appOrigin);
  target.searchParams.set('connect', status);
  if (PROVIDERS.has(provider)) {
    target.searchParams.set('provider', provider);
  }
  return target.toString();
}

function safeLog(logger, level, event, details = {}) {
  const method =
    logger && typeof logger[level] === 'function'
      ? logger[level].bind(logger)
      : null;
  method?.(`[google-integrations] ${event}`, details);
}

function publicError(error) {
  if (error instanceof IntegrationRequestError) {
    return error;
  }
  if (
    error?.code === 'unauthorized' ||
    error?.code === 'authentication_unavailable' ||
    error?.code === 'session_revoked' ||
    error?.code === 'account_unavailable'
  ) {
    return new IntegrationRequestError(
      error.code,
      Number(error.status) ||
        (['unauthorized', 'session_revoked'].includes(error.code)
          ? 401
          : error.code === 'account_unavailable'
            ? 410
            : 503),
    );
  }
  return new IntegrationRequestError('integration_unavailable', 503);
}

function handleAPIError(res, error, requestId, logger) {
  const normalized = publicError(error);
  safeLog(logger, normalized.status >= 500 ? 'error' : 'warn', 'request_failed', {
    requestId,
    code: normalized.code,
    providerStatus:
      error instanceof GoogleProviderError
        ? error.providerStatus
        : undefined,
  });
  if (normalized.status === 405) {
    res.setHeader('Allow', error?.allow || 'GET');
  }
  if (normalized.status === 429 && Number(normalized.retryAfter) > 0) {
    res.setHeader(
      'Retry-After',
      String(Math.max(1, Math.ceil(normalized.retryAfter))),
    );
  }
  return sendJSON(res, normalized.status, {
    error: normalized.code,
    requestId,
  });
}

async function fetchWithTimeout(
  fetchImpl,
  url,
  init,
  timeoutMs = 10_000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    throw new GoogleProviderError();
  } finally {
    clearTimeout(timer);
  }
}

async function tokenRequest(fetchImpl, params) {
  const response = await fetchWithTimeout(fetchImpl, GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw new GoogleProviderError({
      providerCode: stableProviderCode(body?.error),
      providerStatus: response.status,
    });
  }
  return body;
}

function boundedToken(value, required = false) {
  if (value == null && !required) return null;
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 8192 ||
    /[\r\n\u0000]/.test(value)
  ) {
    throw new GoogleProviderError();
  }
  return value;
}

function boundedProviderId(value) {
  if (typeof value !== 'string' || !THREAD_ID.test(value)) {
    throw new GoogleProviderError();
  }
  return value;
}

function sanitizeCalendarEvent(value) {
  if (!value || typeof value !== 'object') return null;
  const id =
    typeof value.id === 'string' && THREAD_ID.test(value.id)
      ? value.id
      : null;
  const start = value.start?.dateTime || value.start?.date;
  const end = value.end?.dateTime || value.end?.date;
  if (!id || typeof start !== 'string' || typeof end !== 'string') return null;
  const title =
    typeof value.summary === 'string'
      ? value.summary.slice(0, 500)
      : '(no title)';
  const location =
    typeof value.location === 'string'
      ? value.location.slice(0, 500)
      : null;
  const attendees = Array.isArray(value.attendees)
    ? value.attendees
        .slice(0, 100)
        .map((attendee) =>
          typeof attendee?.email === 'string'
            ? attendee.email.slice(0, 320)
            : null,
        )
        .filter(Boolean)
    : [];
  return { id, title, start, end, location, attendees };
}

export function createFirestoreGoogleIntegrationRepository(db) {
  if (!db) throw new TypeError('Firestore is required.');

  const stateRef = (hash) =>
    db.collection(OAUTH_STATE_COLLECTION).doc(hash);
  const tokenRoot = (uid) =>
    db.collection(OAUTH_TOKEN_COLLECTION).doc(uid);
  const credentialRef = (uid, provider) =>
    tokenRoot(uid).collection('providers').doc(provider);
  const statusRef = (uid, provider) =>
    db.collection('users').doc(uid).collection('integrations').doc(provider);
  const sentThreadRef = (uid, threadId) =>
    tokenRoot(uid).collection('sentThreads').doc(threadId);
  const gmailSendRef = (uid, idempotencyKey) =>
    tokenRoot(uid).collection('gmailSends').doc(idempotencyKey);
  const outreachRef = (uid, outreachId) =>
    db.collection('users').doc(uid).collection('outreaches').doc(outreachId);
  const contactRef = (uid, contactId) =>
    db.collection('users').doc(uid).collection('contacts').doc(contactId);
  const threadRef = (uid, threadId) =>
    db.collection('users').doc(uid).collection('threads').doc(threadId);
  const securityRef = (uid) =>
    db.collection('_accountSecurity').doc(uid);
  const requireActive = (snapshot) => {
    if (!snapshot.exists || snapshot.data()?.status !== 'active') {
      throw new IntegrationRequestError('account_unavailable', 410);
    }
  };

  return Object.freeze({
    async createState(hash, data) {
      await db.runTransaction(async (transaction) => {
        const security = await transaction.get(securityRef(data.uid));
        requireActive(security);
        transaction.create(stateRef(hash), data);
      });
    },

    async consumeState(hash) {
      const result = await db.runTransaction(async (transaction) => {
        const ref = stateRef(hash);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) {
          throw new IntegrationRequestError('oauth_state_invalid', 400);
        }
        const data = snapshot.data() || {};
        const security = await transaction.get(securityRef(data.uid));
        transaction.delete(ref);
        return {
          data,
          active:
            security.exists &&
            security.data()?.status === 'active',
        };
      });
      if (!result.active) {
        throw new IntegrationRequestError('account_unavailable', 410);
      }
      return result.data;
    },

    async assertActive(uid) {
      const snapshot = await securityRef(uid).get();
      requireActive(snapshot);
    },

    async getCredential(uid, provider) {
      return db.runTransaction(async (transaction) => {
        const [security, snapshot] = await Promise.all([
          transaction.get(securityRef(uid)),
          transaction.get(credentialRef(uid, provider)),
        ]);
        requireActive(security);
        return snapshot.exists ? snapshot.data() || {} : null;
      });
    },

    async setCredential(uid, provider, data) {
      await db.runTransaction(async (transaction) => {
        const security = await transaction.get(securityRef(uid));
        requireActive(security);
        transaction.set(
          tokenRoot(uid),
          { updatedAt: data.updatedAt || new Date() },
          { merge: true },
        );
        transaction.set(
          credentialRef(uid, provider),
          data,
          { merge: true },
        );
      });
    },

    async deleteCredential(uid, provider) {
      await db.runTransaction(async (transaction) => {
        const security = await transaction.get(securityRef(uid));
        requireActive(security);
        transaction.delete(credentialRef(uid, provider));
      });
    },

    async getAllCredentials(uid) {
      return db.runTransaction(async (transaction) => {
        const security = await transaction.get(securityRef(uid));
        requireActive(security);
        const entries = await Promise.all(
          [...PROVIDERS].map(async (provider) => {
            const snapshot = await transaction.get(
              credentialRef(uid, provider),
            );
            return [
              provider,
              snapshot.exists ? snapshot.data() || {} : null,
            ];
          }),
        );
        return Object.fromEntries(entries);
      });
    },

    async deleteAllCredentials(uid) {
      await db.runTransaction(async (transaction) => {
        const security = await transaction.get(securityRef(uid));
        requireActive(security);
        for (const provider of PROVIDERS) {
          transaction.delete(credentialRef(uid, provider));
        }
      });
    },

    async setStatus(uid, provider, patch) {
      await db.runTransaction(async (transaction) => {
        const security = await transaction.get(securityRef(uid));
        requireActive(security);
        transaction.set(
          statusRef(uid, provider),
          {
            provider,
            mode: 'live',
            updatedAt: patch.updatedAt || new Date(),
            ...patch,
          },
          { merge: true },
        );
      });
    },

    async recordSentThread(uid, data) {
      await db.runTransaction(async (transaction) => {
        const security = await transaction.get(securityRef(uid));
        requireActive(security);
        transaction.set(
          sentThreadRef(uid, data.threadId),
          {
            threadId: data.threadId,
            messageId: data.messageId,
            sentAt: data.sentAt,
            recordedAt: data.sentAt,
          },
          { merge: false },
        );
      });
    },

    async beginGmailSend(uid, data) {
      return db.runTransaction(async (transaction) => {
        const [security, receipt, outreachSnapshot] = await Promise.all([
          transaction.get(securityRef(uid)),
          transaction.get(gmailSendRef(uid, data.idempotencyKey)),
          transaction.get(outreachRef(uid, data.idempotencyKey)),
        ]);
        requireActive(security);
        if (receipt.exists) {
          const existing = receipt.data() || {};
          if (existing.requestDigest !== data.requestDigest) {
            throw new IntegrationRequestError('idempotency_conflict', 409);
          }
          if (
            existing.status === 'completed' &&
            THREAD_ID.test(existing.threadId || '') &&
            THREAD_ID.test(existing.messageId || '')
          ) {
            return {
              status: 'completed',
              threadId: existing.threadId,
              messageId: existing.messageId,
            };
          }
          throw new IntegrationRequestError('send_status_unknown', 409);
        }
        const outreach = outreachSnapshot.exists
          ? outreachSnapshot.data() || {}
          : null;
        const contactId =
          typeof outreach?.contactId === 'string' ? outreach.contactId : '';
        if (
          !contactId ||
          contactId.length > 300 ||
          contactId.includes('/')
        ) {
          throw new IntegrationRequestError('outreach_not_sendable', 409);
        }
        const contactSnapshot = await transaction.get(
          contactRef(uid, contactId),
        );
        const verifiedDraft = assertProviderSendDraft({
          uid,
          idempotencyKey: data.idempotencyKey,
          to: data.to,
          subject: data.subject,
          message: data.message,
          outreach,
          contact: contactSnapshot.exists
            ? contactSnapshot.data() || {}
            : null,
        });
        transaction.create(gmailSendRef(uid, data.idempotencyKey), {
          idempotencyKey: data.idempotencyKey,
          requestDigest: data.requestDigest,
          outreachId: verifiedDraft.outreachId,
          contactId: verifiedDraft.contactId,
          status: 'pending',
          createdAt: data.createdAt,
          updatedAt: data.createdAt,
        });
        transaction.update(outreachRef(uid, data.idempotencyKey), {
          providerSendState: 'reserved',
          providerRequestDigest: data.requestDigest,
          providerReservationAt: data.createdAt,
          updatedAt: data.createdAt,
        });
        return { status: 'reserved' };
      });
    },

    async completeGmailSend(uid, data) {
      await db.runTransaction(async (transaction) => {
        const [security, receipt, outreachSnapshot] = await Promise.all([
          transaction.get(securityRef(uid)),
          transaction.get(gmailSendRef(uid, data.idempotencyKey)),
          transaction.get(outreachRef(uid, data.idempotencyKey)),
        ]);
        requireActive(security);
        if (!receipt.exists) {
          throw new IntegrationRequestError('send_status_unknown', 409);
        }
        const existing = receipt.data() || {};
        if (
          existing.requestDigest !== data.requestDigest ||
          !['pending', 'completed'].includes(existing.status)
        ) {
          throw new IntegrationRequestError('send_status_unknown', 409);
        }
        if (
          existing.status === 'completed' &&
          (existing.threadId !== data.threadId ||
            existing.messageId !== data.messageId)
        ) {
          throw new IntegrationRequestError('send_status_unknown', 409);
        }
        if (
          !outreachSnapshot.exists ||
          outreachSnapshot.data()?.providerSendState !== 'reserved' ||
          outreachSnapshot.data()?.providerRequestDigest !==
            data.requestDigest ||
          outreachSnapshot.data()?.contactId !== existing.contactId
        ) {
          throw new IntegrationRequestError('send_status_unknown', 409);
        }
        const outreach = outreachSnapshot.data() || {};
        transaction.set(
          gmailSendRef(uid, data.idempotencyKey),
          {
            status: 'completed',
            threadId: data.threadId,
            messageId: data.messageId,
            completedAt: data.completedAt,
            updatedAt: data.completedAt,
          },
          { merge: true },
        );
        transaction.set(
          sentThreadRef(uid, data.threadId),
          {
            threadId: data.threadId,
            messageId: data.messageId,
            sentAt: data.completedAt,
            recordedAt: data.completedAt,
          },
          { merge: false },
        );
        transaction.update(outreachRef(uid, data.idempotencyKey), {
          status: 'Sent (Provider Verified)',
          verification: 'provider-verified',
          responseReceived: 'No',
          threadId: data.threadId,
          provider: 'gmail',
          deliveryMode: 'provider',
          providerSendState: 'completed',
          providerMessageId: data.messageId,
          aiSummary:
            'Sent through the connected provider and verified by thread id.',
          sentAt: data.completedAt,
          providerVerifiedAt: data.completedAt,
          updatedAt: data.completedAt,
        });
        transaction.set(
          threadRef(uid, data.threadId),
          {
            userId: uid,
            threadId: data.threadId,
            contactId: existing.contactId,
            contactName:
              typeof outreach.contactName === 'string'
                ? outreach.contactName.slice(0, 240)
                : '',
            subject:
              typeof outreach.subject === 'string'
                ? outreach.subject.slice(0, 2_000)
                : '',
            outreachId: data.idempotencyKey,
            status: 'sent',
            sentAt: data.completedAt,
            lastCheckedAt: data.completedAt,
            mode: 'live',
            providerVerified: true,
            createdAt: data.completedAt,
            updatedAt: data.completedAt,
          },
          { merge: false },
        );
      });
    },

    async recordGmailPoll(uid, data) {
      await db.runTransaction(async (transaction) => {
        const security = await transaction.get(securityRef(uid));
        requireActive(security);
        for (const [threadId, status] of Object.entries(data.statuses)) {
          if (
            !THREAD_ID.test(threadId) ||
            !['sent', 'delivered', 'replied'].includes(status)
          ) {
            throw new IntegrationRequestError('invalid_thread_status', 400);
          }
          transaction.update(threadRef(uid, threadId), {
            status,
            lastCheckedAt: data.checkedAt,
            updatedAt: data.checkedAt,
          });
        }
        transaction.set(
          statusRef(uid, 'gmail'),
          {
            provider: 'gmail',
            mode: 'live',
            connected: true,
            historyId: data.historyId,
            lastSyncedAt: data.checkedAt,
            updatedAt: data.checkedAt,
          },
          { merge: true },
        );
      });
    },

    async allowedSentThreadIds(uid, requestedThreadIds) {
      if (requestedThreadIds.length === 0) return [];
      return db.runTransaction(async (transaction) => {
        const security = await transaction.get(securityRef(uid));
        requireActive(security);
        const snapshots = await Promise.all(
          requestedThreadIds.map((threadId) =>
            transaction.get(sentThreadRef(uid, threadId))),
        );
        return requestedThreadIds.filter(
          (_threadId, index) => snapshots[index].exists,
        );
      });
    },
  });
}

function repositoryFor(dependencies) {
  if (dependencies.repository) return dependencies.repository;
  const services = dependencies.adminServicesFactory(dependencies.env);
  return createFirestoreGoogleIntegrationRepository(services.db);
}

async function usableAccessToken({
  uid,
  provider,
  repository,
  config,
  fetchImpl,
  now,
}) {
  const credential = await repository.getCredential(uid, provider);
  if (!credential) {
    throw new IntegrationRequestError('not_connected', 409);
  }
  const tokens = openGoogleTokens(credential, {
    key: config.tokenEncryptionKey,
    context: credentialContext(uid, provider),
  });
  if (tokens.legacyPlaintext) {
    await repository.setCredential(uid, provider, {
      ...sealedTokenPatch({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        uid,
        provider,
        config,
      }),
      updatedAt: now,
    });
  }
  const expiresAt = dateMillis(credential.accessTokenExpiresAt);
  if (
    tokens.accessToken &&
    Number.isFinite(expiresAt) &&
    expiresAt - 60_000 > now.getTime()
  ) {
    return boundedToken(tokens.accessToken, true);
  }
  const refreshToken = boundedToken(tokens.refreshToken);
  if (!refreshToken) {
    throw new IntegrationRequestError('reauth_required', 428);
  }

  let refreshed;
  try {
    refreshed = await tokenRequest(fetchImpl, {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
  } catch (error) {
    if (
      error instanceof GoogleProviderError &&
      error.providerCode === 'invalid_grant'
    ) {
      await repository.setCredential(uid, provider, {
        needsReauth: true,
        updatedAt: now,
      });
      await repository.setStatus(uid, provider, {
        connected: false,
        needsReauth: true,
        updatedAt: now,
      });
      throw new IntegrationRequestError('reauth_required', 428);
    }
    throw error;
  }

  const accessToken = boundedToken(refreshed.access_token, true);
  await repository.setCredential(uid, provider, {
    ...sealedTokenPatch({
      accessToken,
      refreshToken,
      uid,
      provider,
      config,
    }),
    accessTokenExpiresAt: new Date(
      now.getTime() +
        Math.min(Math.max(Number(refreshed.expires_in) || 3600, 60), 86_400) *
          1000,
    ),
    needsReauth: false,
    updatedAt: now,
  });
  return accessToken;
}

async function assertGoogleAPIResponse(
  response,
  { repository, uid, provider, now },
) {
  if (response.ok) return;
  if (response.status === 401) {
    await repository.setCredential(uid, provider, {
      needsReauth: true,
      updatedAt: now,
    });
    await repository.setStatus(uid, provider, {
      connected: false,
      needsReauth: true,
      updatedAt: now,
    });
    throw new IntegrationRequestError('reauth_required', 428);
  }
  throw new GoogleProviderError({ providerStatus: response.status });
}

async function revokeCredential(fetchImpl, credential) {
  const token =
    boundedToken(credential?.refreshToken) ||
    boundedToken(credential?.accessToken);
  if (!token) return;
  const response = await fetchWithTimeout(fetchImpl, GOOGLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  // Google returns 400 when a token is already invalid. Treat that as the
  // idempotent end state, but preserve the credential on operational failures.
  if (!response.ok && response.status !== 400) {
    throw new GoogleProviderError({
      providerStatus: response.status,
    });
  }
}

export function createGoogleIntegrationHandlers({
  env = process.env,
  verifyIdentity,
  adminServicesFactory,
  repository,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = () => new Date(),
  randomBytesImpl = randomBytes,
  requestIdFactory = randomUUID,
  rateLimiters = null,
} = {}) {
  if (typeof verifyIdentity !== 'function') {
    throw new TypeError('verifyIdentity is required.');
  }
  if (!repository && typeof adminServicesFactory !== 'function') {
    throw new TypeError('adminServicesFactory or repository is required.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl is required.');
  }

  const dependencies = { env, adminServicesFactory, repository };
  const operationLimiters =
    rateLimiters ||
    Object.freeze({
      oauthStart: createProvisioningRateLimiter({
        env,
        fetchImpl,
        logger,
        limit: 10,
        windowSeconds: 600,
      }),
      disconnect: createProvisioningRateLimiter({
        env,
        fetchImpl,
        logger,
        limit: 10,
        windowSeconds: 60,
      }),
      calendarUpcoming: createProvisioningRateLimiter({
        env,
        fetchImpl,
        logger,
        limit: 30,
        windowSeconds: 60,
      }),
      gmailSend: createProvisioningRateLimiter({
        env,
        fetchImpl,
        logger,
        limit: 10,
        windowSeconds: 60,
      }),
      gmailPoll: createProvisioningRateLimiter({
        env,
        fetchImpl,
        logger,
        limit: 10,
        windowSeconds: 60,
      }),
    });

  async function enforceRate(operation, uid) {
    const limiter = operationLimiters?.[operation];
    if (!limiter || typeof limiter.check !== 'function') {
      throw new IntegrationRequestError(
        'integration_rate_limit_unavailable',
        503,
      );
    }
    try {
      await limiter.check(`google:${operation}:uid:${uid}`);
    } catch (error) {
      if (error instanceof ProvisioningRateLimitError) {
        const limited = new IntegrationRequestError('rate_limited', 429);
        limited.retryAfter = error.retryAfter;
        throw limited;
      }
      throw new IntegrationRequestError(
        'integration_rate_limit_unavailable',
        503,
      );
    }
  }

  async function apiHandler(req, res, operation) {
    const requestId = requestIdFactory();
    responseHeaders(res, requestId);
    try {
      const config = readGoogleIntegrationConfig(env);
      assertSameOrigin(req, config.appOrigin);
      return await operation({
        config,
        identity: requireVerifiedIdentity(await verifyIdentity(req)),
        repository: repositoryFor(dependencies),
        requestId,
      });
    } catch (error) {
      return handleAPIError(res, error, requestId, logger);
    }
  }

  const oauthStart = (req, res) =>
    apiHandler(req, res, async ({ config, identity, repository: store }) => {
      assertMethod(req, 'POST');
      await enforceRate('oauthStart', identity.uid);
      const body = requestBody(req, ['provider']);
      const provider = normalizeProvider(body.provider);
      const state = randomBytesImpl(32).toString('base64url');
      const verifier = randomBytesImpl(48).toString('base64url');
      if (!OPAQUE_STATE.test(state) || !PKCE_VERIFIER.test(verifier)) {
        throw new IntegrationRequestError('integration_unavailable', 503);
      }
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + OAUTH_STATE_TTL_MS);
      await store.createState(stateHash(state), {
        uid: identity.uid,
        email: identity.email || null,
        provider,
        codeVerifier: verifier,
        redirectUri: config.callbackUrl,
        createdAt,
        expiresAt,
      });

      const authorization = new URL(GOOGLE_AUTHORIZATION_URL);
      authorization.searchParams.set('client_id', config.clientId);
      authorization.searchParams.set('redirect_uri', config.callbackUrl);
      authorization.searchParams.set('response_type', 'code');
      authorization.searchParams.set(
        'scope',
        [
          ...GOOGLE_IDENTITY_SCOPES,
          ...GOOGLE_INTEGRATION_SCOPES[provider],
        ].join(' '),
      );
      authorization.searchParams.set('include_granted_scopes', 'true');
      authorization.searchParams.set('access_type', 'offline');
      authorization.searchParams.set('prompt', 'select_account consent');
      authorization.searchParams.set('state', state);
      authorization.searchParams.set('code_challenge', pkceChallenge(verifier));
      authorization.searchParams.set('code_challenge_method', 'S256');
      if (identity.email) {
        authorization.searchParams.set('login_hint', identity.email);
      }

      return sendJSON(res, 200, {
        authorizationUrl: authorization.toString(),
        expiresAt: expiresAt.toISOString(),
      });
    });

  const oauthCallback = async (req, res) => {
    const requestId = requestIdFactory();
    responseHeaders(res, requestId);
    let config;
    let provider = '';
    try {
      assertMethod(req, 'GET');
      config = readGoogleIntegrationConfig(env);
      const state = queryValue(req, 'state');
      if (typeof state !== 'string' || !OPAQUE_STATE.test(state)) {
        throw new IntegrationRequestError('oauth_state_invalid', 400);
      }
      const store = repositoryFor(dependencies);
      const pending = await store.consumeState(stateHash(state));
      provider = normalizeProvider(pending.provider);

      const current = now();
      const expiresAt = dateMillis(pending.expiresAt);
      if (
        typeof pending.uid !== 'string' ||
        !pending.uid ||
        !PKCE_VERIFIER.test(pending.codeVerifier || '') ||
        pending.redirectUri !== config.callbackUrl ||
        !Number.isFinite(expiresAt) ||
        expiresAt < current.getTime() ||
        expiresAt > current.getTime() + OAUTH_STATE_TTL_MS + 60_000
      ) {
        throw new IntegrationRequestError('oauth_state_invalid', 400);
      }

      const googleError = queryValue(req, 'error');
      if (googleError) {
        return redirect(
          res,
          callbackRedirect(config, 'denied', provider),
        );
      }

      const code = queryValue(req, 'code');
      if (
        typeof code !== 'string' ||
        !code ||
        code.length > 4096 ||
        /[\r\n\u0000]/.test(code)
      ) {
        throw new IntegrationRequestError('oauth_code_invalid', 400);
      }

      const tokens = await tokenRequest(fetchImpl, {
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
        code_verifier: pending.codeVerifier,
        grant_type: 'authorization_code',
      });
      const accessToken = boundedToken(tokens.access_token, true);
      const newlyIssuedRefreshToken = boundedToken(tokens.refresh_token);
      try {
        const scope = validateGrantedScopes(tokens.scope, provider);
        const googlePrincipal = await verifiedGooglePrincipal(
          fetchImpl,
          accessToken,
        );
        await store.assertActive?.(pending.uid);
        const existing = await store.getCredential(
          pending.uid,
          provider,
        );
        const existingTokens = existing
          ? openGoogleTokens(existing, {
              key: config.tokenEncryptionKey,
              context: credentialContext(pending.uid, provider),
            })
          : { refreshToken: null };
        const refreshToken =
          newlyIssuedRefreshToken ||
          boundedToken(existingTokens.refreshToken);
        if (!refreshToken) {
          throw new IntegrationRequestError('reauth_required', 428);
        }

        await store.setCredential(pending.uid, provider, {
          ...sealedTokenPatch({
            accessToken,
            refreshToken,
            uid: pending.uid,
            provider,
            config,
          }),
          accessTokenExpiresAt: new Date(
            current.getTime() +
              Math.min(
                Math.max(Number(tokens.expires_in) || 3600, 60),
                86_400,
              ) *
                1000,
          ),
          scope,
          googleSubject: googlePrincipal.subject,
          googleEmail: googlePrincipal.email,
          needsReauth: false,
          updatedAt: current,
        });
        await store.setStatus(pending.uid, provider, {
          connected: true,
          needsReauth: false,
          email:
            googlePrincipal.email,
          connectedAt: current,
          lastSyncedAt: current,
          expiresAt: config.testMode
            ? new Date(current.getTime() + 7 * 24 * 3600 * 1000)
            : null,
          updatedAt: current,
        });
      } catch (error) {
        // A deletion lock can advance after Google issued a token but before
        // Firestore persistence. Revoke that just-issued grant so the callback
        // cannot leave an orphaned provider credential.
        await revokeCredential(fetchImpl, {
          refreshToken: newlyIssuedRefreshToken,
          accessToken,
        }).catch(() => undefined);
        throw error;
      }

      return redirect(res, callbackRedirect(config, 'ok', provider));
    } catch (error) {
      const normalized = publicError(error);
      safeLog(logger, normalized.status >= 500 ? 'error' : 'warn', 'callback_failed', {
        requestId,
        code: normalized.code,
        providerStatus:
          error instanceof GoogleProviderError
            ? error.providerStatus
            : undefined,
      });
      if (config) {
        return redirect(
          res,
          callbackRedirect(config, 'error', provider),
        );
      }
      return sendJSON(res, normalized.status, {
        error: normalized.code,
        requestId,
      });
    }
  };

  const disconnect = (req, res) =>
    apiHandler(req, res, async ({
      config,
      identity,
      repository: store,
    }) => {
      assertMethod(req, 'POST');
      await enforceRate('disconnect', identity.uid);
      const body = requestBody(req, ['provider']);
      normalizeProvider(body.provider);
      const credentials = await store.getAllCredentials(identity.uid);
      const grants = [];
      for (const provider of PROVIDERS) {
        const credential = credentials[provider];
        if (!credential) continue;
        grants.push(
          openGoogleTokens(credential, {
            key: config.tokenEncryptionKey,
            context: credentialContext(identity.uid, provider),
          }),
        );
      }
      // Google revocation applies to the entire user/app grant, including
      // incrementally granted scopes. Disconnect is therefore deliberately a
      // single "Disconnect Google" operation for Calendar and Gmail together.
      for (const grant of grants) {
        await revokeCredential(fetchImpl, grant);
      }
      if (grants.length > 0) {
        await store.deleteAllCredentials(identity.uid);
      }
      const current = now();
      for (const provider of PROVIDERS) {
        await store.setStatus(identity.uid, provider, {
          connected: false,
          needsReauth: false,
          disconnectedAt: current,
          updatedAt: current,
        });
      }
      return sendJSON(res, 200, { disconnected: true });
    });

  const calendarUpcoming = (req, res) =>
    apiHandler(req, res, async ({ config, identity, repository: store }) => {
      assertMethod(req, 'GET');
      await enforceRate('calendarUpcoming', identity.uid);
      const current = now();
      const accessToken = await usableAccessToken({
        uid: identity.uid,
        provider: 'calendar',
        repository: store,
        config,
        fetchImpl,
        now: current,
      });
      const end = new Date(current.getTime() + 7 * 24 * 3600 * 1000);
      const target = new URL(GOOGLE_CALENDAR_URL);
      target.searchParams.set('timeMin', current.toISOString());
      target.searchParams.set('timeMax', end.toISOString());
      target.searchParams.set('singleEvents', 'true');
      target.searchParams.set('orderBy', 'startTime');
      target.searchParams.set('maxResults', '25');
      const response = await fetchWithTimeout(fetchImpl, target, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      await assertGoogleAPIResponse(response, {
        repository: store,
        uid: identity.uid,
        provider: 'calendar',
        now: current,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new GoogleProviderError();
      }
      const events = Array.isArray(payload?.items)
        ? payload.items
            .slice(0, 25)
            .map(sanitizeCalendarEvent)
            .filter(Boolean)
        : [];
      await store.setStatus(identity.uid, 'calendar', {
        lastSyncedAt: current,
        updatedAt: current,
      });
      return sendJSON(res, 200, {
        events,
        syncedAt: current.toISOString(),
      });
    });

  const gmailSend = (req, res) =>
    apiHandler(req, res, async ({ config, identity, repository: store }) => {
      assertMethod(req, 'POST');
      await enforceRate('gmailSend', identity.uid);
      const body = requestBody(req, [
        'to',
        'subject',
        'body',
        'idempotencyKey',
      ]);
      const to = normalizeRecipient(body.to);
      const subject = normalizeSubject(body.subject);
      const message = normalizeMessageBody(body.body);
      const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey);
      const requestDigest = gmailSendDigest({ to, subject, message });
      const current = now();
      const accessToken = await usableAccessToken({
        uid: identity.uid,
        provider: 'gmail',
        repository: store,
        config,
        fetchImpl,
        now: current,
      });
      const reservation = await store.beginGmailSend(identity.uid, {
        idempotencyKey,
        requestDigest,
        to,
        subject,
        message,
        createdAt: current,
      });
      if (reservation.status === 'completed') {
        return sendJSON(res, 200, {
          threadId: reservation.threadId,
          messageId: reservation.messageId,
          replayed: true,
          recorded: true,
        });
      }
      const mime = [
        `To: ${to}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
        `Message-ID: <cirqle-${requestDigest}@mail.cirqle.app>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        '',
        message,
      ].join('\r\n');
      const raw = Buffer.from(mime, 'utf8').toString('base64url');
      const response = await fetchWithTimeout(
        fetchImpl,
        `${GOOGLE_GMAIL_BASE}/messages/send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ raw }),
        },
      );
      await assertGoogleAPIResponse(response, {
        repository: store,
        uid: identity.uid,
        provider: 'gmail',
        now: current,
      });
      let sent;
      try {
        sent = await response.json();
      } catch {
        throw new GoogleProviderError();
      }
      const threadId = boundedProviderId(sent?.threadId);
      const messageId = boundedProviderId(sent?.id);
      await store.completeGmailSend(identity.uid, {
        idempotencyKey,
        requestDigest,
        threadId,
        messageId,
        completedAt: current,
      });
      await store.setStatus(identity.uid, 'gmail', {
        lastSyncedAt: current,
        updatedAt: current,
      });
      return sendJSON(res, 200, {
        threadId,
        messageId,
        replayed: false,
        recorded: true,
      });
    });

  const gmailPoll = (req, res) =>
    apiHandler(req, res, async ({ config, identity, repository: store }) => {
      assertMethod(req, 'POST');
      await enforceRate('gmailPoll', identity.uid);
      const body = requestBody(req, ['threadIds']);
      const requestedThreadIds = normalizeThreadIds(body.threadIds);
      const threadIds = await store.allowedSentThreadIds(
        identity.uid,
        requestedThreadIds,
      );
      if (
        threadIds.length !== requestedThreadIds.length ||
        threadIds.some(
          (threadId, index) => threadId !== requestedThreadIds[index],
        )
      ) {
        throw new IntegrationRequestError('untrusted_thread_ids', 403);
      }
      const current = now();
      const accessToken = await usableAccessToken({
        uid: identity.uid,
        provider: 'gmail',
        repository: store,
        config,
        fetchImpl,
        now: current,
      });
      const statuses = {};
      for (const threadId of threadIds) {
        const target =
          `${GOOGLE_GMAIL_BASE}/threads/${encodeURIComponent(threadId)}` +
          '?format=metadata&metadataHeaders=From';
        const response = await fetchWithTimeout(fetchImpl, target, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (response.status === 404) continue;
        await assertGoogleAPIResponse(response, {
          repository: store,
          uid: identity.uid,
          provider: 'gmail',
          now: current,
        });
        let thread;
        try {
          thread = await response.json();
        } catch {
          throw new GoogleProviderError();
        }
        const messages = Array.isArray(thread?.messages)
          ? thread.messages.slice(0, 500)
          : [];
        const latest = messages[messages.length - 1];
        const labels = Array.isArray(latest?.labelIds)
          ? latest.labelIds
          : [];
        statuses[threadId] =
          messages.length > 1 && !labels.includes('SENT')
            ? 'replied'
            : 'delivered';
      }

      const profileResponse = await fetchWithTimeout(
        fetchImpl,
        `${GOOGLE_GMAIL_BASE}/profile`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      await assertGoogleAPIResponse(profileResponse, {
        repository: store,
        uid: identity.uid,
        provider: 'gmail',
        now: current,
      });
      let historyId = null;
      try {
        const profile = await profileResponse.json();
        historyId =
          typeof profile?.historyId === 'string' &&
          HISTORY_ID.test(profile.historyId)
            ? profile.historyId
            : null;
      } catch {
        historyId = null;
      }
      await store.recordGmailPoll(identity.uid, {
        statuses,
        historyId,
        checkedAt: current,
      });
      return sendJSON(res, 200, { statuses, historyId });
    });

  return Object.freeze({
    oauthStart,
    oauthCallback,
    disconnect,
    calendarUpcoming,
    gmailSend,
    gmailPoll,
  });
}
