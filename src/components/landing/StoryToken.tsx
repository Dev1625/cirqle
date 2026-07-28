import React from 'react';
import { motion, useTransform, type MotionValue } from 'motion/react';
import { useStoryScroll, useStoryStops, strictlyIncreasing, type AnchorPoint } from './StoryScroll';
import { STORY_STAGES, type StoryStage } from './storyStages';

/* ────────────────────────────────────────────────────────────────────────
   The narrative token.

   One object travels the whole story, and it is the same object in every
   beat — that is what makes six sections read as one story rather than six
   features. It does not morph: an NFC ripple path-interpolated into a graph
   node is the kind of thing that looks clever in a spec and cheap on screen.
   Continuity is carried by position and scale, which track continuously,
   while the stage-specific glyph inside the ring crossfades.

   What changed in the revision pass: the token used to travel a fixed rail
   in the left gutter, deliberately kept clear of the content. It now flies
   to the real visual anchor of each beat — the card, the contact panel, the
   ask bar, a node inside the graph, the queue row, the email — and lands on
   it.

   The mechanic that makes that possible is interpolating in **page space**
   and converting to viewport space once, at the end:

       viewportY = interpolate(anchorPageYs) − progress × scrollLimit

   Interpolating viewport positions directly would be wrong, because the
   target is itself scrolling: the token would cut a straight line across
   the screen while the thing it is supposed to be landing on slides out
   from under it. In page space the anchors are stationary, so a segment
   that holds one anchor's page position holds the token *welded* to that
   element while the page scrolls past.

   Everything here animates transform and opacity only.
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Lead-in before the token starts working a beat, as a share of that beat's
 * pinned stretch. "Give it a second" — the token used to begin moving the
 * instant a beat's window opened, which read as it reacting to the section
 * arriving rather than to you having arrived.
 */
const LEAD_IN = 0.12;
/** Matching tail, so it has left before the pin releases. */
const TAIL = 0.06;
/** A hop's share of a beat, against an anchor's `weight` for its park. */
const HOP_WEIGHT = 1;

type Keyframes = {
  times: number[];
  /** Index into `anchors` for each keyframe; positions are solved live. */
  idx: number[];
  /** Visibility keyframes, built alongside the path from the same segments. */
  visTimes: number[];
  visValues: number[];
} | null;

/** Which segment of an ascending `times` array `at` falls in, and how far. */
function segmentAt(at: number, times: number[]) {
  const last = times.length - 1;
  if (at <= times[0]) return { a: 0, b: 0, t: 0 };
  if (at >= times[last]) return { a: last, b: last, t: 0 };
  for (let i = 1; i <= last; i += 1) {
    if (at <= times[i]) {
      const span = times[i] - times[i - 1];
      return { a: i - 1, b: i, t: span > 0 ? (at - times[i - 1]) / span : 0 };
    }
  }
  return { a: last, b: last, t: 0 };
}

/**
 * Where an anchor actually is on screen, given the current scroll.
 *
 * Its stage is `position: sticky`, so its rendered position is not its layout
 * position: while the beat is pinned the stage sits at the top of the
 * viewport no matter how far the page has scrolled. This resolves the sticky
 * rule directly — natural position until the section's top reaches the
 * viewport top, held at 0 while there is section left underneath, then
 * carried up as the section runs out.
 *
 * Solving it here rather than measuring it is what keeps the token welded to
 * its target: a measured rect would be one frame stale, and this is exact.
 */
function anchorViewportY(a: AnchorPoint, scrollY: number) {
  const natural = a.sectionTop - scrollY;
  const floor = a.sectionTop + a.sectionH - a.stageH - scrollY;
  const stageTop = Math.min(Math.max(0, natural), floor);
  return stageTop + a.stageOffsetY;
}

export function StoryToken() {
  const { progress, anchors, pins, limit, reduced } = useStoryScroll();
  const stops = useStoryStops();

  /**
   * Builds the token's path: for every beat, the anchors it must visit and
   * when. A beat with one anchor parks on it across its whole window; a beat
   * with several (beat 04 travels a graph branch) visits them in order,
   * spread evenly across the same window.
   */
  const frames: Keyframes = React.useMemo(() => {
    if (!limit || anchors.length === 0) return null;

    const times: number[] = [];
    const idx: number[] = [];
    const visTimes: number[] = [];
    const visValues: number[] = [];
    const vis = (t: number, v: number) => {
      visTimes.push(t);
      visValues.push(v);
    };

    for (let stage = 0; stage < STORY_STAGES.length; stage += 1) {
      const own = anchors.filter((a) => a.stage === stage);
      if (own.length === 0) return null; // incomplete measurement — draw nothing

      /* The token works the same pinned stretch the beat's own animation
         does, rather than a window measured out from the section's centre.
         Before the pin existed those were different things and the token
         could be mid-journey while the beat had not started; now there is
         one answer to "when is this beat happening" and everything uses it. */
      const pin = pins[stage];
      if (!pin || pin.end <= pin.start) return null;
      const pinSpan = (pin.end - pin.start) / limit;
      const from = pin.start / limit + pinSpan * LEAD_IN;
      const to = pin.end / limit - pinSpan * TAIL;
      const span = to - from;

      /* A beat is no longer one park. It is park → hop → park → hop → park,
         so the token walks between the things a beat is actually about — the
         chips, then the Ask button, then the answer — instead of sitting on
         one spot while highlights appear elsewhere. Seeing it move to a
         control is what tells you to use that control. */
      const totalWeight =
        own.reduce((sum, a) => sum + a.weight, 0) + HOP_WEIGHT * (own.length - 1);

      let cursor = from;
      own.forEach((a, j) => {
        const parkW = (a.weight / totalWeight) * span;
        const t0 = cursor;
        const t1 = cursor + parkW;

        // Position: two keyframes on the same anchor = parked for that stretch.
        const flat = anchors.indexOf(a);
        times.push(t0, t1);
        idx.push(flat, flat);

        const firstOfPage = stage === 0 && j === 0;
        const lastOfPage = stage === STORY_STAGES.length - 1 && j === own.length - 1;
        const silentIn = a.silent;
        const silentOut = own[j + 1]?.silent ?? false;

        if (firstOfPage) {
          /* Beat 01 forms late, and "late" is a specific number: the card's
             turn runs to roughly three-quarters of this window, so forming
             any earlier puts the token on screen mid-rotation. */
          vis(t0, 0);
          vis(t0 + parkW * 0.76, 0);
          vis(t0 + parkW * 0.9, 1);
          vis(t1, 1);
        } else {
          if (silentIn) {
            // Materialise at the destination rather than be seen crossing.
            vis(t0, 0);
            vis(t0 + parkW * 0.06, 0);
            vis(t0 + parkW * 0.2, 1);
          } else {
            vis(t0, 1);
          }

          /* Heavy stops dissolve mid-park so the beat's own highlight owns
             the moment; light stops are waypoints and stay visible. */
          if (a.weight >= 1.5) {
            vis(t0 + parkW * 0.42, 1);
            vis(t0 + parkW * 0.6, 0);
            vis(t1 - parkW * 0.2, 0);
          }

          vis(t1, lastOfPage || silentOut ? 0 : 1);
        }

        cursor = t1;

        if (j < own.length - 1) {
          const hopW = (HOP_WEIGHT / totalWeight) * span;
          if (own[j + 1].silent) {
            vis(cursor, 0);
            vis(cursor + hopW, 0);
          }
          cursor += hopW;
        }
      });
    }

    return {
      times: strictlyIncreasing(times),
      idx,
      visTimes: strictlyIncreasing(visTimes),
      visValues,
    };
  }, [anchors, pins, stops, limit]);

  // Hooks must run unconditionally, so fall back to a harmless 2-point range
  // when measurement is incomplete and hide the token with opacity instead.
  const safe = frames ?? { times: [0, 1], idx: [0, 0] };


  /* One transformer per axis, both reading `progress` directly, and both
     resolving the anchor's on-screen position live rather than interpolating
     baked coordinates. Positions cannot be baked any more: the stages are
     pinned, so where an anchor *is* depends on the current scroll.

     Chaining these through a second multi-input `useTransform` does not work
     — a multi-input transform fed a derived MotionValue reads a stale
     snapshot of it, which once left the token's y frozen on its first
     keyframe for the entire page. One transformer each, over the one source
     of truth. */
  const solve = React.useCallback(
    (p: number, axis: 'x' | 'y') => {
      if (!frames || anchors.length === 0) return 0;

      // Reduced motion does not travel: snap to the nearest beat first, so
      // the token jumps between stops as a state change, not a slide.
      let at = p;
      if (reduced) {
        let nearest = stops[0];
        stops.forEach((sv) => {
          if (p >= sv - 1e-9) nearest = sv;
        });
        at = nearest;
      }

      const seg = segmentAt(at, safe.times);
      const A = anchors[safe.idx[seg.a]];
      const B = anchors[safe.idx[seg.b]];
      if (!A || !B) return 0;

      const scrollY = p * limit;
      if (axis === 'x') return A.x + (B.x - A.x) * seg.t;
      const ay = anchorViewportY(A, scrollY);
      const by = anchorViewportY(B, scrollY);
      return ay + (by - ay) * seg.t;
    },
    [frames, anchors, reduced, stops, safe.times, safe.idx, limit]
  );

  const x = useTransform(progress, (p) => solve(p, 'x'));
  const y = useTransform(progress, (p) => solve(p, 'y'));

  /* Emphasis: a genuine multi-keyframe range built from the measured stops —
     full size on arrival at each beat, eased back down while travelling. */
  const scaleInput: number[] = [0];
  const scaleOutput: number[] = [0.86];
  stops.forEach((s, i) => {
    scaleInput.push(s);
    scaleOutput.push(1);
    const next = stops[i + 1];
    if (next !== undefined) {
      scaleInput.push((s + next) / 2);
      scaleOutput.push(0.86);
    }
  });
  scaleInput.push(1);
  scaleOutput.push(0.86);
  const scale = useTransform(progress, strictlyIncreasing(scaleInput), scaleOutput);

  /* ── Visibility ─────────────────────────────────────────────────────
     Built segment by segment above rather than as a separate rhythm here,
     because a beat now has several stops and each one needs its own
     arrive / dissolve / re-form decision. The token is the connective
     tissue: visible while it travels and as it lands, out of the way while
     a highlight does the talking. */
  const opacity = useTransform(
    progress,
    frames ? frames.visTimes : [0, 1],
    frames ? frames.visValues : [0, 0]
  );

  // Under ?scrollprobe the built path and the live values are published for
  // inspection. The token is the one thing on this page whose failure mode is
  // "silently lands somewhere wrong", which a screenshot alone cannot explain.
  React.useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('scrollprobe')) return;
    (window as unknown as { __storyToken?: unknown }).__storyToken = {
      frames,
      anchors,
      stops,
      limit,
      pins,
      live: () => ({
        progress: progress.get(),
        // x and y are the only derived values now.

        x: x.get(),
        y: y.get(),
      }),
    };
  }, [frames, anchors, pins, stops, limit, progress, x, y]);

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-30 hidden xl:block"
      style={{ x, y, opacity }}
    >
      <div className="-translate-x-1/2 -translate-y-1/2">
        <motion.span
          className="relative flex h-11 w-11 items-center justify-center rounded-full border border-ink/15 bg-paper"
          style={{ scale, boxShadow: 'var(--shadow-float)' }}
        >
          {/* The recurring ring — the brand mark, and the one shape that
              never changes across the six beats. */}
          <span className="absolute inset-[3px] rounded-full border border-brand/45" />
          {STORY_STAGES.map((stage, i) => (
            <StageGlyph key={stage.key} stage={stage} progress={progress} stops={stops} index={i} />
          ))}
        </motion.span>

        {/* Label to the *left* of the ring, right-aligned. Every anchor is
            placed just outside the top-left corner of the thing it marks, so
            left is the one direction that reliably points away from content —
            below the ring puts the label across the panel it just landed on,
            and right puts it straight through the middle of it. */}
        <span className="pointer-events-none absolute right-[34px] top-1/2 block h-8 w-[132px] -translate-y-1/2">
          {STORY_STAGES.map((stage, i) => (
            <StageLabel key={stage.key} stage={stage} progress={progress} stops={stops} index={i} />
          ))}
        </span>
      </div>
    </motion.div>
  );
}

/**
 * Crossfade window for one stage: fully present at its own stop, gone by the
 * midpoint to either neighbour. The first and last hold out to the ends of
 * the page so the token is never blank.
 */
function crossfade(stops: number[], i: number) {
  const last = stops.length - 1;
  const from = i === 0 ? 0 : (stops[i - 1] + stops[i]) / 2;
  const to = i === last ? 1 : (stops[i] + stops[i + 1]) / 2;
  return {
    input: strictlyIncreasing([from, stops[i], to]),
    output: [i === 0 ? 1 : 0, 1, i === last ? 1 : 0],
  };
}

function StageGlyph({
  stage,
  progress,
  stops,
  index,
}: {
  stage: StoryStage;
  progress: MotionValue<number>;
  stops: number[];
  index: number;
}) {
  const range = crossfade(stops, index);
  const opacity = useTransform(progress, range.input, range.output);
  const Icon = stage.icon;
  return (
    <motion.span className="absolute inset-0 flex items-center justify-center" style={{ opacity }}>
      <Icon size={16} className="text-brand" />
    </motion.span>
  );
}

function StageLabel({
  stage,
  progress,
  stops,
  index,
}: {
  stage: StoryStage;
  progress: MotionValue<number>;
  stops: number[];
  index: number;
}) {
  const range = crossfade(stops, index);
  const opacity = useTransform(progress, range.input, range.output);
  return (
    <motion.span
      className="absolute inset-0 flex flex-col items-end justify-center rounded-card bg-paper/80 px-2 py-1 text-right"
      style={{ opacity }}
    >
      <span className="font-mono text-[9px] uppercase tracking-[0.28em] text-muted">
        {stage.index}
      </span>
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-ink">
        {stage.label}
      </span>
    </motion.span>
  );
}
