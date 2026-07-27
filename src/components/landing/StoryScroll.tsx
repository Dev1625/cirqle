import React from 'react';
import Lenis from 'lenis';
import { useMotionValue, useReducedMotion, type MotionValue } from 'motion/react';

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
   interpolation; it just no longer listens to the browser.
   ──────────────────────────────────────────────────────────────────────── */

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

type StoryScrollValue = {
  /** 0 → 1 across the whole page. Written only by the active scroll driver. */
  progress: MotionValue<number>;
  /**
   * Normalised `progress` values at which each registered story stage sits
   * centred in the viewport. Measured, not hardcoded, so the keyframe ranges
   * survive copy edits and responsive reflow.
   */
  stops: number[];
  registerStage: (index: number, el: HTMLElement | null) => void;
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
 * `useTransform` requires a strictly increasing input range. Measured stops
 * can collide when two stages are short and the viewport is tall, so nudge
 * any duplicate up by a hair rather than handing Framer a flat segment.
 */
function strictlyIncreasing(values: number[]) {
  const out: number[] = [];
  values.forEach((v, i) => {
    const prev = i > 0 ? out[i - 1] : -1;
    out.push(v > prev ? v : prev + 1e-4);
  });
  return out;
}

const sameStops = (a: number[], b: number[]) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-4);

export function StoryScrollProvider({ children }: { children: React.ReactNode }) {
  const reduced = !!useReducedMotion();
  const progress = useMotionValue(0);
  const stages = React.useRef(new Map<number, HTMLElement>());
  const [stops, setStops] = React.useState<number[]>([]);

  const registerStage = React.useCallback((index: number, el: HTMLElement | null) => {
    if (el) stages.current.set(index, el);
    else stages.current.delete(index);
  }, []);

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

  /* ── Stage measurement ─────────────────────────────────────────────── */
  React.useEffect(() => {
    const measure = () => {
      const limit = document.documentElement.scrollHeight - window.innerHeight;
      if (limit <= 0) return;

      const ordered = [...stages.current.entries()].sort((a, b) => a[0] - b[0]);
      const next = strictlyIncreasing(
        ordered.map(([, el]) => {
          const rect = el.getBoundingClientRect();
          const centre = rect.top + window.scrollY + rect.height / 2 - window.innerHeight / 2;
          return clamp01(centre / limit);
        })
      );

      // Equality-guarded: this runs from a ResizeObserver on <body>, and an
      // unconditional setState there is a render loop.
      setStops((prev) => (sameStops(prev, next) ? prev : next));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const value = React.useMemo<StoryScrollValue>(
    () => ({ progress, stops, registerStage, reduced }),
    [progress, stops, registerStage, reduced]
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
