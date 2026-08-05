import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkPasswordBreach,
  screenNewPassword,
} from '../src/lib/passwordBreach';

const PASSWORD_SHA1 =
  '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8';
const PREFIX = PASSWORD_SHA1.slice(0, 5);
const SUFFIX = PASSWORD_SHA1.slice(5);

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

function bytesFromHex(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

const fixedCrypto = {
  subtle: {
    digest: async () => bytesFromHex(PASSWORD_SHA1),
  },
} as unknown as Crypto;

test('client hashes locally and sends only the five-character prefix', async () => {
  const sourcePassword = 'password';
  let requestBody = '';
  let requestCredentials: RequestCredentials | undefined;
  const result = await checkPasswordBreach(sourcePassword, {
    fetchImpl: async (_input, init) => {
      requestBody = String(init?.body || '');
      requestCredentials = init?.credentials;
      return response(
        `00000000000000000000000000000000000:0\r\n${SUFFIX}:3303003\r\n`,
      );
    },
    enabled: true,
    online: () => true,
  });

  assert.equal(result.status, 'breached');
  if (result.status === 'breached') {
    assert.equal(result.prevalence, 3_303_003);
  }
  assert.deepEqual(JSON.parse(requestBody), { prefix: PREFIX });
  assert.equal(requestBody.includes(sourcePassword), false);
  assert.equal(requestBody.includes(PASSWORD_SHA1), false);
  assert.equal(requestBody.includes(SUFFIX), false);
  assert.equal(requestCredentials, 'omit');
});

test('a missing suffix is safe and padded zero-count rows do not block', async () => {
  const result = await checkPasswordBreach('password', {
    fetchImpl: async () =>
      response(
        '00000000000000000000000000000000000:0\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:2\r\n',
      ),
    enabled: true,
    online: () => true,
  });
  assert.deepEqual(result, { status: 'safe' });
});

test('a zero-count padded collision cannot hide a later breached match', async () => {
  const result = await checkPasswordBreach('password', {
    fetchImpl: async () =>
      response(`${SUFFIX}:0\r\n${SUFFIX}:41\r\n`),
    enabled: true,
    online: () => true,
  });
  assert.deepEqual(result, { status: 'breached', prevalence: 41 });
});

test('client rejects a partially malformed proxy response', async () => {
  const result = await checkPasswordBreach('password', {
    fetchImpl: async () =>
      response(`${SUFFIX}:0\r\nnot-a-range-row\r\n`),
    enabled: true,
    online: () => true,
  });
  assert.deepEqual(result, { status: 'unavailable', reason: 'service' });
});

test('offline, disabled, unsupported, and service failures are explicit and do not throw', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return response('', 503);
  };
  assert.deepEqual(
    await checkPasswordBreach('password', {
      fetchImpl,
      enabled: false,
    }),
    { status: 'unavailable', reason: 'disabled' },
  );
  assert.deepEqual(
    await checkPasswordBreach('password', {
      fetchImpl,
      enabled: true,
      online: () => false,
    }),
    { status: 'unavailable', reason: 'offline' },
  );
  assert.equal(fetchCalls, 0);

  assert.deepEqual(
    await checkPasswordBreach('password', {
      fetchImpl,
      cryptoImpl: {} as Crypto,
      enabled: true,
      online: () => true,
    }),
    { status: 'unavailable', reason: 'unsupported' },
  );
  assert.deepEqual(
    await checkPasswordBreach('password', {
      fetchImpl,
      enabled: true,
      online: () => true,
    }),
    { status: 'unavailable', reason: 'service' },
  );
});

test('client timeout aborts the request and returns a fixed unavailable reason', async () => {
  const result = await checkPasswordBreach('password', {
    timeoutMs: 5,
    enabled: true,
    online: () => true,
    fetchImpl: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () =>
            reject(
              Object.assign(new Error('raw network internals'), {
                name: 'AbortError',
              }),
            ),
          { once: true },
        );
      }),
  });
  assert.deepEqual(result, { status: 'unavailable', reason: 'timeout' });
});

test('cancelling during local hashing never sends a stale prefix', async () => {
  let releaseDigest: ((value: ArrayBuffer) => void) | undefined;
  let signalDigestStarted: (() => void) | undefined;
  const digestStarted = new Promise<void>((resolve) => {
    signalDigestStarted = resolve;
  });
  const delayedCrypto = {
    subtle: {
      digest: async () => {
        signalDigestStarted?.();
        return new Promise<ArrayBuffer>((resolve) => {
          releaseDigest = resolve;
        });
      },
    },
  } as unknown as Crypto;
  const controller = new AbortController();
  let fetchCalls = 0;
  const pending = checkPasswordBreach('LongEnoughSeahorse!', {
    cryptoImpl: delayedCrypto,
    signal: controller.signal,
    enabled: true,
    online: () => true,
    fetchImpl: async () => {
      fetchCalls += 1;
      return response(`${SUFFIX}:1\r\n`);
    },
  });

  await digestStarted;
  controller.abort();
  releaseDigest?.(bytesFromHex(PASSWORD_SHA1));

  assert.deepEqual(await pending, {
    status: 'unavailable',
    reason: 'cancelled',
  });
  assert.equal(fetchCalls, 0);
});

test('screening preserves local rules, blocks a corpus match, and fails open only on availability', async () => {
  let calls = 0;
  const localFailure = await screenNewPassword('Password123!', {
    fetchImpl: async () => {
      calls += 1;
      return response(`${SUFFIX}:1`);
    },
  });
  assert.equal(localFailure.accepted, false);
  assert.equal(localFailure.reason, 'local-requirements');
  assert.equal(calls, 0);

  const breached = await screenNewPassword('LongEnoughSeahorse!', {
    cryptoImpl: fixedCrypto,
    enabled: true,
    online: () => true,
    fetchImpl: async () => response(`${SUFFIX}:9\r\n`),
  });
  assert.equal(breached.accepted, false);
  assert.equal(breached.reason, 'known-breach');

  const unavailable = await screenNewPassword('LongEnoughSeahorse!', {
    cryptoImpl: fixedCrypto,
    enabled: true,
    online: () => true,
    fetchImpl: async () => response('', 503),
  });
  assert.equal(unavailable.accepted, true);
  assert.equal(unavailable.reason, 'accepted');
  assert.deepEqual(unavailable.breach, {
    status: 'unavailable',
    reason: 'service',
  });
});
