import React from 'react';
import { Sparkles, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';

/**
 * The house AI-surface contract, extracted so every AI panel added in this
 * pass carries the same four states rather than reimplementing three of them
 * and forgetting the fourth.
 *
 * DESIGN.md §6: AI surfaces carry explicit loading, error-with-retry and empty
 * states, and a sparkle icon marks them as AI-powered. The failure mode this
 * guards against is the one the first polish pass had to fix on the Dashboard
 * brief — an AI panel that renders nothing at all when the call fails, giving
 * the user no way to tell "broken" from "nothing to say".
 *
 * The spinning RefreshCw is the one sanctioned continuous spin in the app
 * (DESIGN.md §5) — functional, not decorative.
 */

export function AILabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-muted ${className}`}>
      <Sparkles size={11} className="text-brand" aria-hidden="true" />
      {children}
    </span>
  );
}

export function AISurface({
  state,
  error,
  onRetry,
  emptyIcon = Sparkles,
  emptyLine,
  emptyAction,
  loadingLine = 'Reading the file…',
  children,
}: {
  state: 'loading' | 'error' | 'empty' | 'ready';
  error?: string | null;
  onRetry?: () => void;
  emptyIcon?: React.ComponentType<{ size?: number; className?: string }>;
  emptyLine: string;
  emptyAction?: React.ReactNode;
  loadingLine?: string;
  children?: React.ReactNode;
}) {
  if (state === 'loading') {
    return (
      <div className="flex items-center gap-2.5 px-1 py-6 font-mono text-xs text-muted">
        <RefreshCw size={13} className="animate-spin" aria-hidden="true" />
        {loadingLine}
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex flex-col items-start gap-3 rounded-card border border-ink/15 bg-paper/60 px-4 py-4">
        <p className="flex items-start gap-2 font-mono text-xs leading-relaxed text-subtle">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-red-600" aria-hidden="true" />
          {error || "The model didn't come back. It happens."}
        </p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    );
  }

  if (state === 'empty') {
    return <EmptyState icon={emptyIcon} line={emptyLine} action={emptyAction} />;
  }

  return <>{children}</>;
}
