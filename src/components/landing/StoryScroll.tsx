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

export type AnchorPoint = { stage: number; order: number; x: number; y: number };

type StoryScrollValue = {
  /** 0 → 1 across the whole page. Written only by the active scroll driver. */
  progress: MotionValue<number>;
  /**
   * Normalised `progress` values at which each registered stage sits centred.
   * Measured, not hardcoded, so the keyframe ranges survive copy edits and
   * responsive reflow.
   */
  stops: number[];
  /** Page-space landing points, sorted by stage then order within a stage. */
  anchors: AnchorPoint[];
  /** Scrollable distance in px — the conversion factor between the two spaces. */
  limit: number;
  viewportH: number;
  registerStage: (index: number, el: HTMLElement | null) => void;
  registerAnchor: (stage: number, order: number, el: HTMLElement | null) => void;
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
      Math.abs(p.x - b[i].x) < 0.5 &&
      Math.abs(p.y - b[i].y) < 0.5
  );

export function StoryScrollProvider({ children }: { children: React.ReactNode }) {
  const reduced = !!useReducedMotion();
  const progress = useMotionValue(0);

  const stageEls = React.useRef(new Map<number, HTMLElement>());
  const anchorEls = React.useRef(
    new Map<string, { stage: number; order: number; el: HTMLElement }>()
  );

  const [stops, setStops] = React.useState<number[]>([]);
  const [anchors, setAnchors] = React.useState<AnchorPoint[]>([]);
  const [metrics, setMetrics] = React.useState({ limit: 0, viewportH: 0 });

  const registerStage = React.useCallback((index: number, el: HTMLElement | null) => {
    if (el) stageEls.current.set(index, el);
    else stageEls.current.delete(index);
  }, []);

  const registerAnchor = React.useCallback(
    (stage: number, order: number, el: HTMLElement | null) => {
      const key = `${stage}:${order}`;
      if (el) anchorEls.current.set(key, { stage, order, el });
      else anchorEls.current.delete(key);
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

      const orderedStages = [...stageEls.current.entries()].sort((a, b) => a[0] - b[0]);
      const nextStops = strictlyIncreasing(
        orderedStages.map(([, el]) => {
          const rect = el.getBoundingClientRect();
          const centre = rect.top + scrollY + rect.height / 2 - window.innerHeight / 2;
          return clamp01(centre / limit);
        })
      );

      const nextAnchors = [...anchorEls.current.values()]
        .sort((a, b) => a.stage - b.stage || a.order - b.order)
        .map(({ stage, order, el }) => {
          const { x, y } = layoutPosition(el);
          // Page space, not viewport space. The token converts to viewport
          // coordinates only at the final step (see StoryToken), which is
          // what keeps it welded to a target that scrolls with the page.
          return { stage, order, x, y };
        });

      // Equality-guarded: this runs from a ResizeObserver on <body>, and an
      // unconditional setState there is a render loop.
      setStops((prev) => (sameStops(prev, nextStops) ? prev : nextStops));
      setAnchors((prev) => (sameAnchors(prev, nextAnchors) ? prev : nextAnchors));
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
      limit: metrics.limit,
      viewportH: metrics.viewportH,
      registerStage,
      registerAnchor,
      reduced,
    }),
    [progress, stops, anchors, metrics, registerStage, registerAnchor, reduced]
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
export function useStoryAnchor(stage: number, order = 0) {
  const { registerAnchor } = useStoryScroll();
  return React.useCallback(
    (el: HTMLElement | null) => registerAnchor(stage, order, el),
    [registerAnchor, stage, order]
  );
}

/** Even spacing, used until the real sections have been measured. */
const FALLBACK_STOPS = STORY_STAGES.map((_, i) => (i + 0.5) / STORY_STAGES.length);

export function useStoryStops() {
  const { stops } = useStoryScroll();
  return stops.length === STORY_STAGES.length ? stops : FALLBACK_STOPS;
}

/**
 * The scroll window a beat's own animations play across.
 *
 * Deliberately NOT the section's whole journey through the viewport. That
 * range spends most of its length with the section barely visible at the top
 * or bottom edge, so anything mapped across it has already finished by the
 * time the section is centred and readable — the visitor arrives to find it
 * done rather than watching it happen.
 *
 * Instead this is a tight window around the section's measured centre stop,
 * sized as a fraction of the *viewport* rather than of the page, so a beat
 * plays out while it is genuinely the thing on screen. `spread` is in
 * viewport heights either side of centre.
 */
export function useSectionRange(index: number, spread = 0.4): [number, number] {
  const { limit, viewportH } = useStoryScroll();
  const stops = useStoryStops();
  const centre = stops[index];
  const half = limit > 0 ? (spread * viewportH) / limit : 0.04;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
