import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPasswordRangeHandler,
} from '../api/security/password-range.js';
import {
  ProvisioningRateLimitError,
} from '../api/_lib/rate-limit.js';

const PREFIX = '5BAA6';
const SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';
const PADDED_SUFFIX = '00000000000000000000000000000000000';

function request({
  method = 'POST',
  body = { prefix: PREFIX },
} = {}) {
  return {
    method,
    body,
    headers: {
      'x-forwarded-for': '203.0.113.10',
      'user-agent': 'password-test',
      'x-request-id': PREFIX,
    },
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

const ALLOW_RATE = {
  check: async () => ({ limit: 30, remaining: 29, resetAt: 123 }),
};

test('range proxy accepts only a five-character prefix and never a password or full hash', async () => {
  let providerCalls = 0;
  const handler = createPasswordRangeHandler({
    rateLimiter: ALLOW_RATE,
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(`${SUFFIX}:10\r\n`, { status: 200 });
    },
    logger: { warn: () => undefined },
  });

  for (const body of [
    { password: 'password' },
    {
      prefix: PREFIX,
      suffix: SUFFIX,
    },
    { prefix: `${PREFIX}${SUFFIX}` },
    { prefix: 'A'.repeat(1_024) },
    { prefix: 'ZZZZZ' },
  ]) {
    const res = response();
    await handler(request({ body }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'password_range_invalid');
  }
  assert.equal(providerCalls, 0);
});

test('range proxy calls only the fixed HIBP endpoint with padding and returns normalized rows', async () => {
  let providerRequest = null;
  const handler = createPasswordRangeHandler({
    rateLimiter: ALLOW_RATE,
    fetchImpl: async (url, init) => {
      providerRequest = { url, init };
      return new Response(
        `${SUFFIX.toLowerCase()}:123\r\n${PADDED_SUFFIX}:0\r\n`,
        {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        },
      );
    },
    logger: { warn: () => undefined },
  });
  const res = response();
  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(providerRequest.url, `https://api.pwnedpasswords.com/range/${PREFIX}`);
  assert.equal(providerRequest.init.method, 'GET');
  assert.equal(providerRequest.init.headers['Add-Padding'], 'true');
  assert.equal(providerRequest.init.headers['User-Agent'], 'Cirqle-Password-Safety/1.0');
  assert.equal(providerRequest.init.redirect, 'error');
  assert.equal(
    res.body,
    `${SUFFIX}:123\r\n${PADDED_SUFFIX}:0\r\n`,
  );
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0');
  assert.equal(res.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(res.headers['RateLimit-Limit'], '30');
});

test('provider failures, bodies, prefixes, and password material never enter logs or responses', async () => {
  const secret = 'NeverLogThisPassword!42';
  const logs = [];
  const handler = createPasswordRangeHandler({
    rateLimiter: ALLOW_RATE,
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => {
        throw new Error(`provider body must not be read: ${secret}`);
      },
    }),
    logger: { warn: (...items) => logs.push(items) },
  });
  const res = response();
  await handler(request(), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, 'password_range_unavailable');
  const serialized = JSON.stringify({ logs, body: res.body });
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, new RegExp(PREFIX));
  assert.doesNotMatch(serialized, new RegExp(SUFFIX));
  assert.notEqual(res.headers['X-Request-Id'], PREFIX);
});

test('provider timeout is bounded and sanitized', async () => {
  const logs = [];
  const handler = createPasswordRangeHandler({
    rateLimiter: ALLOW_RATE,
    timeoutMs: 5,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () =>
            reject(
              Object.assign(new Error('contains provider details'), {
                name: 'AbortError',
              }),
            ),
          { once: true },
        );
      }),
    logger: { warn: (...items) => logs.push(items) },
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, 'password_range_unavailable');
  assert.match(JSON.stringify(logs), /provider_timeout/);
  assert.doesNotMatch(JSON.stringify(logs), /provider details/);
});

test('malformed or oversized upstream ranges fail closed at the proxy boundary', async () => {
  for (const providerBody of [
    'not-a-range-row',
    `${'A'.repeat(35)}:not-a-count`,
    'A'.repeat(256_001),
  ]) {
    const handler = createPasswordRangeHandler({
      rateLimiter: ALLOW_RATE,
      fetchImpl: async () =>
        new Response(providerBody, { status: 200 }),
      logger: { warn: () => undefined },
    });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error.code, 'password_range_unavailable');
  }
});

test('valid high-cardinality ranges are preserved within the byte boundary', async () => {
  const providerRows = Array.from(
    { length: 2_200 },
    (_, index) =>
      `${index.toString(16).toUpperCase().padStart(35, '0')}:0`,
  );
  const handler = createPasswordRangeHandler({
    rateLimiter: ALLOW_RATE,
    fetchImpl: async () =>
      new Response(providerRows.join('\r\n'), { status: 200 }),
    logger: { warn: () => undefined },
  });
  const res = response();

  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.trim().split(/\r?\n/).length, providerRows.length);
});

test('range endpoint is method-restricted and rate-limited before provider access', async () => {
  let calls = 0;
  const wrongMethodHandler = createPasswordRangeHandler({
    rateLimiter: ALLOW_RATE,
    fetchImpl: async () => {
      calls += 1;
      return new Response(`${SUFFIX}:1`, { status: 200 });
    },
  });
  const wrongMethod = response();
  await wrongMethodHandler(request({ method: 'GET' }), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.Allow, 'POST');
  assert.equal(calls, 0);

  const limitedHandler = createPasswordRangeHandler({
    rateLimiter: {
      check: async () => {
        throw new ProvisioningRateLimitError(17);
      },
    },
    fetchImpl: async () => {
      calls += 1;
      return new Response(`${SUFFIX}:1`, { status: 200 });
    },
  });
  const limited = response();
  await limitedHandler(request(), limited);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  assert.equal(limited.headers['Retry-After'], '17');
  assert.equal(calls, 0);
});
