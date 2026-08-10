import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpHandler, __testing } from '../server/mcp/server.js';

const UID = 'mcp-owner';

function response() {
  return {
    headers: {},
    ended: false,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function request(body, { method = 'POST', headers = {} } = {}) {
  return {
    method,
    url: '/api/mcp',
    headers: { 'user-agent': 'ClaudeDesktop/1.2', ...headers },
    body,
  };
}

const ALLOW_ALL = { async check() {} };

function handler(overrides = {}) {
  return createMcpHandler({
    env: {},
    logger: { error() {}, warn() {}, info() {} },
    verifyIdentity: async () => ({ uid: UID, authTime: 1_700_000_000 }),
    adminServicesFactory: () => ({ db: {} }),
    rateLimiter: ALLOW_ALL,
    ...overrides,
  });
}

async function call(body, options) {
  const res = response();
  await handler(options?.handler)(request(body, options), res);
  return res;
}

test('initialize returns tools capability and server identity', async () => {
  const res = await call({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.jsonrpc, '2.0');
  assert.equal(res.payload.id, 1);
  assert.equal(res.payload.result.protocolVersion, '2025-06-18');
  assert.ok(res.payload.result.capabilities.tools);
  assert.equal(res.payload.result.serverInfo.name, 'cirqle');
  // The instructions are how the model learns to search before writing.
  assert.match(res.payload.result.instructions, /search_contacts/);
});

// Spec: echo a supported version, otherwise answer with our latest and let the
// client decide whether it can continue.
test('negotiates the protocol version', async () => {
  for (const supported of __testing.SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(__testing.negotiateVersion(supported), supported);
  }
  assert.equal(
    __testing.negotiateVersion('1999-01-01'),
    __testing.LATEST_PROTOCOL_VERSION,
  );
  assert.equal(
    __testing.negotiateVersion(undefined),
    __testing.LATEST_PROTOCOL_VERSION,
  );
});

test('notifications are acknowledged with no body', async () => {
  const res = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res.statusCode, 202);
  assert.equal(res.ended, true);
  assert.equal(res.payload, undefined);
});

// The schemas are the field contract the model reads, so a tool without a real
// description is a tool the model will use badly. The exact menu is asserted in
// 'the full tool menu is advertised' below.
test('every advertised tool carries a usable schema', async () => {
  const res = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  assert.ok(res.payload.result.tools.length > 0);
  for (const tool of res.payload.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(
      tool.description.length > 20,
      `${tool.name} needs a description the model can act on`,
    );
  }
});

test('rejects anything but POST', async () => {
  const res = await call({}, { method: 'GET' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST');
});

test('unauthenticated calls get a 401 that tells the client to authenticate', async () => {
  const res = await call(
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    {
      handler: {
        verifyIdentity: async () => {
          const error = new Error('nope');
          error.code = 'unauthorized';
          throw error;
        },
      },
    },
  );

  assert.equal(res.statusCode, 401);
  assert.match(res.headers['www-authenticate'], /Bearer/);
});

test('malformed and batched payloads are refused', async () => {
  const notObject = await call('nonsense');
  assert.equal(notObject.statusCode, 400);
  assert.equal(notObject.payload.error.code, -32700);

  // Batching left the spec in 2025-06-18; half-handling an array would be worse
  // than refusing it.
  const batched = await call([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.equal(batched.statusCode, 400);
  assert.equal(batched.payload.error.code, -32600);

  const wrongVersion = await call({ jsonrpc: '1.0', id: 1, method: 'ping' });
  assert.equal(wrongVersion.statusCode, 400);
  assert.equal(wrongVersion.payload.error.code, -32600);
});

test('an unknown method is a JSON-RPC method-not-found', async () => {
  const res = await call({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  assert.equal(res.payload.error.code, -32601);
});

// A tool that fails is a normal outcome the model should read and react to.
// Reporting it as a JSON-RPC error would instead look like the transport broke.
test('a failing tool returns an isError result, not a protocol error', async () => {
  const res = await call({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'get_contact', arguments: { contactId: 'bad/id' } },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.error, undefined);
  assert.equal(res.payload.result.isError, true);
  assert.match(res.payload.result.content[0].text, /invalid_contact/);
});

test('a missing tool name is an invalid-params error', async () => {
  const res = await call({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {},
  });
  assert.equal(res.payload.error.code, -32602);
});

test('rate limiting surfaces as a retryable tool result', async () => {
  const res = await call(
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'search_contacts', arguments: {} },
    },
    {
      handler: {
        rateLimiter: {
          async check() {
            const { ProvisioningRateLimitError } = await import(
              '../server/api/_lib/rate-limit.js'
            );
            throw new ProvisioningRateLimitError(30);
          },
        },
      },
    },
  );

  assert.equal(res.payload.result.isError, true);
  assert.match(res.payload.result.content[0].text, /rate_limited/);
  assert.equal(res.headers['retry-after'], '30');
});

test('responses are never cached and vary on Authorization', async () => {
  const res = await call({ jsonrpc: '2.0', id: 8, method: 'ping' });
  assert.match(res.headers['cache-control'], /no-store/);
  assert.equal(res.headers.vary, 'Authorization');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(res.payload.result, {});
});

// The safety promise is "an agent can add, never remove". A promise in a
// comment decays; this fails the build if a destructive tool ever appears,
// including one added by someone who never read the comment.
test('no tool an agent can call is destructive', async () => {
  const { DESTRUCTIVE_NAME_PATTERN, MCP_TOOLS } = await import(
    '../server/api/_lib/mcp-tools.js'
  );

  for (const tool of MCP_TOOLS) {
    assert.doesNotMatch(
      tool.name,
      DESTRUCTIVE_NAME_PATTERN,
      `${tool.name} looks destructive — agents get additive tools only`,
    );
  }

  // And prove the guard actually bites, so it cannot rot into a no-op.
  assert.match('delete_contact', DESTRUCTIVE_NAME_PATTERN);
  assert.match('merge_duplicates', DESTRUCTIVE_NAME_PATTERN);
  assert.doesNotMatch('upsert_contacts', DESTRUCTIVE_NAME_PATTERN);
});

test('the full tool menu is advertised', async () => {
  const res = await call({ jsonrpc: '2.0', id: 20, method: 'tools/list' });
  assert.deepEqual(res.payload.result.tools.map((t) => t.name).sort(), [
    'add_note',
    'get_contact',
    'log_interaction',
    'log_meeting',
    'search_contacts',
    'upsert_contacts',
  ]);
});

// RFC 9728 5.1 / MCP spec: the 401 must point at the protected-resource
// metadata. A bare realm leaves a connector with no way to find the
// authorization server, which is exactly why claude.ai could not connect.
test('the 401 tells a client where to discover the authorization server', async () => {
  const res = await call(
    { jsonrpc: '2.0', id: 30, method: 'tools/list' },
    {
      handler: {
        verifyIdentity: async () => {
          const error = new Error('nope');
          error.code = 'unauthorized';
          throw error;
        },
      },
    },
  );

  assert.equal(res.statusCode, 401);
  assert.match(
    res.headers['www-authenticate'],
    /resource_metadata="https:\/\/[^"]+\/\.well-known\/oauth-protected-resource"/,
  );
});

test('a Cirqle OAuth access token authenticates without Firebase', async () => {
  const { getOAuthConfig, signAccessToken } = await import(
    '../server/api/_lib/oauth.js'
  );
  const env = {
    MCP_OAUTH_SIGNING_SECRET: 'b'.repeat(48),
    MCP_OAUTH_ISSUER: 'https://cirqle.test',
  };
  const token = signAccessToken({
    config: getOAuthConfig(env),
    uid: 'oauth-user',
    clientId: 'client-1',
    scope: 'cirqle.read cirqle.write',
  });

  const res = response();
  await createMcpHandler({
    env,
    logger: { error() {}, warn() {}, info() {} },
    // Firebase must not be consulted at all when a valid OAuth token is present.
    verifyIdentity: async () => {
      throw new Error('Firebase should not have been called');
    },
    adminServicesFactory: () => ({ db: {} }),
    rateLimiter: ALLOW_ALL,
  })(
    request(
      { jsonrpc: '2.0', id: 31, method: 'tools/list' },
      { headers: { authorization: `Bearer ${token}` } },
    ),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.ok(res.payload.result.tools.length >= 6);
});

// Audience binding is the defence against a token minted elsewhere being
// replayed here.
test('an access token for another resource is refused', async () => {
  const { getOAuthConfig, signAccessToken } = await import(
    '../server/api/_lib/oauth.js'
  );
  const env = {
    MCP_OAUTH_SIGNING_SECRET: 'c'.repeat(48),
    MCP_OAUTH_ISSUER: 'https://cirqle.test',
  };
  const config = getOAuthConfig(env);
  const foreign = signAccessToken({
    config: { ...config, resource: 'https://elsewhere.test/api/mcp' },
    uid: 'oauth-user',
    clientId: 'client-1',
    scope: 'cirqle.read',
  });

  const res = response();
  await createMcpHandler({
    env,
    logger: { error() {}, warn() {}, info() {} },
    verifyIdentity: async () => {
      const error = new Error('nope');
      error.code = 'unauthorized';
      throw error;
    },
    adminServicesFactory: () => ({ db: {} }),
    rateLimiter: ALLOW_ALL,
  })(
    request(
      { jsonrpc: '2.0', id: 32, method: 'tools/list' },
      { headers: { authorization: `Bearer ${foreign}` } },
    ),
    res,
  );

  assert.equal(res.statusCode, 401);
});
