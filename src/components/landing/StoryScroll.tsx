import React from 'react';
import Lenis from 'lenis';
import { useMotionValue, useReducedMotion, type MotionValue } from 'motion/react';
import { STORY_STAGES } from './storyStages';

/* ────────────────────────────────────────────────────────────────────────
   One scroll loop, one source of truth.

   The landing page used to run CSS `scroll-snap`, which is gone: the story
   is continuous, so the scroll is continuous. Smoothing comes from Lenis
   instead — it drives the *real* document scroll (it calls scrollTo under
   the hood rather than transforming a fake container), so the scrollbar,
   anchor links, keyboard paging, find-in-page and screen readers all keep
   working exactly as they did.

   The important part is what this file deliberately does NOT do: it never
   lets Framer Motion attach its own native `scroll` listener. Framer's
   `useScroll` reads scroll position from the browser's scroll event, while
   Lenis writes scroll position from inside a requestAnimationFrame loop.
   Wire both up independently and they sample the same scroll at two
   different moments in the frame — the classic Lenis + Framer symptom,
   where scroll-linked elements lag or judder a frame behind the content
   they're supposed to be pinned to.

   So there is exactly one writer: Lenis's own `scroll` event feeds the
   `progress` MotionValue below, and every scroll-linked animation on the
   page reads that value through `useTransform`. Framer still does all the
   interpolation; it just no longer listens.

   This file measures two things for the story on top of that:

   - **stops** — where each beat sits, centred, in whole-page progress terms.
   - **anchors** — the *page-space* coordinates of the specific element in
     each beat the narrative token should fly to and land on. Page space
     rather than viewport space matters: the token interpolates between
     anchors in page coordinates and only converts to viewport coordinates
     at the very last step, which is what lets it stay pinned to a target
     that is itself scrolling.
   ──────────────────────────────────────────────────────────────────────── */

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export type AnchorPoint = {
  stage: number;
  order: number;
  x: number;
  /** Offset from the top of the sticky stage this anchor lives in. */
  stageOffsetY: number;
  /** Geometry of the pinned section, so the token can solve sticky itself. */
  sectionTop: number;
  sectionH: number;
  stageH: number;
  /** How long the token parks here, relative to the beat's other stops. */
  weight: number;
  /** The hop *into* this anchor is not shown (beat 04 crosses unseen). */
  silent: boolean;
};

type StoryScrollValue = {
  /** 0 → 1 across the whole page. Written only by the active scroll driver. */
  progress: MotionValue<number>;
  /**
   * Normalised `progress` values at which each registered stage sits centred.
   * Measured, not hardcoded, so the keyframe ranges survive copy edits and
   * responsive reflow.
   */
  stops: number[];
  /** Landing points, sorted by stage then order within a stage. */
  anchors: AnchorPoint[];
  /** Each beat's pinned scroll range, in page pixels. */
  pins: Array<{ start: number; end: number }>;
  /** Scrollable distance in px — the conversion factor between the two spaces. */
  limit: number;
  viewportH: number;
  registerStage: (index: number, el: HTMLElement | null) => void;
  registerAnchor: (
    stage: number,
    order: number,
    el: HTMLElement | null,
    opts?: { weight?: number; silent?: boolean }
  ) => void;
  /** The visitor asked for reduced motion — Lenis is bypassed entirely. */
  reduced: boolean;
};

const StoryScrollContext = React.createContext<StoryScrollValue | null>(null);

/** Reads whole-page scroll progress straight from the document. */
function nativeProgress() {
  const limit = document.documentElement.scrollHeight - window.innerHeight;
  return limit > 0 ? clamp01(window.scrollY / limit) : 0;
}

/**
 * `useTransform` requires a strictly increasing input range. Measured values
 * can collide when two beats are short and the viewport is tall, so nudge any
 * duplicate up by a hair rather than handing Framer a flat segment.
 */
export function strictlyIncreasing(values: number[]) {
  const out: number[] = [];
  values.forEach((v, i) => {
    const prev = i > 0 ? out[i - 1] : -Infinity;
    out.push(v > prev ? v : prev + 1e-5);
  });
  return out;
}

/**
 * An element's position in page coordinates, walking the offsetParent chain
 * rather than reading getBoundingClientRect.
 *
 * This is the difference between an anchor that lands and one that misses by
 * a consistent margin. Every beat's visual wraps in a `StoryReveal`, which
 * holds its content translated 18–24px down until it scrolls into view. A
 * rect-based measurement taken before that reveal fires records the anchor
 * where the *animation* had it, not where layout puts it, and the token then
 * lands exactly that far off in every single beat.
 *
 * offsetLeft/offsetTop are layout values. Transforms do not touch them, so
 * this reads the resting position whether the reveal has played or not.
 */
function layoutPosition(el: HTMLElement) {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

const sameStops = (a: number[], b: number[]) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-4);

const sameAnchors = (a: AnchorPoint[], b: AnchorPoint[]) =>
  a.length === b.length &&
  a.every(
    (p, i) =>
      p.stage === b[i].stage &&
      p.order === b[i].order &&
      p.weight === b[i].weight &&
      p.silent === b[i].silent &&
      Math.abs(p.x - b[i].x) < 0.5 &&
      Math.abs(p.stageOffsetY - b[i].stageOffsetY) < 0.5 &&
      Math.abs(p.sectionTop - b[i].sectionTop) < 0.5
  );

export function StoryScrollProvider({ children }: { children: React.ReactNode }) {
  const reduced = !!useReducedMotion();
  const progress = useMotionValue(0);

  const stageEls = React.useRef(new Map<number, HTMLElement>());
  const anchorEls = React.useRef(
    new Map<
      string,
      { stage: number; order: number; el: HTMLElement; weight: number; silent: boolean }
    >()
  );

  const [stops, setStops] = React.useState<number[]>([]);
  const [anchors, setAnchors] = React.useState<AnchorPoint[]>([]);
  const [pins, setPins] = React.useState<Array<{ start: number; end: number }>>([]);
  const [metrics, setMetrics] = React.useState({ limit: 0, viewportH: 0 });

  const registerStage = React.useCallback((index: number, el: HTMLElement | null) => {
    if (el) stageEls.current.set(index, el);
    else stageEls.current.delete(index);
  }, []);

  const registerAnchor = React.useCallback(
    (
      stage: number,
      order: number,
      el: HTMLElement | null,
      opts?: { weight?: number; silent?: boolean }
    ) => {
      const key = `${stage}:${order}`;
      if (el) {
        anchorEls.current.set(key, {
          stage,
          order,
          el,
          weight: opts?.weight ?? 1,
          silent: opts?.silent ?? false,
        });
      } else {
        anchorEls.current.delete(key);
      }
    },
    []
  );

  /* ── The scroll driver ─────────────────────────────────────────────── */
  React.useEffect(() => {
    // Reduced motion: no smoothing library at all. Not a "gentler Lenis" —
    // a smoothing library's entire job is to animate scroll position, so the
    // honest reduced-motion answer is to not run one. Plain native scroll,
    // one passive listener, still feeding the same MotionValue so nothing
    // downstream has to branch.
    if (reduced) {
      const onScroll = () => progress.set(nativeProgress());
      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
      return () => window.removeEventListener('scroll', onScroll);
    }

    const lenis = new Lenis({
      duration: 1.05,
      // Lenis handles in-page anchors itself, so `#network`-style links keep
      // working and land smoothly instead of hard-jumping past the animation.
      anchors: true,
    });

    lenis.on('scroll', (instance: Lenis) => {
      progress.set(instance.limit > 0 ? clamp01(instance.scroll / instance.limit) : 0);
    });

    let frame = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    progress.set(nativeProgress());

    return () => {
      cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, [reduced, progress]);

  /* ── Measurement ───────────────────────────────────────────────────── */
  React.useEffect(() => {
    const measure = () => {
      const limit = document.documentElement.scrollHeight - window.innerHeight;
      if (limit <= 0) return;
      const scrollY = window.scrollY;
      const scrollX = window.scrollX;

      /* A beat's scroll range is the stretch over which its stage is pinned:
         from the section's top reaching the viewport top, to the section
         running out of room underneath it. That is exactly the span during
         which the content is held still in front of the reader, which is why
         it — and not the section's centre — is what the beat's animation is
         mapped onto. */
      const orderedStages = [...stageEls.current.entries()].sort((a, b) => a[0] - b[0]);
      const nextPins = orderedStages.map(([, el]) => {
        const stage = el.querySelector<HTMLElement>('.story-stage');
        const top = layoutPosition(el).y;
        const stageH = stage ? stage.offsetHeight : el.offsetHeight;
        return { start: top, end: top + Math.max(0, el.offsetHeight - stageH) };
      });
      const nextStops = strictlyIncreasing(
        nextPins.map((p) => clamp01((p.start + p.end) / 2 / limit))
      );

      const nextAnchors = [...anchorEls.current.values()]
        .sort((a, b) => a.stage - b.stage || a.order - b.order)
        .map(({ stage, order, el, weight, silent }) => {
          const section = el.closest<HTMLElement>('section');
          const stageEl = el.closest<HTMLElement>('.story-stage');
          const here = layoutPosition(el);
          const stageTop = stageEl ? layoutPosition(stageEl).y : here.y;
          return {
            stage,
            order,
            weight,
            silent,
            x: here.x,
            // Everything below is resolved against live scroll by the token,
            // because a pinned stage's rendered position is not its layout
            // position and only the token knows the current scroll.
            stageOffsetY: here.y - stageTop,
            sectionTop: section ? layoutPosition(section).y : here.y,
            sectionH: section ? section.offsetHeight : 0,
            stageH: stageEl ? stageEl.offsetHeight : 0,
          };
        });

      // Equality-guarded: this runs from a ResizeObserver on <body>, and an
      // unconditional setState there is a render loop.
      setStops((prev) => (sameStops(prev, nextStops) ? prev : nextStops));
      setAnchors((prev) => (sameAnchors(prev, nextAnchors) ? prev : nextAnchors));
      setPins((prev) =>
        prev.length === nextPins.length &&
        prev.every((p, i) => Math.abs(p.start - nextPins[i].start) < 0.5 && Math.abs(p.end - nextPins[i].end) < 0.5)
          ? prev
          : nextPins
      );
      setMetrics((prev) =>
        prev.limit === limit && prev.viewportH === window.innerHeight
          ? prev
          : { limit, viewportH: window.innerHeight }
      );
    };

    measure();
    // Two frames of settle: fonts and the graph SVG change section heights
    // after first paint, and an anchor measured before that is measured wrong.
    const raf = requestAnimationFrame(() => requestAnimationFrame(measure));

    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const value = React.useMemo<StoryScrollValue>(
    () => ({
      progress,
      stops,
      anchors,
      pins,
      limit: metrics.limit,
      viewportH: metrics.viewportH,
      registerStage,
      registerAnchor,
      reduced,
    }),
    [progress, stops, anchors, pins, metrics, registerStage, registerAnchor, reduced]
  );

  return <StoryScrollContext.Provider value={value}>{children}</StoryScrollContext.Provider>;
}

export function useStoryScroll() {
  const ctx = React.useContext(StoryScrollContext);
  if (!ctx) throw new Error('useStoryScroll must be used inside <StoryScrollProvider>');
  return ctx;
}

/**
 * Marks a section as story stage `index`. Returns a ref callback to spread
 * onto the section element; the provider measures it from there.
 */
export function useStoryStage(index: number) {
  const { registerStage } = useStoryScroll();
  return React.useCallback(
    (el: HTMLElement | null) => registerStage(index, el),
    [registerStage, index]
  );
}

/** Registers one landing point for the token inside a beat. */
export function useStoryAnchor(
  stage: number,
  order = 0,
  opts?: { weight?: number; silent?: boolean }
) {
  const { registerAnchor } = useStoryScroll();
  const weight = opts?.weight ?? 1;
  const silent = opts?.silent ?? false;
  return React.useCallback(
    (el: HTMLElement | null) => registerAnchor(stage, order, el, { weight, silent }),
    [registerAnchor, stage, order, weight, silent]
  );
}

/**
 * How much of a beat's pinned stretch is held back at each end, so nothing
 * important fires on the exact frame the pin engages or releases.
 */
export const SECTION_INSET = 0.06;

/** Even spacing, used until the real sections have been measured. */
const FALLBACK_STOPS = STORY_STAGES.map((_, i) => (i + 0.5) / STORY_STAGES.length);

export function useStoryStops() {
  const { stops } = useStoryScroll();
  return stops.length === STORY_STAGES.length ? stops : FALLBACK_STOPS;
}

/**
 * The scroll window a beat's own animations play across: the stretch over
 * which its stage is pinned, trimmed slightly at both ends.
 *
 * This used to be a fixed number of viewport heights either side of the
 * section's centre, and that was the root of a whole class of complaints —
 * the beat began while the section was still entering the bottom of the
 * screen and ended as it left the top, because a section only has a few
 * hundred pixels of scroll during which its content is properly framed. The
 * pin removes the problem rather than retiming around it: for the whole of
 * this range the content is held still, centred, in front of the reader.
 *
 * `inset` keeps the first and last moments of the beat clear of the handoff
 * at either end, so nothing important fires on the exact frame the pin
 * engages or releases.
 */
export function useSectionRange(index: number, inset = SECTION_INSET): [number, number] {
  const { pins, limit } = useStoryScroll();
  const stops = useStoryStops();
  const pin = pins[index];
  if (!pin || !limit || pin.end <= pin.start) {
    // Not pinned (short viewport, or not measured yet) — fall back to a
    // window around the measured centre so the beats still play.
    const half = 0.05;
    return [Math.max(0, stops[index] - half), Math.min(1, stops[index] + half)];
  }
  const span = pin.end - pin.start;
  return [
    clamp01((pin.start + span * inset) / limit),
    clamp01((pin.end - span * inset) / limit),
  ];
}
