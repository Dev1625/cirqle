# Cirqle Design System v2 — Warm Minimalist (reconciled against the real DESIGN.md)

This supersedes the visual-system guidance from round 1. It has been checked line-by-line against `DESIGN.md` (Claude Code's own snapshot of the current system) — real token names, real hex values, real component and file references throughout. Where the current system is already right, this says so explicitly and leaves it alone. The actual delta is narrower and more surgical than "redesign everything."

**Read `DESIGN.md` first, then this document.** This is the diff against that baseline, not a replacement for it.

## Part 1 — What stays exactly as documented (do not touch)

This is most of the system. Resist the urge to "improve" anything in this list — it's already good, already accessibility-audited, and unrelated to this pass's goals.

- **Color**: `--color-paper` (`#F5F0E8`), `--color-ink` (`#1A1A1A`), `--color-subtle` (`#414141`), `--color-muted` (`#5C5850`) — the existing three-tier text hierarchy (ink / subtle / muted) is correct and stays exactly as-is. Don't introduce parallel token names for the same roles.
- **Tier badge colors** (Strong/Warm/Cold/Dormant) — all four already pass WCAG AA and are already visually distinct from the new accent (see Part 3). No changes.
- **Network-graph industry palette** — already muted, earthy, desaturated. This is exactly the restraint this redesign is going for elsewhere; it doesn't need to change to fit in.
- **Semantic/status colors** (blue/emerald/purple/amber/red on the Tracker) — keep exactly as-is.
- **Typography faces and their jobs**: Playfair Display italic/900 for display, Inconsolata uppercase mono `tracking-widest` for labels/machine-layer, **Inter stays as the body/UI sans** — there's no reason to swap it for anything else; it's already doing exactly the job a humanist sans should do here.
- **Signature typographic moves**: the trailing-period page titles (`Dashboard.`, `Directory.`), and big stat numbers set in black serif. Both are good, specific, already-earned brand quirks. Keep them.
- **The existing motion utility system** — `.animate-fade-in`, `.animate-fade-scale-in`, `.animate-fade-slide-up`, `.animate-toast-in`, the `cubic-bezier(0.22, 1, 0.36, 1)` house curve, 150–250ms durations, ~30–40ms stagger, global `prefers-reduced-motion` handling. This already embodies the timing/easing/staging principles this redesign calls for. See Part 4 for the one place it gets a deliberate, scoped exception.
- **Component behavior**: Toast/Confirm/Modal logic, empty-state pattern (icon + line + CTA in a dashed frame), AI-surface loading/error/sparkle-icon pattern, sidebar collapse behavior, `max-w-6xl` content rhythm. All unchanged — only their *border/shadow/radius skin* changes (Part 3), not their behavior.
- **The dot-grid paper texture** — genuinely nice, tasteful, and orthogonal to everything below. Keep it. If it reads as slightly busy once shadows go flat, nudge opacity down further — Claude Code's visual call, not a mandate either way.

## Part 2 — The new accent: a new role, not a retint

There is currently no vivid "decision-point" color anywhere — primary buttons are plain ink-filled. So this isn't replacing `--color-accent` (`#E4DFC9`, the quiet sand/wheat used for tag chips and highlights) — that token keeps its existing hex and existing job as a passive background wash. This adds a **new, distinct role**:

- **New token**: `--color-brand: #7A2331` (deep oxblood/signet red — see prior reasoning: avoids the terracotta-on-cream AI-cliché, and sits tonally consistent with the existing warm/earthy palette, including the industry lane colors already in `NetworkGraph.tsx`).
- **New token**: `--color-brand-on: #F5F0E8` (paper, for text/icons on top of brand fills — reuse the existing paper token, don't invent a new near-white).
- **Where it's used — narrowly, on purpose**: the single primary CTA per view (e.g. the landing page's main CTA, "Send" on Draft Outreach, other true decision points — aim for a handful of uses app-wide, not a blanket recolor), the active/current nav item, link hover/active state, and `focus-visible` rings. Ordinary "default" ink-filled buttons stay ink-filled — don't recolor every button, that defeats the restraint this is supposed to buy.
- **Double-check once implemented**: the existing Dormant-tier text color (`#93401F`) is in a similar warm-dark-red family to the new brand color. They're used in different contexts (small badge text vs. bold CTA fills) so confusion is unlikely, but take a screenshot with both visible and confirm they read as distinct.

## Part 3 — Borders, shadows, radius: the real delta, and it breaks two stated "hard rules" on purpose

DESIGN.md documents zero-radius and offset-hard-shadows as explicit hard rules. **This pass intentionally overrides both.** Don't half-apply this out of deference to rules the app's own documentation states firmly — that's exactly the failure mode to avoid here.

- **Borders**: the current system already has the right mechanism for this — inner dividers already use opacity-reduced ink (`border-ink/20`, `/15`, `/10`) while the *default* border is full-strength `border-ink`. Flip that: standardize on **one** reduced-opacity value (`border-ink/15` is a reasonable single default) as the border treatment everywhere — cards, panels, inputs, buttons. This is a small, mechanical change since the pattern already exists in the codebase for a different current use case.
- **Shadows**: retire the offset-hard-shadow scale (`shadow-[8px_8px_0px_0px_...]` through `16px_16px`) as the default. In-flow surfaces (cards, rows, the sidebar) get **no shadow at all** — the hairline border is the entire structural cue. Reserve **one** soft, small, blurred elevation shadow for genuinely floating layers only: modals, dropdowns, popovers, toasts. Don't leave some components on hard-offset and others on soft-blur — commit fully so the system doesn't fragment.
- **Radius**: introduce `--radius: 7px` as the default for cards, buttons, inputs, and badges — a deliberate, specific number in the spirit of "a considered signature," not a rounded default. The existing rule that `rounded-full` is reserved for genuinely circular things (avatars, graph nodes, dots) is untouched — that part of the hard rule stays exactly as documented; only the "everything else is 0px" half of it changes.

## Part 4 — Motion: honoring what's deliberate, scoping the one exception

The existing system's "never bounce, always ease-out-quint, calm and physical" philosophy is a considered choice, not an oversight — keep it for all daily-use, functional motion (buttons, toggles, modals, list items, everything already using the utility classes in Part 1). Don't introduce spring/overshoot into that system.

The reference video's "pop" comes specifically from a small overshoot on entrance — which is genuinely in tension with "explicitly avoided: spring/bounce" in DESIGN.md. Resolve it by scope, not by override: **the landing-page hero entrance is the one deliberate exception**, since this document already reserves "exaggeration" for onboarding/landing-only moments elsewhere. One subtle overshoot, in one place, on first paint — not a new house-wide curve. Everything else in the app keeps the existing calm curve exactly as documented.

New motion work that doesn't exist yet and does need building: the landing-page scroll-triggered reveal choreography, the network graph hover-tooltip + eased highlight-fade (already flagged as left-undone in the prior report, unrelated to this reconciliation), and the "out of frame" bleed-content motif below.

## Part 5 — The "out of frame" layout motif (new, additive)

Let content continue past the visible edge of its container in a few high-visibility places — a card row wider than the viewport with the last item visibly half-cut, a hero visual anchored at the page edge — rather than boxing everything inside a fully-visible grid. Cheap way to make a simple layout feel considered rather than closed-in. Use deliberately (landing page, a couple of list previews), not everywhere.

## Part 6 — The network graph is still the star

Unchanged from every prior pass: Cirqle's most distinctive, most demo-able asset, and it gets the biggest motion budget of anything in the app (the hero exception in Part 4, the hover-tooltip work in Part 4, real showcase real estate on the landing page).

## Skill reconciliation

Swiss Design System is aligned with this direction (neutral base, restrained color, grid discipline) rather than in tension with it — let it inform structure directly. Taste/Impeccable still governs overall restraint and anti-slop judgment.
