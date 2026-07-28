import React from 'react';

/**
 * The ring-"C" mark.
 *
 * It used to be built from stacked divs, where the gap in the ring was faked
 * by parking an opaque `bg-paper` square over it. That only reads correctly on
 * a paper-colored surface — on the rail, on white, on the landing page's
 * `bg-white/40` bands it showed as a differently-tinted patch floating inside
 * the ring. Drawn as an SVG arc instead the gap is genuinely empty, so
 * whatever sits behind the mark shows through and the background color stops
 * mattering. Strokes are `currentColor`, so it also inherits inverted text.
 *
 * Geometry is derived from the original, not eyeballed. That version masked
 * the ring with a 14px-tall rectangle at the right edge, so on a centerline
 * radius of 17 the gap subtends 2·asin(7/17) ≈ 48.6° — an arc of ≈14.5 units
 * out of a ≈106.8 circumference — centered on 3 o'clock. The dot keeps its
 * original center of (30, 18) with r = 3.
 *
 * The dash offset must be NEGATIVE half a gap. `stroke-dashoffset` is the
 * distance *into* the pattern at which the path starts, and an SVG <circle>
 * starts at 3 o'clock; a positive half-gap therefore starts the path half a
 * gap into the dash and pushes the gap most of the way around to 12 o'clock,
 * which is what made the mark look rotated with the dot stranded on solid
 * stroke. Negative pulls the pattern back so the gap straddles 3 o'clock,
 * putting it around the dot where it belongs.
 */
const R = 17;
const CIRCUMFERENCE = 2 * Math.PI * R; // ≈ 106.81
const GAP = 2 * R * Math.asin(7 / R); // ≈ 14.5 — the original mask's arc

const EASE = 'ease-[cubic-bezier(0.22,1,0.36,1)]';

export type LogoProps = {
  /** md = sidebar scale (default). sm = inline/nav scale. */
  size?: 'sm' | 'md';
  /** Set false for the bare mark with no "Cirqle / CRM" lockup. */
  showWordmark?: boolean;
  /** Kicker under the wordmark. Pass null to hide it. */
  kicker?: string | null;
  className?: string;
};

export function Logo({
  size = 'md',
  showWordmark = true,
  kicker = 'CRM',
  className = '',
}: LogoProps) {
  return (
    <div className={`group flex w-fit cursor-pointer items-center gap-3 ${className}`}>
      <LogoMark px={size === 'md' ? 36 : 28} />

      {showWordmark && (
        <div className="leading-none">
          <div
            className={`font-serif font-black italic tracking-tight ${
              size === 'md' ? 'text-[31px]' : 'text-[23px]'
            }`}
          >
            Cirqle
          </div>
          {kicker && (
            <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.22em] text-subtle">
              {kicker}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The mark on its own — no fills except the dot, nothing opaque behind it. */
export function LogoMark({ px = 36, className = '' }: { px?: number; className?: string }) {
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
      className={`flex-shrink-0 ${className}`}
    >
      {/* Solid ring with a real gap — rotates away and fades on hover. */}
      <circle
        cx="18"
        cy="18"
        r={R}
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={`${CIRCUMFERENCE - GAP} ${GAP}`}
        strokeDashoffset={-GAP / 2}
        className={`origin-center transition-all duration-500 ${EASE} group-hover:rotate-90 group-hover:opacity-0`}
      />

      {/* Dashed ring — the hover counterpart, absent at rest. */}
      <circle
        cx="18"
        cy="18"
        r={R}
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="2 5"
        strokeLinecap="round"
        className={`origin-center opacity-0 transition-all duration-700 ${EASE} group-hover:rotate-[270deg] group-hover:opacity-100`}
      />

      {/* The dot travels from the gap to the center and swells slightly. */}
      <circle
        cx="30"
        cy="18"
        r="3"
        fill="currentColor"
        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        className={`transition-transform duration-500 ${EASE} group-hover:translate-x-[-12px] group-hover:scale-[1.35]`}
      />
    </svg>
  );
}
