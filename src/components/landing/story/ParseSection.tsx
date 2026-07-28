import React from 'react';
import { motion, useTransform, type MotionValue } from 'motion/react';
import { Check, Sparkles } from 'lucide-react';
import {
  StorySection,
  StoryHeading,
  StoryReveal,
  StoryAnchor,
  useScrub,
  useSlotOpacity,
} from './StorySection';
import { useStoryScroll } from '../StoryScroll';
import { StoryOutline, StoryPulse, useCue } from '../StoryHighlight';
import { STORY_CONTACT } from '../storyContact';

/* ────────────────────────────────────────────────────────────────────────
   Beat 02 — the tap becomes a record.

   The point of this beat is that it is not an instant cut. The scrap of text
   the tap produced sits there, then the parsed fields land one at a time,
   and only then does the contact commit.

   That sequence is now scrubbed by scroll rather than played on a timer: the
   fields fill in as you scroll down and empty again as you scroll back up.
   The reveal starts at 32% of the beat's window — after the token has landed,
   which is what makes it read as "it arrives, *then* the record fills in"
   rather than the two happening at once — and finishes by 88%, so the record
   is complete while the beat is still the thing on screen.

   Every row reserves its final height before anything animates, so the card
   never reflows as it populates — the values fade into slots that were
   already the right size.
   ──────────────────────────────────────────────────────────────────────── */

const FIELDS = [
  { label: 'Name', value: STORY_CONTACT.name },
  { label: 'Role', value: STORY_CONTACT.role },
  { label: 'Company', value: STORY_CONTACT.company },
  { label: 'School', value: STORY_CONTACT.school },
  { label: 'Met at', value: `${STORY_CONTACT.metAt} · ${STORY_CONTACT.metWhen}` },
];

/** Reveal window inside the beat's own scroll range. */
const FILL: [number, number] = [0.46, 0.84];

export function ParseSection() {
  const { reduced } = useStoryScroll();
  const scrub = useScrub(1);

  /* Choreography. The token lands, dissolves, and the highlight walks the
     beat: raw text → the label doing the reading → the record being written.
     The form outline deliberately draws on just as FILL begins, so the
     outline is tracking the parse rather than announcing a finished box. */
  const rawOutline = useCue(scrub, [0.08, 0.18], [0.32, 0.4]);
  const readingPulse = useCue(scrub, [0.2, 0.28], [0.34, 0.42]);
  const formOutline = useCue(scrub, [0.42, 0.52], [0.9, 0.97]);

  // One slot per field plus a final slot for tags/commit.
  const slots = FIELDS.length + 1;
  const committed = useTransform(scrub, [FILL[0] + ((FILL[1] - FILL[0]) * 5) / 6, FILL[1]], [0, 1]);

  return (
    <StorySection index={1} id="parse">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-16">
        <StoryReveal className="lg:order-2" y={24}>
          <div className="relative">
            {/* What the tap actually handed over. Outlined first — the story
                here is that this scrap is what gets read. */}
            <div className="relative rounded-card border border-ink/15 bg-paper p-4 font-mono text-xs leading-relaxed text-muted">
              {/* First stop: the scrap being read. */}
              <StoryAnchor stage={1} order={0} className="-left-3 -top-3" />
              <StoryOutline show={rawOutline} />
              “{STORY_CONTACT.rawCapture}”
            </div>

            <div className="my-3 flex items-center gap-3">
              <span className="h-px flex-1 bg-ink/12" />
              <span className="relative flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted">
                <StoryPulse show={readingPulse} inset={-7} radius={7} />
                <Sparkles size={12} className="text-brand" /> Reading
              </span>
              <span className="h-px flex-1 bg-ink/12" />
            </div>

            <div className="relative">
              {/* Second stop, and the one that matters — heavier, so the
                  token settles here and dissolves while the record fills. */}
              <StoryAnchor stage={1} order={1} weight={2.4} className="-left-3 -top-3" />
              {/* …then dissolves, and the outline moves here to accompany the
                  fields as they resolve, rather than sitting on the raw text
                  while the real work happens somewhere else. */}
              <StoryOutline show={formOutline} />
              <div
                className="rounded-card border border-ink/25 bg-white p-5 md:p-6"
                style={{ boxShadow: 'var(--shadow-card)' }}
              >
                <div className="mb-4 flex items-center justify-between border-b border-ink/10 pb-4">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                    New contact
                  </span>
                  <motion.span
                    className="flex items-center gap-1.5 rounded-card bg-[var(--color-tier-strong-bg)] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-tier-strong-text)]"
                    style={{ opacity: reduced ? 1 : committed }}
                  >
                    <Check size={10} /> Saved
                  </motion.span>
                </div>

                <div className="space-y-3.5 font-mono text-sm">
                  {FIELDS.map((field, i) => (
                    <FieldRow
                      key={field.label}
                      {...field}
                      scrub={scrub}
                      slot={i}
                      slots={slots}
                      reduced={reduced}
                    />
                  ))}

                  {/* Tags land last, as one group. */}
                  <div className="grid grid-cols-3 items-center pt-1">
                    <span className="text-muted">Tags</span>
                    <span className="col-span-2 flex flex-wrap gap-2">
                      {STORY_CONTACT.tags.map((tag) => (
                        <motion.span
                          key={tag}
                          className="rounded-card bg-accent/60 px-2 py-0.5 text-[10px] uppercase tracking-wide"
                          style={{ opacity: reduced ? 1 : committed }}
                        >
                          {tag}
                        </motion.span>
                      ))}
                    </span>
                  </div>
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

function FieldRow({
  label,
  value,
  scrub,
  slot,
  slots,
  reduced,
}: {
  label: string;
  value: string;
  scrub: MotionValue<number>;
  slot: number;
  slots: number;
  reduced: boolean;
}) {
  const opacity = useSlotOpacity(scrub, slot, slots, FILL);
  const rule = useTransform(opacity, [0, 1], [1, 0]);

  return (
    <div className="grid grid-cols-3 border-b border-ink/10 pb-2.5">
      <span className="text-muted">{label}</span>
      <span className="relative col-span-2">
        {/* Placeholder rule occupying the slot until the value resolves, so
            the row's height never changes. */}
        <motion.span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-px w-16 -translate-y-1/2 bg-ink/15"
          style={{ opacity: reduced ? 0 : rule }}
        />
        <motion.span className="block font-semibold" style={{ opacity: reduced ? 1 : opacity }}>
          {value}
        </motion.span>
      </span>
    </div>
  );
}
