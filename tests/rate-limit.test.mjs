import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProvisioningRateLimiter,
  DistributedRateLimitUnavailableError,
  ProvisioningRateLimitError,
} from '../api/_lib/rate-limit.js';

test('production fails closed when distributed rate limiting is not configured', async () => {
  const limiter = createProvisioningRateLimiter({
    env: { VERCEL_ENV: 'production' },
    logger: {},
  });

  await assert.rejects(
    limiter.check('user-1'),
    DistributedRateLimitUnavailableError,
  );
});

test('preview fails closed when the distributed limiter is unavailable', async () => {
  const limiter = createProvisioningRateLimiter({
    env: {
      VERCEL_ENV: 'preview',
      UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN: 'secret',
    },
    fetchImpl: async () => {
      throw new Error('network unavailable');
    },
    logger: {},
  });

  await assert.rejects(
    limiter.check('user-1'),
    DistributedRateLimitUnavailableError,
  );
});

test('local development keeps a bounded in-memory fallback', async () => {
  let now = 1_000;
  const limiter = createProvisioningRateLimiter({
    env: {},
    logger: {},
    now: () => now,
    limit: 2,
    windowSeconds: 10,
  });

  assert.equal((await limiter.check('user-1')).remaining, 1);
  assert.equal((await limiter.check('user-1')).remaining, 0);
  await assert.rejects(
    limiter.check('user-1'),
    ProvisioningRateLimitError,
  );

  now += 10_001;
  assert.equal((await limiter.check('user-1')).remaining, 1);
});

test('production uses the configured distributed limiter', async () => {
  const requests = [];
  const limiter = createProvisioningRateLimiter({
    env: {
      VERCEL_ENV: 'production',
      UPSTASH_REDIS_REST_URL: 'https://redis.example.test/',
      UPSTASH_REDIS_REST_TOKEN: 'secret',
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        async json() {
          return [
            { result: 1 },
            { result: 1 },
            { result: 60 },
          ];
        },
      };
    },
    now: () => 10_000,
  });

  const result = await limiter.check('user-1');
  assert.equal(result.remaining, 5);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://redis.example.test/multi-exec',
  );
  assert.doesNotMatch(
    JSON.stringify(requests[0].init.body),
    /user-1/,
  );
});
