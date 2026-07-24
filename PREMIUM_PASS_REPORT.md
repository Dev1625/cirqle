# Cirqle — Premium Visual Pass Report

Branch: `polish/premium-pass-2026-07-24` (branched from the round-1
`polish/design-pass-2026-07-23`). Nothing merged or pushed — every change is
in this branch's commits for commit-by-commit review.

Source of truth for this pass: **`CIRQLE_DESIGN_SYSTEM.md`** (v2), read in full
and reconciled against **`DESIGN.md`** (the app's real token/component
snapshot). This report assumes both.

## TL;DR

Executed the v2 design-system delta as specified — a surgical but real visual
redesign, not a reskin. The heavy "neo-brutalist stamp" (full-strength ink
borders + offset hard-shadows + zero radius) is gone, replaced by a calmer,
more premium Swiss-hairline system: `border-ink/15` everywhere, flat in-flow
surfaces with one reserved soft elevation for floating layers only, a 7px
signature radius, and a single new decision-point accent — deep oxblood
`#7A2331` — used narrowly. The pre-signup landing page was rebuilt from a
barebones two-section stub into a full editorial page with staged motion, a
bespoke animated network-graph showcase, and an "out of frame" layout motif.
The in-app network graph got the top left-undone item — a hover tooltip and
eased highlight-connections. App-wide motion (route transitions, scroll
affordance, reduced-motion guard) and route-level code splitting round it out.

Everything else the design system said to keep — the three-tier text
hierarchy, tier colors, industry palette, typography faces, the existing
motion utility system, component behavior, the dot-grid texture — was left
untouched, on purpose.

## Environment (unchanged from round 1 — reused, not rebuilt)

Same constraints still apply: email/password sign-in is disabled on the live
Firebase project, and no Gemini gateway is reachable in this sandbox. The
round-1 workaround was reused as-is: the opt-in Firebase emulator
(`VITE_USE_FIREBASE_EMULATOR=true` in `.env.development.local`, gitignored and
confirmed absent from production builds), the seeded test account
(`polish-test@cirqle.dev` / `CirqlePolish!2026`), and headless-Edge +
Puppeteer screenshots for every screen at 1440 / 1024 / 768. AI surfaces were
verified in their loading/error/empty states only (no live model output
available here).

## What changed, by area

### 1. The skin — borders, shadows, radius, accent (`premium(skin)` commit)
Implements Parts 2 + 3 of the design system, applied fully (the spec is
explicit that this overrides DESIGN.md's own zero-radius/offset-shadow "hard
rules" and warns against half-applying it):
- **Tokens** (`index.css @theme`): `--color-brand #7A2331` + `--color-brand-on`;
  `--radius-card 7px`; one reserved `--shadow-float` soft elevation. These
  compile to short semantic utilities (`bg-brand`, `ring-brand`, `rounded-card`,
  `shadow-float`) rather than arbitrary values scattered across files.
- **Borders**: standardized on the `border-ink/15` hairline everywhere — cards,
  panels, inputs, buttons, the sidebar edge, table rules.
- **Shadows**: the offset-hard-shadow scale is retired. In-flow surfaces are
  now flat (the hairline is the only structural cue). The single `shadow-float`
  is reserved for genuinely floating layers: modals, the confirm dialog,
  toasts, and the NL-search popover/focus state.
- **Radius**: 7px on cards/buttons/inputs/badges; `rounded-full` still reserved
  for circular things (avatars, graph nodes, dots) exactly as before.
- **Accent**: a new Button `brand` variant for true primary CTAs only — *not* a
  blanket recolor; default buttons stay ink-filled per the spec. Brand
  `focus-visible` rings on Button/Input; link-hover uses brand.
- Double-checked the note in Part 2: the new oxblood CTA fills and the existing
  Dormant-tier badge text (`#93401F`) read as clearly distinct in context
  (bold fill vs. small tan-background badge text) — confirmed on the landing
  queue row where both appear.

### 2. The landing page (Priority 1 — `premium(landing)` commit)
Full rebuild of the pre-signup surface (`LandingPage.tsx`, `LandingLayout.tsx`,
new `src/components/landing/*`):
- **Hero**: Playfair-italic headline with a staged word reveal; the single
  authorized **overshoot** (ease-out-back, first paint only — Part 4's scoped
  exception, not a house-wide curve); oxblood on the "Manage it like it." line;
  a flat hairline product panel that **bleeds past the right edge** (out-of-frame
  motif).
- **Sticky nav**: transparent at the top, gains a hairline border + paper fill
  on scroll — a clean flat transition, no blur/heavy shadow.
- **Stats strip**: scroll-triggered **count-up** figures (`CountUp`,
  reduced-motion safe).
- **Feature beats**: scroll-reveal + stagger, alternating layout; the
  follow-up-queue beat runs its card row **off the right edge** (out-of-frame
  again).
- **Network-graph showcase** (`LandingGraph`): a bespoke SVG constellation
  echoing the real graph — links draw in on scroll, nodes float, the "You" node
  pulses in brand. The biggest-motion-budget moment, per the spec.
- **Closing CTA + real footer.**

### 3. Network graph hover (top left-undone item — `premium(graph)` commit)
The #1 recommended-next item from the round-1 report. Canvas-level work on
`react-force-graph-2d`:
- **Hover tooltip**: name + relationship tier (+ "click to open"), positioned
  every frame from the node's live `graph2ScreenCoords` so it tracks
  pan/zoom/float.
- **Eased highlight-connections**: hovering brightens the node, its links, and
  everyone it connects to and dims the rest — driven by a `hoverProgress` value
  lerped in `onRenderFramePre` (0→1), so it fades in/out instead of the previous
  instant alpha snap. Verified by screenshot (hovering "You" keeps the industry
  hubs bright and dims the peripheral contacts).

### 4. App-wide motion + affordances (`premium(motion)` commit)
- **Route transitions**: each view fades + slides in on navigation (keyed on
  pathname; Tracker `?mode=` changes excluded so in-page tab switches don't
  re-trigger).
- **Table scroll affordance** (the other left-undone item): new reusable
  `ScrollFadeX` masks the leading/trailing edge of the wide Tracker
  Sheet/Firm/Industry tables when content runs off-screen — leaning the fix
  into the out-of-frame motif, exactly as the brief suggested.
- **Grouped-view stagger**: Firm/Industry cards get the existing fade-slide-up
  cadence.
- **Reduced-motion guard**: `<MotionConfig reducedMotion="user">` wraps the app
  so every `motion` component respects `prefers-reduced-motion` (belt-and-
  suspenders with the existing CSS media query). Every landing/graph animation
  is independently gated too.

### 5. Performance — code splitting (`premium(perf)` commit)
Adding `motion` pushed the single JS chunk to ~615KB gzip. Route-split the
eight in-app pages with `React.lazy` + a Suspense boundary *inside* AppLayout
(so the sidebar persists during a chunk load). Result:
- Initial bundle **615KB → 337KB gzip** (−278KB).
- NetworkGraph (`react-force-graph-2d`, ~73KB gzip) and Settings (`pdfjs`, ~136KB
  gzip) now load only when visited; a logged-out landing visitor downloads
  neither. The >500KB chunk-size warning is gone.

## MCP components pulled and adapted

- **21st.dev — "Hero Section" by moumensoliman (demo id 10630)**: pulled via
  `get_component` for its framer-motion stagger logic (`containerVariants`
  `staggerChildren`/`delayChildren`, item `y:20→0` reveal). Adapted into
  `src/components/landing/motion.tsx` (`Reveal`/`RevealGroup`) and the hero,
  fully re-skinned to Cirqle tokens and the house easing — none of its visual
  style (gradient text, pill badge, rounded SaaS look) was kept.
- **ui-layouts MCP**: searched (`scroll reveal text`, `text reveal`) — no
  matching components, so scroll reveals use `motion`'s native `whileInView`
  instead. Searched, as instructed; nothing applicable to pull.
- **Figma MCP**: no existing Cirqle brand file to reference; not used.

## Animation library

**`motion`** (Framer Motion's current package), **already a dependency**
(`^12.38.0`) — no new package added. Used consistently for the landing page,
route transitions, count-ups, and reveals. GSAP was not introduced (the brief
said pick one; `motion` was already present and is the React-native choice).

## Skill reconciliation applied

Per the updated rule, **Swiss Design System informed structure directly** —
8px rhythm, generous `py-20/28/32` sections, `max-w-6xl`, mobile-first grids,
`max-w-[Nch]` measure on body copy, visible focus rings, typographic precision
(`…`, curly quotes) on new landing copy. **Taste/Impeccable** governed
restraint: the accent stays on a handful of CTAs, motion stays calm outside the
one hero overshoot, and the cream+serif+"warm red" combination was checked
against the AI-cliché warning — it clears it because the identity is the pinned
incumbent and the accent is deliberately oxblood (signet red), not terracotta,
a choice the design system doc made explicitly to avoid that cliché.

## Verification

- `npm run lint` (`tsc --noEmit`): clean.
- `npm run build`: clean; production bundle confirmed free of any emulator
  references; build artifact not committed.
- Screens captured and reviewed at **1440 / 1024 / 768** for every app route
  and Tracker sub-view; landing at 1440 / 1024 (full-page); landing → "Get
  started" → signup flow; graph hover (tooltip + highlight); table scroll-fade
  at 1024; nav smoke test across all lazy routes (every chunk loads, no
  lazy-related errors).

## Illustrative-data flags

- The landing **stats strip** numbers (12,000+ contacts parsed, 40,000+
  follow-ups, 3.4× more replies) are **plausible placeholders**, not real usage
  metrics — there's no live analytics source. They're framed as product
  outcomes and should be swapped for real figures (or reframed as capability
  claims) before any public launch.
- The landing feature-card content (parsed "Priya Nair", the draft email, the
  queue rows) is illustrative sample UI, consistent with the seeded demo data.

## Left undone / would push further with more time

- **Live AI-surface motion** (streaming "thinking" states, token-by-token draft
  reveals per the Shape-of-AI patterns) — can't be tuned without a reachable
  model to see real latency; verified only structurally here. Worth a focused
  pass once a dev gateway exists.
- **Graph showcase on mobile (<640px)**: the constellation scales down but the
  hub labels get tight; a simplified fewer-node variant under `sm:` would read
  better.
- **Further bundle trimming**: the 337KB-gzip initial chunk is still dominated
  by `firebase`; a manual `firebase`/vendor chunk split would shave more, but
  it's below the warning threshold and was out of scope for a visual pass.
- **Directory contact-summary Markdown** (a round-1 minor item) still renders
  one-line summaries through the Markdown parser — untouched here.

## Recommended next targets

1. Real numbers (or honest capability framing) for the landing stats strip.
2. A mobile-tuned graph showcase variant.
3. Once an AI gateway is reachable, apply the Shape-of-AI streaming/thinking
   motion to NL search, Draft Outreach, and the priorities brief.
