# Landing Page — Review Index

Everything the two landing passes changed, in one place, with a suggested
order to read it in. The detail lives in the two pass reports; this is the map.

## Where things are

| | |
|---|---|
| **Live** | `http://127.0.0.1:3333` (add `?scrollprobe=1` for the debug readout) |
| **Branch** | `feature/landing-story-choreography-2026-07-28` |
| **Worktree** | `.claude/worktrees/landing-choreo/` |
| **Pass 1 report** | `LANDING_STORY_REPORT.md` — the story rebuild |
| **Pass 2 report** | `LANDING_STORY_REVISION_REPORT.md` — anchor-following token, scrubbing |
| **Pass 3 report** | `LANDING_STORY_CHOREOGRAPHY_REPORT.md` — the per-beat highlight choreography |
| **Previous versions** | `http://127.0.0.1:3111` (pass 1) and `http://127.0.0.1:3222` (pass 2), for A/B |

Both passes branched off `polish/depth-pass-2026-07-24` (`53ea326`), **not**
`main`. `main`'s `LandingPage.tsx` is still the 70-line original with no
landing work in it at all — none of the three landing branches are merged, so
`main` is four passes behind on this page. Worth deciding what to do about
that separately.

## The commits

```
070c378  drop scroll-snap, put Lenis under one scroll loop       (pass 1)
2310b9f  restructure the page around one contact's journey       (pass 1)
589b9b7  LANDING_STORY_REPORT.md
9a0a96b  token travels into content, everything scrubs by scroll (pass 2)
169568b  LANDING_STORY_REVISION_REPORT.md
30a6e8f  LANDING_REVIEW.md
02c08e6  the token hands off to the UI's own reactions           (pass 3)
```

## Suggested review order

Read the machinery before the sections — the six beats are mostly declarative
once you know what the provider gives them.

**1. The narrative content** — start here, it's the part with opinions in it.

| File | What to look at |
|---|---|
| `src/components/landing/storyContact.ts` | The single contact the whole page follows. Every name, role, email and detail the story shows comes from here. The invented specifics you signed off on live in this file. |
| `src/components/landing/storyStages.ts` | The six beats and their labels, in order. |

**2. The scroll machinery** — the two files that carry the technique.

| File | What to look at |
|---|---|
| `StoryScroll.tsx` | Lenis setup, the single `progress` MotionValue, and the measurement of section stops + anchor points. The header comment explains why Framer never gets its own scroll listener. |
| `StoryToken.tsx` | The travelling token: how the path is built from anchors, why interpolation happens in page space, the dwell-window clamp, and the per-beat visibility rhythm (arrive, dissolve, re-form). |
| `StoryHighlight.tsx` | The shared outline + pulse primitive every beat's choreography reuses, and `useCue`, the timing vocabulary. |

**3. The six beats** — each is one file, in page order.

| Beat | File | The interesting bit |
|---|---|---|
| 01 Tap | `story/TapSection.tsx` | The scroll-linked card flip and its dwell/turn/dwell mapping |
| 02 Parsed | `story/ParseSection.tsx` | Fields scrubbed in, rows reserving their height so nothing reflows |
| 03 Asked | `story/AskSection.tsx` | **The scripted answers — worth your eye.** All four questions and their results are hardcoded at the top of the file |
| 04 Mapped | `story/MapSection.tsx` + `LandingGraph.tsx` | The three branch anchors, and `arrival` gating the node's existence |
| 05 Queued | `story/HealthSection.tsx` | Health ring, and the queue marquee's contents |
| 06 Drafted | `story/DraftSection.tsx` | **The email copy — worth your eye.** `SUBJECT` / `GREETING` / `BODY` at the top |

**4. Shared plumbing**

| File | What |
|---|---|
| `story/StorySection.tsx` | Section wrapper, heading, anchors, and the scrub helpers every beat uses |
| `src/pages/LandingPage.tsx` | Page order, hero, roadmap, footer. Shrank from 933 lines to ~380 as the beats moved out |
| `src/index.css` | Lenis's required rules, `.story-section` spacing, the marquee mask |
| `ScrollProbe.tsx` | Debug-only, renders nothing without `?scrollprobe=1` |

## What to look at in the browser

Needs a window ≥1280px wide — the token is hidden below that by design.

1. **Beat 04, scrolled slowly.** The hardest one to judge from stills, and the
   one beat that works unlike the other five: the token dissolves into an
   outline on "You", a pulse of oxblood travels the real edge, and the contact
   only exists once it arrives. Nothing flies down the branch.
2. **Scroll back up** through beats 02, 05, 06. Fields empty, ring drains,
   email un-writes. That's the scrubbing being real rather than triggered.
3. **Beat 03 without touching anything.** It runs itself. Any click or
   keystroke disables that permanently for the session — reload to re-arm.
4. **Beat 01's flip** at a normal trackpad pace. This is the one thing I
   couldn't settle headlessly.
5. **Beat 06's Send.** It pulses, invites a click, and actually sends — a mail
   icon flies off. Click it yourself before the page does it for you.
6. **The token hopping inside a beat** — clearest in beat 03, where it walks
   from the first question chip over to the Ask button. Pacing lives in
   `SECTION_SPREAD` (StoryScroll.tsx); section height is separate and is just
   `min-height` in `index.css`.

## Open questions for you

Nothing is blocked on these; they're the calls I couldn't make.

1. **Does the flip feel right, and is Lenis's `duration: 1.05` the right
   weight?** That number is a taste value I picked, not a measured one.
   `StoryScroll.tsx`, in the Lenis constructor.
2. **The health ring sweeps via `stroke-dashoffset`** — a paint property, the
   one knowing exception to the transform/opacity rule. It triggers no layout.
   The compliant alternative is clip-masked wedges: more code, more fragile,
   no measurable gain at 76px. Happy to build it if you'd rather.
3. **The token can slip under the sticky header** at the far edge of a dwell
   (~250px past a beat's centre). Brief, boundary-only, clampable.
4. **No travelling token below `xl`.** In scope per the brief, but it means
   the continuity device is desktop-only. Beats still read in order via the
   numbered eyebrows.
5. **`main` is four passes behind.** Merge strategy for the landing lineage is
   unresolved and outside what either pass touched.

## Already settled — not open

- **Stats strip: deleted**, not moved. A comment at its old location in
  `LandingPage.tsx` records the shape in case real numbers appear later.
- **Invented personal specifics stay as-is** — `devarshi@cirqle.app`, "Ross
  Founders Night", health 88, "decays to Warm in 9 days". Reviewed, confirmed
  fine as illustrative placeholders, untouched.
