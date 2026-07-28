import React from 'react';
import { motion, useTransform, type MotionValue } from 'motion/react';
import { useStoryScroll, useStoryStops, strictlyIncreasing } from './StoryScroll';
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

/** How much of the section's window the token spends inside the beat. */
const DWELL_VIEWPORTS = 0.68;
/** Ceiling as a share of the distance to the nearest beat — see below. */
const DWELL_GAP_SHARE = 0.46;
/** A hop's share of a beat, against an anchor's `weight` for its park. */
const HOP_WEIGHT = 1;

type Keyframes = {
  times: number[];
  xs: number[];
  ys: number[];
  /** Visibility keyframes, built alongside the path from the same segments. */
  visTimes: number[];
  visValues: number[];
} | null;

/** Piecewise-linear lookup, clamped at both ends. `times` must be ascending. */
function piecewise(at: number, times: number[], values: number[]) {
  if (times.length === 0) return 0;
  if (at <= times[0]) return values[0];
  const last = times.length - 1;
  if (at >= times[last]) return values[last];
  for (let i = 1; i <= last; i += 1) {
    if (at <= times[i]) {
      const span = times[i] - times[i - 1];
      const t = span > 0 ? (at - times[i - 1]) / span : 0;
      return values[i - 1] + (values[i] - values[i - 1]) * t;
    }
  }
  return values[last];
}

export function StoryToken() {
  const { progress, anchors, limit, viewportH, reduced } = useStoryScroll();
  const stops = useStoryStops();

  /**
   * Builds the token's path: for every beat, the anchors it must visit and
   * when. A beat with one anchor parks on it across its whole window; a beat
   * with several (beat 04 travels a graph branch) visits them in order,
   * spread evenly across the same window.
   */
  const frames: Keyframes = React.useMemo(() => {
    if (!limit || anchors.length === 0) return null;

    const desired = (DWELL_VIEWPORTS * viewportH) / limit;
    const times: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    const visTimes: number[] = [];
    const visValues: number[] = [];
    const vis = (t: number, v: number) => {
      visTimes.push(t);
      visValues.push(v);
    };

    for (let stage = 0; stage < STORY_STAGES.length; stage += 1) {
      const own = anchors.filter((a) => a.stage === stage);
      if (own.length === 0) return null; // incomplete measurement — draw nothing

      const centre = stops[stage];

      /* The window has to be clamped to its neighbours, not just taken from
         the viewport. Sized purely in viewport heights it is fine on a long
         page and far too wide on a short one — and when adjacent windows
         overlap, the combined keyframe list stops being monotonic.
         `strictlyIncreasing` then "fixes" it by squashing whole segments to
         1e-5, and the token interpolates against a mangled range and lands
         nowhere near its anchor. That is not hypothetical: tightening the
         section padding once shortened this page by a quarter and produced
         exactly that failure. */
      const gapBefore = stage > 0 ? centre - stops[stage - 1] : Infinity;
      const gapAfter = stage < stops.length - 1 ? stops[stage + 1] - centre : Infinity;
      const half = Math.min(desired, DWELL_GAP_SHARE * Math.min(gapBefore, gapAfter));
      const from = centre - half;
      const to = centre + half;
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

        // Position: two keyframes at the same point = parked for that stretch.
        times.push(t0, t1);
        xs.push(a.x, a.x);
        ys.push(a.y, a.y);

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
      xs,
      ys,
      visTimes: strictlyIncreasing(visTimes),
      visValues,
    };
  }, [anchors, stops, limit, viewportH]);

  // Hooks must run unconditionally, so fall back to a harmless 2-point range
  // when measurement is incomplete and hide the token with opacity instead.
  const safe = frames ?? { times: [0, 1], xs: [0, 0], ys: [0, 0] };


  /* One transformer per axis, both reading `progress` directly.

     The obvious shape for this is a chain — interpolate page position from
     progress, then subtract scroll in a second `useTransform([pageY,
     progress])`. That does not work: a multi-input transform fed a *derived*
     MotionValue reads a stale snapshot of it, so the token interpolated x
     correctly and left y frozen on the first keyframe. Doing the whole
     conversion in a single transformer over the single source of truth
     removes the chain and the staleness with it. */
  const path = React.useCallback(
    (p: number, values: number[]) => {
      // Reduced motion does not travel: snap to the nearest beat first, so
      // the token jumps between anchors as a state change, not a slide.
      let at = p;
      if (reduced) {
        let nearest = stops[0];
        stops.forEach((s) => {
          if (p >= s - 1e-9) nearest = s;
        });
        at = nearest;
      }
      return piecewise(at, safe.times, values);
    },
    [reduced, stops, safe.times]
  );

  const x = useTransform(progress, (p) => path(p, safe.xs));
  // Page space → viewport space. The one conversion, done inline.
  const y = useTransform(progress, (p) => path(p, safe.ys) - p * limit);

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
      viewportH,
      live: () => ({
        progress: progress.get(),
        // x and y are the only derived values now.

        x: x.get(),
        y: y.get(),
      }),
    };
  }, [frames, anchors, stops, limit, viewportH, progress, x, y]);

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
