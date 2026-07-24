# Cirqle — Design System & Philosophy

A snapshot of how Cirqle looks and feels in its current state (after the
`polish/design-pass-2026-07-23` pass). This documents the existing identity —
it's a reference for staying consistent, not a proposal to change anything.

Source of truth for tokens: `src/index.css` (`@theme` block). Everything else
here describes patterns that recur across the app.

---

## 1. Philosophy — "Editorial neo-brutalism on paper"

Cirqle doesn't look like a typical SaaS dashboard. It reads like a **printed
publication crossed with an engineering terminal**: warm off-white "paper,"
hard black hairline borders, chunky offset drop-shadows, a fashion-magazine
serif for headlines, and a monospace typewriter face for every label and stat.

The guiding instincts:

- **Ink on paper, not pixels on a screen.** The whole surface is a cream
  paper tone with a faint printed dot-grid texture. Borders are a single solid
  near-black, never soft gray dividers.
- **Structure is visible.** Nothing floats ambiguously. Cards have real
  borders and hard offset shadows that read like physical cards laid on a
  desk. Sharp 90° corners almost everywhere — roundness is reserved for things
  that are genuinely circular (avatars, graph nodes, status dots).
- **Two voices, deliberately contrasted.** Big expressive **italic serif** for
  identity/headlines; small, precise, **UPPERCASE MONO** for the machine layer
  (labels, metadata, buttons, stats). The tension between the two *is* the
  brand.
- **Restraint over decoration.** Essentially one neutral ink ramp + one warm
  accent. Color is used as *signal* (relationship strength, industry lane,
  status), not as ornament. When something is colorful, it means something.
- **Calm, physical motion.** Transitions are short, eased, and understated —
  fades and small slides, never bounce or spring. Motion confirms an action;
  it never performs.

If a change makes Cirqle look more like a generic Material/Tailwind starter,
it's wrong. If it makes it feel more like a well-set magazine spread or a
refined developer tool, it's right.

---

## 2. Color

### Core neutrals & accent (`@theme` tokens)

| Token | Hex | Role |
|---|---|---|
| `--color-paper` | `#F5F0E8` | The universal background ("paper"). Also used as light text on ink surfaces. |
| `--color-ink` | `#1A1A1A` | Primary text, all borders, filled buttons, the "you" node. Near-black, never pure `#000`. |
| `--color-subtle` | `#414141` | Secondary text on light backgrounds (still high-contrast). |
| `--color-muted` | `#5C5850` | De-emphasized-but-readable text (nav inactive state, page subtitles, placeholders). Deliberately a **solid** tone, not opacity — see Accessibility. |
| `--color-accent` | `#E4DFC9` | The one warm accent — tag chips, subtle highlights, focused-lane background. Sand/wheat tone. |
| `--color-border` | `#1A1A1A` | Alias of ink; borders are always full-strength ink (often at reduced opacity like `border-ink/20` for inner dividers). |

Surfaces stack as: **paper** (app background) → **white `#FFFFFF`** (cards,
panels, inputs) → occasional **`#F8F5EF` / `paper/50`** (card headers, muted
zones). Inverted "spotlight" surfaces (the AI Priorities card) flip to
**ink background with paper text**.

### Relationship-tier signal colors

The core "skim your network" signal. One mapping, applied everywhere via the
`TierBadge` component (`src/components/ui/TierBadge.tsx`) — never re-invented
per screen.

| Tier | Background | Text | Reads as |
|---|---|---|---|
| **Strong** | `#1A1A1A` (ink) | `#F5F0E8` (paper) | Solid/filled — your strongest ties |
| **Warm** | `#F3E4C6` | `#7A5A17` | Warm amber |
| **Cold** | `#EDEBE7` | `#5C5850` | Neutral gray-tan |
| **Dormant** | `#F6E6E1` | `#93401F` | Faded terracotta — going cold |

All four pass WCAG AA (5:1+).

### Network-graph industry palette

The graph's industry "lanes" use a muted, earthy, desaturated palette that
sits harmoniously on paper (defined in `src/pages/NetworkGraph.tsx`,
`INDUSTRY_COLORS`). These are intentionally *low-saturation* so the graph
looks like tinted ink, not a rainbow:

| Lane | Hex | | Lane | Hex |
|---|---|---|---|---|
| Investment Banking | `#56606A` | | Healthcare | `#617672` |
| Consulting | `#746B60` | | Tech | `#6A6473` |
| Private Equity | `#66715F` | | Other | `#8B877D` |
| Venture Capital | `#9A7447` | | Hedge Fund | `#7D5B52` |

### Semantic / status colors

Used sparingly, mostly on the Tracker's `StatusBadge` and inline flags. These
lean on Tailwind's default palettes at low intensity (`bg-*-50/100`,
`text-*-700/800`, `border-*-200/300`):

- **Blue** — Sent / Awaiting Response
- **Emerald / Green** — Responded / Referred / positive close, success toasts
- **Purple** — Meeting Scheduled / Complete
- **Orange / Amber** — Pending Follow-Up, Re-engage, action-needed rows, warnings
- **Red** — destructive actions (delete, clear), error toasts (`#DC2626` / `red-600`)

Rule of thumb: color = state. A neutral row is neutral ink-on-white; color
only appears to flag something actionable or resolved.

---

## 3. Typography

A **three-typeface system**, each with a strict job. Never mix the roles.

| Face | Token | Weights loaded | Used for |
|---|---|---|---|
| **Playfair Display** (serif) | `font-serif` | 400/600/900 + italics | Page titles, card headings, contact names, big numbers with personality. Almost always **italic + black (900)**. |
| **Inconsolata** (mono) | `font-mono` | 400/600/700 | Everything "machine": labels, metadata, stats, buttons, status badges, body copy in dense views. Usually **UPPERCASE + `tracking-widest`**. |
| **Inter** (sans) | `font-sans` | 400/500/600/700/900 | Default body/UI fallback; graph node labels; landing hero. The quiet workhorse. |

### Signature moves
- **The trailing period.** Page titles are set as `Dashboard.`, `Directory.`,
  `Network Graph.` — huge (`text-5xl`), italic, black serif, full stop
  included. This is a recognizable Cirqle tic.
- **Mono micro-labels.** Section labels and metadata are tiny (`text-[10px]`),
  uppercase, letter-spaced mono in muted/subtle tone. They read like printed
  captions or terminal output.
- **Serif for numbers that matter.** Big stat values (network score, queue
  counts) use black serif at `text-3xl`–`text-4xl` — giving data editorial
  weight.

### Scale (typical usage, not exhaustive)
- Page title: `text-5xl` serif italic black + `.`
- Card/section heading: `text-2xl`–`text-3xl` serif italic bold
- Big stat: `text-3xl`–`text-4xl` serif black
- Body: `text-sm` mono, `leading-relaxed`
- Label / metadata: `text-[10px]` mono uppercase `tracking-widest`

---

## 4. Layout, borders & shadows

- **Hairline ink borders everywhere.** `border border-ink` on cards, inputs,
  buttons, panels. Inner dividers drop opacity (`border-ink/20`, `/15`, `/10`)
  to stay quiet without introducing gray.
- **Offset hard shadows** are the signature depth cue — no blur, pure offset,
  ink-colored:
  - Cards: `shadow-[8px_8px_0px_0px_rgba(26,26,26,0.12)]` (soft) up to
    `shadow-[8px_8px_0px_0px_rgba(26,26,26,1)]` (full, for emphasis like the
    global search bar and modals).
  - Modals go big: `shadow-[12px_12px_...]` to `shadow-[16px_16px_...]`.
  - Small controls: `shadow-[2px_2px_...]` / `shadow-[4px_4px_...]`.
- **Sharp corners.** Effectively zero border-radius on cards/buttons/inputs.
  `rounded-full` is used *only* for genuinely circular things (contact
  avatars, graph nodes, the "today" pill, notification dots). This is a hard
  rule — a stray rounded rectangle looks off-system.
- **The dot-grid texture.** A fixed, full-viewport `::before` layer paints a
  faint printed-paper dot grid (`radial-gradient` of ink dots, `24px` pitch,
  `0.05` opacity) behind everything. The Network Graph adds its own denser
  grid + dot overlay on its canvas.
- **Structure & rhythm.** ~256px left sidebar (auto-collapses below ~1100px);
  content capped at `max-w-6xl` and centered; vertical rhythm via
  `space-y-6`/`space-y-8`. The "Ask AI" bar is a pinned bottom sibling that
  reserves its own space (it does not float over content).
- **Custom scrollbars.** Thin (8px), rounded thumb `#D1CDCD` → `#A09D9D` on
  hover, transparent track.

---

## 5. Motion & animation

Philosophy: **short, eased, restrained.** Motion confirms; it never bounces or
shows off. Defined centrally in `src/index.css` and applied via utility
classes. Durations sit in the **150–250ms** band.

| Class | Keyframe | Duration / easing | Used for |
|---|---|---|---|
| `.animate-fade-in` | opacity 0→1 | 180ms `ease-out` | Overlays/backdrops, tab-content swaps, revealed content |
| `.animate-fade-scale-in` | fade + `scale(0.97)→1` + slight rise | 180ms `cubic-bezier(0.22,1,0.36,1)` | Modal/dialog entrances (Draft Outreach, Confirm, Help) |
| `.animate-fade-slide-up` | fade + `translateY(8px)→0` | 200ms `cubic-bezier(0.22,1,0.36,1)` | List/card items on mount, inline forms opening |
| `.animate-toast-in` | fade + rise + `scale(0.98)→1` | 200ms `cubic-bezier(0.22,1,0.36,1)` | Toast notifications |

- **Staggering.** Lists (dashboard queue cards, rolodex, templates) apply an
  incremental `animationDelay` (~30–40ms per item, capped) so they cascade in
  subtly rather than all at once.
- **Hover/press feedback** is done with CSS `transition-colors` /
  `transition-transform` on borders, backgrounds, and small translate/shadow
  shifts (e.g. the search bar lifts `-translate-x-1 -translate-y-1` and grows
  its shadow on focus). Standard easing, ~150ms.
- **The easing curve.** `cubic-bezier(0.22, 1, 0.36, 1)` (a gentle "ease-out
  quint") is the house curve for entrances — quick start, soft settle. The
  animated logo mark uses longer 500–700ms versions of it.
- **`prefers-reduced-motion`.** A global override in `index.css` collapses all
  animation/transition durations to ~0 for users who ask for reduced motion.
  Any new motion must respect this automatically by using these utilities.

Explicitly **avoided:** spring/bounce, spin-for-decoration, long (>300ms)
entrances, parallax, anything gimmicky. The one continuous spin is the
`RefreshCw` icon while an AI brief is generating — functional, not decorative.

---

## 6. Component patterns

- **Buttons** (`src/components/ui/Button.tsx`): mono, uppercase, bold,
  `tracking-widest`. Variants: `default` (filled ink), `outline` (ink border,
  inverts on hover), `ghost`, `link`, `danger` (red). Primary action = filled;
  secondary = outline. Hover transitions color, never morphs shape.
- **TierBadge**: the one relationship-tier chip (see §2).
- **StatusBadge** (Tracker): pipeline-stage chips using the semantic palette,
  bordered, tiny uppercase mono.
- **Toasts** (`ToastContext`): top-right, white card, ink border with a
  colored left accent bar (green/red/ink), icon + message, auto-dismiss, slide
  up on entry. The app-wide replacement for `alert()`.
- **Confirm dialog** (`ConfirmContext`): centered modal matching the card
  language (hard offset shadow, sharp corners, serif italic title), backdrop
  blur, Escape-to-cancel / Enter-to-confirm. The app-wide replacement for
  `window.confirm()`; destructive variants use the red button.
- **Modals** generally: ink/40 blurred backdrop, white bordered panel,
  big offset shadow, `fade-scale-in` entrance, click-outside + Escape to close.
- **Empty states**: icon + one line of muted copy + a CTA button, inside a
  dashed-border frame (see Templates). The standard for "nothing here yet."
- **AI surfaces** carry explicit loading, error-with-retry, and empty states
  (e.g. the Dashboard "This Week's AI Priorities" card) and a ✦ sparkle icon
  marks AI-powered actions.

---

## 7. Accessibility notes (baked into the current system)

- **No opacity-dimmed text for anything meant to be read.** De-emphasis uses
  the solid `--color-muted` token (6.2:1+ on both paper and white).
  `opacity-40/50` on small text previously measured 2.5–3.2:1 and failed
  WCAG AA — that pattern was removed. Opacity is fine for genuinely decorative
  fades only.
- **Tier and status colors all clear AA** for their text-on-fill pairings.
- **Reduced-motion respected globally** (see §5).
- **Keyboard**: modals/dialogs support Escape (and Enter to confirm) handling.

---

*Kept deliberately descriptive of the current state. If you evolve the
identity, update the `@theme` tokens in `src/index.css` first — they're the
single source of truth — then reconcile this file.*
