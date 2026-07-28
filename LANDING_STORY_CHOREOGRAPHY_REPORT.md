# Cirqle — Landing Story: Token Choreography Pass Report

Branch `feature/landing-story-choreography-2026-07-28`, off
`feature/landing-story-revision-2026-07-27` (`30a6e8f`). Nothing pushed, `main`
untouched, `apps/mobile` untouched.

Fix 1's travel, Fix 2's flip, Fix 3's spacing, Fix 4's scrubbing and Fix 6's
range timing are all unchanged as machinery. What changed is what happens
*inside* each beat once the token gets there.

Live at `http://127.0.0.1:3333`. Needs a window ≥1280px.

---

## The shared primitive — reused, not rebuilt

`src/components/landing/StoryHighlight.tsx`, three exports, used **nine times
across six beats**. There is no per-beat variant of either component.

| | |
|---|---|
| `StoryOutline` | SVG rounded-rect stroke, drawn by `stroke-dashoffset` — the same technique already justified for the health ring. `pathLength={1}` normalises the perimeter so the dash maths is size-independent. |
| `StoryPulse` | A restrained breathing ring. |
| `useCue` | `[in0,in1]` draws on, optional `[out0,out1]` takes away. The whole timing vocabulary. |

Counted live in the DOM: **6 outlines, 3 pulses.**

**One deliberate departure from the brief.** The brief asked for these to be
positioned "via the same anchor-measurement approach already built for Fix 1".
They are positioned by *containment* instead — `absolute inset-…` inside the
element they decorate. The token needs page-space measurement because it is
`position: fixed` and has to cross between sections; a highlight lives inside
its target, so containment gets correctness for free at every breakpoint, and
it tracks targets that move on their own. That last part is not hypothetical:
beat 05's highlight goes on a card inside a continuously translating marquee,
which a measured overlay would have to re-measure every frame to stay glued to.

Everything is scrubbed and reversible. Measured: outlines lit at a beat → **1**,
scrolled away → **0**, scrolled back → **1**.

---

## Per-beat sequence, against what was asked

Timeline sampled at every one of 34 frames across the full scroll. `p` is page
progress; "lit" is what the DOM actually reported.

### Beat 01 — timing only

Asked: the token forms only once the flip has completed and settled.

The number that mattered: the turn runs from a third to two-thirds of the
beat's *section range*, which lands at ≈0.74 of its narrower *dwell* window.
Forming at 0.42 of the dwell — which is what the first cut did — put the token
on screen while the card was still rotating. It now forms at 0.78 and departs
almost immediately, which is the hand-off the beat wants.

Measured: token opacity **0** at p≤0.152 (card mid-turn, screenshot
`f05-p0.152.png` shows the card rotating with nothing beside it), **1** by
0.182. Flip completes at p≈0.162. The token forms after it.

### Beat 02 — outline the text, then the form

Measured: `outline:parse` + `pulse:parse` together at p=0.212, outline alone at
0.242–0.273.

`f07-p0.212.png` — raw capture box outlined, "READING" pulsing beside it,
contact card below still showing placeholder rules.
`f09-p0.273.png` — outline has moved onto the New Contact card, fields
resolved, Saved chip up. The form outline draws on at 0.30 of the beat, the
fields fill from 0.32: the outline tracks the parse rather than announcing a
finished box.

### Beat 03 — highlight, urge, confirm

Measured: `outline:ask` (chip) at 0.303, `pulse:ask` at 0.333–0.364,
`outline:ask` (result card) from 0.394.

`f11-p0.333.png` — the *first* chip is outlined, and only that one, because it
is the one Fix 5's auto-run picks. Pointing at it is telling the truth.

The Ask pulse runs 0.30–0.40 of the beat and the auto-run fires at 0.55, so the
invitation has a genuine window before the page takes its own advice.

The result-card outline was originally interaction-driven, animating in when
the answer appeared. The timeline caught it **latching on and staying lit for
the rest of the page** — the one thing these highlights are not allowed to do.
It is now a scrubbed cue whose window opens after the auto-run, so there is an
answer under it either way, and it retracts like everything else.

### Beat 04 — the exception, and the one to look at twice

Asked: no separate object flying down the branch; the edge itself carries
colour; the node appears when the colour arrives; "no node until this
completes" preserved.

Measured: `branch` opacity **1** at p=0.455 with `storyNode` **0**; node **0.6**
at 0.485; node **1** at 0.515.

`f15-p0.455.png` — "You" carries an oxblood outline, a short dash of oxblood is
partway along the branch toward the VC hub, **and there is no Devarshi node in
the graph at all**. No token either.
`f16-p0.485.png` — the colour has arrived, the node and its callout are fading
up in place.

Implementation: one polyline through You → Venture → the contact's position,
`pathLength={1}`, a 0.16-long dash offset from 0.16 down to −1. Same idea as the
graph's existing ambient signal pulses, driven by the beat's scrub instead of a
repeating timer.

The beat registers **two** anchors rather than three, and the token's re-form is
pushed from 0.74 to **0.90** of the dwell for any beat whose token moves
mid-dwell — otherwise it becomes visible a quarter of the way short of the node
and you watch it cross, which is exactly what this beat exists to avoid.

**Flagged, as requested.** This is the one beat that works unlike the other
five, and the one whose correctness is not obvious from a static frame — the
travelling dash only reads as travelling in motion, and its speed relative to
scroll is a taste value I set (0.30 → 0.74 of the beat), not a measured one. If
any beat needs a second look, it is this one.

### Beat 05 — ring first, then the card in the row

Measured: `outline:queue` at 0.515–0.576.

`f19-p0.576.png` — the health ring reads 88 with its arc filled, the ring
outline has already handed off, and **his card in the marquee row is outlined**
while the four others are not.

The stage-4 anchor moved from the card's corner onto the ring itself, so the
token merges into the score rather than landing beside it. The row outline is
guarded to the real copy of his card only — the marquee renders the list twice
to loop seamlessly, and without the guard a second outline drifts across the
row.

### Beat 06 — a cursor, and a send that sends

Measured: `outline:draft` at 0.606; exactly **one** caret lit at 0.667.

`f22-p0.667.png` — the email mid-assembly with a single oxblood caret sitting
after "Would", tracking the writing position.
`send-01-invited.png` / `send-02-flying.png` — the Send control pulsing, then
the mail in flight clear of the card with the button reading "Sent".

The caret is one element per word, lit only while the scrub is inside that
word's slot, absolutely positioned against its word so it adds nothing to the
line box. Moving a single caret would mean recomputing its position in React
every frame; a caret *in* the text flow would nudge every following word.

Send is a real button, and — like beat 03 — completes itself at 0.97 of the
beat for a visitor who scrolls straight through. Any real interaction disables
that permanently.

---

## Three bugs the visual review caught that the numbers did not

Worth recording, because all three passed every assertion I had.

1. **Every outline rendered 150px tall.** `<svg>` is a replaced element, so an
   absolutely positioned one with `height: auto` takes its *intrinsic* size and
   ignores `bottom` entirely. The outline looked plausible on a short box and
   obviously wrong on a tall one. The timeline said "outline lit" the whole
   time. Sized explicitly now.
2. **The flying mail was clipped.** It launched from inside the card, which is
   `overflow-hidden`, so it hit the border and stopped. The element existed,
   animated, and reported correct transforms throughout.
3. **It also faded on takeoff.** Its opacity track shared the house ease-out
   curve, so eased progress was past the fade-out keyframe a third of the way
   through the flight. Opacity has its own linear track now.

---

## Verification

| Check | Result |
|---|---|
| Frames reviewed | 34, full scroll range, plus 2 targeted send captures |
| Console errors | **0** |
| Shared primitive instances | 6 outlines + 3 pulses, 0 bespoke |
| Highlight reversibility | 1 → 0 → 1 |
| Beat 04 node before arrival | absent (`storyNode` 0 while `branch` 1) |
| Carets lit simultaneously | 1 |
| Reduced motion | no Lenis, all beats in end state, 0 errors |
| Mobile 390×844 | 0 horizontal overflow, token hidden, all beats present |
| Animated layout properties | none |
| Production build | passes |

---

## Pacing revision (follow-up on this pass)

Feedback after the first cut: *"there's not enough time to enjoy this… I'd
make the sections a bit longer vertically so you can really see each
animation… and the token should even travel small distances (like between the
questions and the ask button), so I know to ask."*

**The section-height instinct was right but height alone would not have fixed
it.** A beat's animation window is `2 × spread × viewportH` — measured in
*pixels of scrolling*, not in section height. Making sections taller with the
old `spread = 0.4` would have added empty gaps between beats and left every
beat playing out in the same 720px it always had. Two dials, both turned:

| | before | after |
|---|---|---|
| `SECTION_SPREAD` (time per beat) | 0.4 → 720px | **0.68 → 1224px** |
| `.story-section` min-height | 62svh | **118svh** |
| Beat 03 only (four moments + ask latency) | 0.4 | **0.78** |
| Page scroll length | 6,389px | **9,057px** |

118svh is a trimmed figure. 130 gave the pacing room but left a visible dead
band under beats whose content does not fill the height; since the pacing
comes from the spread and not the height, the height came back down without
costing any of the extra time.

**The token now travels inside a beat, not just between them.** A beat used to
be one park. It is now `park → hop → park → hop → park`, so the token walks
between the things a beat is actually about. `StoryAnchor` gained `weight`
(how long it parks) and `silent` (hide the hop *into* this stop, for beat 04).

| Beat | Stops the token walks |
|---|---|
| 01 | the card (one stop, forms after the flip) |
| 02 | raw capture → the record being written |
| 03 | **first chip → Ask button → the answer** |
| 04 | "You" → the new node, hop hidden |
| 05 | the health ring → the queue row |
| 06 | the compose box → Send |

Heavy stops dissolve mid-park so the beat's highlight owns the moment; light
stops are waypoints and the token stays visible through them. That is the rule
that makes the chip → Ask hop read as an instruction rather than decoration.

Beat 03 also had its auto-run latency trimmed (450+620ms → 300+420ms) and
moved to 0.52 of its window. Scrolling does not pause for that delay, so every
millisecond of it was scroll distance the answer was not yet on screen for.

Re-verified after the change: 0 console errors, highlights still retract
(1 → 0 → 1), reduced motion unchanged, mobile clean, build passes.

---

## Flag for a follow-up pass

1. **Beat 04, as above.** The exception, and the one whose motion cannot be
   judged from a still.
2. **Still nobody has scrolled this by hand.** Everything here is headless. The
   pulse rate (2.1s), the outline draw speed, and beat 04's colour speed are
   all taste values.
3. **The health ring and now every outline use `stroke-dashoffset`** — paint,
   not compositor. Same knowing exception as before, now used nine more times.
   It triggers no layout, but it is nine more elements repainting on scroll
   than there were. Nothing measured badly; flagging the multiplication.
4. **Beat 06's send does not reverse.** Scrolling back up un-writes the email
   but the button stays "Sent", consistent with beat 03's answer persisting.
   Un-sending an email on scroll-up seemed the stranger depiction, but it is a
   judgement call and the brief's reversibility rule is otherwise absolute.
5. **The Ask invitation now has real room** — the pulse runs 0.34–0.65 of a
   window that is itself ~1.8× wider, against an auto-run at 0.52. That is the
   pacing complaint's specific fix, but it is still a tuned number rather than
   a measured one.
6. **118svh is a judgement call.** It is nearly double what it was and it may
   still be too much or too little for you; it is one value in `index.css` and
   changing it costs nothing, because the pacing lives in `SECTION_SPREAD`.
