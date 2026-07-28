# Cirqle — Landing Story: Revision Pass Report

Branch `feature/landing-story-revision-2026-07-27`, branched from
`feature/landing-story-2026-07-27` (`589b9b7`). Two commits, nothing pushed,
`main` untouched, `apps/mobile` untouched.

Part 1's Lenis foundation, the crossfade-of-representation mechanic, the
reduced-motion handling and the transform/opacity rule were left as they were,
as instructed. Everything below is what changed on top of them.

---

## Fix 1 — the token travels into the content

**It reads as arriving inside each beat, and the numbers back it up.**

Each section now registers an anchor element alongside its scroll stop.
`StoryAnchor` is a zero-size marker, so dropping one into a layout marks a
coordinate without occupying space or pushing anything around. The provider
measures both on the same `ResizeObserver` pass.

Two implementation details are the whole fix, and both were found by being
wrong first:

**Interpolate in page space, convert to viewport space once, at the end.**

```
viewportY = interpolate(anchorPageYs, progress) − progress × scrollLimit
```

Interpolating viewport positions directly cannot work, because the target is
itself scrolling: the token would cut a straight line across the screen while
the panel it is meant to land on slides out from under it. In page space the
anchors are stationary, so a segment that *holds* one anchor's page position
holds the token welded to that element as the page scrolls past it. That is
what produces a dwell rather than a fly-by.

**Measure anchors through the `offsetParent` chain, not
`getBoundingClientRect`.** Every beat's visual sits inside a `StoryReveal`,
which holds its content translated 24px down until it scrolls into view. A
rect-based measurement taken before that reveal fires records where the
*animation* had the anchor, not where layout puts it. The symptom was
unmistakable once measured — the token landed **exactly 24.0px off in all six
beats**, which is what sent me looking at the reveal transform rather than the
interpolation. `offsetLeft`/`offsetTop` are layout values that transforms do
not touch.

Landing accuracy, measured by parking on each beat's stop and comparing the
token's centre against that beat's own anchor marker:

| Beat | Anchors | Distance |
|---|---|---|
| 01 tap | 1 | 0.4px |
| 02 parse | 1 | 0.9px |
| 03 ask | 1 | 1.7px |
| 04 network | 3 | 0.1px |
| 05 queue | 1 | 0.1px |
| 06 draft | 1 | 0.2px |

**Beat 04 specifically** does what was asked, and the frame sequence shows it
clearly. The graph starts with **no node for the story contact at all** — his
node, its connecting link and its callout are all bound to an `arrival` value
rather than to the graph's own draw-in. The beat registers three anchors —
centre node, Venture hub, the point where he will be — and the token visits
them in order across the beat's window, travelling the same route the graph's
ambient signal pulses take.

- At progress **0.44** the token is mid-branch between "You" and the VC hub,
  and there is no Devarshi node in the graph.
- At progress **0.48** the token has reached the third anchor and the node,
  its oxblood link and the "Devarshi Dalal · CIRQLE · VENTURE" callout have
  faded up around it.

**Sequencing reads as "arrives, then fills in."** Each beat's reveal is
allocated to the back ~60–70% of its window (the token's dwell occupies the
front), so the fill-in demonstrably starts after the landing. Frame 0.24 shows
the token parked on the contact card with Name and Role written, Company
mid-fade, and School and Met-at still showing placeholder rules.

**One change I made unprompted:** the token's stage label moved from below the
ring to the left of it, right-aligned. Below put the label straight across the
panel the token had just landed on — legible through its paper backing, but
visible clutter over the "Reading" divider in beat 02 and over the health card
in beat 05. Every anchor sits just outside the top-left corner of the thing it
marks, so left is the one direction that reliably points into empty space.

Scope is unchanged from the rail: `xl` and up. Mobile keeps numbered eyebrows
and no travelling token.

---

## Fix 2 — the scroll-linked flip

**It is smooth, and the original jitter did not come back.** Reverted to
`rotateY` driven by the shared Lenis-backed progress value, multi-keyframe:
hold the front through the first third of the beat's window, turn through the
middle third, hold the back through the last third.

The premise in the brief was right. The original problem was binding rotation
to raw, unsmoothed scroll position, where every scroll stutter was a rotation
stutter because nothing sat between the browser's scroll events and the
rotation. Driving it from the value Part 1 already measured at sub-pixel drift
with a clean momentum tail carries that smoothness straight through — there is
no second sampler to disagree with the first. The frame sequence shows the
card front-on at 0.12, mid-turn at 0.16, and back-on by 0.20, which is the
dwell/turn/dwell shape working.

It is also now reversible, which the one-shot version could not be: scrolling
up turns the card back.

Honest caveat, since the brief asked for one: this is measured smoothness plus
a frame sequence, not a human watching a trackpad. See the follow-ups.

---

## Fix 3 — vertical whitespace

`min-height: 100svh` per section replaced with `min-height: 62svh` plus
`padding-block: clamp(3.5rem, 7.5vh, 6rem)`. The old height only ever existed
to give scroll-snap a page-sized thing to snap to; with snapping gone it was
just air, and on a tall desktop viewport it was a great deal of air between
short two-column blocks.

**Effect on scroll length: 9,686px → 7,288px at 1512×900. The page is ~25%
shorter.** Six beats' worth of dead cream removed without any beat losing its
own moment on screen.

The floor matters as much as the ceiling — see the note under Fix 6 about what
happened when the page got shorter.

---

## Fix 4 — scrubbed fill-ins, and whether they reverse cleanly

**They do, cleanly and completely.** The parsed fields (beat 02), the health
ring/score/detail rows and queue arrival (beat 05), and the assembling email
(beat 06) are all mapped to their beat's own scroll range through
`useTransform`. Nothing is triggered.

Measured on beat 06's 57-word body by counting words above 0.9 opacity while
scrolling forward, back, and forward again:

| | words lit |
|---|---|
| scroll to centre + 260px | **57 / 57** |
| scroll back to centre − 320px | **0** |
| forward again to centre + 260px | **57 / 57** |

Clean and symmetric — no words stuck lit on the way back, and the second
forward pass matches the first exactly.

The text still assembles by per-word opacity over a paragraph already at its
final size. A character-appending typewriter would reflow the card on every
frame and shove the send button around under the reader's cursor.

---

## Fix 5 — the Ask beat completes itself

A visitor who never clicks now still gets the payoff. If scroll passes the
beat's centre and nothing has been touched, the same populate-then-ask
sequence a click produces runs on its own — chip text into the bar, a pause,
then the ask, then the scripted answer.

It never overrides a real visitor: `touched` is set by picking a chip, typing
in the bar, or submitting, and once set the auto-run is dead for the session.
Reduced motion, which never scrubs and so has nothing to hook onto, shows the
answer outright instead of leaving the beat unfinished.

Verified: scrolling straight through with no interaction ends with the
synthesis panel and the story contact both on screen, and the "press ask to
run it" prompt gone.

I moved the trigger point once during this pass. At three-quarters through the
window, the 450ms populate plus 620ms think meant the answer materialised as
the ask bar was leaving the top of the viewport. It now fires just past centre.

---

## Fix 6 — ranges start when the section is actually in view

**Every beat now plays while it is the thing on screen.** All four
scroll-linked systems share one helper, `useSectionRange`, which builds a tight
window around the section's *measured centre stop* sized in viewport heights
(±0.4) rather than mapping across the section's whole journey through the
viewport. The reveal windows inside each beat then finish by 85–88% of that
range, so the demonstration completes while the beat is still centred rather
than a third of a viewport past it.

Confirmed by walking the sequence: beat 01 turns between frames 0.12 and 0.20
with the card centred; beat 02 is caught mid-fill at 0.24 with the card
centred; beat 06's email is still assembling at 0.68 with the card fully
visible.

**This fix broke Fix 1, and finding out why was the most interesting bug in
the pass.** Fix 3 made the page 25% shorter, which put the beats closer
together *in progress terms*. The token's dwell windows, sized purely in
viewport heights, then overlapped — and once they overlap, the combined
keyframe list stops being monotonic. `strictlyIncreasing` dutifully "repaired"
it by squashing whole segments to 1e-5 wide, and the token interpolated
against a mangled range and landed nowhere near anything. Dwell windows are
now clamped to 0.42 of the distance to the nearest neighbouring beat, which
keeps them disjoint at any page length and still leaves a gap to travel in.

A second bug worth recording, because it is a Motion trap rather than a logic
error: the natural shape for the page→viewport conversion is a chain —
interpolate page position from progress, then subtract scroll in a second
`useTransform([pageY, progress], …)`. **A multi-input `useTransform` fed a
derived MotionValue reads a stale snapshot of it.** The token interpolated x
correctly (single input) and left y frozen on the first keyframe for the whole
page. Collapsing both axes into a single transformer over the single source of
truth removed the chain and the staleness with it.

---

## Settled decisions

1. **Stats strip deleted**, not moved. It carried "12,000+ contacts parsed from
   raw text", "40,000+ follow-ups kept on time", and "3.4× more replies than
   cold sends". If real numbers ever exist, the shape was a three-item
   `<CountUp>` grid inside a full-width bordered band, and a comment at the old
   location in `LandingPage.tsx` records that. `CountUp` itself is still in the
   tree. Verified absent from the rendered page.
2. **Invented personal specifics untouched.** `devarshi@cirqle.app`, "Ross
   Founders Night", the health score of 88, "decays to Warm in 9 days" — none
   changed, none replaced, none re-flagged below.

---

## Verification

Frame-by-frame: **26 screenshots at even scroll intervals across the entire
range**, every one reviewed rather than spot-checked, plus the programmatic
checks from the prior pass kept and extended.

What the visual pass caught that no assertion would have: the label-over-panel
overlap (fixed), the reveals finishing later than they should relative to
section centre (fixed), and the confirmation that beat 04's node genuinely is
absent before the token arrives.

| Check | Result |
|---|---|
| Console errors | **0** |
| Token → anchor distance, all six beats | 0.1–1.7px |
| Draft assembly forward / back / forward | 57 / 0 / 57 |
| Ask auto-completion for a passive scroller | synthesis + story contact shown |
| Reduced motion | no Lenis; all beats in end state; 0 errors |
| Mobile 390×844 | 0 horizontal overflow; token hidden; all beats present |
| Animated layout properties | none — audited across all landing components |
| Page scroll length | 9,686px → 7,288px |
| Production build | passes (9.9s) |

---

## Flag for a follow-up pass

1. **Still nobody has felt this on a trackpad.** Every measurement here is
   headless. The flip in particular is the thing most worth 15 seconds of your
   own scrolling — the brief explicitly asked me to report honestly if the
   jitter came back, and by every measurement available to me it did not, but
   "scroll-linked rotation feels right" is ultimately a judgement made with
   your hand on the trackpad, not with a frame counter.
2. **The health ring is the one knowing exception to the transform/opacity
   rule.** Its arc sweeps via `stroke-dashoffset`, a paint property. The rule
   exists to keep scroll-linked work off the *layout* path, and this triggers
   neither layout nor reflow — it repaints one 76px SVG circle. The strictly
   compliant alternative is counter-rotating half-ring wedges behind clip
   masks, which is materially more code and more fragile for no measurable
   gain. Flagged rather than hidden; say the word and I'll build the wedges.
3. **The token can slip under the sticky header at the extremes of a dwell.**
   It is welded to its anchor, so at the far edge of a dwell window the anchor
   (and therefore the token) is ~250px above centre, which on beat 06 puts it
   behind the header. Brief and only at the boundary, but a clamp on the
   token's viewport Y would fix it if it bothers you.
4. **Beat 04's anchor placement is still hand-tuned** to the graph's current
   `viewBox` and hub layout, now via published percentage coordinates
   (`GRAPH_ANCHORS`) rather than magic numbers. Changing `HUBS` or the viewBox
   still needs it re-checked; there is no layout logic protecting it.
5. **`useSectionRange`'s ±0.4 viewports is a tuned value, not a derived one.**
   Adjacent beats' ranges overlap by ~80px at the current page length, which is
   harmless (each beat only drives its own elements) but is the number to
   revisit if beats ever get closer together again.
6. **No travelling token below `xl`** — unchanged from the last pass and
   explicitly in scope per the brief. The beats still read in order via their
   numbered eyebrows, but the continuity device remains desktop-only.
7. **`ScrollProbe` and the `?scrollprobe` token dump were left in.** They
   render nothing without the query param. The token's failure mode is
   "silently lands somewhere wrong", which a screenshot cannot explain — both
   bugs in Fix 6 above were diagnosed through that dump in minutes. Delete if
   you'd rather not ship the code path.
