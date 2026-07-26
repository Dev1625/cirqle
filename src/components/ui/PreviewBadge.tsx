import React from 'react';

/**
 * Marks a surface that is running on scaffolded/mock data rather than a live
 * external connection. The honesty rule for this pass: a demo must never imply
 * a feature is wired up when it isn't.
 *
 * Reads as machine-layer metadata (mono caps, muted) rather than a promotional
 * "Beta!" chip — it is a statement of fact about the data, not a badge of
 * honour. Sits on --color-accent, the passive sand wash, so it never competes
 * with the oxblood brand accent reserved for decision points.
 */
export function PreviewBadge({
  label = 'Preview',
  title = 'Running on sample data — not connected to a live account yet.',
  className = '',
}: {
  label?: string;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded-card bg-accent px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-subtle ${className}`}
    >
      {label}
    </span>
  );
}
