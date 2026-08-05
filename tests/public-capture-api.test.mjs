import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPublicCaptureHandler,
  normalizeCaptureInput,
} from '../api/cards/capture.js';
import { ProvisioningRateLimitError } from '../api/_lib/rate-limit.js';

function response() {
  return {
    headers: {},
    statusCode: null,
    payload: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

const validBody = {
  cardId: '23456789ab',
  visitorName: '  Alex   Rivera ',
  visitorEmail: 'alex@example.com',
  visitorCompany: 'Cirqle',
  note: 'Met at SaaStr',
  consentToFollowUp: true,
  captureChannel: 'link',
  website: '',
};

function createHandler({
  env = {},
  appCheckVerify = async () => ({ token: {} }),
  persist = async () => ({ duplicate: false }),
  limiter = {
    check: async () => ({ limit: 8, remaining: 7, resetAt: 123 }),
  },
} = {}) {
  return createPublicCaptureHandler({
    env,
    logger: { warn() {}, error() {} },
    adminServicesFactory: () => ({
      db: {},
      appCheck: { verifyToken: appCheckVerify },
    }),
    persist,
    limiter,
    now: () => new Date('2026-07-29T12:00:00.000Z'),
  });
}

test('normalizes the strict public capture schema', () => {
  assert.deepEqual(normalizeCaptureInput(validBody), {
    cardId: '23456789ab',
    visitorName: 'Alex Rivera',
    visitorEmail: 'alex@example.com',
    visitorCompany: 'Cirqle',
    note: 'Met at SaaStr',
    consentToFollowUp: true,
    captureChannel: 'link',
    trapped: false,
  });
  assert.throws(
    () => normalizeCaptureInput({ ...validBody, cardId: '../admin' }),
    /card link is invalid/i,
  );
  assert.throws(
    () => normalizeCaptureInput({ ...validBody, visitorName: 'x'.repeat(121) }),
    /between 1 and 120/i,
  );
  assert.throws(
    () => normalizeCaptureInput({ ...validBody, visitorEmail: 'not-email' }),
    /Email is invalid/i,
  );
  assert.throws(
    () =>
      normalizeCaptureInput({
        ...validBody,
        captureChannel: 'bluetooth-beacon',
      }),
    /Capture channel is invalid/i,
  );
});

test('normalizes capture email case before replay protection and filing', () => {
  assert.equal(
    normalizeCaptureInput({
      ...validBody,
      visitorEmail: '  ALEX.RIVERA@EXAMPLE.COM ',
    }).visitorEmail,
    'alex.rivera@example.com',
  );
});

test('capture channel is allowlisted and unmarked URLs stay direct', () => {
  for (const captureChannel of ['qr', 'nfc', 'link', 'direct']) {
    assert.equal(
      normalizeCaptureInput({ ...validBody, captureChannel }).captureChannel,
      captureChannel,
    );
  }
  const { captureChannel, ...withoutChannel } = validBody;
  assert.equal(captureChannel, 'link');
  assert.equal(
    normalizeCaptureInput(withoutChannel).captureChannel,
    'direct',
  );
});

test('honeypot submissions return success without writing', async () => {
  let writes = 0;
  const handler = createHandler({
    persist: async () => {
      writes += 1;
    },
  });
  const res = response();
  await handler(
    {
      method: 'POST',
      body: { ...validBody, website: 'https://spam.example' },
      headers: {},
    },
    res,
  );
  assert.equal(res.statusCode, 202);
  assert.equal(writes, 0);
  assert.deepEqual(res.payload, { accepted: true });
});

test('App Check can run in monitor mode without blocking a visitor', async () => {
  let writes = 0;
  const handler = createHandler({
    appCheckVerify: async () => {
      throw new Error('invalid');
    },
    persist: async () => {
      writes += 1;
    },
  });
  const res = response();
  await handler(
    {
      method: 'POST',
      body: validBody,
      headers: { 'x-firebase-appcheck': 'invalid-monitor-token' },
    },
    res,
  );
  assert.equal(res.statusCode, 202);
  assert.equal(writes, 1);
});

test('App Check enforcement rejects missing or invalid tokens', async () => {
  const handler = createHandler({
    env: { FIREBASE_APP_CHECK_ENFORCED: 'true' },
    appCheckVerify: async () => {
      throw new Error('invalid');
    },
  });

  for (const headers of [{}, { 'x-firebase-appcheck': 'invalid' }]) {
    const res = response();
    await handler({ method: 'POST', body: validBody, headers }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.error.code, 'app_check_required');
  }
});

test('rate limits before persistence and does not leak internals', async () => {
  let writes = 0;
  const handler = createHandler({
    limiter: {
      check: async () => {
        throw new ProvisioningRateLimitError(30);
      },
    },
    persist: async () => {
      writes += 1;
    },
  });
  const res = response();
  await handler({ method: 'POST', body: validBody, headers: {} }, res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '30');
  assert.equal(writes, 0);
  assert.equal(
    res.payload.error.message,
    'Too many saves. Please wait a moment and try again.',
  );
});

test('persists only normalized fields and returns no capture identifiers', async () => {
  let received;
  const handler = createHandler({
    persist: async (input) => {
      received = input;
      return { duplicate: false, captureId: 'must-not-leak' };
    },
  });
  const res = response();
  await handler(
    {
      method: 'POST',
      body: validBody,
      headers: {
        'x-firebase-appcheck': 'valid',
        'x-forwarded-for': '203.0.113.8',
      },
    },
    res,
  );
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.payload, { accepted: true });
  assert.equal(received.input.visitorName, 'Alex Rivera');
  assert.equal(received.input.captureChannel, 'link');
  assert.equal(received.input.website, undefined);
  assert.equal(received.now.toISOString(), '2026-07-29T12:00:00.000Z');
});
