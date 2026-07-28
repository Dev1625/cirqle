import React from 'react';
import { useTransform, useMotionValueEvent } from 'motion/react';
import { useStoryScroll } from './StoryScroll';

/**
 * Part 1 checkpoint instrument. Renders nothing, and costs nothing, unless
 * the page is loaded with `?scrollprobe=1`.
 *
 * The thing that actually needs proving before any narrative work goes on
 * top of this scroll is that the Framer-interpolated value and the browser's
 * real scroll position agree *on the same frame*. Eyeballing smoothness
 * can't show that — a one-frame lag between the two looks fine in isolation
 * and only becomes visible as judder once something is pinned to it.
 *
 * So: take the shared progress value through a real `useTransform` (the same
 * path every scroll-linked animation on this page uses) and, on every
 * update, compare it against `window.scrollY` read fresh in the same tick.
 *
 * Samples go to `window.__scrollProbe` rather than React state — a setState
 * per frame would itself be a source of the jank being measured. The visible
 * readout repaints on a slow interval instead.
 */
type Sample = { t: number; derived: number; actual: number };

declare global {
  interface Window {
    __scrollProbe?: { samples: Sample[]; reset: () => void };
  }
}

export function ScrollProbe() {
  const enabled =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('scrollprobe');

  if (!enabled) return null;
  return <Probe />;
}

function Probe() {
  const { progress, stops, reduced } = useStoryScroll();

  // Deliberately routed through useTransform rather than read raw: this is
  // the code path the story animations use, so it is the one under test.
  const pageY = useTransform(
    progress,
    (p) => p * (document.documentElement.scrollHeight - window.innerHeight)
  );

  const samples = React.useRef<Sample[]>([]);
  const [, repaint] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    window.__scrollProbe = {
      samples: samples.current,
      reset: () => {
        samples.current.length = 0;
      },
    };
    const id = setInterval(repaint, 250);
    return () => {
      clearInterval(id);
      delete window.__scrollProbe;
    };
  }, []);

  useMotionValueEvent(pageY, 'change', (derived) => {
    samples.current.push({ t: performance.now(), derived, actual: window.scrollY });
    if (samples.current.length > 4000) samples.current.splice(0, 2000);
  });

  const recent = samples.current.slice(-120);
  const worst = recent.reduce((m, s) => Math.max(m, Math.abs(s.derived - s.actual)), 0);

  return (
    <div className="fixed bottom-4 left-4 z-[100] rounded-card border border-ink/25 bg-white/95 px-4 py-3 font-mono text-[10px] leading-relaxed text-ink">
      <div className="font-bold uppercase tracking-widest">scroll probe</div>
      <div>driver: {reduced ? 'native (reduced motion)' : 'lenis'}</div>
      <div>worst drift (last 120): {worst.toFixed(2)}px</div>
      <div>samples: {samples.current.length}</div>
      <div>stages measured: {stops.length}</div>
      <div className="max-w-[220px] break-words opacity-70">
        stops: {stops.map((s) => s.toFixed(3)).join(', ') || '—'}
      </div>
    </div>
  );
}
