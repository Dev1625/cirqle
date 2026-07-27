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

**Before it will work**, confirm two model ids in `litellm-proxy/config.yaml`.
The aliases (`deepseek-v4-flash`, `deepseek-v4-pro`) are correct; the `model:`
values underneath them are a best guess I could not verify. Check DeepSeek's
current model list and edit those two lines. Nothing else changes.

### Which model each feature uses

The app never names a model. It asks for one of three **tiers**, mapped in
`src/lib/aiConfig.ts`:

| Tier | Default model | Used by |
|---|---|---|
| `fast` | `gemini-2.5-flash-lite` | CSV import, Add AI Tags, magic paste-to-contact, voice-memo summary |
| `reasoning` | `deepseek-v4-flash` | Ask-AI search, Dashboard priorities, pre-meeting brief, process reply, commitment extraction, dormant-digest note |
| `draft` | `deepseek-v4-pro` | Draft Outreach, AI card intro |

**To change a model**, edit one line in `src/lib/aiConfig.ts` — or override per
deploy with `VITE_AI_MODEL_FAST` / `_REASONING` / `_DRAFT`. To change what an
alias actually runs on, edit `litellm-proxy/config.yaml` and restart the proxy;
no app rebuild needed.

**If you rename an alias, three files must agree** or you get a 401/403 that
looks like an auth bug:
1. `src/lib/aiConfig.ts`
2. `model_name:` in `litellm-proxy/config.yaml`
3. the `models: [...]` allowlist in `api/register-user.js` — virtual keys are
   scoped per model

### Key hygiene — what lives where

| Secret | Lives in | Never in |
|---|---|---|
| `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` | `litellm-proxy/.env` or Railway vars | git, Vercel, the browser |
| `LITELLM_MASTER_KEY` | Vercel env var (used by `api/register-user.js`) **and** the proxy | git, the browser |
| Per-user virtual key | minted server-side, held in Firestore + `localStorage` | — |

**Nothing prefixed `VITE_` is secret.** Vite inlines those into the browser
bundle at build time, so a real key there is published to every visitor
permanently. The old client had a `VITE_GEMINI_API_KEY` fallback; it has been
removed and must not come back. The only `VITE_` AI variables now are the
gateway URL and model alias names, neither of which is sensitive.

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

**You do not have to deploy it.** The client-side drain in
`src/hooks/useCaptureDrain.ts` still works and still ships; the only
difference is that a captured contact appears on your next app load rather
than instantly. Both paths claim each capture in a transaction, so running
both at once cannot produce a duplicate contact.

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

7. **Put them where they go.** The split matters:

   In `.env.local` (client-side, and safe — a client id is public by design):
   ```
   VITE_INTEGRATIONS_MODE=live
   VITE_GOOGLE_CLIENT_ID="xxxxx.apps.googleusercontent.com"
   ```

   In your **Cloud Function's** environment, never in `.env.local` and never
   in Firestore:
   ```
   GOOGLE_CLIENT_SECRET="xxxxx"
   ```

8. **Restart `npm run dev`.** Vite only reads env vars at startup.

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
Sign-In you already did. Connecting Gmail does not revoke Calendar.

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

## 5. The Cloud Function you need to write

**Not implemented in this pass.** The client code calls it and degrades
cleanly when it's absent, but the function itself is yours to write. It is the
only thing standing between the current preview mode and live mode.

**Why it has to exist at all:** a Google refresh token is a standing key to
your inbox that survives password changes. It must never be in a
client-readable Firestore field and never in browser storage. The browser's
only involvement is the initial consent redirect.

Endpoints the client expects at `VITE_INTEGRATIONS_API_BASE`
(default `/api/integrations`):

| Method | Path | Does |
|---|---|---|
| `GET` | `/oauth/callback` | Exchanges `?code` for tokens, stores the refresh token server-side keyed by uid, redirects back to Settings |
| `GET` | `/calendar/upcoming` | Returns `{ events: [...], syncedAt }` |
| `POST` | `/gmail/send` | Sends a message, returns `{ threadId }` |
| `POST` | `/gmail/poll` | Takes `{ historyId, threadIds }`, returns `{ statuses, historyId }` |

Shapes are defined in `src/lib/integrations/calendar.ts` and
`src/lib/integrations/gmail.ts` — those files are the contract.

Store refresh tokens in Secret Manager, or in a Firestore collection whose
rules deny all client access (`allow read, write: if false`) so only the
Admin SDK can reach them. `users/{uid}/integrations/{provider}` is
client-readable by design and holds **status metadata only** — never put a
token there.

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
