import React from 'react';
import { motion, useTransform } from 'motion/react';
import { Send, Sparkles } from 'lucide-react';
import {
  StorySection,
  StoryHeading,
  StoryReveal,
  StoryAnchor,
  ScrubbedText,
  useScrub,
} from './StorySection';
import { useStoryScroll } from '../StoryScroll';
import { STORY_CONTACT } from '../storyContact';

/* ────────────────────────────────────────────────────────────────────────
   Beat 06 — the loop closes.

   The draft assembles as you scroll: subject, then the greeting, then the
   body, then the send row. Scrolling back up un-writes it. Nothing pops in
   finished and nothing plays out on a timer you can't influence — the
   scroll is doing the writing.

   The text assembles by per-word opacity over a paragraph already at its
   final size (see ScrubbedText). A real character-appending typewriter would
   reflow the card on every frame and shove the send button around under the
   reader's cursor.
   ──────────────────────────────────────────────────────────────────────── */

const SUBJECT = `Following up from ${STORY_CONTACT.metAt}`;
const GREETING = `Hi ${STORY_CONTACT.firstName},`;
const BODY =
  `Really enjoyed talking on ${STORY_CONTACT.metWhen} — you were describing how ` +
  `${STORY_CONTACT.company} handles the messy half of a contact, the part nobody ` +
  `writes down. I've been chewing on that since. Would love 20 minutes to compare ` +
  `notes properly, and I owe you an intro to Sarah at Sequoia either way.`;

/* The token lands across the first 30%, then the draft writes itself, and
   the send row is up by 92% — early enough that the finished email is still
   centred rather than on its way off the top of the screen. */
const SUBJECT_SHARE: [number, number] = [0.3, 0.45];
const GREETING_SHARE: [number, number] = [0.45, 0.52];
const BODY_SHARE: [number, number] = [0.52, 0.85];

export function DraftSection() {
  const { reduced } = useStoryScroll();
  const scrub = useScrub(5);

  const ready = useTransform(scrub, [0.85, 0.92], [0, 1]);
  const pulse = useTransform(scrub, [0.85, 0.92], [1, 0]);

  return (
    <StorySection index={5} id="draft">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-16">
        <StoryReveal className="lg:order-2" y={24}>
          <div className="relative">
            <StoryAnchor stage={5} className="-left-3 -top-3" />
            <div
              className="overflow-hidden rounded-card border border-ink/25 bg-white"
              style={{ boxShadow: 'var(--shadow-card)' }}
            >
              <div className="flex items-center gap-2 border-b border-ink/10 bg-paper/50 px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-muted">
                <Sparkles size={13} className="text-brand" />
                <span className="relative">
                  <motion.span style={{ opacity: reduced ? 0 : pulse }}>Drafting</motion.span>
                  <motion.span
                    className="absolute left-0 top-0 whitespace-nowrap"
                    style={{ opacity: reduced ? 1 : ready }}
                  >
                    Draft ready
                  </motion.span>
                </span>
                <motion.span
                  className="ml-auto h-1.5 w-1.5 rounded-full bg-brand"
                  animate={reduced ? { opacity: 1 } : { opacity: [0.25, 1, 0.25] }}
                  transition={
                    reduced ? { duration: 0 } : { duration: 1, repeat: Infinity, ease: 'easeInOut' }
                  }
                />
              </div>

              <div className="space-y-3 p-5 font-mono text-sm leading-relaxed">
                <p className="text-muted">
                  <span className="text-ink">To:</span> {STORY_CONTACT.email}
                </p>
                <p className="text-muted">
                  <span className="text-ink">Subject:</span>{' '}
                  <ScrubbedText text={SUBJECT} scrub={scrub} share={SUBJECT_SHARE} />
                </p>
                <p>
                  <ScrubbedText text={GREETING} scrub={scrub} share={GREETING_SHARE} />
                </p>
                <p className="text-subtle">
                  <ScrubbedText text={BODY} scrub={scrub} share={BODY_SHARE} />
                </p>

                <motion.div className="flex gap-2 pt-2" style={{ opacity: reduced ? 1 : ready }}>
                  <span className="inline-flex items-center gap-1.5 rounded-card bg-brand px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-brand-on">
                    <Send size={11} /> Send
                  </span>
                  <span className="inline-flex items-center rounded-card border border-ink/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-subtle">
                    Refine
                  </span>
                </motion.div>
              </div>
            </div>
          </div>
        </StoryReveal>

        <StoryHeading
          index={5}
          className="lg:order-1"
          title="And the note writes itself."
          body={
            <>
              Every draft is built from your real history with a person — where you met,
              what they said, what you promised. One tap on a card five minutes ago, and
              this is the message waiting for you: in your voice, about
              {' '}{STORY_CONTACT.firstName} specifically, worth actually sending.
            </>
          }
        />
      </div>
    </StorySection>
  );
}
