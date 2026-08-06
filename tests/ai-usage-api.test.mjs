import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAIUsageHandler,
  fetchSpendLogPages,
} from '../server/api/ai/usage.js';

function responseRecorder() {
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
  };
}

const request = { method: 'GET', headers: { authorization: 'Bearer valid' } };
const env = {
  LITELLM_MASTER_KEY: 'master-for-tests',
  LITELLM_KEY_DERIVATION_SECRET: 'test-secret-at-least-sixteen-characters',
  LITELLM_GATEWAY_URL: 'https://gateway.example',
};

test('fails closed instead of using a browser or production gateway fallback', async () => {
  let clientFactoryCalled = false;
  const handler = createAIUsageHandler({
    env: {
      LITELLM_MASTER_KEY: 'master-for-tests',
      LITELLM_KEY_DERIVATION_SECRET:
        'test-secret-at-least-sixteen-characters',
      VITE_GATEWAY_URL:
        'https://litellm-production-2a63.up.railway.app',
    },
    logger: { error() {} },
    verifyIdentity: async () => ({ uid: 'firebase-user' }),
    liteLLMClientFactory: () => {
      clientFactoryCalled = true;
      return {};
    },
  });
  const res = responseRecorder();

  await handler(request, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'usage_unavailable');
  assert.equal(clientFactoryCalled, false);
});

test('returns only sanitized per-user usage aggregates', async () => {
  let keyLookup;
  let logLookup;
  const handler = createAIUsageHandler({
    env,
    logger: { error() {} },
    verifyIdentity: async () => ({ uid: 'firebase-user' }),
    liteLLMClientFactory: () => ({
      async getKey(hash) {
        keyLookup = hash;
        return {
          info: {
            spend: 1.25,
            max_budget: 5,
            budget_duration: '30d',
            budget_reset_at: '2026-08-28T00:00:00Z',
            secret_value: 'must-not-leak',
          },
        };
      },
      async request(path) {
        logLookup = path;
        return {
          data: [
            {
              user_id: 'firebase-user',
              spend: 0.5,
              total_tokens: 100,
              status: 'success',
              metadata: {
                cirqle_feature: 'dashboard-weekly-priorities',
              },
              prompt: 'private prompt',
            },
            {
              user_id: 'firebase-user',
              spend: 0.75,
              total_tokens: 200,
              status: 'failure',
              metadata: {
                cirqle_feature: 'dashboard-weekly-priorities',
              },
              response: 'private response',
            },
          ],
        };
      },
    }),
  });

  const res = responseRecorder();
  await handler(request, res);

  assert.equal(res.statusCode, 200);
  assert.match(keyLookup, /^[a-f0-9]{64}$/);
  assert.match(logLookup, /user_id=firebase-user/);
  assert.equal(res.body.period.spendUsd, 1.25);
  assert.equal(res.body.period.limitUsd, 5);
  assert.equal(res.body.period.percentage, 25);
  assert.equal(res.body.requestCount, 2);
  assert.equal(res.body.successfulRequests, 1);
  assert.equal(res.body.failedRequests, 1);
  assert.equal(res.body.detail.complete, true);
  assert.equal(res.body.detail.truncated, false);
  assert.equal(res.body.detail.pagesRead, 1);
  assert.match(res.body.detail.startsAt, /^20\d\d-/);
  assert.match(res.body.detail.endsAt, /^20\d\d-/);
  assert.deepEqual(res.body.features['dashboard-weekly-priorities'], {
    requests: 2,
    spendUsd: 1.25,
    tokens: 300,
    label: 'Weekly priorities',
    group: 'Dashboard',
  });
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes('must-not-leak'), false);
  assert.equal(serialized.includes('private prompt'), false);
  assert.equal(serialized.includes('private response'), false);
  assert.equal(serialized.includes('master-for-tests'), false);
});

test('keeps quick and premium outreach usage separate but in one friendly group', async () => {
  const handler = createAIUsageHandler({
    env,
    logger: { error() {} },
    verifyIdentity: async () => ({ uid: 'firebase-user' }),
    liteLLMClientFactory: () => ({
      async getKey() {
        return { info: { spend: 0.03, max_budget: 5 } };
      },
      async request() {
        return {
          data: [
            {
              user_id: 'firebase-user',
              spend: 0.01,
              total_tokens: 80,
              status: 'success',
              metadata: {
                cirqle_feature: 'contact.outreach.draft.quick',
              },
            },
            {
              user_id: 'firebase-user',
              spend: 0.02,
              total_tokens: 120,
              status: 'success',
              metadata: {
                cirqle_feature: 'contact.outreach.draft.premium',
              },
            },
          ],
        };
      },
    }),
  });

  const res = responseRecorder();
  await handler(request, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.features['contact.outreach.draft.quick'],
    {
      requests: 1,
      spendUsd: 0.01,
      tokens: 80,
      label: 'Quick outreach draft',
      group: 'Outreach',
    },
  );
  assert.deepEqual(
    res.body.features['contact.outreach.draft.premium'],
    {
      requests: 1,
      spendUsd: 0.02,
      tokens: 120,
      label: 'Premium outreach draft',
      group: 'Outreach',
    },
  );
});

test('does not allow one client to select another user', async () => {
  let queriedUid = null;
  const handler = createAIUsageHandler({
    env,
    logger: { error() {} },
    verifyIdentity: async () => ({ uid: 'owner-from-token' }),
    liteLLMClientFactory: () => ({
      async getKey() {
        return { info: { spend: 0, max_budget: 5 } };
      },
      async request(path) {
        queriedUid = new URL(path, 'https://example.test').searchParams.get(
          'user_id',
        );
        return { data: [] };
      },
    }),
  });
  const res = responseRecorder();
  await handler(
    { ...request, query: { user_id: 'somebody-else' } },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(queriedUid, 'owner-from-token');
});

test('drops foreign and unattributed spend rows even if the gateway filter regresses', async () => {
  const result = await fetchSpendLogPages({
    client: {
      async request() {
        return {
          data: [
            { id: 'owned-by-uid', user_id: 'owner' },
            {
              id: 'owned-by-key',
              metadata: { user_api_key_hash: 'managed-key-hash' },
            },
            { id: 'foreign', user_id: 'another-user', spend: 999 },
            { id: 'unattributed', spend: 999 },
          ],
        };
      },
    },
    identity: { uid: 'owner' },
    keyHash: 'managed-key-hash',
    start: new Date('2026-07-01T00:00:00Z'),
    end: new Date('2026-07-29T00:00:00Z'),
  });

  assert.deepEqual(
    result.rows.map((row) => row.id),
    ['owned-by-uid', 'owned-by-key'],
  );
});

test('usage detail paginates and discloses a bounded truncation', async () => {
  const requestedPages = [];
  const client = {
    async request(path) {
      const page = Number(
        new URL(path, 'https://gateway.example').searchParams.get('page'),
      );
      requestedPages.push(page);
      return {
        data: [{ id: `row-${page}`, user_id: 'owner' }],
        has_more: true,
      };
    },
  };
  const clock = () => 10_000;

  const result = await fetchSpendLogPages({
    client,
    identity: { uid: 'owner' },
    start: new Date('2026-07-01T00:00:00Z'),
    end: new Date('2026-07-29T00:00:00Z'),
    pageSize: 1,
    maxPages: 3,
    maxReadMs: 2_500,
    now: clock,
  });

  assert.deepEqual(requestedPages, [1, 2, 3]);
  assert.deepEqual(
    result.rows.map((row) => row.id),
    ['row-1', 'row-2', 'row-3'],
  );
  assert.equal(result.pagesRead, 3);
  assert.equal(result.truncated, true);
});
