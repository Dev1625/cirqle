import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { Button } from '../ui/Button';

interface UsageResponse {
  period: {
    spendUsd: number;
    limitUsd: number;
    percentage: number;
    duration: string;
    resetAt: string | null;
  };
  requestCount: number;
  successfulRequests: number;
  failedRequests: number;
  totalTokens: number;
  detail: {
    complete: boolean;
    truncated: boolean;
    pagesRead: number;
    startsAt: string;
    endsAt: string;
  };
  features: Record<
    string,
    {
      requests: number;
      spendUsd: number;
      tokens: number;
      label: string;
      group: string;
    }
  >;
}

function money(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

function budgetMessage(percentage: number): string {
  if (percentage >= 100) return 'AI budget reached. Calls pause until the next reset.';
  if (percentage >= 90) return 'Almost at the AI budget. Use draft calls deliberately.';
  if (percentage >= 70) return 'AI usage is above 70% for this period.';
  return 'Your personal cap prevents unexpected AI spend.';
}

export function AIUsagePanel() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const response = await authenticatedFetch('/api/ai/usage');
      if (!response.ok) throw new Error('usage-unavailable');
      setUsage(await response.json());
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const percentage = usage?.period.percentage || 0;
  const featureRows = usage
    ? Object.entries(usage.features).sort(
        (a, b) => b[1].spendUsd - a[1].spendUsd,
      )
    : [];
  const featureGroups = Array.from(
    new Set(featureRows.map(([, values]) => values.group)),
  )
    .map((group) => [
      group,
      featureRows.filter(([, values]) => values.group === group),
    ] as const)
    .sort(
      (a, b) =>
        b[1].reduce((total, [, values]) => total + values.spendUsd, 0) -
        a[1].reduce((total, [, values]) => total + values.spendUsd, 0),
    );

  return (
    <section aria-labelledby="ai-usage-heading" className="border border-ink/20 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="ai-usage-heading" className="font-serif text-2xl font-bold italic">
            AI usage
          </h2>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-subtle">
            Personal period budget and feature activity
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={load}
          disabled={state === 'loading'}
          aria-busy={state === 'loading'}
          className="gap-2"
        >
          <RefreshCw size={13} aria-hidden="true" className={state === 'loading' ? 'animate-spin' : ''} />
          Refresh
        </Button>
      </div>

      {state === 'loading' && (
        <p role="status" aria-live="polite" aria-busy="true" className="mt-6 font-mono text-xs text-subtle">
          Loading current usage…
        </p>
      )}

      {state === 'error' && (
        <div role="alert" className="mt-6 border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <p>Usage is temporarily unavailable. This does not change your cap or erase usage history.</p>
          <Button type="button" variant="outline" size="sm" onClick={load} className="mt-3">
            Retry usage
          </Button>
        </div>
      )}

      {state === 'ready' && usage && (
        <div className="mt-6 space-y-6">
          <div>
            <div className="flex items-end justify-between gap-4">
              <p className="font-serif text-3xl">
                {money(usage.period.spendUsd)}
                <span className="ml-2 font-mono text-xs text-subtle">
                  of {money(usage.period.limitUsd)}
                </span>
              </p>
              <p className="font-mono text-[10px] uppercase tracking-widest text-subtle">
                {percentage.toFixed(1)}%
              </p>
            </div>
            <div
              className="mt-3 h-2 overflow-hidden bg-ink/10"
              role="progressbar"
              aria-label="AI budget used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(100, Math.max(0, percentage)))}
              aria-valuetext={`${percentage.toFixed(1)} percent of ${money(usage.period.limitUsd)} used`}
            >
              <div
                className={`h-full transition-[width] ${
                  percentage >= 90
                    ? 'bg-red-700'
                    : percentage >= 70
                      ? 'bg-amber-600'
                      : 'bg-brand'
                }`}
                style={{ width: `${Math.min(100, percentage)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-subtle">{budgetMessage(percentage)}</p>
            {usage.period.resetAt && (
              <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-muted">
                Resets {new Date(usage.period.resetAt).toLocaleString()}
              </p>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-px bg-ink/15 md:grid-cols-4">
            {[
              ['Requests', usage.requestCount],
              ['Successful', usage.successfulRequests],
              ['Failed', usage.failedRequests],
              ['Tokens', usage.totalTokens.toLocaleString()],
            ].map(([label, value]) => (
              <div key={label} className="bg-paper p-4">
                <dt className="font-mono text-[9px] uppercase tracking-widest text-subtle">{label}</dt>
                <dd className="mt-2 font-serif text-2xl">{value}</dd>
              </div>
            ))}
          </dl>

          {!usage.detail.complete && (
            <p
              role="status"
              className="border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"
            >
              The spend total and budget bar are current. The feature and
              token breakdown reached its bounded history limit, so those
              detail counts cover only the newest available pages.
            </p>
          )}

          {featureRows.length > 0 && (
            <div>
              <h3 className="font-mono text-[10px] font-bold uppercase tracking-widest">
                By feature
              </h3>
              <div className="mt-3 space-y-5">
                {featureGroups.map(([group, rows]) => (
                  <div key={group}>
                    <h4 className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-subtle">
                      {group}
                    </h4>
                    <div className="mt-2 divide-y divide-ink/10 border-y border-ink/10">
                      {rows.map(([feature, values]) => (
                        <div key={feature} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-3 text-xs">
                          <span>
                            <span className="block font-medium">{values.label}</span>
                            <span className="mt-0.5 block font-mono text-[9px] text-muted">
                              {feature}
                            </span>
                          </span>
                          <span className="text-subtle">{values.requests} calls</span>
                          <span className="font-mono">{money(values.spendUsd)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
