# Cirqle production deployment guide

This guide describes the current three-part deployment. It replaces the
legacy browser-to-LiteLLM architecture.

## 1. Vercel web app and server APIs

Import the repository into Vercel as a Vite project:

- Build command: `npm run build`
- Output directory: `dist`
- Node runtime: 24

The root `firebase-admin` dependency is intentionally pinned to `13.10.0`.
Vercel's current Node function packager converts the `jwks-rsa` 4 / `jose` 6
boundary into an unsupported CommonJS `require()`, causing every Admin-backed
function to fail during startup. Treat an upgrade as a deployment change and
verify a live authenticated and unauthenticated API request before promoting it.

The public `/api/*` contract uses one fixed dispatcher plus four exact-route
timeout wrappers under `api/`. Filesystem routing sends account deletion,
account export, contact merging, and scheduled maintenance to their exact
wrappers first, preserving the original timeout caps. Every other API path is
rewritten to `api/router.js` and dispatched by
`server/vercel-api-dispatcher.js`. Keep all other handlers and private helpers
under `server/api/`; placing another JavaScript file under `api/` creates another
Vercel Function and can exceed plan limits. Unknown APIs return the dispatcher's
JSON 404 before the single-page-app fallback.

Required server-only environment variables:

- `LITELLM_MASTER_KEY`
- `LITELLM_KEY_DERIVATION_SECRET` (stable across master-key rotation and
  different from `LITELLM_MASTER_KEY`)
- `LITELLM_GATEWAY_URL` (set explicitly for each preview/production
  environment)
- Firebase Admin credentials using either
  `FIREBASE_SERVICE_ACCOUNT_JSON` or the split
  `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
  `FIREBASE_PRIVATE_KEY`
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (or matching
  Vercel KV variables) for distributed provisioning/capture throttling;
  preview and production fail closed when this limiter is absent or unavailable
- `CIRQLE_AI_NEW_KEYS_PER_DAY` to cap brand-new managed AI-key issuance across
  the whole deployment in a rolling 24-hour window. It defaults to `25`;
  existing users reusing their deterministic keys do not consume this limit.
- `CRON_SECRET`, a unique random value of at least 32 characters. Vercel sends
  it only to the daily `/api/cron/maintenance` job.
- For live Google Calendar/Gmail only: `INTEGRATIONS_LIVE_ENABLED=true`,
  exact `INTEGRATIONS_APP_ORIGIN`, and server-only `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET`, plus `GOOGLE_TOKEN_ENCRYPTION_KEY`, a stable
  base64-encoded 32-byte key used for AES-256-GCM credential envelopes. Set
  `GOOGLE_OAUTH_TEST_MODE=true` only while the Google consent screen is in
  Testing.

Optional browser build variables:

- `VITE_FIREBASE_APP_CHECK_SITE_KEY`
- `VITE_ENABLE_DEMO_DATA=true` only for an explicitly disposable demo
  deployment
- the preview Gmail/Calendar variables documented in `.env.example`

Live Google browser configuration is exactly:

```text
VITE_INTEGRATIONS_MODE=live
VITE_INTEGRATIONS_API_BASE=/api/integrations
```

No Google credential belongs in a `VITE_*` variable. The server creates an
opaque, ten-minute, single-use OAuth state bound to the verified Firebase UID,
provider, canonical callback, and PKCE S256 verifier. The callback verifies
the actual Google account selected by the user, records that verified address,
and stores access/refresh tokens only inside authenticated encryption
envelopes. See
`GOOGLE_INTEGRATIONS_SECURITY.md` for the release checklist.

Do not set `VITE_PASSWORD_BREACH_CHECK_DISABLED` in production. It exists only
for deliberately offline local development. The password-range proxy needs no
HIBP key or server secret.

Optional server switch:

- `FIREBASE_APP_CHECK_ENFORCED=true` only after preview and production
  monitoring show valid tokens for authenticated CRM use and anonymous card
  visitors

Never put provider keys, the LiteLLM master key, the virtual-key derivation
secret, Firebase Admin credentials, or any virtual key in `VITE_*`.

There is no default LiteLLM production URL, deprecated `VITE_GATEWAY_URL`
fallback, or master-key fallback for key derivation. A missing or invalid
setting makes provisioning, AI calls, usage, and AI account cleanup return a
sanitized unavailable response. This prevents a preview from silently sending
private data or spend to production. Provisioning consumes separately hashed
UID and trusted Vercel-IP rate-limit buckets.

Every successful authenticated provisioning attempt also performs a blind,
idempotent Admin SDK update that deletes known legacy raw AI-key fields from
`users/{uid}`. It never reads, returns, or logs their historical values.

The global issuance circuit breaker is intentionally separate from per-user
and per-IP throttling. A spike in account creation can pause only new managed
keys while signed-in users with an existing key continue to work. A distributed
limiter outage fails closed in preview and production.

Deploy the feature branch to a Vercel preview first. Verify authentication,
AI, public cards, account lifecycle, headers, CSP reports, and App Check
metrics before promoting.

The production deployment registers one daily bounded maintenance job. It
processes queued contact purge/merge-recovery requests and resumes source
retention policies from a private cursor. Runs are leased, retry-safe, limited
to small batches, and return counts only. Vercel preview deployments do not
execute production cron schedules.

## 2. Firebase

Firebase project: `cirqle-9dd06`; Firestore database: `(default)`.

Configure:

1. Email/password and Google Authentication as intended.
2. Password policy, email-enumeration protection, email templates, and the
   `/auth/action` handler from `ACCOUNT_LIFECYCLE_RELEASE.md`. Signup and that
   action handler also enforce the k-anonymous breach-screening contract in
   `PASSWORD_SECURITY.md`.
3. A reCAPTCHA Enterprise web App Check registration matching
   `VITE_FIREBASE_APP_CHECK_SITE_KEY`.
4. App Check monitoring before enforcement.
5. A TTL policy on `captureGuards.expiresAt`.
6. Cloud Functions from `functions/` for capture processing and optional
   integrations.

Rules are source-controlled. Do not paste-edit them in the console:

```sh
npm run test:rules
npm run test:security-config
npm run verify:firestore-rules:deployed
```

Production release is deliberately guarded and only works from clean,
reviewed `main`:

```sh
npm run release:firestore-rules -- --confirm-production=cirqle-9dd06
```

See `SECURITY_RELEASE.md` for OIDC drift monitoring and the exact release
procedure.

## 3. Railway LiteLLM

Point the Railway service root at `litellm-proxy/`. The Docker image starts
LiteLLM with `/app/config.yaml`.

Required Railway variables:

- `LITELLM_MASTER_KEY`
- `LITELLM_SALT_KEY`
- `DATABASE_URL`
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`
- `GEMINI_API_KEY`
- `DEEPSEEK_API_KEY`

`config.yaml` is both the alias router and the private-data logging policy.
It disables response caching, verbose/raw message logging, prompt storage in
spend logs, and LiteLLM telemetry while retaining cost attribution.

After every Railway deployment:

1. Check `/health/liveliness`.
2. Inspect `/model/info` with the master key.
3. Make one tiny completion with each of the three active aliases.
4. Confirm the per-user key allowlist, `$5` cap, `30d` reset, and spend.
5. Inspect logs to ensure prompts, responses, keys, and provider bodies are
   absent.

See `litellm-proxy/README.md` for the model flow and safe alias/model changes.

## Release-candidate gate

From a clean install:

```sh
npm ci
npm run lint
npm test
npm run build
```

On the Vercel preview, verify that the password-range request contains only a
five-character prefix and that a simulated provider outage preserves local
password rules.

Then execute the deployed checklist in `IMPLEMENTATION_VERIFICATION.md`,
including a disposable signup → verified email → provisioning → tiny `fast`
call → export → deletion cycle. Never log the disposable password or any key.
