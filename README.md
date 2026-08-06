# Cirqle CRM

Cirqle is a private relationship-memory CRM built with React, Firebase,
Vercel serverless APIs, and a Railway-hosted LiteLLM gateway. The web app is
the product in this repository; the standalone mobile app is maintained
separately.

## Architecture

The browser authenticates with Firebase and stores the user's CRM data under
`users/{uid}` in Firestore. Model calls go only to same-origin Vercel APIs:

```text
React feature
  -> semantic tier + required product feature ID
  -> src/lib/aiConfig.ts supplies the browser's expected alias
  -> Firebase-authenticated /api/ai/chat
  -> server feature policy independently derives tier, alias, and ceilings
  -> any client alias/policy mismatch is rejected
  -> server-only capped LiteLLM virtual key
  -> policy-approved LiteLLM alias
  -> provider model selected by litellm-proxy/config.yaml
```

No provider key, LiteLLM master key, or LiteLLM virtual key is returned to the
browser or stored in client-readable Firestore/local storage.

New passwords also receive a privacy-preserving known-breach check. The
browser hashes locally, sends only a five-character k-anonymous prefix through
the same-origin `/api/security/password-range` proxy, and performs the suffix
match locally. See `PASSWORD_SECURITY.md` for the threat model and deliberate
offline/provider-outage policy.

The active model contract is:

| Tier | LiteLLM alias | Current provider route |
|---|---|---|
| `fast` | `gemini-3.5-flash-lite` | `gemini/gemini-3.5-flash-lite` |
| `reasoning` | `deepseek-v4-flash` | `deepseek/deepseek-v4-flash` |
| `draft` | `deepseek-v4-pro` | `deepseek/deepseek-v4-pro` |

`server/api/_lib/ai-feature-policy.js` is the authoritative server registry for
feature-to-tier routing, output and temperature ceilings, and friendly spend
labels. Browser-supplied model aliases are only consistency assertions: the
server derives the actual alias from the known feature and rejects mismatches.

Vercel exposes the unchanged `/api/*` URLs through three fixed-depth dynamic
entry points plus four exact-route timeout wrappers under `api/`. The dynamic
entry points dispatch through `server/vercel-api-dispatcher.js`; handlers and
private helpers live under `server/api/`, outside Vercel's function-discovery
directory. This keeps the seven-function deployment within the Hobby limit,
preserves route-specific timeout caps, and avoids exposing accidental endpoints.
Unsupported API depths are routed to the same dispatcher's JSON 404 before the
single-page-app fallback.

See `litellm-proxy/README.md` for routing, model changes, budgets, privacy, and
administrator spend inspection.

## Local development

Requirements:

- Node.js 24
- Java 21+ for Firebase emulator tests
- Firebase CLI (installed as a development dependency)

Install and start:

```sh
npm ci
npm run dev
```

Copy `.env.example` to an untracked local environment file only when you need
optional emulator, App Check, or preview-integration settings. Never put a
provider/master/virtual key in a `VITE_*` variable; Vite publishes those
values in browser JavaScript.

## Verification

```sh
npm run lint
npm test
npm run build
```

The aggregate test command covers authenticated API boundaries, account
lifecycle, AI grounding helpers, outreach truth states, security headers,
Firestore Rules, and the card-capture Cloud Function. The production build
also enforces gzip bundle budgets.

Useful focused checks:

```sh
npm run test:api
npm run test:unit
npm run test:security-config
npm run test:rules
npm run test:functions
npm run verify:firestore-rules:deployed
```

## Deployment

- Vercel builds the root project and serves the SPA plus `/api/*`.
- Firebase owns Authentication, Firestore, App Check, and capture processing.
- Railway builds `litellm-proxy/` and owns provider credentials, Redis,
  Postgres, budgets, and model routing.
- Firestore Rules are released only from reviewed `main` through the guarded
  process in `SECURITY_RELEASE.md`.

Use a Vercel preview for feature-branch verification. Do not promote a preview
until the deployed checklist in `IMPLEMENTATION_VERIFICATION.md` passes.

Operational guides:

- `SECURITY_RELEASE.md`
- `ACCOUNT_LIFECYCLE_RELEASE.md`
- `PASSWORD_SECURITY.md`
- `litellm-proxy/README.md`
- `MANUAL_SETUP.md`
- `DEPLOYED_PRODUCT_QA_AUDIT_2026-07-28.md`

Landing-page behavior, Gmail preview mode, and Google Calendar preview mode
are intentional and should not be converted to live integrations without the
separate provider setup described in `MANUAL_SETUP.md`.
