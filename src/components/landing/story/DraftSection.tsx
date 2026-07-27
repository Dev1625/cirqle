import React from 'react';
import { motion } from 'motion/react';
import { Send, Sparkles } from 'lucide-react';
import {
  StorySection,
  StoryHeading,
  StoryReveal,
  AssemblingText,
  useSettledTrigger,
  HOUSE_EASE,
} from './StorySection';
import { STORY_CONTACT } from '../storyContact';

/* ────────────────────────────────────────────────────────────────────────
   Beat 06 — the loop closes.

   Reaching this section triggers the draft building itself: subject first,
   then the greeting, then the body, then the send row. Nothing pops in
   finished, and nothing is scrubbed by scroll — arriving is the trigger, the
   build is its own fixed timeline.

   The text assembles by per-word opacity over a paragraph that is already at
   its final size (see AssemblingText). A real character-appending typewriter
   would reflow the card on every frame and shove the send button around
   underneath the reader's cursor.
   ──────────────────────────────────────────────────────────────────────── */

const SUBJECT = `Following up from ${STORY_CONTACT.metAt}`;
const GREETING = `Hi ${STORY_CONTACT.firstName},`;
const BODY =
  `Really enjoyed talking on ${STORY_CONTACT.metWhen} — you were describing how ` +
  `${STORY_CONTACT.company} handles the messy half of a contact, the part nobody ` +
  `writes down. I've been chewing on that since. Would love 20 minutes to compare ` +
  `notes properly, and I owe you an intro to Sarah at Sequoia either way.`;

export function DraftSection() {
  const cardRef = React.useRef<HTMLDivElement>(null);
  const building = useSettledTrigger(cardRef, { amount: 0.45, delay: 450 });

  const [stage, setStage] = React.useState<'subject' | 'greeting' | 'body' | 'done'>('subject');

  return (
    <StorySection index={5} id="draft">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-16">
        <StoryReveal className="lg:order-2" y={24}>
          <div
            ref={cardRef}
            className="overflow-hidden rounded-card border border-ink/25 bg-white"
            style={{ boxShadow: 'var(--shadow-card)' }}
          >
            <div className="flex items-center gap-2 border-b border-ink/10 bg-paper/50 px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-muted">
              <Sparkles size={13} className="text-brand" />
              {stage === 'done' ? 'Draft ready' : 'Drafting'}
              <motion.span
                className="ml-auto h-1.5 w-1.5 rounded-full bg-brand"
                animate={stage === 'done' ? { opacity: 1 } : { opacity: [0.25, 1, 0.25] }}
                transition={
                  stage === 'done'
                    ? { duration: 0.3 }
                    : { duration: 1, repeat: Infinity, ease: 'easeInOut' }
                }
              />
            </div>

            <div className="space-y-3 p-5 font-mono text-sm leading-relaxed">
              <p className="text-muted">
                <span className="text-ink">To:</span> {STORY_CONTACT.email}
              </p>
              <p className="text-muted">
                <span className="text-ink">Subject:</span>{' '}
                <AssemblingText
                  text={SUBJECT}
                  active={building}
                  perWord={0.07}
                  onDone={() => setStage('greeting')}
                />
              </p>
              <p>
                <AssemblingText
                  text={GREETING}
                  active={stage !== 'subject'}
                  perWord={0.09}
                  onDone={() => setStage('body')}
                />
              </p>
              <p className="text-subtle">
                <AssemblingText
                  text={BODY}
                  active={stage === 'body' || stage === 'done'}
                  perWord={0.035}
                  onDone={() => setStage('done')}
                />
              </p>

              <motion.div
                className="flex gap-2 pt-2"
                initial={{ opacity: 0, y: 6 }}
                animate={stage === 'done' ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
                transition={{ duration: 0.4, ease: HOUSE_EASE }}
              >
                <span className="inline-flex items-center gap-1.5 rounded-card bg-brand px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-brand-on">
                  <Send size={11} /> Send
                </span>
                <span className="inline-flex items-center rounded-card border border-ink/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-subtle">
                  Refine
                </span>
              </motion.div>
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
