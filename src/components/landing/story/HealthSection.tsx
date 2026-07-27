import React from 'react';
import { motion, useTransform, type MotionValue } from 'motion/react';
import {
  StorySection,
  StoryHeading,
  StoryReveal,
  StoryAnchor,
  useScrub,
  useSlotOpacity,
} from './StorySection';
import { useStoryScroll } from '../StoryScroll';
import { STORY_CONTACT, STORY_INITIALS } from '../storyContact';

/* ────────────────────────────────────────────────────────────────────────
   Beat 05 — nothing falls through the cracks.

   The same contact, now carrying a health signal. He is at the front of the
   queue not because he is cold but because he is the freshest warm thing you
   have and the clock has started — the more honest version of "no warm intro
   goes cold" than yet another overdue row.

   Scrubbed like the rest: the ring fills, the score counts, and the three
   detail rows arrive as you scroll, and reverse if you scroll back. The ring
   sweep is the page's one knowing exception to the transform/opacity rule —
   see HealthRing below.
   ──────────────────────────────────────────────────────────────────────── */

const RING = { size: 76, stroke: 5 };

/** The token arrives across the first 30%; the card fills in after it, and
 *  is finished by 86% so it completes while the beat is still centred. */
const FILL: [number, number] = [0.3, 0.86];

const DETAILS = [
  ['Met', `${STORY_CONTACT.metAt} · ${STORY_CONTACT.metWhen}`],
  ['Last touch', 'None yet — you owe the first note'],
  ['Decays to Warm in', '9 days'],
];

export function HealthSection() {
  const { reduced } = useStoryScroll();
  const scrub = useScrub(4);

  return (
    <StorySection index={4} id="queue" bleed={<QueueMarquee scrub={scrub} reduced={reduced} />}>
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-16">
        <StoryHeading
          index={4}
          title="No warm intro goes cold."
          body={
            <>
              Every relationship gets a health score that decays on its own. The follow-up
              queue reads the whole pipeline and surfaces who needs you next — who's
              overdue, who just replied, who's drifting. {STORY_CONTACT.firstName} is at the
              top of yours, because warm is a thing you can lose.
            </>
          }
        />

        <StoryReveal y={24}>
          <div className="relative">
            <StoryAnchor stage={4} className="-left-3 -top-3" />
            <div
              className="rounded-card border border-ink/25 bg-white p-6"
              style={{ boxShadow: 'var(--shadow-card)' }}
            >
              <div className="flex items-center gap-5">
                <HealthRing scrub={scrub} reduced={reduced} />
                <div className="min-w-0">
                  <p className="font-serif text-2xl font-bold leading-tight">
                    {STORY_CONTACT.name}
                  </p>
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted">
                    {STORY_CONTACT.role} · {STORY_CONTACT.company}
                  </p>
                  <span className="mt-3 inline-block rounded-card bg-[var(--color-tier-strong-bg)] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-tier-strong-text)]">
                    {STORY_CONTACT.tier}
                  </span>
                </div>
              </div>

              <div className="mt-6 space-y-3 border-t border-ink/10 pt-5">
                {DETAILS.map(([k, v], i) => (
                  <DetailRow
                    key={k}
                    label={k}
                    value={v}
                    scrub={scrub}
                    slot={i}
                    slots={DETAILS.length}
                    reduced={reduced}
                  />
                ))}
              </div>
            </div>
          </div>
        </StoryReveal>
      </div>
    </StorySection>
  );
}

function DetailRow({
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
  return (
    <motion.div
      className="grid grid-cols-3 gap-3 font-mono text-xs"
      style={{ opacity: reduced ? 1 : opacity }}
    >
      <span className="text-muted">{label}</span>
      <span className="col-span-2 text-subtle">{value}</span>
    </motion.div>
  );
}

/**
 * The one deliberate exception to the transform/opacity rule on this page.
 *
 * The arc sweeps via `stroke-dashoffset`, which is a paint property, not a
 * compositor one. It is used here knowingly: the rule exists to keep
 * scroll-linked work off the layout path, and stroke-dashoffset triggers
 * neither layout nor reflow — it repaints one 76px SVG circle. The strictly
 * compliant alternative is a pair of counter-rotating half-ring wedges
 * behind clip masks, which is materially more code and more fragile for no
 * measurable gain at this size. Flagged rather than hidden.
 *
 * The number is driven from the same scrub through a MotionValue rather than
 * React state, so it counts without re-rendering the tree every frame.
 */
function HealthRing({ scrub, reduced }: { scrub: MotionValue<number>; reduced: boolean }) {
  const r = (RING.size - RING.stroke) / 2;
  const c = 2 * Math.PI * r;
  const target = STORY_CONTACT.health;

  const fill = useTransform(scrub, [FILL[0], FILL[0] + (FILL[1] - FILL[0]) * 0.7], [0, 1]);
  const dash = useTransform(fill, (f) => c * (1 - (reduced ? 1 : f) * (target / 100)));
  const score = useTransform(fill, (f) => Math.round((reduced ? 1 : f) * target).toString());

  return (
    <div className="relative shrink-0" style={{ width: RING.size, height: RING.size }}>
      <svg width={RING.size} height={RING.size} className="-rotate-90" aria-hidden="true">
        <circle
          cx={RING.size / 2}
          cy={RING.size / 2}
          r={r}
          fill="none"
          stroke="rgba(26,26,26,0.12)"
          strokeWidth={RING.stroke}
        />
        <motion.circle
          cx={RING.size / 2}
          cy={RING.size / 2}
          r={r}
          fill="none"
          stroke="#7A2331"
          strokeWidth={RING.stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          style={{ strokeDashoffset: dash }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-serif text-xl font-black tabular-nums">
        <motion.span aria-label={`Relationship health ${target} out of 100`}>{score}</motion.span>
      </span>
    </div>
  );
}

/**
 * The follow-up queue, drifting.
 *
 * The copy says the list keeps going, so it actually does: the track holds
 * two identical copies and translates by exactly one copy's width, which is
 * why the cards carry their own right margin rather than the track carrying
 * a gap — with a gap the loop is one gap short and visibly jumps every pass.
 *
 * Deliberately slow: ambient movement to be caught out of the corner of your
 * eye while reading the heading, not a carousel demanding attention. Pauses
 * on hover so a card can be read, and the global prefers-reduced-motion rule
 * in index.css stops it outright.
 */
function QueueMarquee({ scrub, reduced }: { scrub: MotionValue<number>; reduced: boolean }) {
  const track = [...QUEUE, ...QUEUE];
  const opacity = useTransform(scrub, [0.34, 0.55], [0, 1]);
  const y = useTransform(scrub, [0.34, 0.55], [24, 0]);

  return (
    <motion.div className="mt-12" style={{ opacity: reduced ? 1 : opacity, y: reduced ? 0 : y }}>
      {/* Fade width is set in CSS, not inline: at xl the narrative token
          travels across this row's left edge, so the mask has to widen past
          it or cards slide out from under the token. */}
      <div className="marquee-mask overflow-hidden">
        <div className="marquee-track flex w-max">
          {track.map((q, i) => (
            <div
              key={`${q.name}-${i}`}
              aria-hidden={i >= QUEUE.length ? true : undefined}
              className="mr-4 w-[290px] shrink-0"
            >
              <div
                className={`h-full rounded-card border p-5 ${
                  q.isStory ? 'border-brand/40 bg-brand/[0.06]' : 'border-ink/15 bg-white'
                }`}
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span className="truncate font-serif text-lg font-bold">{q.name}</span>
                  <span
                    className={`shrink-0 rounded-card px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest ${q.tone}`}
                  >
                    {q.status}
                  </span>
                </div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted">{q.firm}</p>
                <p className="mt-4 font-mono text-sm leading-relaxed text-subtle">{q.action}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

const QUEUE = [
  {
    name: STORY_CONTACT.name,
    firm: `${STORY_CONTACT.company} · ${STORY_INITIALS}`,
    status: 'First note',
    tone: 'bg-[var(--color-tier-strong-bg)] text-[var(--color-tier-strong-text)]',
    action: 'Met Tuesday — send the follow-up while it’s still warm.',
    isStory: true,
  },
  {
    name: 'James Taylor',
    firm: 'Morgan Stanley',
    status: 'Overdue',
    tone: 'bg-[var(--color-tier-dormant-bg)] text-[var(--color-tier-dormant-text)]',
    action: 'Send a check-in note — 92 days quiet.',
  },
  {
    name: 'Sarah Chen',
    firm: 'Sequoia Capital',
    status: 'Replied',
    tone: 'bg-emerald-50 text-emerald-700',
    action: 'She said yes to a call — send times.',
  },
  {
    name: 'Marcus Johnson',
    firm: 'McKinsey & Co',
    status: 'Follow up',
    tone: 'bg-[var(--color-tier-warm-bg)] text-[var(--color-tier-warm-text)]',
    action: 'Bump your last note to the top of his inbox.',
  },
  {
    name: 'Olivia Martinez',
    firm: 'Google',
    status: 'Thank',
    tone: 'bg-blue-50 text-blue-700',
    action: 'She sent the intro — close the loop.',
  },
];
