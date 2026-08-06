import { readFile } from 'node:fs/promises';

import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

import {
  deletePrivateUserData,
  deletePublicCards,
} from '../server/api/_lib/account-admin.js';
import {
  deleteLiteLLMIdentity,
} from '../server/api/_lib/account-lifecycle.js';
import {
  getFirebaseAdminApp,
} from '../server/api/_lib/firebase-admin.js';
import {
  createLiteLLMClient,
  hashLiteLLMKey,
} from '../server/api/_lib/litellm.js';
import {
  deriveManagedVirtualKey,
  PRODUCTION_MODEL_ALIASES,
} from '../server/api/_lib/provisioning.js';
import {
  assertSmokeEnvironmentIsolation,
  assertProvisioningContract,
  createDisposableIdentity,
  normalizeSmokeTarget,
  redactSmokeFailure,
  SMOKE_CONFIRMATION,
} from './production-smoke-core.mjs';

const TIMEOUT_MS = 30_000;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    const error = new Error(`${name} is required.`);
    error.code = 'smoke_configuration_missing';
    throw error;
  }
  return value;
}

async function getFirebaseWebApiKey() {
  if (process.env.FIREBASE_WEB_API_KEY?.trim()) {
    return process.env.FIREBASE_WEB_API_KEY.trim();
  }

  const config = JSON.parse(
    await readFile(
      new URL('../firebase-applet-config.json', import.meta.url),
      'utf8',
    ),
  );
  if (typeof config.apiKey !== 'string' || !config.apiKey) {
    const error = new Error('Firebase Web API key is unavailable.');
    error.code = 'smoke_configuration_missing';
    throw error;
  }
  return config.apiKey;
}

async function requestJson(
  url,
  { method = 'GET', body, token, timeoutMs = TIMEOUT_MS } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // The smoke report intentionally records only status and route.
      }
      const error = new Error('Smoke request failed.');
      error.code = 'smoke_http_error';
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function endpoint(baseUrl, pathname) {
  return new URL(pathname, baseUrl).toString();
}

async function signInWithPassword({ email, password, apiKey }) {
  const payload = await requestJson(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      body: {
        email,
        password,
        returnSecureToken: true,
      },
    },
  );
  if (typeof payload?.idToken !== 'string' || !payload.idToken) {
    const error = new Error('Firebase sign-in returned no ID token.');
    error.code = 'smoke_auth_failed';
    throw error;
  }
  return payload.idToken;
}

async function assertLiteLLMPolicy({ uid }) {
  const masterKey = requiredEnv('LITELLM_MASTER_KEY');
  const derivationSecret = requiredEnv(
    'LITELLM_KEY_DERIVATION_SECRET',
  );
  const baseUrl = requiredEnv('LITELLM_GATEWAY_URL');
  const apiKey = deriveManagedVirtualKey(uid, derivationSecret);
  const keyHash = hashLiteLLMKey(apiKey);
  const client = createLiteLLMClient({
    baseUrl,
    masterKey,
    logger: {},
  });
  const keyInfo = await client.getKey(keyHash);
  if (!keyInfo) {
    const error = new Error('The expected managed key does not exist.');
    error.code = 'smoke_key_missing';
    throw error;
  }

  const info = keyInfo.info || keyInfo.key_info || keyInfo.key || keyInfo;
  const models = Array.isArray(info.models) ? [...info.models].sort() : [];
  const expected = [...PRODUCTION_MODEL_ALIASES].sort();
  if (
    models.length !== expected.length ||
    models.some((model, index) => model !== expected[index])
  ) {
    const error = new Error('Managed key model policy mismatch.');
    error.code = 'smoke_key_policy_mismatch';
    throw error;
  }
  if (Number(info.max_budget) !== 5) {
    const error = new Error('Managed key budget policy mismatch.');
    error.code = 'smoke_key_policy_mismatch';
    throw error;
  }
  return { client, apiKey, keyHash };
}

async function assertGatewayAlias({ baseUrl, apiKey, alias, uid }) {
  const client = createLiteLLMClient({
    baseUrl,
    masterKey: apiKey,
    logger: {},
    timeoutMs: TIMEOUT_MS,
  });
  const payload = await client.request('/v1/chat/completions', {
    method: 'POST',
    body: {
      model: alias,
      messages: [{ role: 'user', content: 'Reply with only OK.' }],
      max_tokens: 8,
      metadata: {
        cirqle_feature: 'production-signup-smoke',
        cirqle_smoke_alias: alias,
        user_id: uid,
      },
    },
  });
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    const error = new Error('A configured AI alias returned no text.');
    error.code = 'smoke_ai_failed';
    throw error;
  }
}

async function assertAttributedUsage({ baseUrl, token }) {
  let usage = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    usage = await requestJson(endpoint(baseUrl, '/api/ai/usage'), {
      token,
    });
    if (
      usage?.period?.limitUsd === 5 &&
      usage?.features?.['production-signup-smoke']?.requests >= 1
    ) {
      return usage;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  const error = new Error('Per-user AI usage attribution was not visible.');
  error.code = 'smoke_usage_attribution_missing';
  throw error;
}

async function assertDeleted({ auth, db, uid, keyHash, liteLLMClient }) {
  try {
    await auth.getUser(uid);
    throw Object.assign(new Error('Firebase user still exists.'), {
      code: 'smoke_cleanup_incomplete',
    });
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error;
  }

  if ((await db.doc(`users/${uid}`).get()).exists) {
    throw Object.assign(new Error('Private user data still exists.'), {
      code: 'smoke_cleanup_incomplete',
    });
  }
  if (!(await db.collection('cards').where('ownerUid', '==', uid).get()).empty) {
    throw Object.assign(new Error('Public card data still exists.'), {
      code: 'smoke_cleanup_incomplete',
    });
  }
  if (await liteLLMClient.getKey(keyHash)) {
    throw Object.assign(new Error('Managed AI key still exists.'), {
      code: 'smoke_cleanup_incomplete',
    });
  }
}

async function bestEffortCleanup({
  auth,
  db,
  identity,
  uid,
}) {
  if (!uid) return;
  try {
    await deleteLiteLLMIdentity({
      uid,
      email: identity.email,
      logger: {},
    });
  } catch {
    // Continue so one failed cleanup layer cannot strand all later layers.
  }
  try {
    await deletePublicCards({ db, uid });
    await deletePrivateUserData({ db, uid });
  } catch {
    // Firebase Auth cleanup below remains useful even if data cleanup failed.
  }
  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') {
      // The caller receives the original failure; secrets remain redacted.
    }
  }
}

async function main() {
  if (process.env.CIRQLE_SMOKE_CONFIRM !== SMOKE_CONFIRMATION) {
    throw Object.assign(
      new Error('Explicit smoke confirmation is required.'),
      { code: 'smoke_confirmation_required' },
    );
  }

  const smokeEnvironment = assertSmokeEnvironmentIsolation({
    targetEnvironment: requiredEnv(
      'CIRQLE_SMOKE_TARGET_ENVIRONMENT',
    ),
    deploymentEnvironment: requiredEnv('VERCEL_ENV'),
    firebaseProjectId: requiredEnv('FIREBASE_PROJECT_ID'),
    serviceAccountJSON: requiredEnv(
      'FIREBASE_SERVICE_ACCOUNT_JSON',
    ),
    allowProduction:
      process.env.CIRQLE_SMOKE_ALLOW_PRODUCTION === 'true',
  });
  const baseUrl = normalizeSmokeTarget(
    requiredEnv('CIRQLE_SMOKE_BASE_URL'),
    {
      allowProduction: smokeEnvironment.allowProduction,
      requireProduction:
        smokeEnvironment.targetEnvironment === 'production',
    },
  );
  const app = getFirebaseAdminApp();
  const auth = getAuth(app);
  const db = getFirestore(app);
  const identity = createDisposableIdentity();
  const apiKey = await getFirebaseWebApiKey();
  let uid = null;
  let idToken = null;
  let liteLLM = null;
  let keyHash = null;
  let deletionConfirmed = false;

  try {
    const user = await auth.createUser({
      email: identity.email,
      password: identity.password,
      emailVerified: true,
      displayName: 'Cirqle disposable smoke user',
    });
    uid = user.uid;

    idToken = await signInWithPassword({
      ...identity,
      apiKey,
    });

    const firstProvision = await requestJson(
      endpoint(baseUrl, '/api/register-user'),
      {
        method: 'POST',
        token: idToken,
        body: {},
      },
    );
    assertProvisioningContract(firstProvision, {
      expectedReused: false,
    });

    const secondProvision = await requestJson(
      endpoint(baseUrl, '/api/register-user'),
      {
        method: 'POST',
        token: idToken,
        body: {},
      },
    );
    assertProvisioningContract(secondProvision, {
      expectedReused: true,
    });

    const policy = await assertLiteLLMPolicy({ uid });
    liteLLM = policy.client;
    keyHash = policy.keyHash;

    const completion = await requestJson(
      endpoint(baseUrl, '/api/ai/chat'),
      {
        method: 'POST',
        token: idToken,
        body: {
          model: PRODUCTION_MODEL_ALIASES[0],
          feature: 'production-signup-smoke',
          prompt: 'Reply with only OK.',
          temperature: 0,
          maxTokens: 8,
        },
      },
    );
    if (typeof completion?.text !== 'string' || !completion.text.trim()) {
      throw Object.assign(new Error('The tiny AI call returned no text.'), {
        code: 'smoke_ai_failed',
      });
    }
    for (const alias of PRODUCTION_MODEL_ALIASES.slice(1)) {
      await assertGatewayAlias({
        baseUrl: requiredEnv('LITELLM_GATEWAY_URL'),
        apiKey: policy.apiKey,
        alias,
        uid,
      });
    }
    await assertAttributedUsage({ baseUrl, token: idToken });

    await requestJson(endpoint(baseUrl, '/api/account/delete'), {
      method: 'DELETE',
      token: idToken,
      body: { confirmation: 'DELETE' },
    });
    deletionConfirmed = true;

    await assertDeleted({
      auth,
      db,
      uid,
      keyHash,
      liteLLMClient: liteLLM,
    });

    console.log(JSON.stringify({
      ok: true,
      target: baseUrl.hostname,
      checks: [
        'email-password-sign-in',
        'verified-user-gate',
        'single-idempotent-managed-key',
        'five-dollar-thirty-day-policy',
        'three-model-allowlist',
        'tiny-call-through-all-three-aliases',
        'per-user-feature-spend-attribution',
        'full-account-deletion',
      ],
    }));
  } finally {
    if (!deletionConfirmed) {
      await bestEffortCleanup({
        auth,
        db,
        identity,
        uid,
      });
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    ...redactSmokeFailure(error),
  }));
  process.exitCode = 1;
});
