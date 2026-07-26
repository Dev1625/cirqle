import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Horizontally scrollable container that fades its leading/trailing edge
 * whenever there's more content off-screen — the visual cue for "this scrolls"
 * that wide tables were missing, done as a mask so content reads as continuing
 * past the frame rather than being hard-clipped.
 */
export function ScrollFadeX({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setEdges({
      left: el.scrollLeft > 1,
      right: el.scrollLeft < maxScroll - 1,
    });
  }, []);

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [update]);

  const fadeSize = '48px';
  const mask =
    edges.left && edges.right
      ? `linear-gradient(to right, transparent, black ${fadeSize}, black calc(100% - ${fadeSize}), transparent)`
      : edges.right
      ? `linear-gradient(to right, black calc(100% - ${fadeSize}), transparent)`
      : edges.left
      ? `linear-gradient(to right, transparent, black ${fadeSize})`
      : undefined;

  return (
    <div
      ref={ref}
      onScroll={update}
      className={`overflow-x-auto ${className}`}
      style={mask ? { WebkitMaskImage: mask, maskImage: mask } : undefined}
    >
      {children}
    </div>
  );
}
