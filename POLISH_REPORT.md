# Cirqle — Design Polish Pass Report

Branch: `polish/design-pass-2026-07-23`. Nothing here is merged or pushed — every change lives in this branch's commits for review.

## TL;DR

Walked the whole app screen-by-screen as a seeded test user, wrote up findings in `POLISH_AUDIT.md`, then fixed the highest-impact ones: a real WCAG contrast failure that dimmed most secondary text app-wide, an uncolored relationship-tier system on the product's core "skim your network" screens, a floating search bar that visually clipped content on Dashboard/Directory/Tracker, an AI-brief card with no error/timeout state (a genuine dead end), five `alert()`/`window.confirm()` calls replaced with a real toast + confirm-dialog system, several responsive breakpoint issues at 1024/768px, and a handful of smaller bugs (negative "days ago", clipped tab labels, an unstyled native file input). The app's existing "neo-brutalist editorial" identity — cream paper, hard ink borders, offset drop-shadows, Playfair Display italic serif, Inconsolata mono — was preserved and reinforced, not replaced.

## Environment note (read this first)

Two backend constraints shaped how this pass was tested:

1. **Email/password sign-in is disabled on the live Firebase project** (`cirqle-9dd06`) — only Google sign-in works there. I couldn't create the `polish-test@cirqle.dev` account against the real backend without either a Google OAuth login (not available here) or changing Firebase Auth project settings (explicitly out of scope for this pass — "auth changes" are excluded).
2. **No reachable Gemini/LiteLLM gateway during that historical pass.** The
   legacy browser gateway path described in the original report has since been
   removed. The current app has no localhost gateway default: every model call
   uses the same-origin, Firebase-authenticated `/api/ai/chat` server route.

**What I did about it:** added an opt-in local Firebase Auth + Firestore emulator path, gated entirely behind `VITE_USE_FIREBASE_EMULATOR=true` in `.env.development.local` (gitignored, dev-server-only — confirmed the production `vite build` output contains zero emulator references). This let me actually create the test account, seed real data, click through every flow, and take real screenshots via headless Edge + Puppeteer instead of guessing from source. It touches no product code path a real user would hit — `src/config/firebase.ts` only calls `connectAuthEmulator`/`connectFirestoreEmulator` when that env var is explicitly `"true"`, which it never is by default or in any deployed build.

The AI gateway being unreachable meant I could not see live Gemini output for NL search, outreach drafts, or the priorities brief. I could, and did, verify every AI surface's **loading, error, and empty states** — which turned out to be exactly where the real problems were (see Dashboard section below). The AI call *code paths* themselves (prompts, response parsing) were not touched.

## What changed, by screen

### Global / shared
- **Design tokens** (`src/index.css`): added `--color-muted` (a solid `#5C5850` tone that passes WCAG AA at 6.2:1+ on both paper and white) to replace `opacity-40`/`opacity-50` on small text, which measured **2.47:1–3.24:1** — failing AA outright. This pattern was used for the sidebar's inactive nav labels and nearly every page subtitle, so it was the single highest-leverage fix in the pass. Also added `--color-tier-*` tokens for the new tier-badge system, and `fade-in`/`fade-scale-in`/`fade-slide-up`/`toast-in` keyframes plus a `prefers-reduced-motion` block (two places in the code referenced an `animate-fade-in` class that was never defined anywhere, so those "fades" had been doing nothing).
- **`TierBadge` component**: one shared, color-coded Strong/Warm/Cold/Dormant chip, replacing three separate uncolored implementations (Directory, Tracker, ContactDetail). This was probably the single biggest visible improvement — a personal CRM whose whole pitch is "skim your relationships" had no visual way to distinguish relationship strength at a glance.
- **Toast + Confirm systems** (`ToastContext`, `ConfirmContext`): replace every `alert()`/`window.confirm()` in the app (Directory's Clear Directory and AI-parse failure, Tracker's Clear Tracker, ContactDetail's reply/tag/draft failures, Templates' delete and save, Settings' save/PDF errors) with dialogs matching the app's own visual language (offset hard shadow, sharp corners, serif italic titles) instead of native browser chrome. Confirm dialogs support Escape-to-cancel and Enter-to-confirm.
- **Floating search bar overlap** (`AppLayout.tsx`): the "Ask AI" bar was `position: absolute` over content with a `pb-48` padding hack that didn't actually prevent overlap — verified via screenshot that the 4th Follow-Up Queue card, the last Directory row, and the last Tracker table row all rendered partially hidden underneath it on a standard 900px-tall viewport. Fixed by making it a normal flex sibling with its own reserved height instead of a floating overlay; content can no longer render behind it, confirmed by re-screenshotting after a scroll.
- **Sidebar nav contrast + collapse**: inactive nav links moved off opacity-dimming onto the muted token; sidebar now starts collapsed below ~1100px width instead of permanently eating 256px on tablet-width viewports.

### Dashboard
- **AI Priorities brief had no timeout or error state** — the biggest AI-UX gap found. If the Gemini call failed or hung, the card stayed on "Reading tracker data and generating your brief..." forever with the refresh button disabled (a genuine dead end), and a later render fell through to a misleading "Not enough data to calculate priorities yet." even with 15 contacts present. Now: a 20-second timeout, a distinct error state with an explanation and a working "Try Again" button, and reassurance that the underlying tracker data is untouched by the AI failure.
- The auto-fetch effect re-ran on every Firestore snapshot change rather than once per session — during seeding (15 sequential writes) this fired ~15 wasted AI calls. Now guarded by a ref so it fires once.
- Queue cards and rolodex cards get a subtle staggered fade/slide-in on mount.

### Directory / Tracker / Contact Detail
- Tier badges everywhere now color-coded (see above).
- Tracker's tab bar (Follow-Up Queue / Sheet / Recruiting / Firm / Industry / Timeline) was silently clipping "Industry" to "INDUS" at 1024px with no ellipsis or scroll cue (`overflow-x-auto` + a scrollbar-hiding utility). Now wraps to a second line instead.
- Fixed `formatRelativeDays` showing **negative** "days ago" for future dates (an upcoming meeting 4 days out rendered "-3 days ago").
- ContactDetail's Draft Outreach modal gets a real fade/scale transition, Escape-to-close, and backdrop-click-to-close (previously only the × button worked); tab switching (Quick Note/Log Meeting/Process Reply/Add AI Tags) now fades instead of snapping.
- Status-pill corner radius made consistent (one pill in the timeline was the only `rounded-full` badge in an otherwise all-sharp-corner design system).

### Network Graph
- Left mostly untouched — it's already the strongest screen in the app (token-matched industry colors, radial layout, live cluster/gap analysis, a real detail panel). Fixed the center "You" node showing a bare "Y" when no profile name is set (now a bullseye glyph), the subtitle contrast, and the metric-card grid's responsive breakpoint.
- Not done, and worth calling out: a hover tooltip before committing to a click, and animating the hover-highlight fade (currently an instant alpha snap on the canvas) — both are canvas-level changes bigger than this pass's remaining budget. Left for a follow-up.

### Templates
- Empty state was a bare dashed box with text only — now icon + one line + inline "New Template" CTA, matching the standard used everywhere else.
- Delete confirmation and save/delete feedback moved off `window.confirm`/silence onto the shared dialog + toast system.

### Settings
- The native `<input type=file>` was the one piece of unstyled OS chrome in an otherwise fully custom-styled form — replaced with a button matching the rest of the app, showing the selected filename.
- `alert('Settings saved!')` and PDF-parse alerts replaced with toasts.

### Auth
- "Continue with Google" is now the primary (filled) button and email/password the secondary (outline) one — on the **live** Firebase project, email/password is disabled, so the previously-primary path was the broken one. This is a visual-hierarchy change only, no auth logic touched. Failure now shows a plain-language explanation instead of a raw Firebase error string when that specific case is hit.

### Responsive (1440 / 1024 / 768)
- Metric-card grids (Dashboard queue stats, Network Graph stats) moved their 2→4 column breakpoint from `md` (768px) to `lg` (1024px) — at exactly 768–1023px they were cramming 4 columns into ~170px cards with wrapping text.
- Sidebar auto-collapses below ~1100px.

## Seed data / test account

- **Email**: `polish-test@cirqle.dev`
- **Password**: `CirqlePolish!2026`
- Seeded via the existing "Seed Test Data" button on the Dashboard, which now creates **15 contacts** across 7 industries (VC, Consulting, IB, Tech, PE, Healthcare, Hedge Fund) with realistic names/companies/roles, shared schools and `connectionSource` references (so the Network Graph shows both inferred and explicit edges out of the box), 6 notes, and mixed outreach states including one `Drafted`-but-unsent outreach and one genuinely stale (90–150 day) `Dormant` contact so "At Risk"/Network Strength don't read as a suspicious flat 0/100.
- This only works locally with `VITE_USE_FIREBASE_EMULATOR=true` set (see `.env.development.local`, gitignored) and the Firebase emulator suite running (`npx firebase-tools emulators:start --only auth,firestore` — config already added to `firebase.json`). Against the real backend, seeding still works the same way once you're signed in with Google.

## Re-triggering the onboarding tour

Tours are per-user, tracked via `completedTours` on the Firestore user doc. To re-trigger any tour: **Help & Tours** in the sidebar → pick a tour → **Run Tour**. Verified all 6 tours (Getting Started, Adding a Contact, Drafting an Outreach, The Tracker, Network Graph, Natural Language Search) still launch correctly after the `AppLayout` changes.

## Verified

- `npx tsc --noEmit` — clean.
- `npm run build` — clean production build; confirmed (via `grep` on the output bundle) it contains zero references to the emulator or `127.0.0.1:9099`.
- Full screenshot walkthrough at 1440×900, 1024×768, and 768×1000 for every route, every Tracker sub-view, and the Add Contact / Draft Outreach / Help & Tours / Filter / Template-delete-confirm modals, both before and after each batch of fixes.
- Functional QA: template save→toast, delete→confirm-dialog→Escape-cancel→delete→toast, and onboarding tour launch, all screenshotted end-to-end with console-error capture (only the expected `/api/register-user` 404 — there's no local serverless function in dev, and the app already degrades gracefully when that call fails).

## Left undone (and why)

- **Table horizontal-scroll affordance** (Tracker Sheet/Firm/Industry at 1024px cut off Response/Meeting/Next Action/AI Summary columns with no gradient/shadow hint that the table scrolls). Real issue, lower priority than what's fixed — a CSS mask-image fade is the right fix but needs care to not fight the table's sticky header.
- **Network Graph hover tooltip + animated highlight fade**. The graph is canvas-rendered (`react-force-graph-2d`), so both of these need JS-level interpolation/state rather than CSS — bigger scope than the remaining budget for this pass.
- **Recruiting pipeline column count indicator / scroll snap** — minor, functions fine as-is.
- **Directory contact summaries render through the Markdown parser** for what's usually a one-line AI sentence — low risk, but worth simplifying to plain text so a stray Markdown character in an AI summary can't produce odd spacing.

## Recommended next polish targets

1. Table scroll affordance on Tracker's wide table views.
2. Network Graph hover tooltip + animated fade (the two canvas-level items above) — this is the demo's wow-screen, so it's worth the extra time in a follow-up pass.
3. Once a real AI gateway is reachable in a dev environment, re-verify the NL search and outreach-draft loading/streaming states against actual model latency (they were only verified structurally here, not against real response timing).
4. Consider code-splitting (`vite build` warns the main JS chunk is ~2MB minified/568KB gzipped, dominated by `pdfjs-dist` and `firebase`) — unrelated to visual polish but worth flagging since it showed up during the build check.
