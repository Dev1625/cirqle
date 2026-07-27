import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Check, Sparkles } from 'lucide-react';
import { StorySection, StoryHeading, StoryReveal, useSettledTrigger, HOUSE_EASE } from './StorySection';
import { STORY_CONTACT } from '../storyContact';

/* ────────────────────────────────────────────────────────────────────────
   Beat 02 — the tap becomes a record.

   The point of this beat is that it is not an instant cut. The scrap of text
   the tap produced sits there for a moment, then the parsed fields land one
   at a time, in the order the model actually resolves them, and only then
   does the contact commit. Watching it fill in is the argument.

   Every row reserves its final height before anything animates, so the card
   never reflows as it populates — the values fade and rise into slots that
   were already the right size.
   ──────────────────────────────────────────────────────────────────────── */

const FIELDS = [
  { label: 'Name', value: STORY_CONTACT.name },
  { label: 'Role', value: STORY_CONTACT.role },
  { label: 'Company', value: STORY_CONTACT.company },
  { label: 'School', value: STORY_CONTACT.school },
  { label: 'Met at', value: `${STORY_CONTACT.metAt} · ${STORY_CONTACT.metWhen}` },
];

const STEP_MS = 420;

/** Advances a step counter on a fixed cadence once triggered. */
function useStepper(active: boolean, steps: number, intervalMs: number) {
  const reduce = useReducedMotion();
  const [step, setStep] = React.useState(0);

  React.useEffect(() => {
    if (!active) return;
    if (reduce) {
      // Reduced motion still gets the end state — the story is the filled
      // record, and only the staging is motion.
      setStep(steps);
      return;
    }
    let current = 0;
    const id = setInterval(() => {
      current += 1;
      setStep(current);
      if (current >= steps) clearInterval(id);
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, steps, intervalMs, reduce]);

  return step;
}

export function ParseSection() {
  const cardRef = React.useRef<HTMLDivElement>(null);
  const started = useSettledTrigger(cardRef, { amount: 0.45, delay: 500 });
  // One step per field, plus a final one for the tags/commit row.
  const step = useStepper(started, FIELDS.length + 1, STEP_MS);
  const done = step > FIELDS.length;

  return (
    <StorySection index={1} id="parse">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-16">
        <StoryReveal className="lg:order-2" y={24}>
          <div ref={cardRef}>
            {/* What the tap actually handed over. */}
            <div className="rounded-card border border-ink/15 bg-paper p-4 font-mono text-xs leading-relaxed text-muted">
              “{STORY_CONTACT.rawCapture}”
            </div>

            <div className="my-3 flex items-center gap-3">
              <span className="h-px flex-1 bg-ink/12" />
              <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted">
                <Sparkles size={12} className="text-brand" />
                {done ? 'Added to your circle' : 'Reading'}
              </span>
              <span className="h-px flex-1 bg-ink/12" />
            </div>

            <div className="rounded-card border border-ink/25 bg-white p-5 md:p-6" style={{ boxShadow: 'var(--shadow-card)' }}>
              <div className="mb-4 flex items-center justify-between border-b border-ink/10 pb-4">
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                  New contact
                </span>
                <motion.span
                  className="flex items-center gap-1.5 rounded-card bg-[var(--color-tier-strong-bg)] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-tier-strong-text)]"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: done ? 1 : 0 }}
                  transition={{ duration: 0.35, ease: HOUSE_EASE }}
                >
                  <Check size={10} /> Saved
                </motion.span>
              </div>

              <div className="space-y-3.5 font-mono text-sm">
                {FIELDS.map((field, i) => (
                  <FieldRow key={field.label} {...field} filled={step > i} />
                ))}

                {/* Tags land last, as one group. */}
                <div className="grid grid-cols-3 items-center pt-1">
                  <span className="text-muted">Tags</span>
                  <span className="col-span-2 flex flex-wrap gap-2">
                    {STORY_CONTACT.tags.map((tag, i) => (
                      <motion.span
                        key={tag}
                        className="rounded-card bg-accent/60 px-2 py-0.5 text-[10px] uppercase tracking-wide"
                        initial={{ opacity: 0, y: 4 }}
                        animate={done ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
                        transition={{ duration: 0.35, delay: i * 0.08, ease: HOUSE_EASE }}
                      >
                        {tag}
                      </motion.span>
                    ))}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </StoryReveal>

        <StoryHeading
          index={1}
          className="lg:order-1"
          title="By the time you look up, they're filed."
          body={
            <>
              The tap hands over a scrap of text. Cirqle reads it and writes a real record —
              name, role, company, where you met and when — then tags it and drops it into
              your directory. You never open a form.
            </>
          }
        />
      </div>
    </StorySection>
  );
}

function FieldRow({ label, value, filled }: { label: string; value: string; filled: boolean }) {
  return (
    <div className="grid grid-cols-3 border-b border-ink/10 pb-2.5">
      <span className="text-muted">{label}</span>
      <span className="col-span-2 relative">
        {/* Placeholder rule occupying the slot until the value resolves, so
            the row's height never changes. */}
        <motion.span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-px w-16 -translate-y-1/2 bg-ink/15"
          initial={{ opacity: 1 }}
          animate={{ opacity: filled ? 0 : 1 }}
          transition={{ duration: 0.2 }}
        />
        <motion.span
          className="block font-semibold"
          initial={{ opacity: 0, y: 5 }}
          animate={filled ? { opacity: 1, y: 0 } : { opacity: 0, y: 5 }}
          transition={{ duration: 0.35, ease: HOUSE_EASE }}
        >
          {value}
        </motion.span>
      </span>
    </div>
  );
}
