import { createHash } from 'node:crypto';

import {
  getSafeRequestId,
  getTrustedClientIp,
  readHeader,
} from '../_lib/http.js';
import {
  createProvisioningRateLimiter,
  ProvisioningRateLimitError,
} from '../_lib/rate-limit.js';

const DIRECTIVES = new Set([
  'base-uri',
  'child-src',
  'connect-src',
  'default-src',
  'font-src',
  'form-action',
  'frame-ancestors',
  'frame-src',
  'img-src',
  'manifest-src',
  'media-src',
  'object-src',
  'script-src',
  'script-src-attr',
  'script-src-elem',
  'style-src',
  'style-src-attr',
  'style-src-elem',
  'worker-src',
]);

function requestSubject(req) {
  const address = getTrustedClientIp(req);
  const agent = String(readHeader(req, 'user-agent') || 'unknown').slice(
    0,
    512,
  );
  return createHash('sha256')
    .update(`${address}|${agent}`)
    .digest('hex')
    .slice(0, 24);
}

function safeOrigin(value) {
  if (['inline', 'eval', 'data', 'blob', 'self'].includes(value)) {
    return value;
  }
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)
      ? parsed.origin
      : 'other-scheme';
  } catch {
    return 'unknown';
  }
}

function routeBucket(value) {
  try {
    const route = new URL(value).pathname;
    if (/^\/app\/directory\/[^/]+$/.test(route)) {
      return '/app/directory/:contactId';
    }
    if (/^\/card\/[^/]+$/.test(route)) return '/card/:cardId';
    if (route === '/' || route === '/login' || route.startsWith('/auth/')) {
      return route.startsWith('/auth/') ? '/auth/:action' : route;
    }
    return [
      '/app',
      '/app/directory',
      '/app/graph',
      '/app/tracker',
      '/app/calendar',
      '/app/templates',
      '/app/settings',
    ].includes(route)
      ? route
      : 'other';
  } catch {
    return 'unknown';
  }
}

export function normalizeCSPReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const source =
    body['csp-report'] && typeof body['csp-report'] === 'object'
      ? body['csp-report']
      : body;
  const directive = String(
    source['effective-directive'] || source.effectiveDirective || '',
  )
    .trim()
    .toLowerCase();
  if (!DIRECTIVES.has(directive)) return null;
  return Object.freeze({
    effectiveDirective: directive,
    blockedOrigin: safeOrigin(
      String(source['blocked-uri'] || source.blockedURL || ''),
    ),
    documentRoute: routeBucket(
      String(source['document-uri'] || source.documentURL || ''),
    ),
    sourceOrigin: safeOrigin(
      String(source['source-file'] || source.sourceFile || ''),
    ),
    disposition:
      source.disposition === 'enforce' ? 'enforce' : 'report',
  });
}

export function createCSPReportHandler({
  env = process.env,
  logger = console,
  fetchImpl = globalThis.fetch,
  limiter,
} = {}) {
  const rateLimiter =
    limiter ||
    createProvisioningRateLimiter({
      env,
      fetchImpl,
      logger,
      limit: 20,
      windowSeconds: 60,
    });

  return async function cspReportHandler(req, res) {
    const requestId = getSafeRequestId(req);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Request-Id', requestId);

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'method_not_allowed', requestId });
    }
    if (JSON.stringify(req.body || {}).length > 8_000) {
      return res.status(400).json({ error: 'invalid_csp_report', requestId });
    }
    const payload = normalizeCSPReport(req.body);
    if (!payload) {
      return res.status(400).json({ error: 'invalid_csp_report', requestId });
    }

    try {
      await rateLimiter.check(`csp:${requestSubject(req)}`);
    } catch (error) {
      if (error instanceof ProvisioningRateLimitError) {
        return res.status(429).json({ error: 'rate_limited', requestId });
      }
      return res.status(503).json({ error: 'telemetry_unavailable', requestId });
    }

    logger.info?.('[csp] browser violation', {
      requestId,
      ...payload,
    });
    return res.status(202).json({ accepted: true });
  };
}

export default createCSPReportHandler();
