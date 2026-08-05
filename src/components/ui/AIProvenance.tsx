import React from 'react';
import { AlertTriangle, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { GroundingPrivacyExclusion } from '../../lib/grounding';
import type { AIResponseMeta } from '../../lib/ai';

export interface AIProvenanceProps {
  sourceIds: string[];
  sourceLabels?: Record<string, string>;
  unsupportedAssumptions?: string[];
  privacyExclusions?: GroundingPrivacyExclusion[];
  generatedAt?: Date | string | null;
  sourceObservedAt?: Record<string, string>;
  consideredSourceCount?: number;
  dataFreshThrough?: Date | string | null;
  generation?: AIResponseMeta;
  className?: string;
}

function formatGeneratedAt(value?: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Compact evidence disclosure shared by every generated surface.
 *
 * The default state stays quiet enough for normal use while the details
 * remain keyboard- and screen-reader-accessible for anyone checking a claim.
 */
export function AIProvenance({
  sourceIds,
  sourceLabels = {},
  unsupportedAssumptions = [],
  privacyExclusions = [],
  generatedAt,
  sourceObservedAt = {},
  consideredSourceCount,
  dataFreshThrough,
  generation,
  className = '',
}: AIProvenanceProps) {
  const time = formatGeneratedAt(generatedAt);
  const freshness = formatGeneratedAt(dataFreshThrough);
  const uniqueIds = [...new Set(sourceIds)];
  const assumptions = unsupportedAssumptions.filter(Boolean);

  return (
    <details className={`group border-t border-ink/10 pt-3 ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oxblood/40">
        {assumptions.length > 0 ? (
          <AlertTriangle size={13} aria-hidden="true" className="text-amber-700" />
        ) : (
          <ShieldCheck size={13} aria-hidden="true" className="text-emerald-700" />
        )}
        <span>
          {uniqueIds.length > 0
            ? `Grounded in ${uniqueIds.length} provided source${uniqueIds.length === 1 ? '' : 's'}`
            : 'No factual source was required'}
        </span>
        {time && <span className="normal-case tracking-normal text-muted">· {time}</span>}
      </summary>

      <div className="mt-3 space-y-3" aria-live="polite">
        {uniqueIds.length > 0 && (
          <div>
            <p className="mb-2 font-mono text-[9px] uppercase tracking-wide text-muted">
              {typeof consideredSourceCount === 'number'
                ? `${consideredSourceCount} source${consideredSourceCount === 1 ? '' : 's'} considered · `
                : ''}
              {freshness
                ? `cited evidence fresh through ${freshness}`
                : 'cited source dates were not available'}
            </p>
            <div className="flex flex-wrap gap-2" aria-label="Sources used">
              {uniqueIds.map((id) => (
                <span
                  key={id}
                  className="border border-ink/15 bg-paper px-2 py-1 font-mono text-[9px] uppercase tracking-wide text-subtle"
                >
                  {sourceLabels[id] || id}
                  {sourceObservedAt[id]
                    ? ` · ${formatGeneratedAt(sourceObservedAt[id])}`
                    : ''}
                </span>
              ))}
            </div>
          </div>
        )}

        {generation && (
          <dl className="grid gap-2 border border-ink/10 bg-paper/60 p-3 font-mono text-[9px] uppercase tracking-wide text-subtle sm:grid-cols-2">
            <div>
              <dt className="text-muted">AI task</dt>
              <dd className="mt-1 break-words normal-case tracking-normal">
                {generation.feature}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Model route</dt>
              <dd className="mt-1 break-words normal-case tracking-normal">
                {generation.semanticTier
                  ? `${generation.semanticTier} · ${generation.modelAlias}`
                  : generation.modelAlias}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Tokens used</dt>
              <dd className="mt-1 normal-case tracking-normal">
                {generation.usage.totalTokens.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Request reference</dt>
              <dd className="mt-1 break-all normal-case tracking-normal">
                {generation.requestId || 'Unavailable'}
              </dd>
            </div>
          </dl>
        )}

        {assumptions.length > 0 && (
          <div className="border border-amber-300 bg-amber-50 p-3 text-amber-950">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest">
              Review before using
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
              {assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          </div>
        )}

        {privacyExclusions.length > 0 && (
          <div className="border border-violet-200 bg-violet-50 p-3 text-violet-950">
            <p className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-widest">
              <LockKeyhole size={12} aria-hidden="true" />
              Privacy boundary applied
            </p>
            <p className="mt-2 text-xs leading-relaxed">
              {privacyExclusions.length} saved source
              {privacyExclusions.length === 1 ? ' was' : 's were'} excluded
              before this request reached AI.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
              {privacyExclusions.map((exclusion) => (
                <li key={`${exclusion.sourceId}-${exclusion.reasons.join('-')}`}>
                  {exclusion.sourceLabel}: {exclusion.reasons
                    .map((reason) =>
                      reason === 'never-use-in-ai'
                        ? 'Never use in AI'
                        : reason === 'retention-expired'
                          ? 'retention expired'
                          : reason === 'provider-disconnected'
                            ? 'provider disconnected'
                            : reason === 'observed-at-missing'
                              ? 'date required by retention policy'
                              : reason,
                    )
                    .join(', ')}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
