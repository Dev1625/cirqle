# Firestore policy and browser-header release guide

This repository is the source of truth for Cirqle's Firestore Security Rules.
Do not edit production rules in the Firebase console. A console edit is
overwritten by the next CLI release and is detected by the scheduled drift
check.

Production resources pinned by this guide:

- Firebase project: `cirqle-9dd06`
- Firestore database: `(default)`
- Rules source: `firestore.rules`
- Vercel policy source: `vercel.json`

Firebase documents that CLI rule deployments overwrite console rules, which
is why the checked-in file and controlled release are authoritative:
https://firebase.google.com/docs/cli#deployment_conflicts_for_security_rules

## What is protected

- `users/{uid}` and every nested CRM collection are owner-only.
- `oauthTokens/{uid}` is inaccessible to every browser, including its owner.
- `cards/{cardId}` supports direct anonymous reads only while `published` is
  true. The global cards collection cannot be listed.
- Card writes are owner-only and field-allowlisted so private profile fields
  cannot accidentally become public.
- Anonymous visitors submit a strictly shaped capture through
  `/api/cards/capture`; direct browser writes are denied so abuse controls
  cannot be bypassed.
- The server verifies the published card and writes the timestamp. Captures
  cannot be publicly read, listed, edited, or deleted.
- The card owner can read and drain captures; Cloud Functions can process them
  through the Admin SDK.

## Local checks

Run these before reviewing any policy or hosting-header change:

```sh
npm run test:rules
node tests/security-config.test.mjs
```

The rules suite exercises allowed and denied behavior against the Firestore
emulator. The offline configuration suite verifies that Firebase deploys the
same file the emulator tests, and that Vercel keeps the required security
headers and API-before-SPA routing.

`firebase.json` also runs both checks as a Firestore `predeploy` hook. A direct
`firebase deploy --only firestore:rules` therefore cannot skip them.

Run `npm run audit:runtime` and `npm --prefix functions audit --omit=dev` as
well. The Functions production dependency tree must contain zero known
vulnerabilities.

Legacy releases could leave commitment-feedback events behind after their
parent commitment was removed. `npm run audit:orphan-feedback` performs a
count-only, dry-run audit across user workspaces. Current contact purge deletes
feedback before commitments, so this is only a legacy-data repair tool. Apply
mode is intentionally double-gated and transactionally rechecks that every
parent is still absent:

```powershell
$env:CIRQLE_ORPHAN_FEEDBACK_CLEANUP_ALLOW='true'
npm run audit:orphan-feedback -- --apply --confirm=DELETE-ORPHAN-COMMITMENT-FEEDBACK
```

The web runtime currently carries React Router
`GHSA-qwww-vcr4-c8h2` because the patched `react-router@8.3.0` release does not
yet have a matching `react-router-dom` release. The upstream advisory states
that it affects only applications using the unstable RSC APIs. Cirqle is a
client-only Vite `BrowserRouter` application and does not install or import
the React Router server/RSC packages. `npm run audit:runtime` fails if any
other runtime advisory appears or if an RSC package/API/configuration is
introduced. Upgrade both Router packages together as soon as a compatible
patched DOM release exists; do not force a mismatched transitive version.

## Verify production without changing it

```sh
npm run verify:firestore-rules:deployed
```

The verifier reads the active `cloud.firestore` release through the Firebase
Rules API and compares a SHA-256 digest with the committed `firestore.rules`.
It prints only resource names and digests. It never prints credentials or rule
source.

Local verification uses the current `firebase login`. CI uses Application
Default Credentials.

## Controlled production release

Only release after the reviewed policy has been merged to `main` and the
security workflow is green:

```sh
git switch main
git pull --ff-only
npm run release:firestore-rules -- --confirm-production=cirqle-9dd06
```

The release script refuses to run:

- without the exact production confirmation,
- outside `main`, or
- while a policy/release file is uncommitted.

The Firebase predeploy hook runs the emulator and configuration checks. The
script then deploys only Firestore rules to `cirqle-9dd06` and independently
reads the active release back. Success means the deployed digest exactly
matches the repository.

Firebase Security Rules do not support one-click rollback. Revert the bad
policy in Git, review it, merge it, and run the controlled release again.

## GitHub drift monitor setup

Use GitHub OIDC/Google Workload Identity Federation so the repository does not
store a long-lived service-account key:

1. Create a dedicated service account and grant it
   `roles/firebaserules.viewer` on `cirqle-9dd06`.
2. Create a Workload Identity Pool/provider restricted to this GitHub
   repository and permit that identity to impersonate the viewer account.
3. Store the provider resource name in the Actions secret
   `GCP_WIF_PROVIDER_CIRQLE`.
4. Store the viewer service-account email in
   `GCP_RULES_VIEWER_SERVICE_ACCOUNT`.
5. Run the **Security policy** workflow manually once.
6. Make that workflow a required branch check for changes to policy files.

Google documents that `roles/firebaserules.viewer` includes the read
permissions used here:
https://cloud.google.com/iam/docs/roles-permissions/firebaserules

The workflow runs policy tests on relevant pull requests and runs production
drift verification after relevant `main` pushes, on manual dispatch, and every
day. A console edit or missed release therefore produces a failing check
without granting CI permission to modify production.

Google's authentication action recommends Workload Identity Federation over
service-account JSON keys:
https://github.com/google-github-actions/auth

## Protected release-candidate smoke environments

The **Production candidate smoke** workflow deliberately uses two separate
GitHub environments:

- `preview-candidate` contains only the isolated preview Firebase, LiteLLM,
  and web API credentials.
- `production-candidate` contains only reviewed production credentials.

Configure required reviewers on both environments and keep their secrets
environment-scoped. Use the same secret names in each environment; never add
these credentials as repository-wide Actions secrets. The workflow selects a
static job and environment for the requested target, and the smoke script
independently verifies the deployment mode, explicit Firebase project, and
service-account project before it creates a disposable user.

A preview run fails before initialization if either Firebase project source
resolves to `cirqle-9dd06`. A production run fails unless both sources resolve
to that reviewed production project and the candidate URL is a recognized
production URL. This prevents a preview URL from receiving production
credentials even if a workflow input or environment secret is misconfigured.

## Vercel security headers

`vercel.json` applies these enforced headers to every response:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer` (prevents Firebase action codes and private
  app routes from appearing in same-origin asset/API referrers)
- `X-Frame-Options: DENY`
- a least-privilege `Permissions-Policy` that preserves first-party voice
  input
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` for Google sign-in

Vercel continues to supply its platform HSTS policy; the application config
does not weaken or override it.

All `/api/*` responses also receive
`Cache-Control: private, no-store, max-age=0`, preventing authenticated AI,
usage, provisioning, and account-lifecycle responses from being stored by a
browser cache or intermediary.

The Content Security Policy starts as
`Content-Security-Policy-Report-Only`. Its allowlist includes the bundled app,
Google Fonts, Firebase/Auth/Firestore, first-party APIs and workers, and blob
media used by supported browser features. Railway/LiteLLM is intentionally not
in `connect-src`; the browser must reach AI only through authenticated
same-origin APIs.

Before promoting CSP from report-only to enforced:

1. Deploy a Vercel preview.
2. Exercise email/password and Google sign-in, every Firebase CRUD flow,
   Firestore realtime updates, AI calls, PDF parsing, voice input, QR/vCard,
   and the anonymous public-card capture flow.
3. Review browser CSP violations and add only sources proven necessary.
4. Repeat on production with monitoring.
5. Replace the report-only header key with `Content-Security-Policy`, retain
   the same offline checks, and rerun the full deployed smoke suite.

Do not add `unsafe-eval`, wildcard `script-src`, wildcard `frame-src`, or a
global CORS header to make a violation disappear.

## Remaining Firebase console hardening

App Check is not activated by a rules deployment. The web client now contains
opt-in reCAPTCHA Enterprise App Check initialization with automatic token
refresh. Register the Vercel web app with reCAPTCHA Enterprise, set
`VITE_FIREBASE_APP_CHECK_SITE_KEY` in the Vercel preview environment, and first
run Firestore App Check in monitoring mode. Confirm that signed-in CRM use and
anonymous public-card captures both obtain valid App Check tokens before
enforcement. Then copy the variable to production, enable Firestore
enforcement, and repeat the deployed public-card and owner-flow tests.

This staged console change is intentionally not performed by the rules release
script: enabling enforcement before the web client is registered would block
every legitimate browser request.

Capture creation now runs through an App-Check-aware server endpoint with a
honeypot, per-card and per-visitor throttling, one-day duplicate suppression,
strict normalization, and a published-card check. Direct browser writes are
denied. Configure Upstash/Vercel KV credentials so throttling is distributed
across serverless instances; the in-process limiter is only a resilience
fallback.

Configure and verify all four Firestore TTL policies before promotion:

| Collection group | TTL field | Data removed |
|---|---|---|
| `_oauthStates` | `expiresAt` | Abandoned, single-use OAuth consent state |
| `captureGuards` | `expiresAt` | Non-sensitive public-capture duplicate guards |
| `_accountSecurity` | `expiresAt` | Deleted-account revocation tombstones after their 48-hour safety window |
| `_accountDeletionReceipts` | `expiresAt` | Opaque deletion receipts after one year |

An active `_accountSecurity` document deliberately has no `expiresAt`, so the
TTL policy cannot remove an active account lock. TTL is asynchronous cleanup,
never authorization: every endpoint and rule must continue to validate status
and expiry even while an expired document is waiting to be deleted. Record the
four enabled field policies in the production-candidate verification report.

## Package script entries

Keep these entries in the root `package.json`:

```json
{
  "scripts": {
    "test:security-config": "node tests/security-config.test.mjs",
    "audit:runtime": "node scripts/check-runtime-audit.mjs",
    "verify:firestore-rules:deployed": "node scripts/verify-deployed-firestore-rules.mjs",
    "release:firestore-rules": "node scripts/release-firestore-rules.mjs"
  }
}
```
