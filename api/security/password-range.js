import { createHash, randomUUID } from 'node:crypto';

import { getTrustedClientIp, readHeader } from '../_lib/http.js';
import {
  createProvisioningRateLimiter,
  ProvisioningRateLimitError,
} from '../_lib/rate-limit.js';

const PWNED_PASSWORDS_ORIGIN = 'https://api.pwnedpasswords.com';
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_PROVIDER_BYTES = 256_000;
// Padding guarantees a minimum-sized response; it does not cap prefixes that
// organically have more matches. The byte limit is the primary bound and
// permits at most ~6,700 shortest valid rows.
const MAX_RANGE_ROWS = 7_000;
const PREFIX_PATTERN = /^[A-F0-9]{5}$/;
const RANGE_ROW_PATTERN = /^([A-F0-9]{35}):(\d{1,12})$/;

function setHeaders(res, requestId) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Request-Id', requestId);
}

function sendError(res, status, code, requestId) {
  return res.status(status).json({
    error: {
      code,
      message:
        status === 400
          ? 'The password safety request is invalid.'
          : 'Password breach screening is temporarily unavailable.',
    },
    requestId,
  });
}

function parseBody(req) {
  if (req.body == null || req.body === '') return null;
  let body = req.body;
  if (typeof body === 'string' && body.length <= 256) {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.prefix !== 'string' ||
    body.prefix.length > 16
  ) {
    return null;
  }
  const prefix = body.prefix.trim().toUpperCase();
  return PREFIX_PATTERN.test(prefix) ? prefix : null;
}

function normalizeRangeBody(value) {
  if (typeof value !== 'string' || value.length > MAX_PROVIDER_BYTES) {
    return null;
  }
  const rows = [];
  for (const rawLine of value.split(/\r?\n/)) {
    if (!rawLine) continue;
    const line = rawLine.trim().toUpperCase();
    if (!RANGE_ROW_PATTERN.test(line)) return null;
    rows.push(line);
    if (rows.length > MAX_RANGE_ROWS) return null;
  }
  return rows.length ? `${rows.join('\r\n')}\r\n` : null;
}

function safeWarn(logger, requestId, event) {
  logger?.warn?.('[password-range] provider unavailable', {
    requestId,
    event,
  });
}

function requestFingerprint(req) {
  const address = getTrustedClientIp(req);
  const agent = readHeader(req, 'user-agent') || 'unknown';
  return createHash('sha256')
    .update(`${address}|${agent}`)
    .digest('hex')
    .slice(0, 32);
}

async function readBoundedText(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROVIDER_BYTES
  ) {
    return null;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return text.length <= MAX_PROVIDER_BYTES ? text : null;
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let value = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > MAX_PROVIDER_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    value += decoder.decode(chunk.value, { stream: true });
  }
  value += decoder.decode();
  return value;
}

export function createPasswordRangeHandler({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
  env = process.env,
  rateLimiter = createProvisioningRateLimiter({
    env,
    fetchImpl,
    logger,
    limit: 30,
    windowSeconds: 60,
  }),
} = {}) {
  return async function passwordRangeHandler(req, res) {
    // Unlike general APIs, this endpoint deliberately ignores caller-provided
    // request IDs so a password hash prefix cannot be smuggled into logs under
    // another header name.
    const requestId = randomUUID();
    setHeaders(res, requestId);

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendError(res, 405, 'method_not_allowed', requestId);
    }

    const prefix = parseBody(req);
    if (!prefix) {
      return sendError(res, 400, 'password_range_invalid', requestId);
    }
    try {
      const rate = await rateLimiter.check(
        `password-range:${requestFingerprint(req)}`,
      );
      res.setHeader('RateLimit-Limit', String(rate.limit));
      res.setHeader('RateLimit-Remaining', String(rate.remaining));
      res.setHeader('RateLimit-Reset', String(rate.resetAt));
    } catch (error) {
      if (error instanceof ProvisioningRateLimitError) {
        res.setHeader('Retry-After', String(error.retryAfter));
        return sendError(res, 429, 'rate_limited', requestId);
      }
      safeWarn(logger, requestId, 'rate_limit_unavailable');
      return sendError(
        res,
        503,
        'password_range_unavailable',
        requestId,
      );
    }
    if (typeof fetchImpl !== 'function') {
      safeWarn(logger, requestId, 'fetch_unavailable');
      return sendError(
        res,
        503,
        'password_range_unavailable',
        requestId,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        `${PWNED_PASSWORDS_ORIGIN}/range/${prefix}`,
        {
          method: 'GET',
          headers: {
            'Add-Padding': 'true',
            Accept: 'text/plain',
            'User-Agent': 'Cirqle-Password-Safety/1.0',
          },
          redirect: 'error',
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        safeWarn(logger, requestId, 'provider_status');
        return sendError(
          res,
          503,
          'password_range_unavailable',
          requestId,
        );
      }
      const providerBody = await readBoundedText(response);
      const normalized = normalizeRangeBody(providerBody);
      if (!normalized) {
        safeWarn(logger, requestId, 'provider_response_invalid');
        return sendError(
          res,
          503,
          'password_range_unavailable',
          requestId,
        );
      }

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(normalized);
    } catch (error) {
      safeWarn(
        logger,
        requestId,
        error?.name === 'AbortError' ? 'provider_timeout' : 'provider_error',
      );
      return sendError(
        res,
        503,
        'password_range_unavailable',
        requestId,
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}

export default createPasswordRangeHandler();
