import React from 'react';
import { Pin, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import type { HealthResult, Trend } from '../../lib/health';

/**
 * The relationship score, never as a bare number.
 *
 * The owner's complaint about the existing score was precisely that "72"
 * tells you nothing you can act on. So the compact form still carries its
 * direction, and the full explanation is one hover away.
 *
 * No new colours: falling and pinned borrow the oxblood brand token, which is
 * already the app's "this is a decision point" signal, and everything else
 * stays in the muted ink ramp.
 */

const TREND_ICON: Record<Trend, React.ComponentType<{ size?: number; className?: string }>> = {
  rising: TrendingUp,
  steady: Minus,
  falling: TrendingDown,
  pinned: Pin,
};

export function HealthPill({ health, className = '' }: { health: HealthResult; className?: string }) {
  const Icon = TREND_ICON[health.trend];
  const emphasised = health.trend === 'falling' || health.trend === 'pinned';

  return (
    <span
      title={health.summary}
      className={`inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-widest ${
        emphasised ? 'text-brand' : 'text-muted'
      } ${className}`}
    >
      <Icon size={11} aria-hidden="true" />
      {/* The visible number is hidden from assistive tech and the whole
          summary announced instead. Marking up both meant a screen reader
          read "34, 34 and falling…" — the score twice, because the summary
          opens with it. */}
      <span aria-hidden="true">{health.score}</span>
      <span className="sr-only">Relationship health: {health.summary}</span>
    </span>
  );
}

/**
 * The full explanation, for Contact Detail where there is room for it.
 * Shows the ranked contributions so the number is auditable rather than
 * oracular.
 */
export function HealthPanel({
  health,
  onTogglePin,
  busy,
}: {
  health: HealthResult;
  onTogglePin?: () => void;
  busy?: boolean;
}) {
  const Icon = TREND_ICON[health.trend];

  return (
    <div className="rounded-card border border-ink/15 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
            Relationship health
          </span>
          <p className="mt-1.5 flex items-center gap-2 font-serif text-3xl font-black">
            {health.score}
            <Icon
              size={16}
              className={health.trend === 'falling' || health.trend === 'pinned' ? 'text-brand' : 'text-muted'}
              aria-hidden="true"
            />
          </p>
          {/* detail, not summary — the score is already set in 3xl serif
              immediately above, and summary opens by repeating it. */}
          <p className="mt-1 font-mono text-xs leading-relaxed text-subtle">{health.detail}</p>
        </div>

        {onTogglePin && (
          <button
            type="button"
            onClick={onTogglePin}
            disabled={busy}
            aria-pressed={health.pinned}
            aria-label={
              health.pinned
                ? 'Unpin relationship health'
                : 'Pin relationship health so time alone does not lower it'
            }
            title={
              health.pinned
                ? 'Unpin — the score will decay again'
                : 'Pin — stop this relationship decaying. For the ones that are quarterly by design.'
            }
            className={`flex min-h-11 min-w-11 shrink-0 items-center gap-1.5 rounded-card border px-2.5 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${
              health.pinned
                ? 'border-brand/40 bg-brand text-brand-on'
                : 'border-ink/15 text-muted hover:border-ink/25 hover:text-ink'
            }`}
          >
            <Pin size={11} aria-hidden="true" />
            {health.pinned ? 'Pinned' : 'Pin'}
          </button>
        )}
      </div>

      {health.reasons.length > 0 && (
        <ul className="mt-4 space-y-1 border-t border-ink/15 pt-3">
          {health.reasons.slice(0, 4).map((reason, index) => (
            <li
              key={index}
              className="flex items-center justify-between gap-3 font-mono text-[11px] text-muted"
            >
              <span className="truncate">{reason.label}</span>
              <span className={reason.delta < 0 ? 'shrink-0 text-brand' : 'shrink-0'}>
                {reason.delta > 0 ? '+' : ''}
                {Math.round(reason.delta)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
