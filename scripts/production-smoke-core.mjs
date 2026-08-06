import { randomBytes } from 'node:crypto';

import {
  PRODUCTION_FIREBASE_PROJECT_ID,
} from '../server/api/_lib/firebase-admin.js';
import {
  BUDGET_DURATION,
  BUDGET_LIMIT_USD,
  PRODUCTION_MODEL_ALIASES,
} from '../server/api/_lib/provisioning.js';

export const SMOKE_CONFIRMATION =
  'create-and-delete-disposable-cirqle-user';

export function normalizeSmokeTarget(rawUrl, {
  allowProduction = false,
  requireProduction = false,
} = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('CIRQLE_SMOKE_BASE_URL must be a valid URL.');
  }

  if (url.protocol !== 'https:') {
    throw new Error('The smoke target must use HTTPS.');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'The smoke target must not contain credentials, a query, or a fragment.',
    );
  }

  const hostname = url.hostname.toLowerCase();
  const isProduction =
    hostname === 'cirqle-taupe.vercel.app' ||
    hostname === 'cirqle.app' ||
    hostname === 'www.cirqle.app';
  if (isProduction && !allowProduction) {
    throw new Error(
      'Refusing to run against production. Use a Vercel preview URL.',
    );
  }
  if (requireProduction && !isProduction) {
    throw new Error(
      'The production smoke environment requires a reviewed production URL.',
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}

function normalizeProjectId(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function serviceAccountProjectId(rawJSON) {
  if (typeof rawJSON !== 'string' || !rawJSON.trim()) {
    throw new Error(
      'The smoke test requires an environment-scoped service account.',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJSON);
  } catch {
    throw new Error(
      'The smoke test service account configuration is invalid.',
    );
  }

  const projectId = normalizeProjectId(
    parsed?.project_id || parsed?.projectId,
  );
  if (!projectId) {
    throw new Error(
      'The smoke test service account has no Firebase project.',
    );
  }
  return projectId;
}

export function assertSmokeEnvironmentIsolation({
  targetEnvironment,
  deploymentEnvironment,
  firebaseProjectId,
  serviceAccountJSON,
  allowProduction,
}) {
  if (
    targetEnvironment !== 'preview' &&
    targetEnvironment !== 'production'
  ) {
    throw new Error('The smoke target environment is invalid.');
  }
  if (deploymentEnvironment !== targetEnvironment) {
    throw new Error(
      'The smoke target and deployment environments do not match.',
    );
  }

  const expectedProductionFlag = targetEnvironment === 'production';
  if (allowProduction !== expectedProductionFlag) {
    throw new Error(
      'The production smoke permission does not match its environment.',
    );
  }

  const explicitProjectId = normalizeProjectId(firebaseProjectId);
  const credentialProjectId = serviceAccountProjectId(serviceAccountJSON);
  if (!explicitProjectId || explicitProjectId !== credentialProjectId) {
    throw new Error(
      'The smoke Firebase project and service account do not match.',
    );
  }

  if (
    targetEnvironment === 'preview' &&
    explicitProjectId === PRODUCTION_FIREBASE_PROJECT_ID
  ) {
    throw new Error(
      'Preview smoke tests can never use the production Firebase project.',
    );
  }
  if (
    targetEnvironment === 'production' &&
    explicitProjectId !== PRODUCTION_FIREBASE_PROJECT_ID
  ) {
    throw new Error(
      'Production smoke tests require the reviewed Firebase project.',
    );
  }

  return Object.freeze({
    targetEnvironment,
    firebaseProjectId: explicitProjectId,
    allowProduction,
  });
}

export function createDisposableIdentity(now = Date.now()) {
  const suffix = randomBytes(6).toString('hex');
  return {
    email: `dev.smoke.${now}.${suffix}@cirqle.test`,
    password: `Cq!${randomBytes(24).toString('base64url')}7a`,
  };
}

export function assertProvisioningContract(
  payload,
  { expectedReused } = {},
) {
  if (payload?.provisioned !== true) {
    throw new Error('AI provisioning did not complete.');
  }
  if (
    expectedReused !== undefined &&
    payload?.reused !== expectedReused
  ) {
    throw new Error('AI provisioning was not idempotent.');
  }
  if (payload?.budget?.limitUsd !== BUDGET_LIMIT_USD) {
    throw new Error('The disposable user does not have the $5 cap.');
  }
  if (payload?.budget?.duration !== BUDGET_DURATION) {
    throw new Error('The disposable user has the wrong reset period.');
  }

  const actualModels = [...(payload?.models || [])].sort();
  const expectedModels = [...PRODUCTION_MODEL_ALIASES].sort();
  if (
    actualModels.length !== expectedModels.length ||
    actualModels.some((model, index) => model !== expectedModels[index])
  ) {
    throw new Error('The disposable user has the wrong model allowlist.');
  }
}

export function redactSmokeFailure(error) {
  const code =
    typeof error?.code === 'string' &&
    /^[a-z0-9/_-]{1,80}$/i.test(error.code)
      ? error.code
      : 'smoke_failed';
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  return { code, ...(status ? { status } : {}) };
}
