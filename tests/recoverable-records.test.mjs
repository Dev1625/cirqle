import assert from 'node:assert/strict';
import test from 'node:test';

import {
  purgeExpiredRecoverableRecords,
} from '../server/api/_lib/recoverable-records.js';

test('recoverable cleanup deletes only expired records still marked deleted', async () => {
  const deleted = [];
  const paths = [];
  const snapshots = {
    templates: [
      {
        ref: { path: 'users/u/templates/deleted' },
        data: () => ({ lifecycleStatus: 'deleted' }),
      },
      {
        ref: { path: 'users/u/templates/restored' },
        data: () => ({ lifecycleStatus: 'active' }),
      },
    ],
    outreaches: [
      {
        ref: { path: 'users/u/outreaches/deleted' },
        data: () => ({ trackerLifecycleStatus: 'deleted' }),
      },
    ],
  };
  const db = {
    collection(path) {
      paths.push(path);
      const key = path.endsWith('/templates')
        ? 'templates'
        : 'outreaches';
      const docs = snapshots[key];
      const chain = {
        where() {
          return chain;
        },
        orderBy() {
          return chain;
        },
        limit() {
          return chain;
        },
        async get() {
          return { docs, size: docs.length };
        },
      };
      return chain;
    },
    batch() {
      return {
        delete(ref) {
          deleted.push(ref.path);
        },
        async commit() {},
      };
    },
  };

  const result = await purgeExpiredRecoverableRecords({
    db,
    uid: 'u',
    now: new Date('2026-07-29T00:00:00Z'),
  });

  assert.deepEqual(paths, [
    'users/u/templates',
    'users/u/outreaches',
  ]);
  assert.deepEqual(deleted, [
    'users/u/templates/deleted',
    'users/u/outreaches/deleted',
  ]);
  assert.deepEqual(result, {
    scanned: 3,
    deleted: 2,
    hasMore: false,
  });
});
