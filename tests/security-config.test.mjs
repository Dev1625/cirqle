/**
 * Offline release/configuration guardrails.
 *
 * This intentionally uses only Node built-ins so it can run before a build,
 * in CI, and from a clean checkout. It checks deployment wiring that unit
 * tests cannot see: the production Firebase alias, the selected database and
 * rules file, the SPA rewrite ordering, and the baseline browser headers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AI_FEATURE_IDS,
  AI_FEATURE_POLICIES,
  AI_MODEL_ALIASES_BY_TIER,
  PRODUCTION_MODEL_ALIASES,
} from '../server/api/_lib/ai-feature-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(
  fs.readFileSync(path.join(ROOT, relativePath), 'utf8'),
);
const readText = (relativePath) => fs.readFileSync(
  path.join(ROOT, relativePath),
  'utf8',
);

let passed = 0;

function check(name, assertion) {
  assertion();
  console.log(`PASS  ${name}`);
  passed++;
}

const firebase = readJson('firebase.json');
const firebaseRc = readJson('.firebaserc');
const firebaseTest = readJson('firebase.test.json');
const vercel = readJson('vercel.json');
const rules = readText('firestore.rules');
const applicationCiWorkflow = readText('.github/workflows/ci.yml');
const securityWorkflow = readText('.github/workflows/security-policy.yml');
const productionCandidateWorkflow = readText(
  '.github/workflows/production-candidate-smoke.yml',
);
const gitignore = readText('.gitignore');
const envExample = readText('.env.example');
const firebaseClient = readText('src/config/firebase.ts');
const cardClient = readText('src/lib/card.ts');
const captureFunction = readText('functions/index.js');
const packageJson = readJson('package.json');
const functionsPackageJson = readJson('functions/package.json');
const liteLLMConfig = readText('litellm-proxy/config.yaml');
const aiConfig = readText('src/lib/aiConfig.ts');
const provisioning = readText('server/api/_lib/provisioning.js');
const liteLLMServerConfig = readText('server/api/_lib/litellm-config.js');
const aiServerConfigConsumers = [
  readText('server/api/register-user.js'),
  readText('server/api/ai/chat.js'),
  readText('server/api/ai/usage.js'),
  readText('server/api/_lib/account-lifecycle.js'),
  readText('scripts/smoke-production-signup.mjs'),
].join('\n');
const legacyKeyScrub = readText('server/api/_lib/legacy-key-scrub.js');
const apiDispatcher = readText('server/vercel-api-dispatcher.js');

check('production Firebase alias is pinned to cirqle-9dd06', () => {
  assert.equal(firebaseRc.projects?.production, 'cirqle-9dd06');
  assert.equal(
    firebaseRc.projects?.default,
    undefined,
    'Do not add a default production project; release commands must be explicit.',
  );
});

check('Firebase deploy targets only the default Firestore database rules file', () => {
  assert.equal(firebase.firestore?.database, '(default)');
  assert.equal(firebase.firestore?.rules, 'firestore.rules');
  assert.equal(
    path.resolve(ROOT, firebase.firestore.rules),
    path.join(ROOT, 'firestore.rules'),
  );
});

check('every Firestore deploy is gated by rules and config tests', () => {
  assert.deepEqual(firebase.firestore?.predeploy, [
    'npm run test:rules',
    'node tests/security-config.test.mjs',
  ]);
});

check('specialized security CI runs for every Firestore emulator suite', () => {
  assert.equal(
    (securityWorkflow.match(/tests\/\*\*\/\*firestore\*\.test\.mjs/g) || [])
      .length,
    2,
    'Both pull-request and main-push path filters must include all Firestore suites.',
  );
});

check('the rules emulator loads the same committed policy as production deploys', () => {
  assert.equal(firebaseTest.firestore?.rules, firebase.firestore.rules);
});

check('private user data and OAuth tokens remain closed to non-owners', () => {
  assert.match(rules, /match \/users\/\{userId\}/);
  assert.match(rules, /request\.auth\.uid == userId/);
  assert.match(rules, /match \/oauthTokens\/\{userId\}/);
  assert.match(rules, /allow read, write: if false/);
});

check('public cards are get-only, published-only, and schema allowlisted', () => {
  assert.match(rules, /match \/cards\/\{cardId\}/);
  assert.match(rules, /allow get: if resource\.data\.published == true/);
  assert.match(rules, /allow list: if false/);
  assert.match(rules, /isValidPublicCard\(cardId\)/);
  assert.match(rules, /keys\(\)\.hasOnly/);
  assert.match(rules, /request\.auth\.token\.email_verified == true/);
});

check('public capture writes are forced through the protected server API', () => {
  assert.match(rules, /match \/captures\/\{captureId\}/);
  assert.match(rules, /allow create: if false/);
  assert.match(rules, /allow update: if false/);
});

check('capture evidence filing has no browser fallback writer', () => {
  assert.doesNotMatch(cardClient, /\bdrainCaptures\b/);
  assert.doesNotMatch(cardClient, /recordType:\s*['"]capture['"]/);
  assert.equal(
    fs.existsSync(path.join(ROOT, 'src/hooks/useCaptureDrain.ts')),
    false,
  );
  assert.match(
    captureFunction,
    /document:\s*['"]cards\/\{cardId\}\/captures\/\{captureId\}['"][\s\S]{0,100}retry:\s*true/,
    'The trusted capture trigger must retry transient failures.',
  );
});

const globalHeaderRule = vercel.headers?.find(
  (entry) => entry.source === '/(.*)',
);
const apiHeaderRule = vercel.headers?.find(
  (entry) => entry.source === '/api/(.*)',
);
const headerMap = new Map(
  (globalHeaderRule?.headers || []).map(({ key, value }) => [
    key.toLowerCase(),
    value,
  ]),
);

check('API responses are explicitly non-cacheable', () => {
  const apiHeaders = new Map(
    (apiHeaderRule?.headers || []).map(({ key, value }) => [
      key.toLowerCase(),
      value,
    ]),
  );
  assert.equal(
    apiHeaders.get('cache-control'),
    'private, no-store, max-age=0',
  );
});

check('security headers cover every Vercel route', () => {
  assert.ok(globalHeaderRule, 'Missing global Vercel header rule.');
  for (const key of [
    'content-security-policy-report-only',
    'x-content-type-options',
    'referrer-policy',
    'x-frame-options',
    'permissions-policy',
  ]) {
    assert.ok(headerMap.has(key), `Missing ${key}.`);
  }
});

check('CSP starts in report-only mode with Firebase-compatible sources', () => {
  assert.equal(
    headerMap.has('content-security-policy'),
    false,
    'Start with report-only CSP until production violations are reviewed.',
  );
  const csp = headerMap.get('content-security-policy-report-only') || '';
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    'https://www.recaptcha.net',
    'https://www.gstatic.com',
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
    'https://*.googleapis.com',
    'https://firebaseappcheck.googleapis.com',
    'https://*.firebaseio.com',
    'wss://*.firebaseio.com',
    'https://*.firebaseapp.com',
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    'report-uri /api/telemetry/csp',
  ]) {
    assert.ok(csp.includes(directive), `CSP missing: ${directive}`);
  }
  assert.equal(csp.includes("'unsafe-eval'"), false);
  assert.equal(csp.includes('script-src *'), false);
  assert.equal(
    csp.includes('up.railway.app'),
    false,
    'The browser must call same-origin AI APIs, never LiteLLM directly.',
  );
});

check('enforced headers prevent MIME sniffing and clickjacking', () => {
  assert.equal(headerMap.get('x-content-type-options'), 'nosniff');
  assert.equal(headerMap.get('x-frame-options'), 'DENY');
  assert.equal(
    headerMap.get('referrer-policy'),
    'no-referrer',
  );
});

check('Permissions Policy preserves first-party voice input only', () => {
  const policy = headerMap.get('permissions-policy') || '';
  assert.ok(policy.includes('microphone=(self)'));
  for (const disabledFeature of [
    'camera=()',
    'geolocation=()',
    'payment=()',
    'usb=()',
  ]) {
    assert.ok(
      policy.includes(disabledFeature),
      `Permissions-Policy missing: ${disabledFeature}`,
    );
  }
});

check('API routing precedes the SPA fallback', () => {
  assert.deepEqual(vercel.rewrites?.slice(0, 2), [
    {
      source: '/api',
      destination: '/api/_dispatch',
    },
    {
      source: '/api/(.*)',
      destination: '/api/_dispatch',
    },
  ]);
  assert.deepEqual(vercel.rewrites?.at(-1), {
    source: '/(.*)',
    destination: '/index.html',
  });
});

check('Vercel deploys bounded API functions within the Hobby limit', () => {
  const functionFiles = fs
    .readdirSync(path.join(ROOT, 'api'), {
      recursive: true,
      withFileTypes: true,
    })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'));
  assert.equal(functionFiles.length, 5);
  assert.ok(functionFiles.length <= 12);
  assert.deepEqual(
    functionFiles.map((entry) => entry.name).sort(),
    ['_dispatch.js', 'delete.js', 'export.js', 'maintenance.js', 'merge.js'],
  );
  assert.deepEqual(Object.keys(vercel.functions || {}).sort(), [
    'api/account/delete.js',
    'api/account/export.js',
    'api/contacts/merge.js',
    'api/cron/maintenance.js',
  ]);
  assert.match(apiDispatcher, /'account\/bootstrap':/);
  assert.match(apiDispatcher, /'cron\/maintenance':/);
  assert.match(apiDispatcher, /'integrations\/gmail\/send':/);
  assert.match(apiDispatcher, /'telemetry\/vitals':/);
});

check('daily maintenance is bounded and protected by a server-only secret', () => {
  assert.deepEqual(vercel.crons, [
    {
      path: '/api/cron/maintenance',
      schedule: '17 4 * * *',
    },
  ]);
  assert.equal(vercel.functions?.['api/cron/maintenance.js']?.maxDuration, 60);
  assert.equal(vercel.functions?.['api/account/export.js']?.maxDuration, 300);
  assert.equal(vercel.functions?.['api/account/delete.js']?.maxDuration, 300);
  assert.equal(vercel.functions?.['api/contacts/merge.js']?.maxDuration, 60);
  const cronSource = readText('server/api/cron/maintenance.js');
  const schedulerSource = readText(
    'server/api/_lib/scheduled-maintenance.js',
  );
  assert.match(cronSource, /CRON_SECRET/);
  assert.match(cronSource, /isAuthorizedCronRequest/);
  assert.match(schedulerSource, /timingSafeEqual/);
  assert.match(schedulerSource, /maxRequests:\s*8/);
  assert.match(schedulerSource, /maxDocuments:\s*300/);
  assert.doesNotMatch(
    cronSource,
    /res\.status\([^)]*\)\.json\(\{\s*error:\s*error/,
  );
});

check('scheduled drift monitoring uses short-lived Google OIDC credentials', () => {
  assert.match(securityWorkflow, /schedule:/);
  assert.match(
    securityWorkflow,
    /uses:\s*google-github-actions\/auth@[a-f0-9]{40}\s+# v3/,
  );
  assert.match(securityWorkflow, /id-token: write/);
  assert.match(securityWorkflow, /GCP_WIF_PROVIDER_CIRQLE/);
  assert.match(securityWorkflow, /GCP_RULES_VIEWER_SERVICE_ACCOUNT/);
  assert.doesNotMatch(
    securityWorkflow,
    /credentials_json/,
    'Do not introduce a long-lived service-account key.',
  );
  assert.match(gitignore, /^gha-creds-\*\.json$/m);
});

check('the aggregate test command includes deployment-security checks', () => {
  assert.match(packageJson.scripts?.test || '', /npm run test:app/);
  assert.match(packageJson.scripts?.test || '', /npm run test:functions/);
  assert.match(
    packageJson.scripts?.['test:app'] || '',
    /npm run test:security-config/,
  );
});

check('CI tests the application and Cloud Functions on their declared runtimes', () => {
  const functionsJobStart = applicationCiWorkflow.indexOf(
    '\n  functions-emulator:',
  );
  assert.ok(functionsJobStart > 0, 'Missing the Functions emulator job.');
  const applicationJob = applicationCiWorkflow.slice(0, functionsJobStart);
  const functionsJob = applicationCiWorkflow.slice(functionsJobStart);

  assert.match(applicationJob, /node-version:\s*24/);
  assert.match(applicationJob, /run:\s*npm run test:app/);
  assert.doesNotMatch(applicationJob, /run:\s*npm test\s*$/m);
  assert.match(functionsJob, /node-version:\s*22/);
  assert.match(functionsJob, /run:\s*npm run test:functions/);
  assert.equal(functionsPackageJson.engines?.node, '22');
});

check('both release SBOMs have versioned package roots', () => {
  assert.match(
    functionsPackageJson.version || '',
    /^\d+\.\d+\.\d+(?:[-+].+)?$/,
  );
  assert.match(
    applicationCiWorkflow,
    /npm sbom --package-lock-only --sbom-format cyclonedx > cirqle-web-sbom\.cdx\.json/,
  );
  assert.match(
    applicationCiWorkflow,
    /npm sbom --prefix functions --package-lock-only --sbom-format cyclonedx > cirqle-functions-sbom\.cdx\.json/,
  );
});

check('preview and production smokes use distinct protected environments', () => {
  const productionJobStart = productionCandidateWorkflow.indexOf(
    '\n  production-smoke:',
  );
  assert.ok(productionJobStart > 0, 'Missing the production smoke job.');
  const previewJob = productionCandidateWorkflow.slice(
    0,
    productionJobStart,
  );
  const productionJob = productionCandidateWorkflow.slice(
    productionJobStart,
  );

  assert.match(previewJob, /environment:\s*preview-candidate/);
  assert.match(
    previewJob,
    /CIRQLE_SMOKE_TARGET_ENVIRONMENT:\s*preview/,
  );
  assert.match(previewJob, /CIRQLE_SMOKE_ALLOW_PRODUCTION:\s*"false"/);
  assert.match(previewJob, /VERCEL_ENV:\s*preview/);
  assert.doesNotMatch(previewJob, /environment:\s*production-candidate/);

  assert.match(productionJob, /environment:\s*production-candidate/);
  assert.match(
    productionJob,
    /CIRQLE_SMOKE_TARGET_ENVIRONMENT:\s*production/,
  );
  assert.match(
    productionJob,
    /CIRQLE_SMOKE_ALLOW_PRODUCTION:\s*"true"/,
  );
  assert.match(productionJob, /VERCEL_ENV:\s*production/);
});

check('the web client has opt-in reCAPTCHA Enterprise App Check wiring', () => {
  assert.match(firebaseClient, /initializeAppCheck/);
  assert.match(firebaseClient, /ReCaptchaEnterpriseProvider/);
  assert.match(firebaseClient, /VITE_FIREBASE_APP_CHECK_SITE_KEY/);
  assert.match(firebaseClient, /isTokenAutoRefreshEnabled:\s*true/);
});

check('LiteLLM keeps spend metadata without caching or logging CRM content', () => {
  assert.match(liteLLMConfig, /store_prompts_in_spend_logs:\s*false/);
  assert.match(liteLLMConfig, /turn_off_message_logging:\s*true/);
  assert.match(liteLLMConfig, /log_raw_request_response:\s*false/);
  assert.match(liteLLMConfig, /cache:\s*false/);
  assert.match(liteLLMConfig, /set_verbose:\s*false/);
  assert.doesNotMatch(liteLLMConfig, /set_verbose:\s*true/);
});

check('the app, virtual keys, and LiteLLM expose exactly the same three aliases', () => {
  const expectedAliases = [
    'gemini-3.5-flash-lite',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
  ];
  const gatewayAliases = Array.from(
    liteLLMConfig.matchAll(/^\s*-\s+model_name:\s*([^\s#]+)\s*$/gm),
    (match) => match[1],
  );
  const appAliases = Array.from(
    aiConfig.matchAll(/^\s*(?:fast|reasoning|draft):\s*'([^']+)'/gm),
    (match) => match[1],
  );
  const keyAliases = [...PRODUCTION_MODEL_ALIASES];

  assert.deepEqual([...gatewayAliases].sort(), [...expectedAliases].sort());
  assert.deepEqual([...appAliases].sort(), [...expectedAliases].sort());
  assert.deepEqual([...keyAliases].sort(), [...expectedAliases].sort());
  assert.deepEqual(
    Object.values(AI_MODEL_ALIASES_BY_TIER),
    expectedAliases,
  );
  assert.equal(new Set(gatewayAliases).size, gatewayAliases.length);
  assert.match(
    provisioning,
    /from '\.\/ai-feature-policy\.js'/,
    'Virtual-key allowlists must derive from the server feature policy.',
  );
  assert.doesNotMatch(aiConfig, /VITE_AI_MODEL_/);
  assert.doesNotMatch(envExample, /VITE_AI_MODEL_/);
});

check('every registered AI feature resolves to a virtual-key-allowed alias', () => {
  assert.equal(AI_FEATURE_IDS.length, 14);
  for (const feature of AI_FEATURE_IDS) {
    const policy = AI_FEATURE_POLICIES[feature];
    assert.ok(
      PRODUCTION_MODEL_ALIASES.includes(policy.modelAlias),
      `${feature} resolves to an alias omitted from managed virtual keys.`,
    );
    assert.equal(
      AI_MODEL_ALIASES_BY_TIER[policy.tier],
      policy.modelAlias,
      `${feature} has a tier/alias mismatch.`,
    );
    assert.ok(policy.maxOutputTokens <= 4_000);
    assert.ok(policy.maxTemperature <= 1);
  }
});

check('AI server configuration has no implicit production or browser fallback', () => {
  assert.match(liteLLMServerConfig, /LITELLM_GATEWAY_URL/);
  assert.match(liteLLMServerConfig, /LITELLM_KEY_DERIVATION_SECRET/);
  assert.doesNotMatch(
    `${liteLLMServerConfig}\n${aiServerConfigConsumers}`,
    /VITE_GATEWAY_URL|litellm-production-2a63\.up\.railway\.app/,
  );
  assert.doesNotMatch(
    liteLLMServerConfig,
    /LITELLM_KEY_DERIVATION_SECRET[\s\S]{0,120}\|\|[\s\S]{0,80}LITELLM_MASTER_KEY/,
  );
});

check('authenticated provisioning revokes legacy raw AI keys before scrubbing them', () => {
  for (const field of [
    'apiKey',
    'liteLLMApiKey',
    'litellmApiKey',
    'liteLLMKey',
    'litellmKey',
  ]) {
    assert.match(legacyKeyScrub, new RegExp(`'${field}'`));
  }
  assert.match(legacyKeyScrub, /\.get\(\)/);
  assert.match(legacyKeyScrub, /revokeLegacyKeys\(\{/);
  assert.match(legacyKeyScrub, /\.update\(patch\)/);
  assert.ok(
    legacyKeyScrub.indexOf('revokeLegacyKeys({') <
      legacyKeyScrub.indexOf('.update(patch)'),
    'A legacy key must be ownership-verified and revoked before its readable field is deleted.',
  );
  assert.match(legacyKeyScrub, /legacy_key_scrub_failed/);
  assert.match(
    readText('server/api/register-user.js'),
    /scrubLegacyKeys\(\{\s*uid:\s*identity\.uid,\s*email:\s*identity\.email,\s*env,\s*client,/,
  );
});

check('each public alias resolves to its intended upstream provider model', () => {
  const routes = Array.from(
    liteLLMConfig.matchAll(
      /^\s*-\s+model_name:\s*([^\s#]+)[\s\S]*?^\s+model:\s*([^\s#]+)\s*$/gm,
    ),
    (match) => [match[1], match[2]],
  );

  assert.deepEqual(Object.fromEntries(routes), {
    'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
    'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
    'gemini-3.5-flash-lite': 'gemini/gemini-3.5-flash-lite',
  });
  assert.doesNotMatch(liteLLMConfig, /OPENAI_API_KEY/);
  assert.doesNotMatch(liteLLMConfig, /gemini-1\.5|gpt-4|compatibility-/i);
});

console.log(`\n${passed} security configuration checks passed`);
