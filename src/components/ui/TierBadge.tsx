import React from 'react';

const TIER_STYLES: Record<string, string> = {
  Strong: 'bg-[var(--color-tier-strong-bg)] text-[var(--color-tier-strong-text)]',
  Warm: 'bg-[var(--color-tier-warm-bg)] text-[var(--color-tier-warm-text)]',
  Cold: 'bg-[var(--color-tier-cold-bg)] text-[var(--color-tier-cold-text)]',
  Dormant: 'bg-[var(--color-tier-dormant-bg)] text-[var(--color-tier-dormant-text)]',
};

export function TierBadge({ tier, className = '' }: { tier?: string | null; className?: string }) {
  if (!tier) return null;
  const styles = TIER_STYLES[tier] || TIER_STYLES.Cold;
  return (
    <span className={`inline-block rounded-card px-2 py-1 text-[10px] uppercase tracking-widest font-mono font-bold ${styles} ${className}`}>
      {tier}
    </span>
  );
}
