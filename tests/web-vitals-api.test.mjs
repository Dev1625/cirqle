import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createVitalsHandler,
  normalizeVitals,
} from '../api/telemetry/vitals.js';

const valid = {
  route: '/app/directory/:contactId',
  metrics: [
    { name: 'LCP', value: 1720.4 },
    { name: 'CLS', value: 0.042 },
  ],
  viewport: { widthBucket: 480, mobile: true },
};

function response() {
  return {
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

test('accepts only bounded, non-identifying app metrics', () => {
  assert.deepEqual(normalizeVitals(valid), valid);
  assert.equal(
    normalizeVitals({ ...valid, route: '/app/directory/private-contact-id' }),
    null,
  );
  assert.deepEqual(
    normalizeVitals({
      ...valid,
      metrics: [
        ...valid.metrics,
        { name: 'EMAIL', value: 1 },
        { name: 'LCP', value: -1 },
      ],
    })?.metrics,
    valid.metrics,
  );
});

test('logs normalized metrics and returns no identifiers', async () => {
  const events = [];
  const handler = createVitalsHandler({
    limiter: { check: async () => ({}) },
    logger: { info: (...args) => events.push(args) },
  });
  const res = response();
  await handler(
    {
      method: 'POST',
      body: valid,
      headers: { 'x-forwarded-for': '203.0.113.4' },
    },
    res,
  );
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.payload, { accepted: true });
  assert.equal(JSON.stringify(events).includes('203.0.113.4'), false);
});
