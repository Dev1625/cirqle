import React from 'react';

/**
 * One consistent "last synced" treatment for anywhere live-ish data appears
 * (Gmail thread status, Calendar events, the dormant digest). Mono micro-label
 * in muted tone, per the machine-layer type role in DESIGN.md §3.
 *
 * Renders relative time, because the absolute clock time is almost never the
 * question being asked — "is this stale?" is. The exact timestamp stays
 * available on hover via title.
 */
export function relativeTime(input?: Date | number | null): string {
  if (!input) return 'never';
  const then = input instanceof Date ? input.getTime() : input;
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 90) return '1 min ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hr ago' : `${hours} hrs ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

export function LastSynced({
  at,
  prefix = 'Synced',
  className = '',
}: {
  at?: Date | number | null;
  prefix?: string;
  className?: string;
}) {
  const absolute = at ? new Date(at instanceof Date ? at.getTime() : at).toLocaleString() : undefined;
  return (
    <span
      title={absolute}
      className={`font-mono text-[10px] uppercase tracking-widest text-muted ${className}`}
    >
      {prefix} {relativeTime(at)}
    </span>
  );
}
