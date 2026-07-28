import React from 'react';
import { AnimatePresence, motion, useMotionValueEvent, type MotionValue } from 'motion/react';
import { Sparkles, CornerDownLeft } from 'lucide-react';
import {
  StorySection,
  StoryHeading,
  StoryReveal,
  StoryAnchor,
  HOUSE_EASE,
  useScrub,
  useSectionRange,
} from './StorySection';
import { useStoryScroll } from '../StoryScroll';
import { StoryOutline, StoryPulse, useCue } from '../StoryHighlight';
import { STORY_CONTACT } from '../storyContact';

/* ────────────────────────────────────────────────────────────────────────
   Beat 03 — ask your network, for real.

   This one the visitor operates themselves. Clicking an example question
   loads it into the bar; clicking Ask runs it.

   Every answer below is hardcoded, per question. Nothing here calls a model,
   a mock endpoint, or anything else over the network. A landing page demo
   has to be instant, identical on every load, impossible to rate-limit and
   free to serve — a real inference call is none of those things, and a
   marketing page is the worst possible place to discover that your API key
   rotated. The fidelity that matters here is that the *shape* of the answer
   is the product's real shape: a synthesis line, then the people, then why
   each one matched.
   ──────────────────────────────────────────────────────────────────────── */

type Result = { name: string; firm: string; why: string; isStory?: boolean };
type Scripted = {
  question: string;
  /** Lowercase keywords that also resolve to this answer if typed. */
  keywords: string[];
  read: number;
  synthesis: string;
  results: Result[];
};

const SCRIPTS: Scripted[] = [
  {
    question: 'Who did I meet this week?',
    keywords: ['week', 'recent', 'new', 'just met', 'this week'],
    read: 214,
    synthesis: `Three new contacts since Monday. ${STORY_CONTACT.firstName} is the warmest — you talked for a while and he hasn't been followed up yet.`,
    results: [
      {
        name: STORY_CONTACT.name,
        firm: STORY_CONTACT.company,
        why: `${STORY_CONTACT.metAt} · Tuesday · no follow-up yet`,
        isStory: true,
      },
      { name: 'Marcus Chen', firm: 'Flatiron Health', why: 'Panel Q&A · Wednesday' },
      { name: 'Olivia Martinez', firm: 'Google', why: 'Intro’d by James · Friday' },
    ],
  },
  {
    question: 'Which founders do I know at Michigan?',
    keywords: ['founder', 'michigan', 'ross', 'school', 'alumni', 'umich'],
    read: 214,
    synthesis: `Four founders in your directory came through Michigan. ${STORY_CONTACT.firstName} is the only one you've met in person this term.`,
    results: [
      {
        name: STORY_CONTACT.name,
        firm: `${STORY_CONTACT.company} · ${STORY_CONTACT.role}`,
        why: 'Ross undergrad · met in person Tuesday',
        isStory: true,
      },
      { name: 'Sarah Chen', firm: 'Sequoia Capital', why: 'Ross MBA ’19 · now investing' },
      { name: 'Daniel Osei', firm: 'Mayo Clinic', why: 'Michigan Med · clinical AI' },
    ],
  },
  {
    question: 'Who should I follow up with first?',
    keywords: ['follow up', 'followup', 'first', 'priority', 'next', 'owe'],
    read: 214,
    synthesis: `${STORY_CONTACT.firstName} first — the conversation is still warm and you said you'd send something. James is the opposite problem: 92 days of silence.`,
    results: [
      {
        name: STORY_CONTACT.name,
        firm: STORY_CONTACT.company,
        why: 'Met Tuesday · you owe him a note',
        isStory: true,
      },
      { name: 'James Taylor', firm: 'Morgan Stanley', why: 'Quiet 92 days · was strong' },
      { name: 'Sarah Chen', firm: 'Sequoia Capital', why: 'Said yes to a call · send times' },
    ],
  },
  {
    question: 'Who in healthcare have I not spoken to since spring?',
    keywords: ['healthcare', 'quiet', 'cold', 'spring', 'dormant', 'lapsed'],
    read: 214,
    synthesis:
      'Three healthcare contacts have gone quiet since March. Priya and Daniel owe you nothing — you owe them. Marcus replied and was never answered.',
    results: [
      { name: 'Priya Nair', firm: 'UnitedHealth', why: 'Payer strategy · quiet 118 days' },
      { name: 'Daniel Osei', firm: 'Mayo Clinic', why: 'Met at the panel · never followed up' },
      { name: 'Marcus Chen', firm: 'Flatiron Health', why: 'Replied in March · unanswered' },
    ],
  },
];

/** Exact question first, then keyword overlap, so free typing still lands. */
function resolve(query: string): Scripted | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const exact = SCRIPTS.find((s) => s.question.toLowerCase() === q);
  if (exact) return exact;

  let best: { script: Scripted; hits: number } | null = null;
  for (const script of SCRIPTS) {
    const hits = script.keywords.filter((k) => q.includes(k)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { script, hits };
  }
  return best?.script ?? null;
}

/* This beat has more to get through than any other — name the chip, invite
   the click, run the query, then point at the answer — and unlike the rest
   its middle step costs real time that scroll cannot scrub. So it is given a
   wider window than the page default rather than having its steps packed
   tighter together. */
const ASK_SPREAD = 0.78;

type Phase = { state: 'idle' } | { state: 'thinking' } | { state: 'answered'; script: Scripted | null };

export function AskSection() {
  const [query, setQuery] = React.useState(SCRIPTS[0].question);
  const [phase, setPhase] = React.useState<Phase>({ state: 'idle' });
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  /* Fix 5 — the beat completes itself for someone scrolling straight past.
     A visitor who never clicks Ask would otherwise leave this section having
     seen only the question, which is the setup without the payoff. If the
     scroll gets most of the way through the beat and nobody has touched
     anything, run the same populate-then-ask sequence a click would.

     `touched` is the guard, and it is deliberately a ref rather than state:
     it must be readable from inside the scroll subscription without making
     that subscription re-bind on every render. Once the visitor interacts —
     picking a chip, typing, or pressing Ask — this never fires. */
  const { progress, reduced } = useStoryScroll();
  const [rangeStart, rangeEnd] = useSectionRange(2, ASK_SPREAD);
  // After the Ask pulse has had its window, and far enough before the end of
  // the beat that the populate-then-ask sequence and its thinking pause still
  // finish while the answer panel is on screen. The beat is roughly twice as
  // long in scroll terms as it used to be, so this is a real pause rather
  // than a formality — there is time to press it yourself.
  const autoAt = rangeStart + (rangeEnd - rangeStart) * 0.52;
  const touched = React.useRef(false);
  const autoRan = React.useRef(false);

  /* Choreography. The chip is named first, then the invitation moves to the
     Ask button — and the pulse is timed to land *before* the auto-run at
     0.55 of the beat, so the invitation is real rather than decorative. A
     visitor who takes it gets there first; one who doesn't sees the page
     take its own advice. */
  const scrub = useScrub(2, ASK_SPREAD);
  const chipOutline = useCue(scrub, [0.05, 0.14], [0.26, 0.33]);
  const askPulse = useCue(scrub, [0.34, 0.43], [0.58, 0.65]);
  /* The callback onto his result card. Scrubbed, not latched to the click:
     an interaction-driven outline stayed lit for the rest of the page, which
     is the one thing this pass's highlights are not allowed to do. Its window
     opens after the auto-run at 0.55, so by the time it draws there is an
     answer under it either way. */
  const callback = useCue(scrub, [0.68, 0.78], [0.96, 1]);

  React.useEffect(() => () => clearTimeout(timer.current), []);

  const ask = React.useCallback((question: string) => {
    clearTimeout(timer.current);
    setPhase({ state: 'thinking' });
    // A short, fixed beat. Not a fake network call — just enough that the
    // answer reads as having been worked out rather than pre-printed.
    timer.current = setTimeout(() => {
      setPhase({ state: 'answered', script: resolve(question) });
    }, 420);
  }, []);

  const pick = (question: string) => {
    touched.current = true;
    clearTimeout(timer.current);
    setQuery(question);
    setPhase({ state: 'idle' });
  };

  useMotionValueEvent(progress, 'change', (p) => {
    if (autoRan.current || touched.current || p < autoAt) return;
    autoRan.current = true;
    const chosen = SCRIPTS[0];
    setQuery(chosen.question);
    // Populate, then ask — the same two steps, in the same order, with the
    // same pause between them a person clicking would produce.
    timer.current = setTimeout(() => ask(chosen.question), 300);
  });

  React.useEffect(() => {
    if (!reduced) return;
    // Reduced motion never scrubs, so the auto-run has nothing to hook onto.
    // Show the answer outright instead of leaving the beat unfinished.
    if (!touched.current && !autoRan.current) {
      autoRan.current = true;
      setPhase({ state: 'answered', script: SCRIPTS[0] });
    }
  }, [reduced]);

  return (
    <StorySection index={2} id="ask" className="bg-white/40">
      <StoryHeading
        index={2}
        className="mx-auto max-w-3xl text-center [&_h2]:mx-auto [&_h2]:max-w-[20ch] [&_p:last-of-type]:mx-auto [&_p:first-of-type]:justify-center"
        title="Ask a question. Get people, not rows."
        body="Type the thing you'd actually say out loud — no filters to stack, no tags to remember. Try it: the questions below run right here on the page."
      />

      <StoryReveal y={24} className="mt-10">
        <div className="mx-auto max-w-2xl">
          {/* Example questions. Clicking one replaces whatever is in the bar
              and resets the answer, so the visitor still presses Ask. */}
          <div className="mb-4 flex flex-wrap justify-center gap-2">
            {SCRIPTS.map((s, i) => {
              const selected = s.question === query;
              return (
                <button
                  key={s.question}
                  type="button"
                  onClick={() => pick(s.question)}
                  aria-pressed={selected}
                  className={`relative rounded-card border px-3 py-1.5 font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
                    selected
                      ? 'border-brand/40 bg-brand/10 text-ink'
                      : 'border-ink/15 bg-paper/70 text-muted hover:border-ink/30 hover:text-ink'
                  }`}
                >
                  {/* Only the first chip is outlined: it is the one the
                      passive-scroller auto-run picks, so pointing at it is
                      telling the truth about what is about to happen. */}
                  {i === 0 && <StoryAnchor stage={2} order={0} className="-left-3 -top-3" />}
                  {i === 0 && <StoryOutline show={chipOutline} inset={-4} radius={9} />}
                  “{s.question}”
                </button>
              );
            })}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              touched.current = true;
              ask(query);
            }}
            className="relative flex items-center gap-3 rounded-card border border-ink/25 bg-white px-4 py-3"
          >
            {/* The token lands on the ask bar — the thing this beat is about
                and the thing the visitor is meant to reach for. */}
            <StoryAnchor stage={2} className="-left-3 -top-3" />
            <Sparkles size={17} className="shrink-0 text-brand" />
            <input
              value={query}
              onChange={(e) => {
                touched.current = true;
                setQuery(e.target.value);
                setPhase({ state: 'idle' });
              }}
              aria-label="Ask your network"
              placeholder="Ask your network…"
              className="min-w-0 flex-1 bg-transparent font-mono text-sm font-semibold italic text-ink placeholder:not-italic placeholder:font-normal placeholder:text-muted focus:outline-none"
            />
            <span className="relative shrink-0">
              {/* The invitation. The token hops here from the chip before the
                  pulse starts — seeing it move to the control is what tells
                  you the control is the point. Its window still closes before
                  the auto-run so a real visitor gets a genuine chance to
                  click rather than watching the page do it for them. */}
              <StoryAnchor stage={2} order={1} weight={1.3} className="-left-3 -top-3" />
              <StoryPulse show={askPulse} inset={-7} radius={9} />
              <button
                type="submit"
                disabled={phase.state === 'thinking'}
                className="rounded-card bg-brand px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-brand-on transition-[transform,background-color] duration-150 hover:bg-[#8E2A3A] active:scale-[0.98] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                {phase.state === 'thinking' ? 'Asking' : 'Ask'}
              </button>
            </span>
          </form>

          <div className="relative mt-3 min-h-[280px]" aria-live="polite">
            <StoryAnchor stage={2} order={2} weight={2} className="-left-3 top-8" />
            <AnimatePresence mode="wait" initial={false}>
              {phase.state === 'idle' && (
                <Fade key="idle">
                  <p className="flex items-center justify-center gap-2 py-10 font-mono text-[11px] uppercase tracking-widest text-muted">
                    <CornerDownLeft size={12} /> Press Ask to run it
                  </p>
                </Fade>
              )}

              {phase.state === 'thinking' && (
                <Fade key="thinking">
                  <div className="flex items-center justify-center gap-2 py-10 font-mono text-[11px] uppercase tracking-widest text-muted">
                    <motion.span
                      className="h-1.5 w-1.5 rounded-full bg-brand"
                      animate={{ opacity: [0.25, 1, 0.25] }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                    />
                    Reading your directory
                  </div>
                </Fade>
              )}

              {phase.state === 'answered' && (
                <Fade key={`answer-${phase.script?.question ?? 'none'}`}>
                  {phase.script ? (
                    <Answer script={phase.script} callback={callback} />
                  ) : (
                    <div className="rounded-card border border-ink/15 bg-white p-5">
                      <p className="font-mono text-xs leading-relaxed text-subtle">
                        In the app this runs against your own directory, so it answers
                        anything. On this page the answers are scripted — pick one of the
                        questions above to see a real one.
                      </p>
                    </div>
                  )}
                </Fade>
              )}
            </AnimatePresence>
          </div>
        </div>
      </StoryReveal>
    </StorySection>
  );
}

function Fade({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.28, ease: HOUSE_EASE }}
    >
      {children}
    </motion.div>
  );
}

function Answer({ script, callback }: { script: Scripted; callback: MotionValue<number> }) {
  return (
    <div className="overflow-hidden rounded-card border border-ink/25 bg-white" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-center gap-2 border-b border-ink/10 bg-paper/50 px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest text-muted">
        <Sparkles size={13} className="text-brand" /> AI synthesis · {script.read} contacts read
      </div>
      <div className="p-4">
        <p className="rounded-card border border-ink/12 bg-accent/60 px-4 py-3 font-mono text-xs leading-relaxed">
          {script.synthesis}
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {script.results.map((r, i) => (
            <motion.div
              key={r.name}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.08 + i * 0.07, ease: HOUSE_EASE }}
              className={`relative rounded-card border p-3.5 ${
                r.isStory ? 'border-brand/40 bg-brand/[0.06]' : 'border-ink/15 bg-paper/50'
              }`}
            >
              {/* The callback. Of the three results, one of them is the
                  person this page has been following since the tap — so the
                  outline goes on that card and not the other two. */}
              {r.isStory && <StoryOutline show={callback} inset={-5} radius={10} />}
              <p className="font-serif text-base font-bold leading-tight">{r.name}</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted">
                {r.firm}
              </p>
              <p className="mt-2.5 font-mono text-[11px] leading-relaxed text-subtle">{r.why}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
