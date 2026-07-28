import React from 'react';
import { AnimatePresence, motion, useMotionValueEvent, useTransform } from 'motion/react';
import { Mail, Send, Sparkles } from 'lucide-react';
import {
  StorySection,
  StoryHeading,
  StoryReveal,
  StoryAnchor,
  ScrubbedText,
  useScrub,
  useSectionRange,
  HOUSE_EASE,
} from './StorySection';
import { useStoryScroll } from '../StoryScroll';
import { StoryOutline, StoryPulse, useCue } from '../StoryHighlight';
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
   reader's cursor. The caret rides on top of that, one per word, lit only
   while the scrub is inside its slot.

   The send is the one thing here that is a state change rather than a
   scrubbed value, for the same reason beat 03's answer is: it happens
   because someone pressed a button, or because the page pressed it for a
   visitor who scrolled straight past. Un-sending an email on scroll-up would
   be a strange thing to depict.
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
const SUBJECT_SHARE: [number, number] = [0.2, 0.32];
const GREETING_SHARE: [number, number] = [0.32, 0.38];
const BODY_SHARE: [number, number] = [0.36, 0.72];

export function DraftSection() {
  const { progress, reduced } = useStoryScroll();
  const scrub = useScrub(5);
  const [rangeStart, rangeEnd] = useSectionRange(5);

  const ready = useTransform(scrub, [0.72, 0.78], [0, 1]);
  const pulse = useTransform(scrub, [0.72, 0.78], [1, 0]);

  /* Choreography: the whole compose box is named on arrival, then the
     highlight gets out of the way and lets the caret do the work. */
  const composeOutline = useCue(scrub, [0.08, 0.18], [0.3, 0.38]);
  // The invitation only exists once there is a finished email to send.
  const sendPulse = useCue(scrub, [0.78, 0.84], [0.97, 1]);

  /* Send. Real click, or — for a visitor scrolling straight through — the
     same passive-completion pattern beat 03 already uses, with the same
     guarantee: any real interaction disables the automatic one for good, and
     it fires at the very end of the beat so a visitor who wants to press it
     themselves gets an unhurried window after the invitation appears. */
  const [sent, setSent] = React.useState(false);
  const touched = React.useRef(false);
  const autoRan = React.useRef(false);
  const autoAt = rangeStart + (rangeEnd - rangeStart) * 0.9;

  useMotionValueEvent(progress, 'change', (p) => {
    if (autoRan.current || touched.current || p < autoAt) return;
    autoRan.current = true;
    setSent(true);
  });

  React.useEffect(() => {
    if (reduced && !touched.current && !autoRan.current) {
      // Nothing scrubs under reduced motion, so the auto-send has no hook.
      autoRan.current = true;
      setSent(true);
    }
  }, [reduced]);

  return (
    <StorySection index={5} id="draft">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-16">
        <StoryReveal className="lg:order-2" y={24}>
          <div className="relative">
            <StoryAnchor stage={5} order={0} weight={2.6} className="-left-3 -top-3" />
            <StoryOutline show={composeOutline} />
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
                    {sent ? 'Sent' : 'Draft ready'}
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

              <div className="relative space-y-3 p-5 font-mono text-sm leading-relaxed">
                <p className="text-muted">
                  <span className="text-ink">To:</span> {STORY_CONTACT.email}
                </p>
                <p className="text-muted">
                  <span className="text-ink">Subject:</span>{' '}
                  <ScrubbedText text={SUBJECT} scrub={scrub} share={SUBJECT_SHARE} cursor />
                </p>
                <p>
                  <ScrubbedText text={GREETING} scrub={scrub} share={GREETING_SHARE} cursor />
                </p>
                <p className="text-subtle">
                  <ScrubbedText text={BODY} scrub={scrub} share={BODY_SHARE} cursor />
                </p>

                <motion.div className="flex gap-2 pt-2" style={{ opacity: reduced ? 1 : ready }}>
                  <span className="relative">
                    {/* Unmounted rather than faded once sent: the invitation
                        has been accepted, so there is nothing left to invite. */}
                    {/* The token walks over to Send once the draft is
                        written, for the same reason it walks to Ask. */}
                    <StoryAnchor stage={5} order={1} weight={1.2} className="-left-3 -top-3" />
                    {!sent && <StoryPulse show={sendPulse} inset={-7} radius={9} />}
                    <button
                      type="button"
                      onClick={() => {
                        touched.current = true;
                        setSent(true);
                      }}
                      disabled={sent}
                      className="inline-flex items-center gap-1.5 rounded-card bg-brand px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-brand-on transition-[transform,background-color] duration-150 hover:bg-[#8E2A3A] active:scale-[0.98] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                    >
                      <Send size={11} /> {sent ? 'Sent' : 'Send'}
                    </button>
                  </span>
                  <span className="inline-flex items-center rounded-card border border-ink/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-subtle">
                    Refine
                  </span>
                </motion.div>

              </div>
            </div>
            {/* Outside the card, not inside it: the card is overflow-hidden
                so an email launched from within it was neatly clipped at the
                border and never went anywhere. */}
            <FlyingMail sent={sent} reduced={reduced} />
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

/**
 * The email leaving. Transform and opacity only, and `pointer-events-none` so
 * it cannot swallow a click on its way out of the card.
 */
function FlyingMail({ sent, reduced }: { sent: boolean; reduced: boolean }) {
  if (reduced) return null;
  return (
    <AnimatePresence>
      {sent && (
        <motion.span
          key="flying"
          aria-hidden="true"
          className="pointer-events-none absolute bottom-8 left-8 z-10 text-brand"
          initial={{ opacity: 0, x: 0, y: 0, scale: 0.7 }}
          animate={{ opacity: [0, 1, 1, 0], x: 540, y: -150, scale: [0.7, 1, 1, 0.8] }}
          /* Opacity gets its own linear track. Sharing the house ease-out
             curve meant the eased progress was already past the fade-out
             keyframe a third of the way through the flight, so the mail
             vanished almost as soon as it set off. The path keeps the ease;
             the fade no longer inherits it.

             It also leaves to the right rather than straight up — a steeper
             exit flew it behind the sticky header, where nobody sees it. */
          transition={{
            duration: 1.3,
            ease: HOUSE_EASE,
            opacity: { duration: 1.3, ease: 'linear', times: [0, 0.08, 0.72, 1] },
          }}
        >
          <Mail size={22} />
        </motion.span>
      )}
    </AnimatePresence>
  );
}
