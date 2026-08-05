import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PRODUCTION_FIREBASE_PROJECT_ID,
  resolveFirebaseAdminProjectId,
} from '../api/_lib/firebase-admin.js';

test('preview Admin configuration fails closed unless it names an isolated project', () => {
  for (const env of [
    { VERCEL_ENV: 'preview' },
    {
      VERCEL_ENV: 'preview',
      FIREBASE_PROJECT_ID: PRODUCTION_FIREBASE_PROJECT_ID,
    },
    {
      VERCEL_ENV: 'preview',
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        project_id: PRODUCTION_FIREBASE_PROJECT_ID,
      }),
    },
  ]) {
    assert.throws(
      () => resolveFirebaseAdminProjectId(env),
      (error) => error.code === 'firebase_admin_environment_invalid',
    );
  }

  assert.equal(
    resolveFirebaseAdminProjectId({
      VERCEL_ENV: 'preview',
      FIREBASE_PROJECT_ID: 'cirqle-isolated-preview',
    }),
    'cirqle-isolated-preview',
  );
});

test('production Admin configuration is pinned and conflicting sources are rejected', () => {
  assert.equal(
    resolveFirebaseAdminProjectId({
      VERCEL_ENV: 'production',
      FIREBASE_PROJECT_ID: PRODUCTION_FIREBASE_PROJECT_ID,
    }),
    PRODUCTION_FIREBASE_PROJECT_ID,
  );
  assert.throws(
    () =>
      resolveFirebaseAdminProjectId({
        VERCEL_ENV: 'production',
        FIREBASE_PROJECT_ID: 'wrong-project',
      }),
    (error) => error.code === 'firebase_admin_environment_invalid',
  );
  assert.throws(
    () =>
      resolveFirebaseAdminProjectId({
        VERCEL_ENV: 'preview',
        FIREBASE_PROJECT_ID: 'cirqle-isolated-preview',
        FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          project_id: PRODUCTION_FIREBASE_PROJECT_ID,
        }),
      }),
    (error) => error.code === 'firebase_admin_environment_invalid',
  );
});

test('local development remains compatible with application-default credentials', () => {
  assert.equal(resolveFirebaseAdminProjectId({}), null);
});
