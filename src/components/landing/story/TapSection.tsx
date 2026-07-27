import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Nfc } from 'lucide-react';
import { StorySection, StoryHeading, StoryReveal, useSettledTrigger, HOUSE_EASE } from './StorySection';
import { STORY_CONTACT } from '../storyContact';
import { LogoMark } from '../../Logo';

/* ────────────────────────────────────────────────────────────────────────
   Beat 01 — the tap.

   The card flip, specifically. The earlier version bound rotateY straight to
   scroll position, so every scroll stutter was a visible rotation stutter,
   and how much of the turn you saw depended entirely on how fast you
   happened to be scrolling.

   The fix is to decouple trigger from playback. Entering view is the
   trigger; the turn is then a fixed-duration animation on its own timeline.
   `once: true` on the trigger means that once it has fired, scrolling —
   fast, slow, backwards — cannot touch it again. Everyone sees the same
   turn, at the same speed, exactly once.
   ──────────────────────────────────────────────────────────────────────── */

const TURN_DURATION = 1.15;

export function TapSection() {
  const cardRef = React.useRef<HTMLDivElement>(null);
  // 0.6 — "most of it visible". Then a beat of stillness so the front face
  // registers as a thing before it moves.
  const turned = useSettledTrigger(cardRef, { amount: 0.6, delay: 1000 });

  return (
    <StorySection index={0} id="tap">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-16">
        <StoryHeading
          index={0}
          title="It starts with a tap."
          body={
            <>
              You meet {STORY_CONTACT.firstName} at {STORY_CONTACT.metAt}. One tap of the
              Cirqle card against your phone and the introduction writes itself — no
              spelling out an email, no photographing a badge, no promising to look each
              other up later.
            </>
          }
        >
          <p className="mt-6 font-mono text-[11px] uppercase tracking-widest text-muted">
            Matte black. NFC on the back.
          </p>
        </StoryHeading>

        <StoryReveal y={24}>
          <div ref={cardRef} className="flex justify-center">
            <div className="relative">
              <TapRipple />
              {/* Perspective lives on the rotating element itself — a second
                  one on a wrapper would compound and exaggerate the turn. */}
              <motion.div
                className="relative h-[202px] w-[320px] md:h-[240px] md:w-[380px]"
                style={{ transformPerspective: 1600, transformStyle: 'preserve-3d' }}
                // No reduced-motion branch needed: the app-root MotionConfig
                // runs reducedMotion="user", which settles straight on the end
                // value — those readers still see the back face, without the
                // rotation.
                animate={{ rotateY: turned ? 180 : 0 }}
                transition={{ duration: TURN_DURATION, ease: HOUSE_EASE }}
              >
                <CardFace side="front" />
                <CardFace side="back" />
              </motion.div>
            </div>
          </div>
        </StoryReveal>
      </div>
    </StorySection>
  );
}

/**
 * The tap itself — rings leaving the card's NFC corner. Pure scale + opacity
 * on a fixed-size element, so nothing here touches layout.
 */
function TapRipple() {
  const reduce = useReducedMotion();
  if (reduce) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none absolute -right-6 -top-6 h-24 w-24">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="absolute inset-0 rounded-full border border-brand/60"
          initial={{ scale: 0.25, opacity: 0 }}
          animate={{ scale: [0.25, 1], opacity: [0, 0.7, 0] }}
          transition={{
            duration: 2.4,
            delay: i * 0.8,
            repeat: Infinity,
            repeatDelay: 0.6,
            ease: 'easeOut',
          }}
        />
      ))}
    </div>
  );
}

/**
 * A physical product is being depicted rather than a UI surface, so this one
 * card gets more dimensionality and sheen than the flat hairline language
 * everywhere else on the page — that contrast is the point.
 */
function CardFace({ side }: { side: 'front' | 'back' }) {
  const front = side === 'front';
  return (
    <div
      className="absolute inset-0 overflow-hidden rounded-[14px]"
      style={{
        backfaceVisibility: 'hidden',
        WebkitBackfaceVisibility: 'hidden',
        transform: front ? undefined : 'rotateY(180deg)',
        background: 'linear-gradient(145deg, #232323 0%, #101010 46%, #262626 100%)',
        boxShadow:
          '0 26px 60px -28px rgba(26,26,26,0.72), 0 8px 20px -12px rgba(26,26,26,0.45), inset 0 1px 0 rgba(255,255,255,0.10)',
      }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(112deg, rgba(255,255,255,0) 34%, rgba(255,255,255,0.10) 47%, rgba(255,255,255,0) 60%)',
        }}
      />
      {front ? (
        <div className="relative flex h-full flex-col justify-between p-6 md:p-7">
          <div className="flex items-start justify-between">
            <LogoMark px={32} className="text-paper/85" />
            <Nfc size={19} className="text-paper/45" />
          </div>
          <div>
            <div className="font-serif text-[26px] font-black italic leading-none tracking-tight text-paper md:text-[30px]">
              {STORY_CONTACT.name}
            </div>
            <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.28em] text-paper/45">
              {STORY_CONTACT.role} · {STORY_CONTACT.company}
            </div>
          </div>
        </div>
      ) : (
        <div className="relative flex h-full flex-col justify-between p-6 md:p-7">
          <div className="font-mono text-[9px] uppercase tracking-[0.28em] text-paper/45">
            Tap to connect
          </div>
          <div className="space-y-2.5">
            <div className="h-px w-full bg-paper/15" />
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-paper/80">
              {STORY_CONTACT.handle}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" />
              <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-paper/45">
                Contact written on tap
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
