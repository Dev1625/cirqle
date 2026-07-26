import React from 'react';

/**
 * Consistent initials avatar for contacts without a photo.
 *
 * Two rules worth stating, because both were being improvised per-screen
 * before this existed:
 *
 * 1. Initials are taken from the *first and last* whitespace-separated tokens,
 *    not the first two. "Maria del Carmen Ruiz" reads MR, not MD.
 * 2. The background tone is derived deterministically from the name, so the
 *    same person is the same colour on every screen. The palette is the
 *    NetworkGraph industry lane palette (DESIGN.md §2) — already muted, earthy
 *    and desaturated, so a wall of avatars reads as tinted ink rather than a
 *    bag of Skittles. Paper text on all eight clears WCAG AA.
 *
 * rounded-full is correct here and is not a radius-token violation: DESIGN.md
 * reserves it for genuinely circular things, and an avatar is one.
 */

const AVATAR_TONES = [
  '#56606A', // investment banking
  '#746B60', // consulting
  '#66715F', // private equity
  '#9A7447', // venture capital
  '#7D5B52', // hedge fund
  '#617672', // healthcare
  '#6A6473', // tech
  '#8B877D', // other
];

export function getInitials(name?: string | null): string {
  const cleaned = (name || '').trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function avatarTone(name?: string | null): string {
  const cleaned = (name || '').trim();
  if (!cleaned) return AVATAR_TONES[AVATAR_TONES.length - 1];
  let hash = 0;
  for (let i = 0; i < cleaned.length; i++) {
    hash = (hash * 31 + cleaned.charCodeAt(i)) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

const SIZES: Record<string, string> = {
  sm: 'h-7 w-7 text-[9px]',
  default: 'h-9 w-9 text-[10px]',
  lg: 'h-14 w-14 text-sm',
  xl: 'h-20 w-20 text-lg',
};

export function Avatar({
  name,
  photoUrl,
  size = 'default',
  tone,
  className = '',
}: {
  name?: string | null;
  photoUrl?: string | null;
  size?: 'sm' | 'default' | 'lg' | 'xl';
  /**
   * Overrides the name-derived colour. Used on the public card page, where
   * the owner has explicitly chosen an accent and the largest circular
   * element on the page ignoring that choice looked like a bug.
   * Everywhere else the deterministic per-name tone is what you want.
   */
  tone?: string;
  className?: string;
}) {
  const dimension = SIZES[size] || SIZES.default;

  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name || 'Contact'}
        className={`${dimension} shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: tone || avatarTone(name) }}
      className={`${dimension} inline-flex shrink-0 items-center justify-center rounded-full font-mono font-bold uppercase tracking-widest text-paper ${className}`}
    >
      {getInitials(name)}
    </span>
  );
}
