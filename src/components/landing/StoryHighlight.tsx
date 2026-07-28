import React from 'react';
import { motion, useTransform, type MotionValue } from 'motion/react';
import { useStoryScroll } from './StoryScroll';

/* ────────────────────────────────────────────────────────────────────────
   The shared highlight primitive.

   The token used to arrive next to a beat and crossfade its own icon while
   the section's content filled in beside it, passively. The story is told
   better by the real UI reacting: the token dissolves on arrival and hands
   off to oxblood outlines and pulses applied to the section's *actual*
   elements — the text box being read, the Ask button waiting for a click,
   the one result card that is the person we have been following.

   Two components, used by every beat. Nothing here is bespoke per section.

   Positioning is by containment, not by measurement. Each primitive renders
   `absolute inset-…` inside the element it decorates, so it is correct at
   every breakpoint, survives reflow, and needs no registry — and it tracks
   targets that move on their own, which matters for the queue card that
   lives inside a continuously translating marquee. Measuring those in page
   space (the approach the travelling token needs, because it is `fixed` and
   has to cross between sections) would have to re-measure every frame to
   stay glued to a moving card. Containment gets it for free.

   Both are driven by a `show` MotionValue derived from the beat's scroll
   scrub, so they draw on as you scroll down and retract as you scroll back.
   Neither is ever triggered.
   ──────────────────────────────────────────────────────────────────────── */

/**
 * An oxblood rounded-rect stroke that draws itself around its parent.
 *
 * Uses the same `stroke-dashoffset` sweep already justified for the health
 * ring — the one knowing exception to the transform/opacity rule on this
 * page. It is a paint property: no layout, no reflow, and here it is drawing
 * a single stroked rect. `pathLength={1}` normalises the perimeter so the
 * dash maths is the same whatever size the target is.
 */
export function StoryOutline({
  show,
  inset = -6,
  radius = 11,
  width = 1.5,
  className = '',
}: {
  show: MotionValue<number>;
  inset?: number;
  radius?: number;
  width?: number;
  className?: string;
}) {
  const { reduced } = useStoryScroll();
  const dashoffset = useTransform(show, [0, 1], [1, 0]);

  /* Sized with an explicit width/height, not by pinning all four edges.
     `<svg>` is a replaced element with an intrinsic size, so an absolutely
     positioned one with `height: auto` takes that intrinsic height and
     ignores `bottom` entirely — every outline on the page rendered at SVG's
     default 150px regardless of what it was wrapping. It looked plausible on
     a short box and obviously wrong on a tall one, which is precisely the
     class of bug the numbers could not see.

     The stroke sits centred on the rect's edge, so half of it falls outside
     the box — overflow-visible keeps that half painted. */
  const grow = `calc(100% + ${-2 * inset}px)`;
  return (
    <svg
      aria-hidden="true"
      data-story-outline=""
      className={`pointer-events-none absolute overflow-visible ${className}`}
      style={{ top: inset, left: inset, width: grow, height: grow }}
    >
      <motion.rect
        x="0"
        y="0"
        width="100%"
        height="100%"
        rx={radius}
        ry={radius}
        fill="none"
        stroke="#7A2331"
        strokeWidth={width}
        pathLength={1}
        strokeDasharray={1}
        style={{ strokeDashoffset: reduced ? 0 : dashoffset, opacity: show }}
      />
    </svg>
  );
}

/**
 * A restrained breathing ring, for "look at this one" moments — the Reading
 * label, the Ask button, the Send control.
 *
 * The breathing is an ambient loop rather than a scrubbed value, because a
 * scrubbed pulse only pulses while the visitor happens to be moving. What
 * *is* scrubbed is whether it exists at all, so scrolling back still takes
 * it away. Loop is dropped entirely under reduced motion; the static ring
 * still marks the element.
 */
export function StoryPulse({
  show,
  inset = -8,
  radius = 999,
  className = '',
}: {
  show: MotionValue<number>;
  inset?: number;
  radius?: number;
  className?: string;
}) {
  const { reduced } = useStoryScroll();
  return (
    <motion.span
      aria-hidden="true"
      data-story-pulse=""
      className={`pointer-events-none absolute ${className}`}
      style={{ top: inset, right: inset, bottom: inset, left: inset, opacity: show }}
    >
      <motion.span
        className="absolute inset-0 border border-brand/70"
        style={{ borderRadius: radius }}
        animate={reduced ? { opacity: 0.6 } : { opacity: [0.65, 0.25, 0.65], scale: [1, 1.045, 1] }}
        transition={reduced ? { duration: 0 } : { duration: 2.1, repeat: Infinity, ease: 'easeInOut' }}
      />
    </motion.span>
  );
}

/**
 * A slice of a beat's scrub, as a 0 → 1 value with a hold in the middle.
 *
 * `[in0, in1]` draws it on and `[out0, out1]` takes it away again; omit the
 * out pair and it stays for the rest of the beat. This is the only timing
 * vocabulary the beats need, which is what keeps the choreography readable
 * as a list of windows rather than a pile of one-off transforms.
 */
export function useCue(
  scrub: MotionValue<number>,
  [in0, in1]: [number, number],
  out?: [number, number]
) {
  const input = out ? [in0, in1, out[0], out[1]] : [in0, in1];
  const output = out ? [0, 1, 1, 0] : [0, 1];
  return useTransform(scrub, input, output);
}
