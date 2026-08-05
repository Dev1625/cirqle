import { createHash } from 'node:crypto';

const DEFAULT_LIMIT = 6;
const DEFAULT_WINDOW_SECONDS = 60;
const localWindows = new Map();

export class ProvisioningRateLimitError extends Error {
  constructor(retryAfter) {
    super('Too many provisioning attempts.');
    this.name = 'ProvisioningRateLimitError';
    this.code = 'rate_limited';
    this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
}

export class DistributedRateLimitUnavailableError extends Error {
  constructor() {
    super('Distributed rate limiting is unavailable.');
    this.name = 'DistributedRateLimitUnavailableError';
    this.code = 'distributed_rate_limit_unavailable';
  }
}

function subjectKey(subject) {
  return createHash('sha256').update(subject).digest('hex').slice(0, 32);
}

function safeWarn(logger, event) {
  const method =
    logger && typeof logger.warn === 'function'
      ? logger.warn.bind(logger)
      : null;
  method?.(`[provisioning-rate-limit] ${event}`);
}

export function createProvisioningRateLimiter({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = () => Date.now(),
  limit = DEFAULT_LIMIT,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
} = {}) {
  const redisUrl = (
    env.UPSTASH_REDIS_REST_URL ||
    env.KV_REST_API_URL ||
    ''
  ).replace(/\/+$/, '');
  const redisToken =
    env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '';
  const distributedRequired =
    env.REQUIRE_DISTRIBUTED_RATE_LIMIT === 'true' ||
    env.VERCEL_ENV === 'production' ||
    env.VERCEL_ENV === 'preview';

  async function checkDistributed(key) {
    const response = await fetchImpl(`${redisUrl}/multi-exec`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, windowSeconds, 'NX'],
        ['TTL', key],
      ]),
    });
    if (!response.ok) throw new Error('Distributed rate limiter unavailable.');

    const result = await response.json();
    const count = Number(result?.[0]?.result);
    const ttl = Number(result?.[2]?.result);
    if (!Number.isFinite(count) || !Number.isFinite(ttl)) {
      throw new Error('Distributed rate limiter returned an invalid response.');
    }

    const retryAfter = ttl > 0 ? ttl : windowSeconds;
    if (count > limit) throw new ProvisioningRateLimitError(retryAfter);

    return {
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: Math.ceil(now() / 1000) + retryAfter,
    };
  }

  function checkLocal(key) {
    const current = now();
    const existing = localWindows.get(key);
    const entry =
      !existing || existing.resetAt <= current
        ? { count: 0, resetAt: current + windowSeconds * 1000 }
        : existing;

    entry.count += 1;
    localWindows.set(key, entry);

    const retryAfter = Math.max(1, (entry.resetAt - current) / 1000);
    if (entry.count > limit) throw new ProvisioningRateLimitError(retryAfter);

    if (localWindows.size > 2_000) {
      for (const [candidate, candidateEntry] of localWindows) {
        if (candidateEntry.resetAt <= current) localWindows.delete(candidate);
      }
    }

    return {
      limit,
      remaining: Math.max(0, limit - entry.count),
      resetAt: Math.ceil(entry.resetAt / 1000),
    };
  }

  return Object.freeze({
    async check(subject) {
      const key = `cirqle:provision:v1:${subjectKey(subject)}`;
      if (redisUrl && redisToken && typeof fetchImpl === 'function') {
        try {
          return await checkDistributed(key);
        } catch (error) {
          if (error instanceof ProvisioningRateLimitError) throw error;
          safeWarn(
            logger,
            distributedRequired
              ? 'distributed_unavailable'
              : 'distributed_fallback',
          );
          if (distributedRequired) {
            throw new DistributedRateLimitUnavailableError();
          }
        }
      }
      if (distributedRequired) {
        safeWarn(logger, 'distributed_not_configured');
        throw new DistributedRateLimitUnavailableError();
      }
      return checkLocal(key);
    },
  });
}
