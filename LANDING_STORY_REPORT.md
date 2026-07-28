# Cirqle — Landing Page: Story Scroll Rebuild

Branch `feature/landing-story-2026-07-27`, two commits, nothing pushed, `main`
untouched, `apps/mobile` untouched (not present in this worktree).

**Branch point.** This branched from `polish/depth-pass-2026-07-24` (`53ea326`),
not from `main`. The landing page with CSS scroll-snap — the thing this pass
exists to replace — lives only on that branch; `main`'s `LandingPage.tsx` is the
70-line original with no landing work in it at all. Branching from `main` would
have meant deleting a scroll-snap implementation that wasn't there and
rebuilding the premium and depth passes from scratch. Worth knowing if this ever
needs merging: neither of the prior landing branches is merged either, so
`main` is three passes behind on this page.

---

## Part 1 — the foundation, and how it was actually checked

Scroll-snap is gone rather than reconciled: `.snap-section` → `.story-section`
(same viewport-scale rhythm, no snapping), the `landing-snap` class no longer
goes on `<html>`, and the `scroll-snap-type` / `scroll-behavior: smooth` block
is deleted. Lenis 1.3.25 replaces it, driving the real document scroll.

The integration is in `src/components/landing/StoryScroll.tsx`, and the point of
it is what it refuses to do: **Framer Motion never attaches its own native
scroll listener anywhere on this page.** `useScroll` reads scroll position from
the browser's scroll event; Lenis *writes* scroll position from inside a rAF
loop. Wired up independently they sample the same scroll at two different
moments in a frame, which is the well-documented source of scroll-linked judder.
So Lenis's own `scroll` event is the sole writer of one `progress` MotionValue,
and every scroll-linked animation reads that through `useTransform`. Framer
still does all the interpolation — it has simply been taken off scroll-event
duty. `useScroll` itself is therefore not called anywhere in the story code;
that is the deliberate substitution, not an omission.

Under `prefers-reduced-motion` Lenis is not constructed at all. A smoothing
library's entire job is animating scroll position, so the honest reduced answer
is not to run one — plain native scroll, one passive listener, feeding the same
MotionValue so nothing downstream has to branch.

### The checkpoint — measured, and passed, before any Part 2 work started

Part 1 was committed on its own (`070c378`) before a single narrative section
was written. Eyeballing smoothness cannot detect a one-frame lag between the
Lenis-driven value and the browser's real position — it looks fine in isolation
and only shows up as judder once something is pinned to it. So the page mounts a
probe under `?scrollprobe=1` (`ScrollProbe.tsx`, renders `null` otherwise) that
pushes the `useTransform`-derived value and a fresh `window.scrollY` read into
`window.__scrollProbe` every frame, and a headless-Chrome harness drove it.

An important false start is worth recording: the first attempt used the live
Chrome browser and produced zero frames. The window was minimised, so
`document.visibilityState` was `hidden`, `requestAnimationFrame` was frozen, and
Lenis was not running at all. Any "it feels smooth" judgement made in that state
would have been meaningless. Headless Chrome runs the frame loop normally, which
is why the verification moved there.

| Check | Result |
|---|---|
| `scroll-snap-type` on `<html>` | `none`; zero `.snap-section` elements remain |
| Console errors on load | **0** |
| Lenis ↔ Framer drift | max **0.50px**, mean **0.24px**, **0 samples above 1px** |
| Momentum, slow input (6 × 120px, 140ms apart) | 80-frame decelerating tail, easing ratio 0.90, final step 1px |
| Momentum, fast input (12 × 400px, flicked) | 56-frame tail, easing ratio 0.93, final step 1px |
| Same behaviour fast vs slow | yes — both decelerate to a 1px final step |
| `#network` anchor | lands in view, `top: 0` |
| Reduced motion | no `lenis` class, native driver, jumps exactly 900px rather than easing |

Sub-pixel drift is float rounding of the scroll position, not lag.

Clearing the console-error line required a fix that predates this pass:
`LandingGraph`'s six pulse circles animated `cx`/`cy` without seeding them, so
first paint wrote literal `"undefined"` into both attributes — twelve errors on
every load.

---

## Part 2 — the story

Sections were repurposed in place, not appended. Nothing was bolted onto the
end.

| Beat | Section | Came from |
|---|---|---|
| 01 Tap | `TapSection` | the NFC card beat, promoted to the opening |
| 02 Parsed | `ParseSection` | the "Capture / paste the mess" FeatureBeat |
| 03 Asked | `AskSection` | the Ask-your-network beat, now interactive |
| 04 Mapped | `MapSection` | the graph showcase |
| 05 Queued | `HealthSection` | the follow-up queue beat |
| 06 Drafted | `DraftSection` | the "Reach out" FeatureBeat |

Two structural calls beyond the six:

- **The hero's product panel became the story's table of contents.** Every
  screenshot worth putting in a hero is a beat further down the page, and
  showing one in the hero spends it twice. Listing the six stages instead tells
  the visitor the page goes somewhere and teaches the numbered language the
  thread uses all the way down. Hero CTA is now "Follow one contact" → `#tap`.
- **The stats strip moved below beat 06.** It is not part of the narrative and
  sitting between the hero and beat 01 it broke the thread immediately. See
  follow-ups — those numbers need a decision from you.

Roadmap, closing CTA and footer are unchanged in substance, but all now use the
same `STORY_COLUMN` container so the content column never jogs sideways when you
scroll from a story section into a non-story one.

### Beat 03 is genuinely scripted

Four example questions, each with a hardcoded synthesis line and three
hardcoded result cards. Clicking a chip replaces whatever is in the bar and
resets the answer, so the visitor still presses Ask themselves. **Nothing calls
a model, a mock endpoint, or anything else over the network** — a landing demo
has to be instant, identical on every load, impossible to rate-limit and free to
serve, and a marketing page is the worst possible place to find out an API key
rotated. The 620ms delay before the answer is a fixed timeout, not a request.

The bar is a real editable input, so free typing is possible; keyword matching
resolves typed text to the nearest scripted answer, and an honest fallback
appears when nothing matches ("on this page the answers are scripted — pick one
of the questions above").

Verified headless: the chip replaces the bar text, Ask returns the right
scripted answer, and the answer contains the story contact.

---

## Part 3 — the continuity character

`src/components/landing/storyContact.ts`, one object, defined once:

```
Devarshi Dalal · Founder & CEO · Cirqle · University of Michigan · Ross
```

plus the fields sections actually display: `email`, `handle`, `industry`
(Venture — his graph lane), `tags`, `health` (88), `tier` (Strong), `metAt`
("Ross Founders Night"), `metWhen`, and the `rawCapture` string beat 02 parses.

Audited headless across all five name-bearing beats: every one contains
"Devarshi", and **none** contains `Sarah Jenkins`, `Priya Nair` or
`Goldman Sachs`. The old sample contacts survive only as *other* people in the
directory — answer rows, queue cards, roadmap mocks — never as the subject of a
beat, which is what they were being used as before.

The email is `devarshi@cirqle.app`, the product address, deliberately not the
personal one — this string renders on a public page. It is currently invented;
see follow-ups.

---

## Part 4 — how the token flows, and the call I made

**Stage representations built:** six, one per beat, each a lucide glyph inside
the recurring ring — `Nfc` (tap), `Sparkles` (parsed), `Search` (asked),
`Network` (mapped), `Activity` (queued), `Mail` (drafted) — plus a numbered
label ("01 · TAP") that crossfades with it.

**The technique held, with one deliberate constraint.** No shape-morphing was
attempted, as instructed. Continuity is carried by position, scale and colour
tracking continuously while the stage representation inside the token
crossfades:

- **Travel** — `translateY` interpolated from the shared progress value.
- **Scale** — a genuine multi-keyframe range built from the measured stops:
  `0.88` between beats, `1.0` at each one, so the six stops are felt rather than
  merely passed.
- **Crossfade** — each glyph and label has its own `useTransform` opacity
  window, full at its own stop and gone by the midpoint to either neighbour.
  First and last hold out to the ends so the token is never blank.
- **Thread fill** — `scaleY` against a fixed-height track. Never a height
  animation.

The stop positions are **measured, not guessed**: each section registers itself
with the provider, which computes where its centre sits in page-scroll terms and
re-measures on resize via a `ResizeObserver`. Confirmed reading
`0.119 / 0.230 / 0.342 / 0.453 / 0.564 / 0.675` rather than the even-spacing
fallback.

**The constraint I chose, and would flag for your judgement:** the token travels
a fixed left-gutter thread rather than flying to an arbitrary position inside
each section's layout. Free-flying DOM continuity across six differently-shaped
two-column sections means the token lands on top of copy at some viewport widths
and behind cards at others, and the failure mode is not subtle. A thread that
runs alongside the whole story is the version that reads as considered rather
than as an object escaping its container. This is not the "give up and use a
recurring colour" fallback the brief allowed — the position/scale/crossfade
interpolation is all real and all scroll-linked — but it is a narrower stage
than "anywhere on the page", and that was a taste call rather than a technical
limit.

Travel is mapped to end at beat 06, not at the bottom of the document: the
roadmap, CTA and footer sit below the story, and a thread that kept crawling
through them would say the story was still going. The rail fades out over the
5% of scroll after the last beat.

The rail is `xl`-only. Below that there is no room for a gutter that isn't
stealing width from the content.

---

## Part 5 — the card flip

Trigger and playback are fully decoupled. `useSettledTrigger` fires on
`useInView(ref, { amount: 0.6, once: true })` — most of the card visible — then
waits 1000ms so the front face registers as a thing before it moves. Playback is
then a fixed 1.15s `rotateY: 0 → 180` on its own timeline, **not scrubbed by
scroll at any point**. `once: true` is the part that matters for the stated
requirement: once the trigger has fired, scrolling fast, slow or backwards
cannot touch it again.

---

## Part 6 — performance rules

**Every scroll-linked and narrative animation uses `transform` and `opacity`
only.** Audited by grepping every `animate` / `initial` / `whileInView` / `exit`
/ animated `style` prop across the landing components for `width`, `height`,
`top`, `left`, `right`, `bottom`, `margin`, `padding`. Two hits, both **static**
values on plain non-motion elements — the health ring's fixed wrapper size and
the thread ticks' one-time `top` percentage. Neither is animated.

Two places where the obvious implementation would have violated this, and what
was done instead:

- **The assembling email and the populating contact card.** A real
  character-appending typewriter reflows its paragraph every frame and shoves
  everything below it around. `AssemblingText` puts the whole string in the DOM
  at final size immediately and animates per-word `opacity` into a layout that
  was already correct. Same for the parsed fields — each row reserves its height
  with a placeholder rule that fades out as the value fades in.
- **The health ring** is drawn statically at its value rather than sweeping
  open, so there is no `stroke-dashoffset` animation. The card's own entrance
  carries the motion.

**Reduced motion**, verified headless at beat 06: Lenis absent, all 57 words of
the draft at full opacity without any animation having run, every parsed field
present, the card resting on its back face, zero errors. The story arrives as
state. The rail token also stops travelling under reduced motion and steps
between stage positions instead.

**Mobile** (390×844): zero horizontal overflow, rail correctly hidden, all six
beats present, zero errors.

Production build passes (`vite build`, 30.8s). The >500kB chunk warning is
pre-existing and unrelated (Firebase).

---

## Flag for a follow-up pass

1. **The stats strip numbers are unverified claims.** "12,000+ contacts parsed",
   "40,000+ follow-ups kept on time", "3.4× more replies than cold sends" were
   inherited from an earlier pass. For a product at this stage they're very
   likely not true, and they now sit directly under a story that names you
   personally — which raises the cost of being wrong. I moved the strip out of
   the narrative but did not touch the numbers, because that's your call.
   Recommend replacing with something real or cutting the section.
2. **`devarshi@cirqle.app` and `cirqle.app/devarshi` are invented.** So are
   "Ross Founders Night", "Tuesday", the health score of 88 and "decays to Warm
   in 9 days". They read as real specifics on a page that names a real person.
   Swap in whatever is actually true before this ships.
3. **Everything was verified headless.** The measurements are solid, but nobody
   has yet felt this on a trackpad on a real GPU-composited desktop browser. The
   live-Chrome attempt was blocked by a minimised window freezing rAF. Worth
   fifteen seconds of your own scrolling before shipping — particularly the
   Lenis `duration: 1.05`, which is a taste value I picked, not a measured one.
4. **No visible thread below `xl`.** The beats still read in order and each
   still carries its numbered eyebrow, but the continuity device — the main
   point of the pass — is desktop-only. A thin top progress bar or a per-section
   numbered marker would carry it down to tablet and phone.
5. **Beat 04's node placement is hand-tuned to the current `viewBox`.** The
   story node is positioned relative to the Venture hub with roughly 120 units
   of clear space reserved for the callout in a 760-wide viewBox. Changing
   `HUBS` or the viewBox will need that re-checked; there is no layout logic
   protecting it.
6. **Beat 03 has four scripted answers.** Free typing that misses every keyword
   gets an honest fallback, but the more questions there are, the less often
   anyone sees it. Cheap to extend — it's one array.
7. **`ScrollProbe` was left in.** It renders `null` without `?scrollprobe=1` and
   costs nothing, and it is the instrument that makes "is the scroll actually
   healthy" answerable in ten seconds. Delete it if you'd rather not ship the
   code path.
8. **`LandingLayout`'s header still uses its own native scroll listener.**
   Deliberate — it's a boolean threshold for the header border, not an
   animation, and the layout is shared with the auth pages where Lenis isn't
   mounted. Noting it so it isn't mistaken later for the thing Part 1 warned
   about.
9. **The 100svh section rhythm leaves a lot of vertical air** on tall desktop
   viewports now that snapping no longer justifies it. Worth a look at whether
   beats should be content-height with generous padding instead.
