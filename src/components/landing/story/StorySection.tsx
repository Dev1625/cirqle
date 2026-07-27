import React from 'react';
import { motion, useInView, useReducedMotion, type Variants } from 'motion/react';
import { useStoryStage } from '../StoryScroll';
import { STORY_STAGES } from '../StoryRail';

const HOUSE_EASE = [0.22, 1, 0.36, 1] as const;

/**
 * The page's one content column. The left inset on xl is where the narrative
 * thread lives — every section on the page uses this, story beat or not, so
 * the column never jogs sideways as you scroll past a non-story section.
 */
export const STORY_COLUMN = 'mx-auto w-full max-w-6xl px-6 md:px-8 xl:pl-[220px]';

/**
 * One beat of the narrative. Registers itself with the scroll provider under
 * its story index, which is how the rail knows where each stop actually sits
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
    <section
      ref={ref}
      id={id}
      className={`story-section overflow-x-clip border-t border-ink/15 py-20 md:py-28 ${className}`}
    >
      <div className={STORY_COLUMN}>{children}</div>
      {bleed}
    </section>
  );
}

/**
 * The beat's heading block. The numbered eyebrow is the same number the rail
 * is showing at that moment, so the token and the copy agree about which
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
 * Fade + rise on entry. Transform and opacity only; under reduced motion the
 * rise is dropped and the content simply reveals in place.
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

/**
 * Text that assembles a word at a time.
 *
 * The whole string is always in the DOM at full size — only per-word opacity
 * animates. A real typewriter appends characters, which reflows the
 * paragraph on every frame and is exactly the layout-thrashing this pass
 * bans; this reserves the final layout up front and reveals into it, so the
 * effect is compositor-only and nothing below it ever shifts.
 */
export function AssemblingText({
  text,
  active,
  className = '',
  startDelay = 0,
  perWord = 0.05,
  onDone,
}: {
  text: string;
  active: boolean;
  className?: string;
  startDelay?: number;
  perWord?: number;
  onDone?: () => void;
}) {
  const reduce = useReducedMotion();
  const words = React.useMemo(() => text.split(' '), [text]);

  React.useEffect(() => {
    if (!active || !onDone) return;
    const ms = reduce ? 0 : (startDelay + words.length * perWord + 0.35) * 1000;
    const id = setTimeout(onDone, ms);
    return () => clearTimeout(id);
  }, [active, onDone, reduce, startDelay, perWord, words.length]);

  return (
    <span className={className}>
      {words.map((word, i) => (
        <motion.span
          key={`${word}-${i}`}
          className="inline-block whitespace-pre"
          initial={{ opacity: 0 }}
          animate={active ? { opacity: 1 } : { opacity: 0 }}
          transition={{
            duration: reduce ? 0 : 0.28,
            delay: reduce ? 0 : startDelay + i * perWord,
            ease: 'easeOut',
          }}
        >
          {word}
          {i < words.length - 1 ? ' ' : ''}
        </motion.span>
      ))}
    </span>
  );
}

/**
 * Fires once the element is properly on screen, after a settle delay. Used
 * by every beat that plays a fixed-duration animation rather than scrubbing
 * one: the trigger is "you have arrived", the playback is its own timeline.
 */
export function useSettledTrigger(
  ref: React.RefObject<Element | null>,
  { amount = 0.5, delay = 600 }: { amount?: number; delay?: number } = {}
) {
  const inView = useInView(ref, { amount, once: true });
  const [fired, setFired] = React.useState(false);

  React.useEffect(() => {
    if (!inView) return;
    const id = setTimeout(() => setFired(true), delay);
    return () => clearTimeout(id);
  }, [inView, delay]);

  return fired;
}

export { HOUSE_EASE };
