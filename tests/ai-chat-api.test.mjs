import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createAIChatHandler } from '../server/api/ai/chat.js';

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

function eventedResponseRecorder() {
  return Object.assign(new EventEmitter(), responseRecorder(), {
    writableEnded: false,
    destroyed: false,
  });
}

function request(body = {}, authorization = 'Bearer valid') {
  return {
    method: 'POST',
    body,
    headers: { authorization },
  };
}

function validBody(overrides = {}) {
  return {
    feature: 'dashboard-weekly-priorities',
    model: 'deepseek-v4-flash',
    prompt: 'Answer only from saved facts.',
    ...overrides,
  };
}

const env = {
  LITELLM_GATEWAY_URL: 'https://gateway.example',
  LITELLM_KEY_DERIVATION_SECRET: 'test-secret-at-least-sixteen-characters',
};

const identity = {
  uid: 'firebase-user',
  email: 'dev@example.com',
  emailVerified: true,
};
const silentLogger = { error() {}, warn() {}, info() {} };

test('rejects unauthenticated callers before contacting the gateway', async () => {
  let contacted = false;
  const handler = createAIChatHandler({
    env,
    logger: silentLogger,
    verifyIdentity: async () => {
      const error = new Error('no');
      error.code = 'unauthorized';
      throw error;
    },
    fetchImpl: async () => {
      contacted = true;
    },
  });
  const res = responseRecorder();
  await handler(request(validBody()), res);
  assert.equal(res.statusCode, 401);
  assert.equal(contacted, false);
});

test('requires a known feature before selecting any model', async () => {
  let contacted = false;
  const handler = createAIChatHandler({
    env,
    logger: silentLogger,
    verifyIdentity: async () => identity,
    fetchImpl: async () => {
      contacted = true;
    },
  });

  const missingRes = responseRecorder();
  await handler(
    request({ model: 'deepseek-v4-flash', prompt: 'Hello' }),
    missingRes,
  );
  assert.equal(missingRes.statusCode, 400);
  assert.equal(missingRes.body.error, 'feature_required');

  const unknownRes = responseRecorder();
  await handler(
    request(validBody({ feature: 'made-up-premium-task' })),
    unknownRes,
  );
  assert.equal(unknownRes.statusCode, 400);
  assert.equal(unknownRes.body.error, 'feature_not_allowed');
  assert.equal(contacted, false);
});

test('fails closed without an explicit gateway and dedicated derivation secret', async () => {
  const configurations = [
    {
      LITELLM_KEY_DERIVATION_SECRET:
        'test-secret-at-least-sixteen-characters',
      VITE_GATEWAY_URL:
        'https://litellm-production-2a63.up.railway.app',
    },
    {
      LITELLM_GATEWAY_URL: 'https://gateway.example',
      LITELLM_MASTER_KEY: 'shared-secret-must-not-be-reused',
    },
    {
      LITELLM_GATEWAY_URL: 'https://gateway.example',
      LITELLM_MASTER_KEY: 'same-secret-at-least-sixteen',
      LITELLM_KEY_DERIVATION_SECRET:
        'same-secret-at-least-sixteen',
    },
  ];

  for (const candidateEnv of configurations) {
    let contacted = false;
    const handler = createAIChatHandler({
      env: candidateEnv,
      logger: silentLogger,
      verifyIdentity: async () => identity,
      fetchImpl: async () => {
        contacted = true;
      },
    });
    const res = responseRecorder();

    await handler(request(validBody()), res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'ai-not-provisioned');
    assert.equal(contacted, false);
  }
});

test('rejects models outside the production allowlist', async () => {
  const handler = createAIChatHandler({
    env,
    logger: silentLogger,
    verifyIdentity: async () => identity,
  });
  const res = responseRecorder();
  await handler(
    request(validBody({ model: 'arbitrary-provider-model' })),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'model_not_allowed');
});

test('rejects an allowed alias when it does not match the feature policy', async () => {
  let contacted = false;
  const handler = createAIChatHandler({
    env,
    logger: silentLogger,
    verifyIdentity: async () => identity,
    fetchImpl: async () => {
      contacted = true;
    },
  });
  const res = responseRecorder();
  await handler(
    request(
      validBody({
        model: 'deepseek-v4-pro',
        feature: 'dashboard-weekly-priorities',
      }),
    ),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'model_feature_mismatch');
  assert.equal(contacted, false);
});

test('requires verified email before paid model calls', async () => {
  for (const candidate of [
    {
      uid: 'firebase-user',
      email: 'unverified@example.com',
      emailVerified: false,
    },
    {
      uid: 'firebase-user',
      email: null,
      emailVerified: false,
    },
  ]) {
    let contacted = false;
    const handler = createAIChatHandler({
      env,
      logger: silentLogger,
      verifyIdentity: async () => candidate,
      fetchImpl: async () => {
        contacted = true;
      },
    });
    const res = responseRecorder();
    await handler(request(validBody()), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'email_verification_required');
    assert.equal(contacted, false);
  }
});

test('rejects oversized prompts and output budgets', async () => {
  const handler = createAIChatHandler({
    env,
    logger: silentLogger,
    verifyIdentity: async () => identity,
  });

  const promptRes = responseRecorder();
  await handler(
    request({
      feature: 'directory-csv-import',
      model: 'gemini-3.5-flash-lite',
      prompt: 'x'.repeat(60_001),
    }),
    promptRes,
  );
  assert.equal(promptRes.statusCode, 400);
  assert.equal(promptRes.body.error, 'invalid_prompt');

  const tokenRes = responseRecorder();
  await handler(
    request({
      feature: 'directory-csv-import',
      model: 'gemini-3.5-flash-lite',
      prompt: 'Hello',
      maxTokens: 4_001,
    }),
    tokenRes,
  );
  assert.equal(tokenRes.statusCode, 400);
  assert.equal(tokenRes.body.error, 'invalid_max_tokens');

  const policyTokenRes = responseRecorder();
  await handler(
    request(validBody({ maxTokens: 501 })),
    policyTokenRes,
  );
  assert.equal(policyTokenRes.statusCode, 400);
  assert.equal(
    policyTokenRes.body.error,
    'max_tokens_exceeds_policy',
  );
});

test('rejects temperatures above the feature ceiling', async () => {
  let contacted = false;
  const handler = createAIChatHandler({
    env,
    logger: silentLogger,
    verifyIdentity: async () => identity,
    fetchImpl: async () => {
      contacted = true;
    },
  });
  const res = responseRecorder();
  await handler(
    request(
      validBody({
        feature: 'contact.tags.extract',
        model: 'gemini-3.5-flash-lite',
        temperature: 0.1,
      }),
    ),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'temperature_exceeds_policy');
  assert.equal(contacted, false);
});

test('derives the model and default limits from the feature policy', async () => {
  let forwarded;
  const handler = createAIChatHandler({
    env,
    logger: silentLogger,
    verifyIdentity: async () => identity,
    fetchImpl: async (url, init) => {
      forwarded = { url: String(url), init, body: JSON.parse(init.body) };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '  grounded answer  ' } }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  const res = responseRecorder();
  await handler(
    request({
      prompt: 'Answer only from facts',
      feature: 'dashboard-weekly-priorities',
      json: true,
      temperature: 0.2,
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.text, 'grounded answer');
  assert.deepEqual(res.body.usage, {
    promptTokens: 12,
    completionTokens: 4,
    totalTokens: 16,
  });
  assert.equal(
    res.body.feature,
    'dashboard-weekly-priorities',
  );
  assert.equal(res.body.model, 'deepseek-v4-flash');
  assert.equal(res.body.tier, 'reasoning');
  assert.equal(
    forwarded.url,
    'https://gateway.example/v1/chat/completions',
  );
  assert.equal(
    forwarded.body.metadata.cirqle_feature,
    'dashboard-weekly-priorities',
  );
  assert.equal(forwarded.body.metadata.cirqle_tier, 'reasoning');
  assert.equal(forwarded.body.model, 'deepseek-v4-flash');
  assert.equal(forwarded.body.max_tokens, 500);
  assert.equal(forwarded.body.temperature, 0.2);
  assert.deepEqual(forwarded.body.response_format, {
    type: 'json_object',
  });
  assert.equal(
    Object.hasOwn(forwarded.body, 'stream'),
    false,
    'grounded JSON envelopes must be validated before they are disclosed',
  );
  assert.match(forwarded.init.headers.Authorization, /^Bearer sk-cirqle-/);
  assert.equal(
    JSON.stringify(forwarded).includes(
      'test-secret-at-least-sixteen-characters',
    ),
    false,
  );
});

test('keeps the synthetic smoke feature restricted to its tiny exact request', async () => {
  let contacted = 0;
  const handler = createAIChatHandler({
    env,
    logger: silentLogger,
    verifyIdentity: async () => identity,
    fetchImpl: async (_url, init) => {
      contacted += 1;
      const payload = JSON.parse(init.body);
      assert.equal(payload.model, 'gemini-3.5-flash-lite');
      assert.equal(payload.max_tokens, 8);
      assert.equal('temperature' in payload, false);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'OK' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  const validRes = responseRecorder();
  await handler(
    request({
      feature: 'production-signup-smoke',
      prompt: 'Reply with only OK.',
    }),
    validRes,
  );
  assert.equal(validRes.statusCode, 200);
  assert.equal(contacted, 1);

  const promptRes = responseRecorder();
  await handler(
    request({
      feature: 'production-signup-smoke',
      prompt: 'Write me an email.',
    }),
    promptRes,
  );
  assert.equal(promptRes.statusCode, 400);
  assert.equal(promptRes.body.error, 'invalid_synthetic_request');

  const tokenRes = responseRecorder();
  await handler(
    request({
      feature: 'production-signup-smoke',
      prompt: 'Reply with only OK.',
      maxTokens: 9,
    }),
    tokenRes,
  );
  assert.equal(tokenRes.statusCode, 400);
  assert.equal(tokenRes.body.error, 'max_tokens_exceeds_policy');

  const jsonRes = responseRecorder();
  await handler(
    request({
      feature: 'production-signup-smoke',
      prompt: 'Reply with only OK.',
      json: true,
    }),
    jsonRes,
  );
  assert.equal(jsonRes.statusCode, 400);
  assert.equal(jsonRes.body.error, 'invalid_synthetic_request');
  assert.equal(contacted, 1);
});

test('does not leak provider error bodies', async () => {
  const handler = createAIChatHandler({
    env,
    logger: silentLogger,
    verifyIdentity: async () => identity,
    fetchImpl: async () =>
      new Response('provider stack trace and secret', { status: 500 }),
  });
  const res = responseRecorder();
  await handler(
    request({
      model: 'deepseek-v4-pro',
      feature: 'digital-card-draft',
      prompt: 'Draft something',
    }),
    res,
  );
  assert.equal(res.statusCode, 502);
  assert.deepEqual(Object.keys(res.body).sort(), ['error', 'requestId']);
  assert.equal(JSON.stringify(res.body).includes('provider'), false);
  assert.equal(JSON.stringify(res.body).includes('secret'), false);
});

test('a closed browser request aborts the upstream model request', async () => {
  let upstreamAborted = false;
  const handler = createAIChatHandler({
    env,
    logger: silentLogger,
    verifyIdentity: async () => identity,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          upstreamAborted = true;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });
  const res = eventedResponseRecorder();
  const pending = handler(
    request({
      model: 'deepseek-v4-pro',
      feature: 'digital-card-draft',
      prompt: 'Draft something',
    }),
    res,
  );
  await new Promise((resolve) => setImmediate(resolve));
  res.emit('close');
  await pending;
  assert.equal(upstreamAborted, true);
  assert.equal(res.statusCode, 499);
  assert.equal(res.body.error, 'request_cancelled');
});
