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

const METRICS = new Set(['CLS', 'FCP', 'INP', 'LCP', 'TTFB']);
const ROUTES = new Set([
  '/app',
  '/app/directory',
  '/app/directory/:contactId',
  '/app/graph',
  '/app/tracker',
  '/app/calendar',
  '/app/templates',
  '/app/settings',
]);

export function normalizeVitals(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const route =
    typeof body.route === 'string' && ROUTES.has(body.route)
      ? body.route
      : null;
  const metrics = Array.isArray(body.metrics)
    ? body.metrics
        .filter(
          (metric) =>
            metric &&
            METRICS.has(metric.name) &&
            Number.isFinite(Number(metric.value)) &&
            Number(metric.value) >= 0 &&
            Number(metric.value) <= 120_000,
        )
        .slice(0, 5)
        .map((metric) => ({
          name: metric.name,
          value: Number(metric.value),
        }))
    : [];
  if (!route || metrics.length === 0) return null;

  const widthBucket = Math.max(
    160,
    Math.min(3_840, Math.round(Number(body.viewport?.widthBucket) || 0)),
  );
  return {
    route,
    metrics,
    viewport: {
      widthBucket,
      mobile: body.viewport?.mobile === true,
    },
  };
}

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

export function createVitalsHandler({
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
      limit: 30,
      windowSeconds: 60,
    });

  return async function vitalsHandler(req, res) {
    const requestId = getSafeRequestId(req);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Request-Id', requestId);

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'method_not_allowed', requestId });
    }
    if (JSON.stringify(req.body || {}).length > 2_500) {
      return res.status(400).json({ error: 'invalid_metrics', requestId });
    }
    const payload = normalizeVitals(req.body);
    if (!payload) {
      return res.status(400).json({ error: 'invalid_metrics', requestId });
    }

    try {
      await rateLimiter.check(`vitals:${requestSubject(req)}`);
    } catch (error) {
      if (error instanceof ProvisioningRateLimitError) {
        return res.status(429).json({ error: 'rate_limited', requestId });
      }
      return res.status(503).json({ error: 'telemetry_unavailable', requestId });
    }

    logger.info?.('[web-vitals] measurement', {
      requestId,
      ...payload,
    });
    return res.status(202).json({ accepted: true });
  };
}

export default createVitalsHandler();
