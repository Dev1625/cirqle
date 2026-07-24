# Cirqle — Depth, Story & Presence Pass Report

Branch: `polish/depth-pass-2026-07-24`, branched from
`polish/premium-pass-2026-07-24`. Six commits, nothing merged, nothing
pushed, `main` untouched. `apps/mobile` untouched (it isn't even present in
this worktree).

Environment reused, not rebuilt: the Firebase emulator from the previous two
passes was still running on auth `9099` / firestore `8085` with the seeded
`polish-test@cirqle.dev` account intact, and the cached `firebase-tools` /
`puppeteer` installs from those passes were reused for screenshots.

---

## 1. What Directory and Tracker actually showed

Only the Dashboard had been reviewed directly, so the first thing I did was
take fresh screenshots of Directory and Tracker (sheet + firm modes) and check
them against the three confirmed Dashboard findings. **The three findings do
not transfer uniformly** — one is Dashboard-only, one is global, one is
present everywhere but at very different severities.

### Finding #1 — zero tier signal: **Dashboard-only. Directory and Tracker are clean.**

Both screens already carry the signal, via the shared `TierBadge`:

- **Directory** renders a tier chip on every contact row (`STRONG` / `COLD` /
  `WARM` / `DORMANT` were all visible in one screenful), alongside an industry
  label.
- **Tracker** renders a tier chip immediately after every name in every mode,
  *and* is the most colour-dense screen in the app — the `StatusBadge`
  pipeline colours (Responded / Meeting Scheduled / Sent / Drafted /
  Re-engage) plus the amber action-needed row highlighting are all working.

So the "Cirqle demonstrates no relationship signal" problem was specifically a
Dashboard problem, not a systemic one. That actually makes it worse, not
better: the two screens that already had it are the ones users reach *second*.
Fixed on the Dashboard only; nothing was added to Directory or Tracker.

### Finding #2 — card-to-page contrast: **present on all three, severity varies a lot.**

- **Dashboard** — worst, as reported. Confirmed.
- **Tracker firm/industry mode** — nearly as bad, and for a sharper reason:
  it nests firm cards *inside* the main view container, and with the outer
  boundary and the inner card boundaries both at `border-ink/15` the outer
  container simply disappeared. The nesting read as a flat list of floating
  cards rather than a container holding a stack.
- **Tracker sheet mode** — mild. The table is dense enough that its own rules
  supply the structure; the weak surface is the toolbar/tab card above it.
- **Directory** — mildest. Its list is one large white block that fills most
  of the frame, so it reads as a surface by sheer area even with a weak
  boundary. Still fixed for consistency.

### Finding #3 — washed-out accent: **global, single root cause, and it was not the shade.**

The token was correct. `--color-brand` is `#7A2331` exactly as specified, and
the Search button was using it. The problem was `disabled:opacity-50` on
`Button`'s base class combined with `disabled={isSearching || !queryStr}` in
`GlobalNLSearch` — the button is disabled whenever the field is empty, which
is its *resting* state. So the app's single most visible accent surface was
permanently rendering oxblood at 50% over white, which composites to exactly
the pale dusty rose that was observed. Because the search bar is one shared
component pinned to the bottom of every in-app view, this was identical on
all three screens.

### One finding not in the brief

Checking "typographic confidence" on Tracker turned up a real regression of
the kind the brief anticipated: the **firm/industry card stats**
(Contacts / Response % / Meeting %) were set in small bold *sans*
(`text-sm font-bold`) rather than the black serif the Dashboard stat strip
uses. They read as captions rather than figures. Fixed.

Everything else held: all eight page titles are `text-5xl` italic black serif
with the trailing period, and the Dashboard stat strip's serif numerals were
left exactly as they were.

---

## 2. What changed, by area

### Priority 1 — interior presence

**`depth(signal)`** — findings #1 and #3.
- Search button now disables only while a search is genuinely in flight
  (`handleSearch` already no-ops on an empty query, so nothing was lost).
- `disabled:opacity-50` moved off `Button`'s base class onto the individual
  variants, so the `brand` fill is never halved; a disabled brand button
  signals "busy" by softening its label instead. The other variants keep the
  opacity treatment they had.
- Follow-Up Queue rows get a `TierBadge` chip beside the name plus a 3px
  tier-coloured left edge for scanning down the list. The rolodex cards below
  get a tier dot rather than a chip, because those cards invert to ink on
  hover and a pale chip background fights that.
- New `TIER_MARKER_COLOR` / `TierDot` / `tierMarkerColor` exports live beside
  `TIER_STYLES` in `TierBadge.tsx`, so a dot and a chip can't drift apart on
  what "Warm" looks like.

**`depth(surface)`** — finding #2, plus the sidebar.
- Two new tokens in `index.css`:
  - `--shadow-card`, one soft light lift, markedly lighter than the existing
    `--shadow-float` (which stays reserved for floating layers). It goes on
    exactly three surfaces app-wide: the Dashboard's Follow-Up Queue block,
    the Directory list, and the Tracker's main view area.
  - `--color-rail` (`#EEE8DD`), a touch deeper and warmer than paper.
- Two-tier hairline: those same three outer boundaries step up to
  `border-ink/25`; every divider *inside* them stays at `/15` or lighter.
  Nothing else changed weight.
- Sidebar moves from `bg-paper` (identical to the canvas) to `bg-rail`, and
  the pinned search strip matches it — together they read as one frame of
  chrome around the paper canvas, which is what lets the white cards come
  forward. Contrast checked: `text-muted` holds 5.8:1 on the new tone,
  `--color-brand` holds 8.1:1. The logo mark was not touched.
- Active nav item and Tracker sub-item now carry `--color-brand` instead of
  plain ink.
- Tracker firm/industry stats moved to the serif treatment.

**`depth(accent)`** — accent as a thread rather than a one-off.
- New `AccentRule`: a short oxblood rule above every page title (all eight
  pages), decorative and `aria-hidden`.
- Icon tinting on the Follow-Up Queue's `ListTodo` and the Tracker title's
  `Sparkles`. The AI Priorities sparkle deliberately stays paper — it sits on
  the inverted ink card, where oxblood goes muddy.
- Nothing that carries meaning (tier, status, industry lane) was recoloured.

### Priority 2 — landing scroll-snap (`depth(landing)`)

CSS `scroll-snap-type: y proximity` on the root scroller. No JS wheel
hijacking, so trackpad inertia, keyboard paging, scrollbar dragging and
find-in-page all keep working. Scoped to the route by a `landing-snap` class
that `LandingPage` puts on `<html>` for its lifetime.

Top-level sections take `.snap-section` (`scroll-snap-align: start`,
`min-height: 100svh`, flex column, `justify-content: center`). The stats strip
and footer deliberately stay natural height and non-snapping — forcing a thin
band to a full viewport looks sparse, and `proximity` handles the gap without
a fight. Proximity was kept; it didn't feel loose enough to warrant
`mandatory`.

`scroll-mt-24` was removed from `#network`: `scroll-margin` shifts an
element's *snap area* too, which would have given that one section a snap
position 6rem out of step with every other.

Verified:
- All 10 sections: `scroll-snap-align: start`, exactly 900px in a 900px
  viewport, `display: flex`, `justify-content: center`, none overflowing.
- Anchor link — clicking "See the network" leaves `#network` at
  `getBoundingClientRect().top === 0`.
- `whileInView` reveals still fire under discrete snapping. They do, as
  expected: the `-12%` viewport inset sits well inside a centred full-height
  section, and `#network`'s children measure `opacity: 1` / `transform: none`
  after snapping.
- Narrow/short guard — snap is off below 768px wide or 640px tall. At
  390×780 the hero genuinely measures 999px, i.e. exactly the case where
  snapping to a section start would strand content; `scroll-snap-type`
  computes to `none` there.

### Priority 3 — the two graphs, treated oppositely (`depth(graph)`)

**LandingGraph** (decorative) gains ambient life: a brand-coloured signal dot
travels out from "You" along one hub connection at a time on a staggered
infinite loop, rendered between links and nodes so it passes *under* the node
it arrives at.

**NetworkGraph** (the real tool) gets no ambient motion at all, and instead
gets the entrance assembly that was left undone: "You" lands first, then the
industry hubs, then each cluster's contacts, with links extending from source
to target once both endpoints have arrived. Labels are held until their node
has essentially landed so they don't pop in over a half-formed circle.

Link painting moved from `linkColor`/`linkWidth`/`linkLineDash` to a single
`linkCanvasObject`, because a genuine progressive draw needs the stroke to
*extend*, not just fade. All three props' rules — including the eased hover
highlight from the previous pass — were carried into the painter unchanged,
and once assembly finishes it draws the full line exactly as before.
Re-assembly keys on `graphData` identity, so filtering by lane or search does
not re-trigger it.

Verified by sampling canvas ink coverage after mount: **8% → 98% over ~850ms,
then flat** — it builds, then holds still. A mid-assembly capture shows "You"
and the first two hubs landed with their links drawn while later clusters are
still ghosting in.

### Priority 4 — roadmap sections (`depth(landing)`)

Framed as a plan throughout, not as shipped features. A "What we're building
next" divider opens the run and states plainly that everything above it works
today. Each beat carries a visible **Planned** chip, copy stays in the future
tense, and the mock visuals use *dashed* hairlines against the shipped
sections' solid ones — reusing the app's own dashed-border "nothing here yet"
empty-state language.

- **NFC card**: `useScroll` on the section + `useTransform` mapping progress
  to `rotateY` 0 → 180 → 360, across real front and back faces
  (`backface-visibility` + `preserve-3d`) under `transformPerspective: 1600`.
  As a physical product render it deliberately carries more dimensionality
  than the flat UI language — gradient body, raking highlight, real drop
  shadow — and that treatment is contained to the card itself. Measured
  across the section: 0° / 90° / 180° / 270° / 360°.
- **Gmail + Calendar**: lower-drama beats on the established `FeatureBeat`
  pattern — reveal + stagger, alternating layout, copy plus a mockup.

---

## 3. Guardrails

**Reduced motion** — verified with `prefers-reduced-motion: reduce` emulated:
`scroll-snap-type` → `none`, section `scroll-snap-align` → `none`, landing
graph renders **0** pulse circles, the NFC card gets no 3D transform at all
(static front face), and content is still fully revealed (`opacity: 1` — the
guard hides nothing). The in-app graph skips the build and renders
fully-formed immediately: ink coverage starts at 77% of peak and hits 100%
within 35ms.

**No second reskin** — every change is additive on the v2 system. Tokens were
added, not redefined: `--color-brand`, `--color-accent`, the tier colours, the
industry palette, `--radius-card`, `--shadow-float` and all typography are
untouched. `border-ink/15` remains the default hairline; only three outer
boundaries app-wide were promoted to `/25`, and only three surfaces took a
shadow.

**Bundle** — honest numbers, measured by building the baseline commit
(`08403d2`) and this branch back to back:

| | initial chunk (raw) | initial chunk (gzip) |
|---|---|---|
| baseline `08403d2` | 1,285.64 kB | 336.81 kB |
| this branch | 1,305.70 kB | 342.57 kB |
| delta | **+20.06 kB** | **+5.76 kB (+1.7%)** |

That's `motion`'s scroll module plus the four new landing sections. Route
splitting still holds — NetworkGraph (73 kB gzip) and Settings (136 kB gzip)
still load only when visited.

One correction to the previous report: it stated the ">500KB chunk-size
warning is gone." It isn't, and it wasn't then either — Vite's
`chunkSizeWarningLimit` measures the **uncompressed** chunk, so the 1.28 MB
raw initial chunk was already tripping it at the baseline. The warning is
pre-existing, not introduced here.

`npm run lint` (`tsc --noEmit`) clean at every commit; `npm run build` clean.

---

## 4. Verification

- Screens captured and reviewed at **1440 / 1024 / 768** for Dashboard,
  Directory, Tracker (sheet / firm / queue), Calendar, Templates, Settings.
- Network graph captured mid-assembly and settled; assembly measured
  numerically rather than eyeballed.
- Landing captured section-by-section at 1440×900 and probed at 390×780.
- No new console errors. The only errors in any run are the pre-existing
  `Failed to generate key from serverless API` / `Failed to fetch` from the
  unreachable AI gateway in this sandbox.

Unchanged environment constraints, same as the last two passes: email/password
sign-in is disabled on the live Firebase project (hence the emulator), and no
Gemini gateway is reachable here, so AI surfaces were verified in their
loading/error/empty states only.

---

## 5. Left undone

- **The tier left-edge only reads for two of four tiers.** Dormant
  (terracotta) and Warm (amber) are clearly visible when scanning; Strong
  (ink) and Cold (grey) sit close to the `border-ink/15` hairline and barely
  register as colour. That's arguably correct — Cold *should* be quiet, and
  the chip carries the label regardless — but if the edge is meant to be the
  primary scan affordance it needs either more width or a dedicated
  higher-chroma marker ramp, which would mean adding tokens rather than
  reusing `TierBadge`'s.
- **Snapped sections look airy at tall viewports.** At 900px the shorter
  feature beats leave a lot of empty field above and below the centred
  content. It reads as deliberate editorial spacing rather than broken, and
  most real viewports are shorter, but the feature-beat visuals could be
  scaled up to fill the taller rhythm.
- **The landing stats strip numbers are still placeholders** (12,000+ /
  40,000+ / 3.4×), flagged in the previous report and untouched here. They're
  the one remaining piece of the landing page that asserts something
  unverified, and they now sit directly above a roadmap section that's
  scrupulously honest about what isn't built — which makes the contrast more
  noticeable, not less. Worth resolving before any public launch.
- **Graph showcase on mobile** (<640px) — still the tight-hub-labels issue
  from the last report; the new pulse doesn't change it.
- **Directory contact-summary Markdown** — round-1 minor item, still
  untouched.

## 6. Flags for the next round

1. **The stats strip is now the weakest link on the landing page.** Fix the
   numbers or reframe them as capability claims.
2. **`--shadow-card` needs a written rule before it spreads.** It's currently
   applied by judgement to "the primary surface per screen," which held for
   three screens but won't survive someone adding a fourth without guidance.
   One sentence in `DESIGN.md` — *one card per screen may lift; everything
   else is flat* — would keep it from becoming a general-purpose shadow.
3. **`DESIGN.md` is now two passes stale.** It still documents offset hard
   shadows and zero radius as hard rules, both of which the premium pass
   deliberately overrode, and it knows nothing about `--color-brand`,
   `--color-rail`, `--shadow-card`, or the two-tier hairline. It's the
   nominal source of truth and currently describes an app that no longer
   exists.
4. **The `.snap-section` breakpoint guard is a magic pair of numbers**
   (768/640) chosen from the hero's measured overflow. If the landing copy
   grows, that threshold needs rechecking — there's no test holding it.
