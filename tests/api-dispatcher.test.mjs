import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  API_ROUTE_PATHS,
  createApiDispatcher,
  routePathFromRequest,
} from '../server/vercel-api-dispatcher.js';

const SERVER_API_ROOT = fileURLToPath(
  new URL('../server/api/', import.meta.url),
);

function routeModules(directory = SERVER_API_ROOT) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '_lib') return [];
      return routeModules(absolute);
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) return [];
    return [
      path
        .relative(SERVER_API_ROOT, absolute)
        .replaceAll(path.sep, '/')
        .replace(/\.js$/u, ''),
    ];
  });
}

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

test('registers every server API handler exactly once', () => {
  assert.deepEqual(
    [...API_ROUTE_PATHS].sort(),
    routeModules().sort(),
  );
  assert.equal(new Set(API_ROUTE_PATHS).size, API_ROUTE_PATHS.length);
  assert.equal(API_ROUTE_PATHS.length, 23);
});

test('derives only exact same-origin API paths and ignores query values', () => {
  assert.equal(
    routePathFromRequest({ url: '/api/contacts/profile?path=ai/chat' }),
    'contacts/profile',
  );
  assert.equal(
    routePathFromRequest({ url: '/api/account/export/' }),
    'account/export',
  );
  assert.equal(
    routePathFromRequest({
      url: '/api/ai/chat?group=account&route=delete',
      query: { group: 'account', route: 'delete' },
    }),
    'ai/chat',
  );
  assert.equal(
    routePathFromRequest({ url: '/api?route=ai%2Fchat' }),
    null,
  );
  assert.equal(routePathFromRequest({ url: '/api/' }), null);
  assert.equal(routePathFromRequest({ url: '/app/directory' }), null);
  assert.equal(routePathFromRequest({ url: '/api//ai/chat' }), null);
  assert.equal(
    routePathFromRequest({ url: '/api/x/../account/delete' }),
    null,
  );
  assert.equal(
    routePathFromRequest({ url: '/api/x/%2e%2e/account/delete' }),
    null,
  );
  assert.equal(routePathFromRequest({ url: '/api/ai%2fchat' }), null);
  assert.equal(routePathFromRequest({ url: '/api/ai\\chat' }), null);
  assert.equal(
    routePathFromRequest({ url: 'https://example.com/api/ai/chat' }),
    null,
  );
  assert.equal(routePathFromRequest({ url: 'http://[invalid' }), null);
});

test('dispatches without changing the request, response, or handler result', async () => {
  const req = { url: '/api/example/route?value=1', method: 'PATCH' };
  const res = response();
  const expected = { handled: true };
  let received = null;
  const dispatcher = createApiDispatcher({
    routes: {
      'example/route': async (handlerReq, handlerRes) => {
        received = { handlerReq, handlerRes };
        return expected;
      },
    },
  });

  assert.equal(await dispatcher(req, res), expected);
  assert.deepEqual(received, { handlerReq: req, handlerRes: res });
});

test('returns a stable no-store 404 for unknown and internal module paths', async () => {
  for (const url of ['/api/not-real', '/api/_lib/http']) {
    const res = response();
    await createApiDispatcher({ routes: {} })({ url, method: 'GET' }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.payload, {
      error: {
        code: 'not_found',
        message: 'API route not found.',
      },
    });
    assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  }
});
