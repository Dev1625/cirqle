import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCSPReportHandler,
  normalizeCSPReport,
} from '../api/telemetry/csp.js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test('CSP reports retain origins and route buckets but drop paths and ids', () => {
  assert.deepEqual(
    normalizeCSPReport({
      'csp-report': {
        'effective-directive': 'connect-src',
        'blocked-uri':
          'https://unexpected.example/private/user-123?token=secret',
        'document-uri':
          'https://cirqle.test/app/directory/private-contact-id',
        'source-file':
          'https://cirqle.test/assets/index-private-hash.js',
        disposition: 'report',
      },
    }),
    {
      effectiveDirective: 'connect-src',
      blockedOrigin: 'https://unexpected.example',
      documentRoute: '/app/directory/:contactId',
      sourceOrigin: 'https://cirqle.test',
      disposition: 'report',
    },
  );
});

test('CSP endpoint rate-limits and logs only normalized report fields', async () => {
  const logs = [];
  const handler = createCSPReportHandler({
    limiter: { async check() {} },
    logger: {
      info(message, payload) {
        logs.push({ message, payload });
      },
    },
  });
  const response = responseRecorder();
  await handler(
    {
      method: 'POST',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      body: {
        'csp-report': {
          'effective-directive': 'script-src-elem',
          'blocked-uri':
            'https://blocked.test/path?credential=private',
          'document-uri': 'https://cirqle.test/app',
          'source-file': 'https://cirqle.test/assets/app.js',
        },
      },
    },
    response,
  );
  assert.equal(response.statusCode, 202);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('credential'), false);
  assert.equal(serialized.includes('/path'), false);
  assert.equal(serialized.includes('127.0.0.1'), false);
  assert.match(serialized, /https:\/\/blocked\.test/);
});

test('CSP endpoint rejects invalid and oversized payloads', async () => {
  const handler = createCSPReportHandler({
    limiter: { async check() {} },
    logger: { info() {} },
  });
  const invalid = responseRecorder();
  await handler(
    { method: 'POST', headers: {}, body: { anything: 'else' } },
    invalid,
  );
  assert.equal(invalid.statusCode, 400);

  const oversized = responseRecorder();
  await handler(
    {
      method: 'POST',
      headers: {},
      body: {
        'csp-report': {
          'effective-directive': 'script-src',
          padding: 'x'.repeat(8_100),
        },
      },
    },
    oversized,
  );
  assert.equal(oversized.statusCode, 400);
});
