# Feature Build Report — Integrations, NFC, Relationship Intelligence

**Branch:** `feature/major-build-2026-07-25`
**Base:** `origin/main` (b4ee4dd)
**Date:** 2026-07-25
**Scope:** 49 files, +6,014 / −84, in 4 commits
**Not touched:** `apps/mobile`, the app's own login / Firebase-Auth configuration

---

## ⚠️ Read this first: merge these branches one at a time

This work is on its own branch off `main`, deliberately. There is a concurrent
design pass on `polish/depth-pass-2026-07-24`. **Merge one, verify it, then
merge the other. Do not merge both blind.**

### The thing you should know before you plan that merge

`main` does not contain any of the polish work. Not some of it — none of it.

At the time this build started, `polish/depth-pass-2026-07-24` was **3,426
lines ahead of `origin/main` across 34 files**, entirely unmerged. `main`'s
`index.css` was 48 lines with five colour tokens and no keyframes. There was no
`--color-brand`, no `--radius-card`, no motion utilities, no `TierBadge`, no
`ToastContext`, no `ConfirmContext`, no emulator harness. `Settings.tsx` still
used `alert()`.

So the two instructions "branch from `main`" and "inherit the existing visual
and motion language" were in tension: on `main`, that language didn't exist yet.

**How that was resolved.** The design foundation was ported onto this branch
**verbatim** from `polish/depth-pass-2026-07-24` — same token names, same hex
values, same class names, same component APIs. Eight files are byte-identical
to that branch:

```
firebase.json                   src/config/firebase.ts
src/index.css                   src/contexts/ToastContext.tsx
src/components/ui/Button.tsx    src/contexts/ConfirmContext.tsx
src/components/ui/Input.tsx     src/components/ui/TierBadge.tsx
```

(Verified with `diff` against that branch after the final commit, not assumed.)

Because the content is identical, git resolves all eight automatically in
either merge order, and no feature code has to change either way.

### The actual conflict surface: 7 files

These are touched by both branches with genuinely different content:

| File | This branch changed | Expect |
|---|---|---|
| `src/pages/Settings.tsx` | Profile/Connections tabs, `alert()` → toasts, card setup | **Largest.** Both restructured it |
| `src/pages/Dashboard.tsx` | +3 panels, calendar hook, memo modal | Additive; polish restyled existing blocks |
| `src/pages/ContactDetail.tsx` | Intelligence block, thread tracking on send, `c` shortcut | Additive, 4 small hunks |
| `src/layouts/AppLayout.tsx` | Capture drain, shortcuts, What's New entries | Moderate |
| `src/App.tsx` | `/c/:cardId` route + 2 providers | Small; polish added lazy routes |
| `src/pages/Directory.tsx` | Avatar component swap | 2 lines |
| `src/components/GlobalNLSearch.tsx` | `data-shortcut` attribute + placeholder hint | 2 lines |

### Recommended order

**Merge `polish/depth-pass-2026-07-24` first, then this branch.** Polish is the
larger visual diff and the one whose styling decisions should win. When you
then merge this branch, take *theirs* (polish) for anything purely visual and
keep *ours* for the additive feature blocks — they're separable, because the
feature work lives in new files and the edits to shared files are marked
insertions rather than rewrites.

`firestore.rules` and `package.json` do **not** conflict — polish touched
neither.

**One follow-up this creates:** `src/pages/Settings.tsx` and
`src/pages/Dashboard.tsx` on this branch were written against the ported
foundation, so they already use `rounded-card`, `border-ink/15` and `text-muted`.
If polish restyled the same blocks differently, reconcile toward polish.

---

## What got built, and how real each piece is

Legend: **Real** = works fully, no external credential.
**Mock-gated** = fully interactive on realistic sample data, one env var from live.
**Scaffolded** = client contract written, server half is yours.

| # | Feature | Status |
|---|---|---|
| 1 | NFC digital card | **Real** end to end |
| 2 | Google Calendar | **Mock-gated**; Cloud Function scaffolded |
| 3 | Gmail | **Mock-gated**; Cloud Function scaffolded |
| 4 | Pre-meeting briefing | **Real** logic, on mock-gated calendar data |
| 5 | Voice memo | **Real** (Web Speech API — no credential at all) |
| 6 | "Why they matter" | **Real** |
| 7 | Commitment tracking | **Real** |
| 8 | Health score | **Real** — extended, not duplicated. See audit note |
| 9 | Dormant digest | **Real** in-app; email delivery scaffolded |
| 10 | Public-signal monitoring | **Not built — deliberately.** See below |

---

### 1. NFC digital card — the highest-payoff piece, and it's fully real

No physical card exists and none is needed to demo this. An NFC tag is a chip
that opens a URL, so `/c/:cardId` *is* the product; provisioning hardware later
is a write-the-URL step with zero further software work.

**Public page** (`src/pages/PublicCard.tsx`) — public route outside both
layouts, because someone who tapped a chip should land on a card, not on a
product's chrome. Loading, not-found and ready states all designed; a retired
link says so plainly instead of erroring.

**First visit** asks one question, once: a name. A `localStorage` flag, not an
account — no cookie, no identifier, nothing that follows the viewer off the
page. Skippable.

**Reverse capture — the asymmetry that beats paper.** Saving the contact
downloads a vCard *and* writes a capture back to the owner's account. The vCard
download never waits on that network write, so the viewer's half can't be
broken by the owner's half failing. On the owner's next app load,
`useCaptureDrain` files pending captures into real contacts, pre-filled with
timestamp and — when Event Mode is on — the event name.

**Three creation routes**, in order of decreasing friction: AI draft from
bio/resume (suggested by default, because the other two start from a blank
field), manual customiser (six accents, all drawn from the existing palette —
no new colours were introduced — plus compact/expanded), or point at an
existing page with the name prompt layered over it. The AI route has
loading/error+retry/empty states *and* an explicit "compose without AI"
fallback — never a silent substitution.

**QR fallback** and a **"Preview my card"** link in Settings, so the entire flow
demos with no hardware.

**Event Mode** — manual or calendar-suggested, batch-tags every capture in the
window, then builds a recap. The recap counts contacts that *actually landed*
rather than a counter incremented on attempt, so it says six when six landed.

**Definition of done:** met, with one honest caveat — see Verification below.

---

### 2 & 3. Calendar and Gmail

**Mock by default, and the mock is not a placeholder.** The mock calendar
synthesises events from the owner's **real contacts**, which is what makes the
briefing genuinely demoable — a brief about a stranger is useless. Events are
deterministic per user per day, and the first meeting is always still ahead of
"now", so "today's meetings" is never empty on a fresh demo.

**Live mode requires BOTH** `VITE_INTEGRATIONS_MODE=live` **and** a client id.
Requiring both means a half-finished `.env` degrades to a working demo rather
than a broken OAuth redirect loop.

**Scopes, deliberately narrow:**
- Calendar: `calendar.events.readonly`. Nothing here writes to a calendar.
- Gmail: `gmail.send` + `gmail.metadata`, **not** `gmail.readonly`.

The Gmail choice is the one worth not undoing by accident. `gmail.metadata`
returns headers and label ids but no message bodies, so "Cirqle only ever looks
at threads it started" is enforced by the scope rather than promised in a
policy page. It's also *sensitive* rather than *restricted*: `gmail.readonly`
triggers a mandatory third-party security assessment before you can publish,
which is a materially more expensive and slower verification path.

**Incremental authorisation**, not a second login — `include_granted_scopes=true`
merges the new scope into the existing Google Sign-In grant, so connecting
Gmail doesn't revoke Calendar.

**Token storage is the hard requirement it was stated to be.** No refresh token
is written anywhere the client can read. `users/{uid}/integrations/{provider}`
holds connection *status metadata only*. The browser's sole involvement is the
consent redirect.

**Polling, not push**, for both — watch channels need a public HTTPS webhook, a
Pub/Sub topic and 7-day renewal, and buy nothing before testing-mode limits are
cleared.

**Data model:** outreach → Gmail thread id → contact, plus a per-user
`historyId` sync cursor for incremental checking.

**The payoff moment works in mock mode:** hitting send in Draft Outreach
fabricates a Gmail-shaped 16-hex-char thread id, records it for real, and
"Tracked threads" on the contact lights up immediately. The mock status clock
advances plausibly (delivered after minutes, some replied after hours),
deterministically per thread so a thread never flips back and forth between
polls.

---

### 4. Pre-meeting briefing

Dashboard **"Next up."** — brief per meeting, drawing on notes, outreach
history, the "why they matter" field and open commitments. Sparkle label,
loading/error+retry/empty, plus a non-AI fallback that composes from local
facts when the gateway is unreachable (offered explicitly, never silently).

Length is a feature: 3–4 one-line bullets, because the brief is only worth
having if it fits on a phone screen thirty seconds before you walk in. The
prompt forbids pep talk and restating their job title back.

---

### 5. Voice memo

**Web Speech API** — zero cost, zero credential, no audio leaving the device.
Reachable from Contact Detail regardless of Calendar status, so it's never
blocked on an integration you haven't set up, *and* prompted automatically for
a meeting that just ended.

**Three degradation steps, each explicit:** dictate → type (browser
unsupported, or mic denied) → save raw text (AI gateway down). Firefox has no
support and Safari's is uneven, which is exactly why the manual path is always
offered rather than being an error branch.

**The note is written first and unconditionally.** The AI summary and the
commitment extraction run afterwards, after the modal has closed, and a failure
in either cannot lose the user's words.

No paid transcription service was added. The free path covers the use case, and
adding a credential nobody has configured would make the feature *less*
demoable, not more.

---

### 6. "Why they matter"

One text field, deliberately not a subsystem. It earns its place through
placement: it's the first thing the pre-meeting brief reads and the thing the
dormant digest quotes back. Empty state says *"Not recorded. This is the line
you'll want in six months."*

---

### 7. Commitment tracking

AI extraction from notes and memos, surfaced in the **Follow-Up Queue's visual
language** — same bordered rows, same mono metadata, same action-on-the-right
rhythm — rather than as a new list type that would imply it works differently.

The prompt is strict about what does *not* count (pleasantries, vague
intentions, "we should grab coffee sometime") because the failure mode is a
queue full of noise that trains you to ignore it. Returning an empty list is
stated to be a correct answer. Every item is dismissible.

Re-running over the same note doesn't duplicate: existing commitments are
matched case-insensitively before insert.

---

### 8. Health score — audited first, extended not duplicated

**Audit result: scoring already existed**, in `src/pages/NetworkGraph.tsx`
(`buildAnalysis`). That version is graph-local — computed at render time, never
persisted, used only for node radius and signal colour — and it has no
explanation and no way to stop the decay.

`src/lib/health.ts` **carries those exact weights forward** (tier points,
interaction/response/meeting/referral bonuses, the >60d and >120d decay steps)
so one contact can't read 72 on one screen and 58 on another. What's added is
what was missing:

- **Explainability.** `"72 and falling — last contact 47 days ago."`, plus a
  ranked breakdown of what moved the number, so it's auditable rather than
  oracular.
- **Pinning.** A mentor you see quarterly is not "going cold", and a score that
  insists otherwise is simply wrong. Pinned contacts stop decaying and are
  excluded from the dormant digest.

**Deliberately not done:** `NetworkGraph.tsx` was **not** refactored to call
this. It's heavily modified on the concurrent polish branch, and rewriting it
here would have produced a large merge conflict for no user-visible gain. The
two should be unified once that branch lands — that's the top follow-up.

**This is a first pass, not a mature system**, and it overlaps work in progress
separately. Treat the weights as inherited, not endorsed.

---

### 9. Dormant-contact digest

**Content generation and the in-app surface are fully real** — no mock, no
external dependency.

Ranking is by *what's worth reviving*, not raw staleness: tier weight and
whether they ever replied both push up, and staleness has deliberately
diminishing returns (400 days and 200 days aren't different decisions). Sorting
purely by days-since would surface exactly the contacts least likely to answer.

One-tap AI-drafted opener per suggestion, with copy-to-clipboard. The prompt
bans "hope this finds you well", "just circling back" and "touching base".

**Email delivery is scaffolded** behind the same gate as the OAuth work. In
mock mode "Email it" says plainly that delivery isn't configured — it does not
pretend to have sent anything.

---

### 10. Public-signal life-event monitoring — not built, deliberately

**Deprioritised pending an actual decision on data sourcing.** Not skipped
silently, and no scraping approach was improvised.

It's a different risk category from everything else on the list: it means
monitoring public activity about *other people* who aren't Cirqle users and
haven't consented to anything. Depending on the source, that runs into real
platform-ToS and legal territory that is well-trodden and actively contested
for sales-intelligence tools.

The decision that unblocks it is *where the data comes from* — a licensed
provider with terms that permit it is a completely different proposition from
scraping — and that's a call for you, not something to pick by default.

---

## Small polish items

| Item | Done |
|---|---|
| Unified **Connections** section in Settings | ✅ New Profile/Connections tabs; card, Gmail, Calendar, reconnect all in one place |
| Keyboard shortcuts | ✅ `/` focus search, `c` compose, `Esc` close |
| Consistent initials avatars | ✅ Replaced `name.charAt(0)` on flat ink with first+last initials on a deterministic tone |
| "What's new" surface | ✅ **Extended the list already in the Help menu** rather than adding a second surface |
| Consistent "last synced" treatment | ✅ One `LastSynced` component, relative time, mono metadata style |

Two notes. The shortcuts never steal a key while you're typing (inputs,
textareas and contenteditable are exempt — otherwise `c` vanishes mid-word in
the notes field) and never swallow a modifier chord. The avatar palette is the
NetworkGraph industry lanes, already muted and earthy, so a wall of avatars
reads as tinted ink rather than a bag of Skittles.

---

## Design compliance

Everything was built against the ported foundation from the start, not styled
afterwards:

- **Tokens only.** `--color-brand` oxblood used narrowly (primary CTA per view,
  active state, focus rings, falling/pinned health, AI sparkles). No new
  colours anywhere — the six card accents are the brand token plus five
  existing NetworkGraph lane colours. `--radius-card` (7px) throughout.
  `border-ink/15` inner, `border-ink/25` outer. `--shadow-float` for floating
  layers only.
- **Motion.** House curve `cubic-bezier(0.22, 1, 0.36, 1)`, 150–250ms, 35ms
  staggered list entrance capped at ~175ms. All new motion uses the existing
  utility classes, so the global `prefers-reduced-motion` override covers it
  automatically.
- **AI surfaces.** `AISurface` was extracted so the four states can't be
  partially implemented — sparkle label, loading, error-with-retry, empty. This
  is the pattern the first polish pass had to retrofit onto the Dashboard
  brief; making it a component means no new panel can ship a silent dead end.
- **Empty states everywhere.** Every new list and panel has one before real
  data exists.
- **Copy.** Direct and a little dry, mono-caps for machine-layer labels.
  *"Nobody's gone cold. Either you're on top of it or the network is young —
  both are fine."* / *"Not recorded. This is the line you'll want in six
  months."* / *"Say what happened. It files itself."*
- **Preview labels.** Every surface running on mock data carries one. It reads
  as machine-layer metadata on the passive sand accent, not a promotional
  "Beta!" chip — it's a statement of fact about the data.

---

## Schema additions — all additive, nothing destroyed or migrated

No existing field changed type or meaning. No seed or real data is rewritten.
Everything below is new and absent-tolerant: every read defaults sensibly when
the field isn't there, so existing documents keep working untouched.

### `users/{uid}` — new fields
| Field | Type | Purpose |
|---|---|---|
| `cardId` | string | The owner's published card id |
| `card` | map | Card config: `mode`, `accent`, `layout`, `name`, `role`, `company`, `intro`, `portedUrl`, `links[]`, `email`, `published` |
| `eventMode` | map | `active`, `eventName`, `startedAt`, `endedAt`, `source` |

### `users/{uid}/contacts/{id}` — new fields
| Field | Type | Purpose |
|---|---|---|
| `whyTheyMatter` | string \| null | Feature 6 |
| `healthPinned` | bool | Stops decay |
| `healthPinnedAt` | timestamp \| null | When pinned |
| `capturedVia` | string \| null | `'nfc-card'` |
| `capturedAt` | timestamp \| null | Tap time |
| `capturedEventName` | string \| null | Event Mode tag |

### New collections
| Path | Access | Contents |
|---|---|---|
| `cards/{cardId}` | **public read**, owner write | Denormalised card snapshot + `ownerUid` |
| `cards/{cardId}/captures/{id}` | **public create only**, owner read/delete | `visitorName`, `visitorEmail`, `visitorCompany`, `note`, `capturedAt`, `processed` |
| `users/{uid}/commitments/{id}` | owner only | `contactId`, `contactName`, `text`, `dueHint`, `owedBy`, `status`, `sourceType`, `sourceId` |
| `users/{uid}/threads/{threadId}` | owner only | `threadId`, `contactId`, `subject`, `status`, `sentAt`, `lastCheckedAt`, `mode` |
| `users/{uid}/integrations/{provider}` | owner only | **Status metadata only** — `connected`, `mode`, `email`, `connectedAt`, `lastSyncedAt`, `expiresAt`, `historyId`. **Never a token.** |

### `users/{uid}/notes/{id}` — new fields on voice-memo notes
`source: 'voice-memo'`, `meetingTitle`, `aiSummary`.

### `firestore.rules` — **must be redeployed**
```bash
npx firebase deploy --only firestore:rules
```
Without this the card page 404s for everyone including you. The public surface
is tight: `cards/{cardId}` is a denormalised opt-in snapshot, never a window
onto `users/{uid}`; captures are create-only with a validated field list and
length caps, and have no public read, so a stranger can leave a card but can
never enumerate who else has. Card ids are 10 chars of a 31-symbol alphabet
(~2⁴⁹), so the collection isn't enumerable by guessing.

---

## MANUAL_SETUP.md — what's in it

Written for someone returning after time away, in eight sections:

1. **Running locally**, including the emulator and what to do when its ports
   are already taken.
2. **Google Calendar** — create the Cloud project, enable the API, configure
   the consent screen as External/Testing, **add yourself as a test user**
   (the step people forget; without it you get an unexplained "access blocked"),
   add the scope, create the OAuth client with the exact redirect URI, and
   which of the client id / client secret goes where.
3. **Gmail** — the extra scopes, and the full reasoning for `gmail.metadata`
   over `gmail.readonly` recorded so it isn't casually undone later.
4. **The 7-day token expiry**, stated plainly as expected behaviour rather than
   a bug, with the reconnect affordance described and the verification path
   that ends it.
5. **The Cloud Function you still need to write** — endpoint table, where the
   contract lives in code, and why the token must never touch the client.
6. **Transactional email** for the digest, including domain verification and an
   explicit warning that anything `VITE_`-prefixed is compiled into the browser
   bundle.
7. **Redeploying Firestore rules**, with what changed and why.
8. **Ordering an actual NFC card** — NTAG215, NFC Tools, and the note that the
   card id survives content edits so a written tag keeps working.

---

## Verification — what was actually checked

**Passing:**
- `npm run lint` (`tsc --noEmit`) — clean, at every commit.
- `npm run build` — clean production build.
- **15/15 Firestore rules tests**, run against a real emulator on isolated
  ports. Covering: stranger can read a published card; stranger and
  other-signed-in-user cannot overwrite it; owner can; stranger can leave one
  capture; captures with empty name / 200-char name / an extra unexpected field
  / pre-set `processed:true` are all rejected; neither a stranger nor another
  user can enumerate captures; owner can; and existing user data
  (`users/{uid}`, contacts) remains private throughout.

**A bug this caught, worth flagging.** `listCommitments` originally used two
equality filters on different fields, which requires a composite index. The
emulator creates those on demand, so it would have passed every local test and
failed *only after deploy* with "The query requires an index". Now one filter
goes to Firestore and the rest is applied in memory. Fixed in `3764bd1`.

**Not verified — be aware:**
- **No visual browser check was possible.** Chrome script injection timed out
  against `localhost` in this environment on every attempt across two tabs and
  two routes. The app compiles and builds, and the data layer is tested, but
  **nobody has looked at these screens rendered.** Please click through
  Settings → Connections and the Dashboard before trusting the layout.
- The rules tests were run but **not committed** — they need
  `@firebase/rules-unit-testing`, and adding a test dependency and harness
  wasn't in scope. Worth adding properly; the throwaway file is reproducible
  from the list above.
- The Cloud Function half of Calendar/Gmail is unwritten by design, so live
  mode is untested end to end.

---

## Follow-ups, in the order I'd do them

1. **Click through the new screens** — see the verification caveat above.
2. **Unify the two scores.** Point `NetworkGraph.buildAnalysis` at
   `lib/health.ts` once the polish branch has landed.
3. **Move capture draining to a Cloud Function.** It's client-side today so the
   whole flow demos with nothing deployed, which means a captured contact
   appears on the owner's *next app load* rather than instantly. An
   `onCreate` trigger on `cards/{cardId}/captures` does the same write
   server-side.
4. **Commit the rules tests properly**, with a real test dependency and an
   `npm test` script.
5. **Write the Cloud Function** (MANUAL_SETUP §5) whenever you want live
   Calendar/Gmail.
6. **Decide the life-event data sourcing question** before anyone builds
   feature 10.
