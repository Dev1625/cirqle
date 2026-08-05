import React, { useEffect, useState } from 'react';
import { Sparkles, RefreshCw, AlertTriangle, X } from 'lucide-react';
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
  loadingStages,
  onCancel,
  usageLabel,
  tone = 'default',
  children,
}: {
  state: 'loading' | 'error' | 'empty' | 'ready';
  error?: string | null;
  onRetry?: () => void;
  emptyIcon?: React.ComponentType<{ size?: number; className?: string }>;
  emptyLine: string;
  emptyAction?: React.ReactNode;
  loadingLine?: string;
  loadingStages?: string[];
  onCancel?: () => void;
  usageLabel?: string;
  tone?: 'default' | 'inverted';
  children?: React.ReactNode;
}) {
  const [stage, setStage] = useState(0);
  const stages =
    loadingStages && loadingStages.length > 0
      ? loadingStages
      : [loadingLine];

  useEffect(() => {
    if (state !== 'loading' || stages.length < 2) {
      setStage(0);
      return;
    }
    const interval = window.setInterval(
      () => setStage((current) => Math.min(current + 1, stages.length - 1)),
      2_200,
    );
    return () => window.clearInterval(interval);
  }, [state, stages.length]);

  if (state === 'loading') {
    return (
      <div
        className={`flex items-center gap-2.5 px-1 py-6 font-mono text-xs ${
          tone === 'inverted' ? 'text-paper/75' : 'text-muted'
        }`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy="true"
      >
        <RefreshCw size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span>{stages[stage]}</span>
        {usageLabel && (
          <span className="ml-auto text-[10px] uppercase tracking-widest">
            {usageLabel}
          </span>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className={`ml-auto inline-flex min-h-11 min-w-11 items-center justify-center gap-1 px-2 text-[10px] font-bold uppercase tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 ${
              tone === 'inverted'
                ? 'text-paper/75 hover:text-paper focus-visible:ring-paper'
                : 'text-muted hover:text-ink focus-visible:ring-brand'
            }`}
          >
            <X size={11} aria-hidden="true" />
            Cancel
          </button>
        )}
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div
        className={`flex flex-col items-start gap-3 rounded-card px-4 py-4 ${
          tone === 'inverted'
            ? 'border border-paper/25 bg-paper/10'
            : 'border border-ink/15 bg-paper/60'
        }`}
        role="alert"
      >
        <p className={`flex items-start gap-2 font-mono text-xs leading-relaxed ${
          tone === 'inverted' ? 'text-paper/85' : 'text-subtle'
        }`}>
          <AlertTriangle
            size={13}
            className={`mt-0.5 shrink-0 ${
              tone === 'inverted' ? 'text-amber-300' : 'text-red-600'
            }`}
            aria-hidden="true"
          />
          {error ||
            "AI couldn't finish this request. Your work is still here; check your connection and try again."}
        </p>
        {onRetry && tone === 'inverted' ? (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-11 items-center border border-paper/30 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-paper transition-colors hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper"
          >
            Try AI again
          </button>
        ) : onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try AI again
          </Button>
        ) : null}
      </div>
    );
  }

  if (state === 'empty') {
    return <EmptyState icon={emptyIcon} line={emptyLine} action={emptyAction} />;
  }

  return <>{children}</>;
}
