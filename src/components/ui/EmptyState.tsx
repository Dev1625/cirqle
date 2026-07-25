import React from 'react';

/**
 * The house empty state: icon + one line of muted copy + a CTA, inside a
 * dashed frame. Documented in DESIGN.md §6 as the standard for "nothing here
 * yet" — this component exists so every new surface in the feature pass gets
 * it identically rather than each one improvising its own blank.
 *
 * Deliberately has no loading or error mode. Those are a different pattern
 * (see AISurface) and conflating them is how a dead end gets shipped.
 */
export function EmptyState({
  icon: Icon,
  line,
  action,
  className = '',
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  line: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-ink/25 px-6 py-10 text-center ${className}`}
    >
      <Icon size={20} className="text-muted" />
      <p className="max-w-xs font-mono text-xs leading-relaxed text-muted">{line}</p>
      {action}
    </div>
  );
}
