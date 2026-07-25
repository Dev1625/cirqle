import React from 'react';

const TIER_STYLES: Record<string, string> = {
  Strong: 'bg-[var(--color-tier-strong-bg)] text-[var(--color-tier-strong-text)]',
  Warm: 'bg-[var(--color-tier-warm-bg)] text-[var(--color-tier-warm-text)]',
  Cold: 'bg-[var(--color-tier-cold-bg)] text-[var(--color-tier-cold-text)]',
  Dormant: 'bg-[var(--color-tier-dormant-bg)] text-[var(--color-tier-dormant-text)]',
};

/**
 * The saturated half of each tier's colour pair, for places where a full
 * bg+text chip is too heavy but the row still needs glanceable signal — dots,
 * edge markers, rules. Strong uses its badge *background* (solid ink); the
 * other three use their badge *text* tone, which is the saturated one. Kept
 * next to TIER_STYLES on purpose: a dot and a chip must never disagree about
 * what "Warm" looks like.
 */
export const TIER_MARKER_COLOR: Record<string, string> = {
  Strong: 'var(--color-tier-strong-bg)',
  Warm: 'var(--color-tier-warm-text)',
  Cold: 'var(--color-tier-cold-text)',
  Dormant: 'var(--color-tier-dormant-text)',
};

export function tierMarkerColor(tier?: string | null): string {
  if (!tier) return 'var(--color-tier-cold-text)';
  return TIER_MARKER_COLOR[tier] || TIER_MARKER_COLOR.Cold;
}

export function TierDot({ tier, className = '' }: { tier?: string | null; className?: string }) {
  if (!tier) return null;
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${className}`}
      style={{ backgroundColor: tierMarkerColor(tier) }}
    />
  );
}

export function TierBadge({ tier, className = '' }: { tier?: string | null; className?: string }) {
  if (!tier) return null;
  const styles = TIER_STYLES[tier] || TIER_STYLES.Cold;
  return (
    <span className={`inline-block rounded-card px-2 py-1 text-[10px] uppercase tracking-widest font-mono font-bold ${styles} ${className}`}>
      {tier}
    </span>
  );
}
