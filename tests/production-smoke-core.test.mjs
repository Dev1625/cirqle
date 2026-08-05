import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSmokeEnvironmentIsolation,
  assertProvisioningContract,
  createDisposableIdentity,
  normalizeSmokeTarget,
  redactSmokeFailure,
  SMOKE_CONFIRMATION,
} from '../scripts/production-smoke-core.mjs';

test('preview smoke target requires HTTPS and rejects production by default', () => {
  assert.equal(
    normalizeSmokeTarget(
      'https://cirqle-git-hardening-example.vercel.app/',
    ).hostname,
    'cirqle-git-hardening-example.vercel.app',
  );
  assert.throws(
    () => normalizeSmokeTarget('http://localhost:3000'),
    /HTTPS/,
  );
  assert.throws(
    () => normalizeSmokeTarget('https://cirqle-taupe.vercel.app'),
    /production/,
  );
  assert.equal(
    normalizeSmokeTarget('https://cirqle-taupe.vercel.app', {
      allowProduction: true,
      requireProduction: true,
    }).hostname,
    'cirqle-taupe.vercel.app',
  );
  assert.throws(
    () =>
      normalizeSmokeTarget(
        'https://cirqle-git-hardening-example.vercel.app',
        {
          allowProduction: true,
          requireProduction: true,
        },
      ),
    /reviewed production URL/,
  );
});

test('preview smoke credentials can never select production Firebase', () => {
  const serviceAccount = (projectId) =>
    JSON.stringify({ project_id: projectId });

  assert.deepEqual(
    assertSmokeEnvironmentIsolation({
      targetEnvironment: 'preview',
      deploymentEnvironment: 'preview',
      firebaseProjectId: 'cirqle-isolated-preview',
      serviceAccountJSON: serviceAccount('cirqle-isolated-preview'),
      allowProduction: false,
    }),
    {
      targetEnvironment: 'preview',
      firebaseProjectId: 'cirqle-isolated-preview',
      allowProduction: false,
    },
  );
  assert.throws(
    () =>
      assertSmokeEnvironmentIsolation({
        targetEnvironment: 'preview',
        deploymentEnvironment: 'preview',
        firebaseProjectId: 'cirqle-9dd06',
        serviceAccountJSON: serviceAccount('cirqle-9dd06'),
        allowProduction: false,
      }),
    /never use the production Firebase project/,
  );
  assert.throws(
    () =>
      assertSmokeEnvironmentIsolation({
        targetEnvironment: 'preview',
        deploymentEnvironment: 'preview',
        firebaseProjectId: 'cirqle-isolated-preview',
        serviceAccountJSON: serviceAccount('cirqle-9dd06'),
        allowProduction: false,
      }),
    /do not match/,
  );
});

test('production smoke requires its protected environment and project', () => {
  const productionServiceAccount = JSON.stringify({
    project_id: 'cirqle-9dd06',
  });
  assert.deepEqual(
    assertSmokeEnvironmentIsolation({
      targetEnvironment: 'production',
      deploymentEnvironment: 'production',
      firebaseProjectId: 'cirqle-9dd06',
      serviceAccountJSON: productionServiceAccount,
      allowProduction: true,
    }),
    {
      targetEnvironment: 'production',
      firebaseProjectId: 'cirqle-9dd06',
      allowProduction: true,
    },
  );
  assert.throws(
    () =>
      assertSmokeEnvironmentIsolation({
        targetEnvironment: 'production',
        deploymentEnvironment: 'preview',
        firebaseProjectId: 'cirqle-9dd06',
        serviceAccountJSON: productionServiceAccount,
        allowProduction: true,
      }),
    /do not match/,
  );
  assert.throws(
    () =>
      assertSmokeEnvironmentIsolation({
        targetEnvironment: 'production',
        deploymentEnvironment: 'production',
        firebaseProjectId: 'cirqle-isolated-preview',
        serviceAccountJSON: JSON.stringify({
          project_id: 'cirqle-isolated-preview',
        }),
        allowProduction: true,
      }),
    /reviewed Firebase project/,
  );
});

test('disposable credentials are unique and never contain the confirmation', () => {
  const first = createDisposableIdentity(1);
  const second = createDisposableIdentity(1);
  assert.match(first.email, /^dev\.smoke\.1\.[a-f0-9]+@cirqle\.test$/);
  assert.notEqual(first.email, second.email);
  assert.notEqual(first.password, second.password);
  assert.equal(first.password.includes(SMOKE_CONFIRMATION), false);
});

test('provisioning contract enforces reuse, cap, reset, and exact aliases', () => {
  const valid = {
    provisioned: true,
    reused: true,
    models: [
      'gemini-3.5-flash-lite',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ],
    budget: { limitUsd: 5, duration: '30d' },
  };
  assert.doesNotThrow(() =>
    assertProvisioningContract(valid, { expectedReused: true }),
  );
  assert.throws(
    () =>
      assertProvisioningContract(
        { ...valid, models: [...valid.models, 'other-model'] },
        { expectedReused: true },
      ),
    /allowlist/,
  );
  assert.throws(
    () =>
      assertProvisioningContract(
        { ...valid, budget: { limitUsd: 50, duration: '30d' } },
        { expectedReused: true },
      ),
    /\$5 cap/,
  );
});

test('smoke failures expose only stable code and status', () => {
  const secret = Object.assign(
    new Error('Authorization: Bearer secret-token'),
    {
      code: 'smoke_http_error',
      status: 502,
      stack: 'must-not-appear',
    },
  );
  assert.deepEqual(redactSmokeFailure(secret), {
    code: 'smoke_http_error',
    status: 502,
  });
});
