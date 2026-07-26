# Hardening Pass Report

**Branch:** `feature/hardening-2026-07-26`
**Base:** `feature/major-build-2026-07-25` (`fd40289`)
**Date:** 2026-07-26
**Scope:** 7 commits, 20 files, +11,706 / −1,362 (most of that is two lockfiles)
**Not touched:** `apps/mobile`, `main`

Built directly from the "Still not verified" and "Follow-ups" sections of
`FEATURE_BUILD_REPORT.md`. All six priorities are done, including P6, which was
marked optional.

---

## Summary

| # | Priority | Outcome |
|---|---|---|
| 1 | Verify at real mobile width | **Done.** 3 defects found and fixed, 2 invisible at desktop |
| 2 | Commit the rules test suite | **Done.** 15 ad-hoc assertions → 31 committed, `npm test`, verified from a clean clone |
| 3 | Investigate the unproven root cause | **Done.** Feared risk disproved; 2 different real defects found |
| 4 | Move capture draining server-side | **Done.** Cloud Function + 4 trigger tests; race with the client path closed |
| 5 | Unify the two health scores | **Done.** One scorer; the graph gained explanations and pinning |
| 6 | Gmail/Calendar Cloud Function | **Written, not proven.** No OAuth client exists to test against |

**Final state:** `tsc --noEmit` clean, production build clean, **35/35 tests
passing** (31 rules + 4 trigger), no horizontal overflow and zero unnamed
interactive elements at 375 / 390 / 768 / 1394px.

---

## P1 — Mobile, the top-priority gap

The previous pass could not change the viewport: `resize_window` reported
success while the page stayed at 1394px. Replaced with **Playwright** —
explicit `viewport`, `isMobile`, `hasTouch`, `deviceScaleFactor: 2` — at 375,
390 and 768.

### First: why the old tooling kept timing out

Worth recording, because it burned time twice and looks like a bug.
`waitUntil: 'networkidle'` never fires on any page in this app, and the earlier
Chrome-extension `document_idle` waits failed for the same reason. The cause is
benign: **Firestore holds a `Listen/channel` WebChannel stream open for the
life of the page**, so the network is never idle by design. Pages reach
`readyState: complete` and render fine. Any future automation must use
`domcontentloaded`, not `networkidle`.

### Three defects fixed

1. **The card header was cramped on a phone.** Side by side, the 80px avatar
   took a quarter of a 375px screen and forced the name onto two lines —
   "Devarshi / Dalal" is the *first thing* a person sees after tapping a
   physical card. Now stacks below `sm`, name on one line at full width, title
   stepping `3xl → 4xl`, padding `6 → 9`. Tablet was already right and is
   untouched.

2. **The hamburger had no accessible name.** Below 1100px the sidebar starts
   collapsed, so it is the *only* route into navigation — a screen-reader user
   on a phone got an unlabelled button and no way in. The previous audit
   reported "zero unnamed interactive elements" and was correct *at desktop
   width*, where this button does not render. Exactly the class of bug a real
   mobile viewport exists to catch.

3. **The sidebar's collapse control was a `<div onClick>`** — not focusable,
   not keyboard-activatable, invisible to assistive tech. The sidebar could be
   opened and then not closed without a mouse. Now a real `<button>` with a
   label and a focus ring.

### Flagged, deliberately not changed

Several secondary buttons measure **27–29px tall** against the 44px iOS
guideline (Refresh brief, Import CSV, Choose PDF, Try again). Bumping them
means changing the design system's `size="sm"` scale, which is a design
decision, not a defect fix. Your call.

---

## P2 — The rules suite, committed and runnable

The rules were verified once by hand and the file thrown away: the reassurance
of having tested without the protection of a test.

- `@firebase/rules-unit-testing` and `firebase-tools` are now real
  `devDependencies`, not throwaway `--no-save` installs.
- `tests/firestore-rules.test.mjs` is committed and grew **15 → 31**
  assertions. New coverage: `ownerUid` reassignment (card theft), creating a
  card in someone else's name, non-string and over-long payloads, single-doc
  capture reads, post-hoc capture edits and deletes, cross-user reads of
  integration status, and (from P6) that refresh tokens are unreadable even by
  their own owner.
- `npm test` wraps everything in `firebase emulators:exec`, so the emulator
  starts and stops itself. No setup step to forget.
- Separate emulator configs for rules vs triggers, on purpose: the rules suite
  seeds a capture as a fixture, and the new trigger would eat it.

**Verified from a genuinely clean checkout** — `git clone` into an empty
directory, `npm ci`, `npm test` — not just from this working tree. 31/31.

**Known rough edge:** on Windows the emulator's Java process sometimes outlives
`emulators:exec` despite a clean-looking shutdown, so the *next* `npm test`
fails with "port taken" and the message points nowhere useful. Hit this twice.
Documented in `MANUAL_SETUP.md` with the exact `netstat`/`taskkill` commands. I
did not automate a fix — a cross-platform port-killer in an npm script is more
fragile than the problem.

---

## P3 — The unproven root cause: feared risk disproved, two real ones found

Last pass fixed a Connections status read that never settled, and honestly
flagged that the suspected cause (background-tab throttling) was never
confirmed. Reproduced deliberately with Playwright driving real conditions.

**What an unbounded Firestore read actually does** (26 call sites share the
pattern):

| Condition | Result |
|---|---|
| Offline, uncached | **Rejects in 4ms** with `unavailable`. Does not hang |
| Offline, cached | Resolves from cache in 2ms |
| 2G (400ms RTT, 50kbps) | Resolves in 601ms |
| Severe (3000ms RTT, 10kbps) | Resolves in **7,036ms** |
| CPU throttled 20× | Resolves in 114ms — no meaningful effect |

**So the feared latent risk is not real.** Firestore fails fast on a dead
network and serves cache where it can. I have **not** added timeouts to the
other 25 reads — that would be ritual, not engineering. The original hang did
not reproduce under *any* of these conditions, which leaves the
sandbox/background-tab explanation standing but **still not positively
proven**. I would rather say that than claim a root cause I did not observe.

### Two real defects this turned up instead

1. **My own 8s timeout was mis-tuned.** A legitimate read takes ~7.0s on a
   badly throttled connection — barely a second of headroom — so a user in a
   lift would have been shown "Retry" for a read that was about to succeed.
   Raised to 15s, documented as a backstop against a never-settling read
   rather than a latency budget.

2. **The important one.** The real defect was never the missing timeout — it
   was *rendering a confident state while the read was in flight*. Auditing
   for **that** pattern instead found `ContactCommitments` asserting
   **"Nothing outstanding"** whenever `items` was falsy, including while
   loading. A contact with open commitments claimed to have none for the
   duration of the fetch, which at ~7s is not a hypothetical flicker. Now
   three states, with the block staying mounted so the Voice memo button does
   not flicker away. Its two siblings already guarded correctly.

---

## P4 — Capture draining, server-side

`functions/index.js` adds `onCardCapture`, a Firestore `onCreate` trigger on
`cards/{cardId}/captures/{captureId}`. A tap now becomes a contact
immediately, rather than on the owner's next app load — which is the
difference between the reverse-capture demo landing and not.

**The part that needed care: both paths are now live at once.** The client
drain has to stay (the feature must work with nothing deployed, and the
function deliberately leaves captures behind when it fails), so the two can
race on the same capture and the naive version files it twice.

Both now **claim** a capture in a transaction: read it, bail if already gone,
create the contact and delete the capture in one atomic commit. First one
there wins. This is why the client path moved from `addDoc` to a pre-generated
ref with `transaction.set` — `addDoc` cannot take part in a transaction, and
without one the check and the write are separate, which is exactly the gap
that produces a duplicate.

Failure is deliberately safe: unknown card, missing `ownerUid`, or a thrown
transaction all leave the capture in place. A capture is never dropped, only
delayed to the fallback.

`tests/capture-trigger.test.mjs`, 4 assertions, all passing. Separately
verified the **client** path still drains after the transaction rewrite: 3
pending captures → 0, contacts 22 → 25, no duplicates, no page errors.

Deploying needs the **Blaze plan** — Cloud Functions are not on Spark. You do
not have to deploy it; without it everything still works, just on next load.

---

## P5 — One health scorer

The stated blocker is gone now that everything is on one branch.
`NetworkGraph.buildAnalysis` now calls `computeHealth`.

**Two deliberate behaviour changes:**

1. **`contact.updatedAt` no longer counts as a "touch."** The graph used to
   include it, so renaming a contact or fixing a typo in their company reset
   their decay clock — an edit is not a conversation. Recently *edited*
   contacts will now score lower on the graph. That is the correct number, not
   a regression.
2. **Pinned contacts stop decaying on the graph.** Pinning previously applied
   only on Contact Detail, so a pinned mentor still drifted cold in the one
   view whose entire job is showing you who is drifting cold.

The graph's detail panel also showed a bare **"72/100"** — precisely the
complaint that started the health work. It now carries the same one-line
explanation the contact record does, plus a pin icon when held.

**Verified in a browser, not just compiled.** Graph renders (31 nodes, 34
links); derived stats still compute (22 visible, 21 touched in 30 days, 1 at
risk, 48% response rate); a clicked node reads *"34/100 — Steady, last contact
today"*; after pinning, *"Held. Pinned, so it won't decay."* The 34 matches
Contact Detail for the same person, which is the entire point.

---

## P6 — Gmail/Calendar server half: written, **not proven**

All four endpoints implemented with plain `fetch` rather than pulling in
`googleapis` for four calls.

**Nothing here has run against Google.** There is no OAuth client, so it is a
reviewed draft matching the shapes the client already expects. Expect the
first live consent round-trip to need debugging. It changes nothing that ships
today — mock mode is untouched and still the default.

The invariant it upholds: refresh tokens land in `oauthTokens/{uid}`, and
`firestore.rules` now denies every client read and write there outright. An
unmatched path is denied by default anyway, so this is belt-and-braces — but
it puts the rule where someone editing the file will see it. Three assertions
lock it in, including that the token's own owner cannot read it.

Details worth not losing:
- `refresh_token` is merged **only when Google returns one** — it comes back
  on first consent only, so a naive write clobbers a good token with
  `undefined` on every reconnect.
- `invalid_grant` is treated as the routine 7-day testing-mode expiry, not an
  error: flags `needsReauth`, returns **428**, which the client turns into
  Reconnect.
- `gmail/poll` uses `format=metadata` — all the `gmail.metadata` scope
  permits. The app *cannot* read mail it did not send, the scope choice
  enforcing itself rather than being a promise in a policy page.

---

## What remains genuinely unverified

Stated precisely, not rounded up.

- **Live OAuth end-to-end.** P6 is written and unrun. Needs a real Google
  client ID; no amount of local testing substitutes.
- **The original Connections hang's root cause.** Disproved the network
  hypothesis; the background-tab explanation is consistent with everything
  observed but was never reproduced. The fix stands on its own merits.
- **Real speech input.** Web Speech is present in the test Chrome, but I
  cannot speak into it. The manual fallback is tested.
- **Deployed behaviour of the Cloud Function.** Verified against the emulator
  only. Emulator and production Firestore triggers differ in retry semantics
  and cold-start timing.
- **Visual regression over time.** The mobile check was run by hand with a
  throwaway Playwright script and was not committed: Playwright is a ~115MB
  browser download, and a layout snapshot test would need updating on every
  design change. The recipe is in this report if you want it back. Unlike the
  rules suite — a security surface where a silent regression is dangerous —
  this is a cosmetic surface where a stale test is worse than none.
- **Tap-target sizes**, flagged in P1 and left as your call.

---

## Worth flagging for next time

**The duplicate-contact problem is already real, not theoretical.** While
testing I noticed the demo account holds **six contacts named "Priya Raman"** —
created by my own screenshot runs each clicking "Save contact" on the same
card. Nothing prevented it, and nothing surfaced it. That is the exact risk
named as candidate scope: four ingest paths (CSV, manual/NL, NFC capture,
soon Gmail-linked) and no dedupe. The NFC path makes it worse than the others
because a stranger tapping twice is *normal behaviour*, not user error.

If you want new scope next, that is the one I would pick — it is now evidenced
rather than anticipated. Data export and account deletion remain well-scoped
and unambiguous, but nothing observed tonight made them more urgent.

**One small thing:** `npm test` leaves a stale emulator on Windows often
enough that it bit me twice in one session. Documented, not automated. If it
annoys you, the fix is a `pretest` script — I judged that more fragile than
the two-line manual workaround.
