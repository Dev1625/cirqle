# Manual Setup

Everything in this file is **optional**. The app runs today with none of it
done — Calendar, Gmail and digest email all run on realistic sample data, every
screen is fully interactive, and each one carries a small `Preview` label so a
demo can't be mistaken for a live connection.

This document is the checklist for turning those previews into real
connections. Written for someone coming back to this after a while: it assumes
you remember nothing, and it says what each step is *for*, not just what to
click.

Do them in whatever order you like. They're independent.

**Time estimate:** Calendar ~20 min, Gmail ~10 min more (shares the same
Google project), digest email ~15 min.

---

## Contents

1. [Running it locally](#1-running-it-locally)
2. [Google Calendar (read-only)](#2-google-calendar-read-only)
3. [Gmail (send + track your own threads)](#3-gmail-send--track-your-own-threads)
4. [The 7-day token expiry — read this one](#4-the-7-day-token-expiry--read-this-one)
5. [The Cloud Function you need to write](#5-the-cloud-function-you-need-to-write)
6. [Transactional email for the digest](#6-transactional-email-for-the-digest)
7. [Firestore rules — must be redeployed](#7-firestore-rules--must-be-redeployed)
8. [Ordering an actual NFC card](#8-ordering-an-actual-nfc-card)
9. [Enabling the rules drift check in CI](#9-enabling-the-rules-drift-check-in-ci)

---

## 0. AI models and where the keys go

### Where to put your DeepSeek key — the short answer

**One place: `litellm-proxy/.env`** (gitignored, never deployed to Vercel).

```bash
cd litellm-proxy
cp .env.template .env          # if you have not already
# then set:
DEEPSEEK_API_KEY=sk-your-real-key
```

Then restart the proxy so it picks the key up:

```bash
docker compose up -d --build
```

If your proxy runs on Railway rather than locally, set `DEEPSEEK_API_KEY` as a
Railway service variable instead — same variable name, same effect.

The three provider routes in `litellm-proxy/config.yaml` are the release
contract: Gemini 3.5 Flash-Lite for `fast`, DeepSeek V4 Flash for `reasoning`,
and DeepSeek V4 Pro for `draft`. Smoke-test all three aliases after every
Railway deployment; process health alone does not prove model-route health.

### Which model each feature uses

Product code asks for a semantic **tier** and sends a required feature ID.
`server/api/_lib/ai-feature-policy.js` is authoritative: it derives the allowed
alias, default/hard token cap, maximum temperature, and usage label. The
browser mapping in `src/lib/aiConfig.ts` is a consistency assertion, not an
authorization boundary.

| Tier | Default model | Used by |
|---|---|---|
| `fast` | `gemini-3.5-flash-lite` | CSV import, Add AI Tags, magic paste-to-contact, voice-memo summary, quick outreach draft |
| `reasoning` | `deepseek-v4-flash` | Ask-AI search, Dashboard priorities, pre-meeting brief, process reply, commitment extraction, dormant-digest note |
| `draft` | `deepseek-v4-pro` | Premium outreach improvement, AI card intro |

**To change a model**, update the tier alias in
`server/api/_lib/ai-feature-policy.js`, mirror it in `src/lib/aiConfig.ts`, and add
the matching alias/provider route in `litellm-proxy/config.yaml`. Redeploy
Vercel and Railway, then make one real completion through every active alias.
There are intentionally no `VITE_AI_MODEL_*` overrides.

**If you rename an alias, three files must agree** or policy/configuration
tests fail:

1. `server/api/_lib/ai-feature-policy.js`
2. `src/lib/aiConfig.ts`
3. `model_name:` in `litellm-proxy/config.yaml`

Managed virtual-key allowlists derive directly from the server feature policy.
Existing deployed keys are reconciled during sign-in; confirm their allowlist
after a release that renames an alias.

### Key hygiene — what lives where

| Secret | Lives in | Never in |
|---|---|---|
| `DEEPSEEK_API_KEY`, `GEMINI_API_KEY` | `litellm-proxy/.env` or Railway vars | git, Vercel, the browser |
| `LITELLM_MASTER_KEY` | Vercel env var (used by `server/api/register-user.js`) **and** the proxy | git, the browser |
| `LITELLM_KEY_DERIVATION_SECRET` | Vercel server env, stable and distinct from the master key | Railway provider config, git, the browser |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | Vercel server env, stable base64-encoded 32-byte key | Railway, git, the browser |
| Per-user virtual key | deterministically derived and used only by verified Vercel server functions | Firestore, browser storage, API responses, logs |

**Nothing prefixed `VITE_` is secret.** Vite inlines those into the browser
bundle at build time, so a real key there is published to every visitor
permanently. The old client-side provider-key and model-override paths have
been removed and must not come back.

Set `LITELLM_GATEWAY_URL` explicitly in every Vercel environment. The server
does not use a hard-coded production URL or `VITE_GATEWAY_URL` fallback, and
it does not reuse `LITELLM_MASTER_KEY` as the derivation secret. Missing
settings fail closed so previews cannot silently call production. Vercel
preview and production also require Upstash/Vercel KV: provisioning checks
separately hashed UID and trusted edge-IP buckets and rejects requests when
distributed throttling is unavailable.

Set `CIRQLE_AI_NEW_KEYS_PER_DAY` in Vercel to the maximum number of brand-new
managed AI keys Cirqle may issue across the deployment in a rolling day
(`25` by default). Reusing an existing deterministic key does not consume the
limit. This is the last-resort spend circuit breaker if automated signups spike.

---

## 1. Running it locally

```bash
npm install
npm run dev          # http://localhost:3000
```

With the Firebase emulator instead of the live project:

```bash
echo "VITE_USE_FIREBASE_EMULATOR=true" > .env.development.local
npx firebase emulators:start --only auth,firestore
npm run dev
```

The emulator uses auth `:9099` and firestore `:8085` (set in `firebase.json`).

Seed test data from the **Seed Test Data** button on the Dashboard.

### Running the security rules tests

```bash
npm test
```

Wraps `tests/firestore-rules.test.mjs` in `firebase emulators:exec`, so the
emulator starts and stops on its own — no manual step. It uses its own ports
(`firebase.test.json`) so it never collides with a dev emulator.

**If it fails with "Could not start Firestore Emulator, port taken":** on
Windows the emulator's Java process sometimes outlives `emulators:exec`,
despite the CLI reporting a clean shutdown. Find and kill the stale one:

```bash
netstat -ano | grep ":8590" | grep LISTENING   # note the PID
taskkill //F //PID <pid>
```

Nothing else uses port 8590, so anything holding it is a leftover test run.

**If it fails with "Firestore Emulator has exited with code: 1" and an empty
`firestore-debug.log`, this is not a stale port and not your Java version.**
The emulator dies before it can log anything. Run the jar directly to see the
real error, because `emulators:exec` swallows it:

```bash
java -jar ~/.cache/firebase/emulators/cloud-firestore-emulator-v*.jar \
  --host=127.0.0.1 --port=8590
```

On this machine that surfaces:

```
java.lang.IllegalStateException: failed to create a child event loop
Caused by: io.netty.channel.ChannelException: failed to open a new selector
Caused by: java.io.IOException: Unable to establish loopback connection
Caused by: java.net.SocketException: Invalid argument: connect
    at sun.nio.ch.UnixDomainSockets.connect0(Native Method)
    at sun.nio.ch.WEPollSelectorImpl.<init>(WEPollSelectorImpl.java:79)
```

Java's Windows selector opens its internal wakeup pipe over an **AF_UNIX
socket**, and that `connect` is failing at the OS level. It is a machine
problem, not a project or JDK problem — **Temurin 21 and Oracle 25 both fail
identically here**, and neither `--add-opens java.base/sun.nio.ch=ALL-UNNAMED`,
`--sun-misc-unsafe-memory-access=allow`, nor forcing
`-Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.WindowsSelectorProvider`
works around it (all three were tried). Shortening `TMP`/`TEMP` does not help
either; the AF_UNIX path length is not the issue.

Usual causes are endpoint-security software blocking AF_UNIX, or a damaged
Winsock catalog (`netsh winsock reset`, then reboot). Until it is fixed, the
rules suite can only be run in CI, which does pin Java 21 via
`actions/setup-java` and passes there.

This also blocks `firebase deploy`, because the `firestore` predeploy hook runs
`npm run test:rules` — so a broken emulator looks like a rules failure or a
hanging deploy rather than a local networking problem. When CI has already run
the suite green on the exact commit you are deploying, the gate is satisfied;
deploy with a config that omits the hook and verify afterwards:

```bash
# firebase.deploy.json: same firestore block, no "predeploy"
npx firebase deploy --config firebase.deploy.json --project production \
  --only firestore:rules,firestore:indexes
npm run verify:firestore-rules:deployed   # compares deployed SHA-256 to the repo
```

`--project production` is required: `.firebaserc` defines `preview` and
`production` with no default.

`npm test` runs the rules suite and the Cloud Function trigger suite in turn.
They deliberately use separate emulators (`firebase.test.json` and
`firebase.functions-test.json`): the rules tests seed a capture document as a
fixture, and with functions running the trigger would delete that fixture out
from under the assertions that read it.

### Deploying the capture trigger

`functions/index.js` holds `onCardCapture`, which files an NFC tap into the
owner's Directory the moment it happens instead of on their next app load.

```bash
cd functions && npm install && cd ..
npx firebase deploy --only functions
```

This needs the Blaze (pay-as-you-go) plan — Cloud Functions are not available
on Spark. For a personal card the volume rounds to nothing, but the plan
change is a real prerequisite, not a formality.

This function is required for reverse capture. Capture filing is deliberately
server-only: browser rules cannot create capture evidence or contacts through
this path. That keeps owner checks, deduplication, consent provenance, and the
atomic capture claim inside the trusted backend. If the function is not
deployed, the public visitor can still download the vCard, but the captured
lead will remain pending. Once deployed, failed deliveries are retried by the
server and the idempotent transaction safely ignores an already-filed capture.

### Running a second emulator (two worktrees at once)

Those default ports only fit one emulator. If a second checkout is already
running one, `emulators:start` fails with "port taken" — and the trap is that
pointing the app at the *first* emulator appears to work while silently running
against that branch's `firestore.rules`, which fails in confusing ways.

Give the second instance its own ports. Create `firebase.local.json` (already
gitignored):

```json
{
  "firestore": { "rules": "firestore.rules" },
  "emulators": {
    "auth":      { "port": 9299 },
    "firestore": { "port": 8285 },
    "ui":        { "enabled": true, "port": 4600 },
    "hub":       { "port": 4402 },
    "logging":   { "port": 4602 }
  }
}
```

and a matching `.env.development.local`:

```
VITE_USE_FIREBASE_EMULATOR=true
VITE_EMULATOR_AUTH_PORT=9299
VITE_EMULATOR_FIRESTORE_PORT=8285
```

then:

```bash
npx firebase emulators:start --config firebase.local.json --only auth,firestore
npm run dev -- --port 3200
```

The hub and logging ports matter too — the CLI aborts if either collides, even
though neither is a service you use directly.

---

## 2. Google Calendar (read-only)

**What this buys you:** pre-meeting briefs on the Dashboard fire against real
meetings, and Event Mode can auto-suggest "you're at SaaStr right now" instead
of you typing the event name.

**Scope requested:** `calendar.events.readonly` — nothing in this app writes to
a calendar, and asking for write access you don't use makes the consent screen
scarier and the eventual verification slower.

### Steps

1. **Create a Google Cloud project.**
   Go to <https://console.cloud.google.com/projectcreate>. Name it something
   you'll recognise (`cirqle-integrations`). Note the project id.

2. **Enable the Calendar API.**
   APIs & Services → Library → search "Google Calendar API" → **Enable**.

3. **Configure the OAuth consent screen.**
   APIs & Services → OAuth consent screen.
   - User type: **External**. (Internal is only available with Google
     Workspace, and only for your own domain.)
   - App name, your support email, your developer contact email. That's all
     that's required.
   - Publishing status: leave it on **Testing**. Do not click "Publish app" —
     that starts a verification review you don't need yet, and see §4 for the
     one real consequence of staying in Testing.

4. **Add yourself as a test user.**
   Same screen → **Test users** → **Add users** → your own Google address.
   **This is the step people forget.** In Testing status, only listed test
   users can complete the consent flow; everyone else gets a flat
   "access blocked" error that doesn't explain itself.

5. **Add the scope.**
   Same screen → **Scopes** → **Add or remove scopes** → paste:
   ```
   https://www.googleapis.com/auth/calendar.events.readonly
   ```

6. **Create the OAuth client.**
   APIs & Services → Credentials → **Create credentials** → **OAuth client ID**.
   - Application type: **Web application**
   - Authorised redirect URI — must match exactly, including protocol and
     absence of a trailing slash:
     ```
     http://localhost:3000/api/integrations/oauth/callback
     ```
     Add your production origin as a second URI when you deploy.
   - Copy the **client ID** and the **client secret**.

7. **Put them where they go.** The split is a security boundary.

   In the Vercel server environment:
   ```
   INTEGRATIONS_LIVE_ENABLED=true
   INTEGRATIONS_APP_ORIGIN="https://your-canonical-domain.example"
   GOOGLE_CLIENT_ID="xxxxx.apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="xxxxx"
   GOOGLE_TOKEN_ENCRYPTION_KEY="<base64-encoded 32-byte key>"
   GOOGLE_OAUTH_TEST_MODE=true
   ```

   In the Vercel browser-build environment:
   ```
   VITE_INTEGRATIONS_MODE=live
   VITE_INTEGRATIONS_API_BASE="/api/integrations"
   ```

   Never put the client secret, client id, token-encryption key, refresh
   tokens, or OAuth state in a `VITE_*` variable. The browser asks the
   authenticated start endpoint for a Google URL; it does not construct OAuth
   state. Keep `GOOGLE_TOKEN_ENCRYPTION_KEY` stable: changing or losing it
   requires every existing user to reconnect Google.

8. **Redeploy or restart the local Vercel runtime.** Vite only reads browser
   variables at build startup and Vercel functions read server variables at
   runtime.

9. Settings → **Connections** → Calendar → **Connect**. You'll get Google's
   consent screen with an "unverified app" warning — expected in Testing
   status. Click through it.

The `Preview` labels disappear once a provider is genuinely connected.

---

## 3. Gmail (send + track your own threads)

Shares the Google project from §2. Enable the **Gmail API** in the Library, and
add these two scopes to the consent screen:

```
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.metadata
```

### Why these two and not `gmail.readonly`

This was a deliberate choice and it's worth not undoing by accident later.

- **Privacy.** The app only ever needs the state of threads *it created*.
  `gmail.metadata` returns headers and label ids but **no message bodies** —
  so "Cirqle only ever looks at threads it started, and never reads your mail"
  is enforced by the scope itself, not promised in a policy page.
- **Verification cost.** `gmail.readonly` is a **restricted** scope: Google
  requires a third-party security assessment (historically $15k–$75k and
  several weeks) before you can publish. `gmail.metadata` is *sensitive* but
  not restricted — a materially cheaper and faster path when you're ready to
  verify.
- **Consent conversion.** "Send email on your behalf" is a very different ask
  from "read all your email".

If you later need message bodies (for reply-content analysis, say), that's a
real decision with a real price tag, not a config tweak.

No separate login is involved: the app uses **incremental authorisation**
(`include_granted_scopes=true`), so Gmail is added on top of the Google
grant you already approved. Connecting Gmail does not revoke Calendar. Google
revocation applies to that combined user/app grant, however, so Cirqle exposes
one honest **Disconnect Google** action that disconnects Calendar and Gmail
together.

---

## 4. The 7-day token expiry — read this one

**While your app is in Testing publishing status, Google expires refresh
tokens after 7 days.** You will have to reconnect Calendar and Gmail roughly
weekly.

**This is expected behaviour and not a bug.** The app detects it and shows a
**Reconnect** button in Settings → Connections with a plain-language note, so
it degrades gracefully rather than silently failing.

The only way to stop it is to move the OAuth consent screen to **In
production** and complete Google's verification (domain ownership, a privacy
policy URL, a demo video, and — for restricted scopes — a security assessment).
Worth doing when you have real users. Not worth doing to test a feature.

---

## 5. Live integration server boundary

The integration handlers are implemented as same-origin Vercel functions.
Firebase no longer exports a second OAuth callback.

**Why it has to exist at all:** a Google refresh token is a standing key to
your inbox that survives password changes. It must never be in a
client-readable Firestore field and never in browser storage. The browser's
only involvement is the initial consent redirect.

Endpoints the client expects at `VITE_INTEGRATIONS_API_BASE`
(default `/api/integrations`):

| Method | Path | Does |
|---|---|---|
| `POST` | `/oauth/start` | Verifies a non-revoked Firebase token and creates opaque state + PKCE |
| `GET` | `/oauth/callback` | Atomically consumes state, exchanges `?code`, stores provider credentials server-side, redirects to the canonical origin |
| `POST` | `/disconnect` | Revokes the shared Google grant and disconnects Calendar and Gmail together |
| `GET` | `/calendar/upcoming` | Returns `{ events: [...], syncedAt }` |
| `POST` | `/gmail/send` | Requires an exact saved outreach, reserves its idempotency key, sends once, and atomically records bounded provider ids plus server-owned proof |
| `POST` | `/gmail/poll` | Takes `{ historyId, threadIds }`, returns `{ statuses, historyId }` |

Shapes are defined in `src/lib/integrations/calendar.ts` and
`src/lib/integrations/gmail.ts` — those files are the contract.

Encrypted token envelopes live in
`oauthTokens/{uid}/providers/{provider}`. AES-256-GCM authenticates both the
ciphertext and its UID/provider context. Firestore rules deny browser access
recursively. `users/{uid}/integrations/{provider}` is client-readable by
design and holds **status metadata only**, including the verified email of the
Google account the user actually selected.

Successful sends are registered under the server-only OAuth tree. A retry with
the same outreach idempotency key returns the already completed send instead
of calling Gmail again. A conflicting payload is rejected, and an ambiguous
pending result tells the user to check Gmail instead of risking a duplicate.
Before Google is contacted, the server verifies that the authenticated user's
saved draft, contact email, subject, and body match the request and places a
server-owned reservation on the outreach. After Google returns, one Firestore
transaction writes the provider-verified outreach state, live thread, sent-
thread allowlist entry, and idempotency receipt. The browser cannot award
itself provider verification. Status polling is limited to thread IDs that
Cirqle itself successfully sent.

OAuth state lives under `_oauthStates/{sha256(state)}`, is valid for ten
minutes, and is deleted transactionally before code exchange. Enable a
Firestore TTL policy on its `expiresAt` field so abandoned consent attempts
are eventually removed. See `GOOGLE_INTEGRATIONS_SECURITY.md`.

The complete Firestore TTL inventory is:

| Collection group | Field |
|---|---|
| `_oauthStates` | `expiresAt` |
| `captureGuards` | `expiresAt` |
| `_accountSecurity` | `expiresAt` |
| `_accountDeletionReceipts` | `expiresAt` |

Enable each policy in the Firebase/Google Cloud console for the exact
collection-group and field name. `_accountSecurity.expiresAt` is present only
on deleted-account tombstones; active accounts do not expire. TTL deletion can
lag, so application checks remain the security boundary.

**Polling, not push.** Both integrations poll. Gmail `watch()` and Calendar
watch channels need a public HTTPS webhook, a Pub/Sub topic, and renewal every
7 days, and they buy nothing until you're past testing-mode limits. Polling
upcoming events every few minutes is right for this stage.

---

## 6. Transactional email for the digest

**Only needed to email the dormant-contact digest out.** The in-app
"Worth reviving" surface on the Dashboard is fully real and needs none of this.

1. Sign up for **Resend** (<https://resend.com>), Postmark, or SendGrid. All
   have a free tier sufficient for a weekly personal digest.
2. Verify a sending domain. This means adding SPF and DKIM DNS records — the
   provider gives you the exact values. Without it your digest lands in spam.
3. Add to `.env.local`:
   ```
   VITE_EMAIL_MODE=live
   VITE_EMAIL_FROM="you@yourdomain.com"
   ```
4. Put the provider's **API key** in your server environment, never in
   `.env.local` — anything prefixed `VITE_` is compiled into the browser
   bundle and is readable by anyone who opens devtools.
5. Implement `POST /api/digest/send`. The payload shape is in
   `sendDigestEmail()` in `src/lib/digest.ts`.

Until then, "Email it" says plainly that delivery isn't configured. It does
not pretend to have sent anything.

---

## 7. Firestore rules — must be redeployed

The NFC card needs a public read surface, so `firestore.rules` changed in this
pass. **Deploy it or the card page will 404 for everyone including you:**

```bash
npx firebase deploy --only firestore:rules
```

What was added, and the reasoning:

- `cards/{cardId}` is **publicly readable**. It's a denormalised, opt-in
  snapshot of only what you chose to put on your card — it is never a window
  onto `users/{uid}`, which stays owner-only. Card ids are 10 characters of a
  31-symbol alphabet (~2⁴⁹), so the collection isn't enumerable by guessing.
- `cards/{cardId}/captures` accepts **unauthenticated creates only**, with a
  validated field list and length caps, and **no public read**. A stranger can
  leave a card; they can never enumerate who else has.

These are covered by 15 rules tests that were run against the emulator during
this build (public read allowed, stranger overwrite denied, oversized and
malformed captures denied, capture enumeration denied, existing user data
still private). The test file wasn't committed — see the report.

---

## 8. Ordering an actual NFC card

No software work left. The card page already exists at `/c/:cardId`.

1. Settings → Connections → publish your card, then copy the link.
2. Buy NTAG215 blank cards (a few pounds for ten, any of the usual sites).
3. Write the URL to the tag with **NFC Tools** (iOS/Android, free): Write →
   Add a record → URL → paste → Write.
4. Lock the tag only when you're happy with the URL — locking is permanent.

The card id doesn't change when you edit your card's content, so a written tag
keeps working after redesigns. If you ever need to retire a card, unpublish it
and the page returns a clean "no card here" state rather than an error.

---

## 9. Enabling the rules drift check in CI

The `Security policy` workflow has a `Production rules match main` job that
reads the **live** Firestore rules and compares them byte-for-byte with
`firestore.rules` on `main`. It catches the case where someone edits rules in
the Firebase console, or a rules deploy silently fails, and production quietly
drifts away from what the repo says is enforced.

It needs read-only access to your Google Cloud project. Until the two secrets
below exist the job **skips with a warning** instead of failing — so this is
optional, but the check is only real once you do it.

Use Workload Identity Federation rather than a downloaded service-account
key: GitHub mints a short-lived token per run, so there is no long-lived
credential to leak or rotate.

```bash
PROJECT_ID=cirqle-9dd06
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

# 1. A pool + provider that trusts only this repository.
gcloud iam workload-identity-pools create github --project="$PROJECT_ID" --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github-actions \
  --project="$PROJECT_ID" --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='Dev1625/cirqle'"

# 2. A service account that can read rules and nothing else.
gcloud iam service-accounts create firestore-rules-viewer --project="$PROJECT_ID" \
  --display-name="CI Firestore rules viewer"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:firestore-rules-viewer@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/firebaserules.viewer"

# 3. Let only this repo impersonate it.
gcloud iam service-accounts add-iam-policy-binding \
  "firestore-rules-viewer@$PROJECT_ID.iam.gserviceaccount.com" --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/Dev1625/cirqle"

echo "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-actions"
```

Then add two repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `GCP_WIF_PROVIDER_CIRQLE` | the `projects/…/providers/github-actions` string printed above |
| `GCP_RULES_VIEWER_SERVICE_ACCOUNT` | `firestore-rules-viewer@cirqle-9dd06.iam.gserviceaccount.com` |

The next scheduled or pushed run picks them up automatically — no workflow
edit needed. `roles/firebaserules.viewer` is read-only, so a compromised run
can read rules and nothing else.
