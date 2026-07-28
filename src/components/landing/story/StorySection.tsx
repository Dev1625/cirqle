import React from 'react';
import { motion, useReducedMotion, useTransform, type MotionValue, type Variants } from 'motion/react';
import { useStoryStage, useStoryAnchor, useStoryScroll, useSectionRange } from '../StoryScroll';
import { STORY_STAGES } from '../storyStages';

const HOUSE_EASE = [0.22, 1, 0.36, 1] as const;

/**
 * The page's one content column. The left inset on xl is where the narrative
 * token does most of its travelling — every section on the page uses this,
 * story beat or not, so the column never jogs sideways as you scroll past a
 * non-story section.
 */
export const STORY_COLUMN = 'mx-auto w-full max-w-6xl px-6 md:px-8 xl:pl-[200px]';

/**
 * One beat of the narrative. Registers itself with the scroll provider under
 * its story index, which is how the token knows where each stop actually sits
 * on the page rather than guessing at fractions.
 */
export function StorySection({
  index,
  id,
  children,
  bleed,
  className = '',
}: {
  index: number;
  id?: string;
  children: React.ReactNode;
  /** Rendered outside the measured column, for content that runs off-edge. */
  bleed?: React.ReactNode;
  className?: string;
}) {
  const ref = useStoryStage(index);
  return (
    <section ref={ref} id={id} className={`story-section border-t border-ink/15 ${className}`}>
      {/* The stage is what sticks. Everything a beat shows lives inside it,
          bleed content included, so the whole composition holds still while
          the beat plays. `overflow-x-clip` sits here rather than on the
          section: an ancestor that clips would not break sticky, but keeping
          it inside the stage keeps the clipping box the same size as the
          thing being clipped. */
      }
      <div className="story-stage overflow-x-clip">
        <div className={STORY_COLUMN}>{children}</div>
        {bleed}
      </div>
    </section>
  );
}

/**
 * A landing point for the narrative token. Zero-size on purpose: it marks a
 * coordinate, it does not occupy space, so dropping one into a layout can
 * never push anything around. Needs a positioned ancestor.
 */
export function StoryAnchor({
  stage,
  order = 0,
  weight = 1,
  silent = false,
  className = '',
  style,
}: {
  stage: number;
  order?: number;
  /** How long the token parks here, relative to the beat's other stops. */
  weight?: number;
  /** Hide the token on its way *to* this stop. */
  silent?: boolean;
  className?: string;
  /** For anchors placed by percentage, e.g. a node inside a fluid SVG. */
  style?: React.CSSProperties;
}) {
  const ref = useStoryAnchor(stage, order, { weight, silent });
  return (
    <span
      ref={ref}
      aria-hidden="true"
      style={style}
      className={`pointer-events-none absolute block h-0 w-0 ${className}`}
    />
  );
}

/**
 * The beat's heading block. The numbered eyebrow is the same number the token
 * is carrying at that moment, so the token and the copy agree about which
 * chapter the visitor is in.
 */
export function StoryHeading({
  index,
  title,
  body,
  className = '',
  children,
}: {
  index: number;
  title: React.ReactNode;
  body: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  const stage = STORY_STAGES[index];
  const Icon = stage.icon;
  return (
    <StoryReveal className={className}>
      <p className="mb-4 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.22em] text-brand">
        <Icon size={13} /> {stage.index} · {stage.label}
      </p>
      <h2 className="max-w-[17ch] text-balance font-serif text-3xl font-bold italic tracking-tight md:text-5xl">
        {title}
      </h2>
      <p className="mt-5 max-w-[52ch] font-mono text-sm leading-relaxed text-subtle">{body}</p>
      {children}
    </StoryReveal>
  );
}

/**
 * Fade + rise on entry, for static copy. Transform and opacity only; under
 * reduced motion the rise is dropped and the content reveals in place.
 *
 * Deliberately NOT scroll-scrubbed. Headings and body copy that fade back out
 * when you scroll up read as broken rather than as responsive — scrubbing is
 * for the beats' demonstrations, not for the prose around them.
 */
export function StoryReveal({
  children,
  className = '',
  y = 18,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  y?: number;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  const variants: Variants = {
    hidden: reduce ? { opacity: 0 } : { opacity: 0, y },
    visible: { opacity: 1, y: 0, transition: { duration: 0.6, delay, ease: HOUSE_EASE } },
  };
  return (
    <motion.div
      className={className}
      variants={variants}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: '-12% 0px' }}
    >
      {children}
    </motion.div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Scroll-scrubbed reveals.

   Every beat's demonstration — fields filling in, an email assembling, a
   queue arriving — is mapped to that beat's own scroll window rather than
   fired once on a timer when the section is first seen. Scrolling forward
   reveals more, scrolling back hides it again: the scroll is the mechanism
   doing the work, not a trigger for something that then plays out on its own
   regardless of what the visitor does next.
   ──────────────────────────────────────────────────────────────────────── */

/** 0 → 1 across a beat's window. The input every scrubbed reveal reads. */
export function useScrub(index: number, spread?: number) {
  const { progress } = useStoryScroll();
  const range = useSectionRange(index, spread);
  return useTransform(progress, range, [0, 1]);
}

/**
 * Reveals one item within a scrub, given its slot. `share` narrows the item
 * to a slice of the beat, so several sequences can share one window without
 * having to know about each other.
 */
export function useSlotOpacity(
  scrub: MotionValue<number>,
  slot: number,
  count: number,
  share: [number, number] = [0, 1]
) {
  const span = share[1] - share[0];
  const step = span / Math.max(count, 1);
  const start = share[0] + slot * step;
  // Items finish in 0.75 of a step, so they overlap slightly — that reads as
  // a sequence rather than as a series of discrete flashes.
  return useTransform(scrub, [start, start + step * 0.75], [0, 1]);
}

/**
 * Text that assembles a word at a time, scrubbed by scroll.
 *
 * The whole string is always in the DOM at full size — only per-word opacity
 * animates. A real typewriter appends characters, which reflows the paragraph
 * on every frame and is exactly the layout-thrashing this page bans; this
 * reserves the final layout up front and reveals into it, so the effect is
 * compositor-only and nothing below it ever shifts.
 */
export function ScrubbedText({
  text,
  scrub,
  share = [0, 1],
  className = '',
  cursor = false,
}: {
  text: string;
  scrub: MotionValue<number>;
  share?: [number, number];
  className?: string;
  /** Show an oxblood caret at the word currently being written. */
  cursor?: boolean;
}) {
  const { reduced } = useStoryScroll();
  const words = React.useMemo(() => text.split(' '), [text]);

  return (
    <span className={className}>
      {words.map((word, i) => (
        <ScrubWord
          key={`${word}-${i}`}
          word={word + (i < words.length - 1 ? ' ' : '')}
          scrub={scrub}
          slot={i}
          count={words.length}
          share={share}
          reduced={reduced}
          cursor={cursor}
        />
      ))}
    </span>
  );
}

function ScrubWord({
  word,
  scrub,
  slot,
  count,
  share,
  reduced,
  cursor,
}: {
  word: string;
  scrub: MotionValue<number>;
  slot: number;
  count: number;
  share: [number, number];
  reduced: boolean;
  cursor: boolean;
}) {
  const opacity = useSlotOpacity(scrub, slot, count, share);

  /* The caret.
     Every word carries its own, and each is lit only while the scrub is
     inside that word's slot — so exactly one is visible at a time and it
     appears to walk the text as it writes. Rendering one caret and moving it
     would mean recomputing its position in React on every frame; this is
     pure opacity on elements that already exist.

     It is absolutely positioned against its word, so it adds nothing to the
     line box. A caret in the text flow would nudge every following word by
     its own width on each step, which is precisely the reflow this page's
     word-by-word reveal exists to avoid. */
  const span = share[1] - share[0];
  const step = span / Math.max(count, 1);
  const start = share[0] + slot * step;
  const here = useTransform(
    scrub,
    [start, start + step * 0.05, start + step * 0.95, start + step],
    [0, 1, 1, 0]
  );

  return (
    <motion.span
      className={`whitespace-pre ${cursor ? 'relative inline-block' : 'inline-block'}`}
      style={{ opacity: reduced ? 1 : opacity }}
    >
      {word}
      {cursor && !reduced && (
        <motion.span
          aria-hidden="true"
          data-caret=""
          className="pointer-events-none absolute right-0 top-[0.1em] h-[1em] w-[2px] bg-brand"
          style={{ opacity: here }}
        />
      )}
    </motion.span>
  );
}

export { HOUSE_EASE, useSectionRange };
