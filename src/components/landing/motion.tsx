import React from 'react';
import { motion, useReducedMotion, type Variants } from 'motion/react';

// The house ease-out-quint curve from index.css, expressed for motion.
const HOUSE_EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Container that staggers its <Reveal> children in as they enter the viewport.
 * Stagger increment matches the app's existing ~40ms list cadence.
 */
export function RevealGroup({
  children,
  className = '',
  stagger = 0.08,
  delay = 0,
  as = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  stagger?: number;
  delay?: number;
  as?: 'div' | 'section' | 'ul';
}) {
  const reduce = useReducedMotion();
  const container: Variants = {
    hidden: {},
    visible: {
      transition: reduce ? {} : { staggerChildren: stagger, delayChildren: delay },
    },
  };
  const MotionTag = motion[as] as typeof motion.div;
  return (
    <MotionTag
      className={className}
      variants={container}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: '-12% 0px' }}
    >
      {children}
    </MotionTag>
  );
}

/**
 * A single fade + slide-up reveal. Use inside RevealGroup for stagger, or
 * standalone (it will reveal itself on scroll). Reduced-motion safe.
 */
export function Reveal({
  children,
  className = '',
  y = 16,
  as = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  y?: number;
  as?: 'div' | 'section' | 'li' | 'span' | 'h2' | 'p';
}) {
  const reduce = useReducedMotion();
  const item: Variants = {
    hidden: reduce ? { opacity: 0 } : { opacity: 0, y },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.55, ease: HOUSE_EASE },
    },
  };
  const MotionTag = motion[as] as typeof motion.div;
  return (
    <MotionTag className={className} variants={item}>
      {children}
    </MotionTag>
  );
}

export { HOUSE_EASE };
