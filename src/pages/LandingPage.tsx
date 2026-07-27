import React from 'react';
import { Link } from 'react-router-dom';
import { motion, useInView, useReducedMotion, type Variants } from 'motion/react';
import { ArrowRight, Sparkles, Send, ListTodo, Network, Nfc, Mail, CalendarDays, Compass, Search } from 'lucide-react';
import { CountUp } from '../components/landing/CountUp';
import { Reveal, RevealGroup } from '../components/landing/motion';
import { LandingGraph } from '../components/landing/LandingGraph';
import { StoryScrollProvider } from '../components/landing/StoryScroll';
import { ScrollProbe } from '../components/landing/ScrollProbe';
import { Logo, LogoMark } from '../components/Logo';

const HOUSE_EASE = [0.22, 1, 0.36, 1] as const;
// Ease-out-back — the single deliberate overshoot, used only on the hero's
// first paint (per CIRQLE_DESIGN_SYSTEM.md Part 4). Not a house-wide curve.
const OVERSHOOT = [0.34, 1.4, 0.64, 1] as const;

const primaryCta =
  'inline-flex items-center justify-center gap-2 rounded-card bg-brand text-brand-on px-7 py-3.5 font-mono text-xs uppercase tracking-widest font-bold hover:bg-[#8E2A3A] active:bg-[#661D29] active:scale-[0.98] transition-[transform,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper';
const secondaryCta =
  'inline-flex items-center justify-center gap-2 rounded-card border border-ink/15 px-7 py-3.5 font-mono text-xs uppercase tracking-widest font-bold hover:bg-ink hover:text-paper transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper';

function HeroHeadline() {
  const reduce = useReducedMotion();
  const line1 = ['Your', 'network', 'is', 'your', 'net', 'worth.'];

  const container: Variants = {
    hidden: {},
    visible: { transition: { staggerChildren: reduce ? 0 : 0.07, delayChildren: 0.15 } },
  };
  const word: Variants = {
    hidden: reduce ? { opacity: 0 } : { opacity: 0, y: '0.5em' },
    visible: { opacity: 1, y: 0, transition: { duration: 0.7, ease: OVERSHOOT } },
  };

  return (
    <motion.h1
      variants={container}
      initial="hidden"
      animate="visible"
      className="font-serif text-[clamp(2.6rem,7vw,5.25rem)] leading-[0.98] tracking-tight text-balance"
    >
      <span className="inline-flex flex-wrap gap-x-[0.28em]">
        {line1.map((w, i) => (
          <motion.span key={i} variants={word} className="inline-block">
            {w}
          </motion.span>
        ))}
      </span>
      <motion.span variants={word} className="block italic text-brand mt-1">
        Manage it like it.
      </motion.span>
    </motion.h1>
  );
}

export default function LandingPage() {
  return (
    <StoryScrollProvider>
      <LandingStory />
    </StoryScrollProvider>
  );
}

function LandingStory() {
  const reduce = useReducedMotion();

  return (
    <div className="w-full overflow-x-clip">
      <ScrollProbe />
      {/* ── Hero ───────────────────────────────────────────────── */}
      <section className="story-section max-w-6xl mx-auto px-6 md:px-8 pt-16 pb-20 md:pt-24 md:pb-28">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-8 items-center">
          <div className="lg:col-span-6">
            <motion.p
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: HOUSE_EASE }}
              className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted mb-6 flex items-center gap-2"
            >
              <Sparkles size={13} className="text-brand" /> AI personal CRM
            </motion.p>

            <HeroHeadline />

            <motion.p
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.6, ease: HOUSE_EASE }}
              className="mt-8 font-mono text-sm md:text-base leading-relaxed text-subtle max-w-[52ch]"
            >
              Cirqle turns scattered contacts, half-remembered conversations, and cold
              threads into one living map — with AI that parses, drafts, and remembers,
              so you stay in touch like it matters. Because it does.
            </motion.p>

            <motion.div
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.75, ease: HOUSE_EASE }}
              className="mt-10 flex flex-col sm:flex-row gap-3"
            >
              <Link to="/signup" className={primaryCta}>
                Start for free <ArrowRight size={15} />
              </Link>
              <a href="#network" className={secondaryCta}>
                See the network
              </a>
            </motion.div>
          </div>

          {/* Product panel — flat, hairline, bleeds past the right edge */}
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.35, ease: HOUSE_EASE }}
            className="lg:col-span-6 lg:-mr-16 xl:-mr-28"
          >
            <div className="bg-white border border-ink/15 rounded-card p-6 md:p-7">
              <div className="flex items-center justify-between border-b border-ink/10 pb-4 mb-5">
                <span className="font-serif italic text-lg flex items-center gap-2">
                  <Sparkles size={15} className="text-brand" /> Contact parsed
                </span>
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted">2.8s</span>
              </div>
              <div className="space-y-3.5 font-mono text-sm">
                {[
                  ['Name', 'Sarah Jenkins'],
                  ['Company', 'Goldman Sachs'],
                  ['Role', 'Managing Director'],
                ].map(([k, v]) => (
                  <div key={k} className="grid grid-cols-3 border-b border-ink/10 pb-2.5">
                    <span className="text-muted">{k}</span>
                    <span className="col-span-2 font-semibold">{v}</span>
                  </div>
                ))}
                <div className="grid grid-cols-3 items-center pt-1">
                  <span className="text-muted">Tags</span>
                  <span className="col-span-2 flex flex-wrap gap-2">
                    {['IBD', 'Alumni', 'Warm intro'].map((t) => (
                      <span key={t} className="rounded-card bg-accent/60 px-2 py-0.5 text-[10px] uppercase tracking-wide">
                        {t}
                      </span>
                    ))}
                  </span>
                </div>
              </div>
              <div className="mt-6 flex items-center gap-2 rounded-card bg-paper/70 border border-ink/10 px-3 py-2.5 font-mono text-xs text-subtle">
                <Send size={13} className="text-brand shrink-0" />
                Draft ready: “Congrats on the promotion, Sarah — would love to…”
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── Stats strip ────────────────────────────────────────── */}
      <section className="border-y border-ink/15 bg-white/60">
        <RevealGroup className="max-w-6xl mx-auto grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-ink/12">
          {[
            { value: 12000, suffix: '+', label: 'contacts parsed from raw text' },
            { value: 40000, suffix: '+', label: 'follow-ups kept on time' },
            { value: 3.4, suffix: '×', decimals: 1, label: 'more replies than cold sends' },
          ].map((s) => (
            <Reveal key={s.label} className="px-6 md:px-8 py-10">
              <div className="font-serif text-4xl md:text-5xl font-black leading-none">
                <CountUp value={s.value} suffix={s.suffix} decimals={s.decimals || 0} />
              </div>
              <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted max-w-[24ch]">
                {s.label}
              </p>
            </Reveal>
          ))}
        </RevealGroup>
      </section>

      {/* ── Feature beats ──────────────────────────────────────── */}
      <FeatureBeat
        eyebrow="Capture"
        icon={Sparkles}
        title="Paste the mess. Keep the person."
        body="Drop in a LinkedIn bio, an email signature, or a note you scribbled after a conference. Cirqle's AI reads it and files a clean, tagged contact — company, role, relationship strength, and the context you'll want later."
        reverse={false}
        visual={<ParseVisual />}
      />
      <FeatureBeat
        eyebrow="Reach out"
        icon={Send}
        title="Outreach that sounds like you, not a template."
        body="Every draft is built from your real history with a person — past meetings, what they mentioned, where you left off. You get a message worth sending in one click, in your voice, not a form letter."
        reverse
        visual={<DraftVisual />}
      />

      {/* Out-of-frame beat: the queue row bleeds past the edge */}
      <section className="story-section py-20 md:py-28 border-t border-ink/15 overflow-x-clip">
        <div className="max-w-6xl mx-auto px-6 md:px-8">
          <RevealGroup>
            <Reveal>
              <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-brand mb-4 flex items-center gap-2">
                <ListTodo size={13} /> Stay in touch
              </p>
            </Reveal>
            <Reveal>
              <h2 className="font-serif text-3xl md:text-5xl italic font-bold tracking-tight max-w-[18ch] text-balance">
                No warm intro ever goes cold.
              </h2>
            </Reveal>
            <Reveal>
              <p className="mt-5 font-mono text-sm leading-relaxed text-subtle max-w-[54ch]">
                The follow-up queue reads your whole pipeline and surfaces exactly who needs
                you next — who's overdue, who just replied, who's drifting. The list keeps
                going; you just work down it.
              </p>
            </Reveal>
          </RevealGroup>
        </div>

        <QueueMarquee />
      </section>

      {/* ── Network graph showcase ─────────────────────────────── */}
      {/* No scroll-mt here any more: scroll-margin shifts an element's *snap
          area* too, which would give this one section a snap position 6rem
          off from every other. The section is full-height with centred
          content, so the #network anchor lands correctly without it. */}
      <section id="network" className="story-section py-20 md:py-28 border-t border-ink/15 bg-white/40">
        <div className="max-w-6xl mx-auto px-6 md:px-8 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          <div className="lg:col-span-5">
            <RevealGroup>
              <Reveal>
                <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-brand mb-4 flex items-center gap-2">
                  <Network size={13} /> The whole map
                </p>
              </Reveal>
              <Reveal>
                <h2 className="font-serif text-3xl md:text-5xl italic font-bold tracking-tight text-balance">
                  See your network the way it actually works.
                </h2>
              </Reveal>
              <Reveal>
                <p className="mt-5 font-mono text-sm leading-relaxed text-subtle max-w-[46ch]">
                  You sit at the center. Industry lanes fan out around you, each holding the
                  people inside it — sized and shaded by how warm the relationship is. It's
                  the fastest way to see where you're strong, and where a lane is going thin.
                </p>
              </Reveal>
              <Reveal>
                <Link to="/signup" className={`${primaryCta} mt-9`}>
                  Map your circle <ArrowRight size={15} />
                </Link>
              </Reveal>
            </RevealGroup>
          </div>
          <div className="lg:col-span-7 lg:-mr-10 xl:-mr-20">
            <LandingGraph />
          </div>
        </div>
      </section>

      {/* ── Ask the network ───────────────────────────────────────
          The original idea, and still the one that carries the product:
          plain-English questions answered against your own directory. */}
      <AskNetworkSection />

      {/* The card ships, so it sits above the roadmap divider with the rest
          of the built features — no Planned marker. */}
      <NfcCardSection />

      {/* ── Roadmap: everything below here is explicitly NOT shipped ─── */}
      <RoadmapIntro />
      <RoadmapBeat
        icon={Mail}
        title="Your inbox, already filed."
        body="Connect Gmail and every thread lands on the right person automatically — no copy-pasting, no forgetting who said what. Cirqle reads the reply, updates the pipeline stage, and moves them up or down the queue on its own."
        reverse
        visual={<GmailVisual />}
      />
      <RoadmapBeat
        icon={CalendarDays}
        title="Every coffee, on the record."
        body="Two-way calendar sync turns meetings into relationship history. A call gets logged against the contact before you've left the room, and the follow-up it should trigger is already waiting in your queue the next morning."
        reverse={false}
        visual={<CalendarVisual />}
      />

      {/* ── Closing CTA ────────────────────────────────────────── */}
      <section className="story-section py-24 md:py-32 border-t border-ink/15">
        <RevealGroup className="max-w-3xl mx-auto px-6 text-center">
          <Reveal>
            <h2 className="font-serif text-4xl md:text-6xl italic font-black tracking-tight text-balance">
              Start building your circle.
            </h2>
          </Reveal>
          <Reveal>
            <p className="mt-6 font-mono text-sm leading-relaxed text-subtle max-w-[46ch] mx-auto">
              Free to start. Bring one messy list of contacts and watch it become a network
              you can actually work.
            </p>
          </Reveal>
          <Reveal>
            <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
              <Link to="/signup" className={primaryCta}>
                Get started free <ArrowRight size={15} />
              </Link>
              <Link to="/login" className={secondaryCta}>
                Log in
              </Link>
            </div>
          </Reveal>
        </RevealGroup>
      </section>

      <LandingFooter />
    </div>
  );
}

/**
 * The follow-up queue row, drifting.
 *
 * The copy says "the list keeps going" — a static row that merely ran off the
 * right edge only implied that. Now it actually keeps going: the track holds
 * two identical copies of the queue and translates by exactly one copy's
 * width, so the loop is seamless and the row reads as endless rather than as
 * five cards that happen to be cropped.
 *
 * Deliberately slow (~34px/s): this is ambient movement to be caught out of
 * the corner of your eye while reading the heading, not a carousel demanding
 * attention. It pauses on hover so a card can actually be read, and the
 * global prefers-reduced-motion rule in index.css stops it outright.
 *
 * Spacing is `mr-4` on each card rather than `gap-4` on the track: with a gap,
 * one copy's advance (5 cards + 5 gaps) and half the track width (10 cards +
 * 9 gaps) differ by exactly one gap, and the loop visibly jumps every pass.
 */
function QueueMarquee() {
  const track = [...QUEUE, ...QUEUE];

  return (
    <Reveal className="mt-12" y={24}>
      <div
        className="marquee-mask overflow-hidden"
        style={{ ['--marquee-fade' as any]: '4rem' }}
      >
        <div className="marquee-track flex w-max">
          {track.map((q, i) => (
            <div
              key={`${q.name}-${i}`}
              aria-hidden={i >= QUEUE.length ? true : undefined}
              className="mr-4 w-[290px] shrink-0"
            >
              <div className="h-full bg-white border border-ink/15 rounded-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-serif text-lg font-bold">{q.name}</span>
                  <span className={`rounded-card px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest font-bold ${q.tone}`}>
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
    </Reveal>
  );
}

function FeatureBeat({
  eyebrow,
  icon: Icon,
  title,
  body,
  reverse,
  visual,
}: {
  eyebrow: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  body: string;
  reverse: boolean;
  visual: React.ReactNode;
}) {
  return (
    <section className="story-section py-20 md:py-28 border-t border-ink/15">
      <div className="max-w-6xl mx-auto px-6 md:px-8 grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
        <RevealGroup className={reverse ? 'lg:order-2' : ''}>
          <Reveal>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-brand mb-4 flex items-center gap-2">
              <Icon size={13} /> {eyebrow}
            </p>
          </Reveal>
          <Reveal>
            <h2 className="font-serif text-3xl md:text-5xl italic font-bold tracking-tight max-w-[16ch] text-balance">
              {title}
            </h2>
          </Reveal>
          <Reveal>
            <p className="mt-5 font-mono text-sm leading-relaxed text-subtle max-w-[52ch]">{body}</p>
          </Reveal>
        </RevealGroup>
        <Reveal className={reverse ? 'lg:order-1' : ''} y={24}>
          {visual}
        </Reveal>
      </div>
    </section>
  );
}

/**
 * Ask the network — natural-language search over your own directory.
 *
 * This is the beat the whole product grew out of, so it gets a full-bleed
 * centred treatment rather than the standard two-column FeatureBeat: the
 * question sits alone at the top, the way it does in the app, and the answer
 * assembles underneath it.
 */
function AskNetworkSection() {
  return (
    <section className="story-section py-14 md:py-16 border-t border-ink/15 bg-white/40">
      <div className="max-w-4xl mx-auto px-6 md:px-8 w-full">
        <RevealGroup className="text-center">
          <Reveal>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-brand mb-4 flex items-center justify-center gap-2">
              <Search size={13} /> Ask your network
            </p>
          </Reveal>
          <Reveal>
            <h2 className="font-serif text-3xl md:text-5xl italic font-bold tracking-tight text-balance mx-auto max-w-[20ch]">
              Ask a question. Get people, not rows.
            </h2>
          </Reveal>
          <Reveal>
            <p className="mt-5 font-mono text-sm leading-relaxed text-subtle max-w-[58ch] mx-auto">
              Type the thing you'd actually say out loud. No filters to stack, no tags to
              remember, no query language — just the handful of people who match, and why.
            </p>
          </Reveal>
          <Reveal>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {ASK_EXAMPLES.map((q) => (
                <span
                  key={q}
                  className="inline-block rounded-card border border-ink/15 bg-paper/70 px-3 py-1.5 font-mono text-[10px] text-muted"
                >
                  “{q}”
                </span>
              ))}
            </div>
          </Reveal>
        </RevealGroup>

        <Reveal y={24} className="mt-10">
          <AskVisual />
        </Reveal>
      </div>
    </section>
  );
}

/**
 * A still of the global search bar and the synthesis panel it opens. Solid
 * hairlines and the real oxblood accent — this one ships, so it uses the
 * shipped-feature visual language, not the dashed roadmap one.
 */
function AskVisual() {
  return (
    <div className="mx-auto max-w-2xl">
      {/* The query bar, mirroring the in-app GlobalSearch chrome. */}
      <div className="flex items-center gap-3 rounded-card border border-ink/15 bg-white px-4 py-4">
        <Sparkles size={17} className="shrink-0 text-brand" />
        <span className="flex-1 truncate font-mono text-sm font-semibold italic text-ink">
          Who in healthcare have I not spoken to since spring?
        </span>
        <span className="shrink-0 rounded-card bg-brand px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest font-bold text-brand-on">
          Ask
        </span>
      </div>

      <div className="mt-2 flex justify-center text-muted">
        <ArrowRight size={16} className="rotate-90 text-brand" />
      </div>

      {/* The synthesis panel. */}
      <div className="mt-2 rounded-card border border-ink/15 bg-white overflow-hidden">
        <div className="flex items-center gap-2 border-b border-ink/10 bg-paper/50 px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest text-muted">
          <Sparkles size={13} className="text-brand" /> AI synthesis · 214 contacts read
        </div>
        <div className="p-4">
          <p className="rounded-card border border-ink/12 bg-accent/60 px-4 py-3 font-mono text-xs leading-relaxed">
            Three healthcare contacts have gone quiet since March. Priya and Daniel both
            owe you nothing — you owe them. Marcus replied and was never answered.
          </p>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {ASK_RESULTS.map((r) => (
              <div key={r.name} className="rounded-card border border-ink/15 bg-paper/50 p-3.5">
                <p className="font-serif text-base font-bold leading-tight">{r.name}</p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted">
                  {r.firm}
                </p>
                <p className="mt-2.5 font-mono text-[11px] leading-relaxed text-subtle">{r.why}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const ASK_EXAMPLES = [
  'Who can introduce me at Sequoia?',
  'List my pending action items',
  'Which alumni are in product?',
];

const ASK_RESULTS = [
  { name: 'Priya Nair', firm: 'UnitedHealth', why: 'Payer strategy · quiet 118 days' },
  { name: 'Daniel Osei', firm: 'Mayo Clinic', why: 'Met at the panel · never followed up' },
  { name: 'Marcus Chen', firm: 'Flatiron Health', why: 'Replied in March · unanswered' },
];

/* ────────────────────────────────────────────────────────────────────────
   Roadmap sections.

   Everything below the RoadmapIntro divider is a plan, not a feature. None
   of it ships today, so the copy stays in the future tense and each beat
   carries a visible "Planned" marker — and the mock visuals use dashed
   hairlines rather than the solid ones the shipped-feature sections use,
   reusing the app's own dashed = "nothing here yet" empty-state language.
   ──────────────────────────────────────────────────────────────────────── */

function PlannedChip() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-card border border-dashed border-ink/35 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest font-bold text-muted">
      Planned
    </span>
  );
}

function RoadmapIntro() {
  return (
    <section className="story-section border-t border-ink/15 bg-white/30 py-20 md:py-28">
      <RevealGroup className="max-w-3xl mx-auto px-6 text-center">
        <Reveal>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-brand mb-5 flex items-center justify-center gap-2">
            <Compass size={13} /> Roadmap
          </p>
        </Reveal>
        <Reveal>
          <h2 className="font-serif text-4xl md:text-6xl italic font-black tracking-tight text-balance">
            What we're building next.
          </h2>
        </Reveal>
        <Reveal>
          <p className="mt-6 font-mono text-sm leading-relaxed text-subtle max-w-[52ch] mx-auto">
            Everything above this line works today — including the card. Everything below
            it is where Cirqle is headed: two integrations that close the last gap, so the
            things you already do in your inbox and your calendar file themselves.
          </p>
        </Reveal>
        <Reveal>
          <div className="mt-9 flex justify-center">
            <PlannedChip />
          </div>
        </Reveal>
      </RevealGroup>
    </section>
  );
}

/**
 * The NFC card beat. A physical product is being depicted rather than a UI
 * surface, so this one card is allowed more dimensionality and sheen than the
 * flat hairline language everywhere else on the page — that contrast is the
 * point. It must not bleed into the surrounding sections.
 *
 * The turn is driven by the section *entering the viewport*, not by scroll
 * position — and that distinction is the whole fix.
 *
 * Coupling rotateY to scroll progress cannot work on this page. The sections
 * are 100svh with CSS scroll-snap, so a reader does not sweep through a range
 * of scroll positions here; they arrive at essentially one. Whatever angle the
 * mapping assigns to that position is the only angle they ever see. Tuned so
 * the back faces them at rest, the card has already finished turning before it
 * settles — it "flips too early", because the flip happened somewhere above
 * the fold. Tuned so it turns later, they scroll away before it does. There is
 * no mapping that makes a scroll-coupled turn watchable under snap scrolling.
 *
 * So: the card holds its front face until the section is properly on screen,
 * waits a beat so the front actually registers, then turns over once, at a
 * readable speed, and stays on the back. The turn is always witnessed, from
 * any scroll speed, and both faces get a good long look. Scrolling away and
 * back replays it.
 */
const CARD_TURN_DELAY = 0.65;
const CARD_TURN_DURATION = 1.25;

function NfcCardSection() {
  const ref = React.useRef<HTMLElement>(null);
  // 0.5 rather than something higher: the section is exactly one viewport
  // tall, so it is never much more than half-visible until it has essentially
  // settled. Waiting for more would delay the turn past the reader's arrival.
  const isSettled = useInView(ref, { amount: 0.5 });

  return (
    <section ref={ref} className="story-section border-t border-ink/15 py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-6 md:px-8 grid grid-cols-1 lg:grid-cols-2 gap-14 lg:gap-16 items-center">
        <RevealGroup>
          <Reveal>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-brand mb-4 flex items-center gap-2">
              <Nfc size={13} /> The card
            </p>
          </Reveal>
          <Reveal>
            <h2 className="font-serif text-3xl md:text-5xl italic font-bold tracking-tight max-w-[16ch] text-balance">
              Tap once. They're in your circle.
            </h2>
          </Reveal>
          <Reveal>
            <p className="mt-5 font-mono text-sm leading-relaxed text-subtle max-w-[52ch]">
              A physical Cirqle card that writes the introduction for you. Tap a phone and
              they get your details — you get a contact already filed, tagged with where you
              met and when, sitting in the queue for a follow-up while the conversation is
              still warm.
            </p>
          </Reveal>
          <Reveal>
            <p className="mt-6 font-mono text-[11px] uppercase tracking-widest text-muted">
              Matte black. NFC on the back.
            </p>
          </Reveal>
        </RevealGroup>

        <Reveal y={24}>
          {/* Perspective lives on the rotating element itself
              (transformPerspective) — a second one on this wrapper would
              compound and exaggerate the turn. */}
          <div className="flex justify-center">
            <motion.div
              className="relative w-[320px] h-[202px] md:w-[380px] md:h-[240px]"
              style={{ transformPerspective: 1600, transformStyle: 'preserve-3d' }}
              // No reduced-motion branch needed: the MotionConfig at the app
              // root runs reducedMotion="user", which skips the tween and
              // settles straight on the end value — so those readers still
              // get to see the back face, just without the rotation.
              animate={{ rotateY: isSettled ? 180 : 0 }}
              transition={{
                duration: CARD_TURN_DURATION,
                delay: isSettled ? CARD_TURN_DELAY : 0,
                ease: HOUSE_EASE,
              }}
            >
              <NfcCardFace side="front" />
              <NfcCardFace side="back" />
            </motion.div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function NfcCardFace({ side }: { side: 'front' | 'back' }) {
  const front = side === 'front';
  return (
    <div
      className="absolute inset-0 rounded-[14px] overflow-hidden"
      style={{
        backfaceVisibility: 'hidden',
        WebkitBackfaceVisibility: 'hidden',
        transform: front ? undefined : 'rotateY(180deg)',
        // A product render, not a UI card: real depth + a raking sheen.
        background: 'linear-gradient(145deg, #232323 0%, #101010 46%, #262626 100%)',
        boxShadow:
          '0 26px 60px -28px rgba(26,26,26,0.72), 0 8px 20px -12px rgba(26,26,26,0.45), inset 0 1px 0 rgba(255,255,255,0.10)',
      }}
    >
      {/* raking highlight across the face */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(112deg, rgba(255,255,255,0) 34%, rgba(255,255,255,0.10) 47%, rgba(255,255,255,0) 60%)',
        }}
      />
      {front ? (
        <div className="relative h-full flex flex-col justify-between p-6 md:p-7">
          <div className="flex items-start justify-between">
            <RingMark />
            <Nfc size={19} className="text-paper/45" />
          </div>
          <div>
            <div className="font-serif text-[30px] md:text-[34px] font-black italic tracking-tight text-paper leading-none">
              Cirqle
            </div>
            <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.28em] text-paper/45">
              Personal CRM
            </div>
          </div>
        </div>
      ) : (
        <div className="relative h-full flex flex-col justify-between p-6 md:p-7">
          <div className="font-mono text-[9px] uppercase tracking-[0.28em] text-paper/45">
            Tap to connect
          </div>
          <div className="space-y-2.5">
            <div className="h-px w-full bg-paper/15" />
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-paper/80">
              cirqle.app/you
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

/**
 * The real mark, on the card. It used to be re-drawn here with a hardcoded
 * #141414 square faking the ring's gap — which only matched because the card
 * gradient happens to pass near that value at that spot. Now that LogoMark
 * draws a genuine gap it can simply be reused, inheriting `currentColor`.
 */
function RingMark() {
  return <LogoMark px={32} className="text-paper/85" />;
}

/** Same shape as FeatureBeat, plus the Planned marker. */
function RoadmapBeat({
  icon: Icon,
  title,
  body,
  reverse,
  visual,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  body: string;
  reverse: boolean;
  visual: React.ReactNode;
}) {
  return (
    <section className="story-section py-20 md:py-28 border-t border-ink/15">
      <div className="max-w-6xl mx-auto px-6 md:px-8 grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
        <RevealGroup className={reverse ? 'lg:order-2' : ''}>
          <Reveal>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-brand mb-4 flex items-center gap-2">
              <Icon size={13} /> Coming soon
            </p>
          </Reveal>
          <Reveal>
            <h2 className="font-serif text-3xl md:text-5xl italic font-bold tracking-tight max-w-[16ch] text-balance">
              {title}
            </h2>
          </Reveal>
          <Reveal>
            <p className="mt-5 font-mono text-sm leading-relaxed text-subtle max-w-[52ch]">{body}</p>
          </Reveal>
          <Reveal>
            <div className="mt-8">
              <PlannedChip />
            </div>
          </Reveal>
        </RevealGroup>
        <Reveal className={reverse ? 'lg:order-1' : ''} y={24}>
          {visual}
        </Reveal>
      </div>
    </section>
  );
}

function GmailVisual() {
  return (
    <div className="rounded-card border border-dashed border-ink/30 bg-white/70 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-dashed border-ink/20 bg-paper/50 px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-muted">
        <Mail size={13} className="text-brand" /> Inbox · filed automatically
      </div>
      <div className="divide-y divide-dashed divide-ink/15">
        {[
          { who: 'Sarah Chen', gist: 'Re: Demo day follow-up', tag: 'Responded', tone: 'bg-emerald-50 text-emerald-700' },
          { who: 'James Taylor', gist: 'Re: Catching up', tag: 'Re-engaged', tone: 'bg-[var(--color-tier-dormant-bg)] text-[var(--color-tier-dormant-text)]' },
          { who: 'Priya Nair', gist: 'Intro to our payer team', tag: 'Meeting set', tone: 'bg-blue-50 text-blue-700' },
        ].map((m) => (
          <div key={m.who} className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <p className="font-serif text-base font-bold">{m.who}</p>
              <p className="font-mono text-[11px] text-muted truncate">{m.gist}</p>
            </div>
            <span className={`shrink-0 rounded-card px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest font-bold ${m.tone}`}>
              {m.tag}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CalendarVisual() {
  return (
    <div className="rounded-card border border-dashed border-ink/30 bg-white/70 p-5">
      <div className="flex items-center gap-2 pb-4 mb-4 border-b border-dashed border-ink/20 font-mono text-[10px] uppercase tracking-widest text-muted">
        <CalendarDays size={13} className="text-brand" /> This week · synced
      </div>
      <div className="space-y-3">
        {[
          { day: 'Tue', time: '09:30', who: 'Coffee — Alex Johnson', note: 'Logged · follow-up queued Thu' },
          { day: 'Wed', time: '14:00', who: 'Intro call — Priya Nair', note: 'Logged · notes attached' },
          { day: 'Fri', time: '11:15', who: 'Catch-up — Olivia Martinez', note: 'Quarterly sync · auto-scheduled' },
        ].map((e) => (
          <div key={e.who} className="flex gap-4 rounded-card border border-dashed border-ink/20 bg-paper/40 px-4 py-3">
            <div className="shrink-0 text-center">
              <div className="font-mono text-[9px] uppercase tracking-widest text-muted">{e.day}</div>
              <div className="font-serif text-lg font-black leading-none mt-0.5">{e.time}</div>
            </div>
            <div className="min-w-0 border-l border-dashed border-ink/20 pl-4">
              <p className="font-mono text-xs font-semibold truncate">{e.who}</p>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted mt-1">{e.note}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ParseVisual() {
  return (
    <div className="relative">
      <div className="bg-paper border border-ink/15 rounded-card p-4 font-mono text-xs leading-relaxed text-muted">
        “met priya @ the healthcare panel — VP strategy at unitedhealth, sharp on payer
        stuff, said email her directly, boston based”
      </div>
      <div className="mt-3 flex justify-center text-muted">
        <ArrowRight size={16} className="rotate-90 text-brand" />
      </div>
      <div className="mt-3 bg-white border border-ink/15 rounded-card p-5 font-mono text-sm">
        <div className="flex items-center justify-between mb-3">
          <span className="font-serif text-lg font-bold not-italic">Priya Nair</span>
          <span className="rounded-card bg-[var(--color-tier-warm-bg)] text-[var(--color-tier-warm-text)] px-2 py-0.5 text-[10px] uppercase tracking-widest font-bold">
            Warm
          </span>
        </div>
        <p className="text-[10px] uppercase tracking-widest text-muted">VP of Strategy · UnitedHealth Group · Boston</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {['Healthcare', 'Payer strategy', 'Direct contact'].map((t) => (
            <span key={t} className="rounded-card border border-ink/12 bg-paper/70 px-2 py-0.5 text-[10px] uppercase tracking-wide">
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function DraftVisual() {
  return (
    <div className="bg-white border border-ink/15 rounded-card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-ink/10 bg-paper/50 px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-muted">
        <Sparkles size={13} className="text-brand" /> AI draft · references 3 past notes
      </div>
      <div className="p-5 font-mono text-sm leading-relaxed space-y-3">
        <p className="text-muted"><span className="text-ink">Subject:</span> Following up from the a16z demo day</p>
        <p>Hi Sarah,</p>
        <p className="text-subtle">
          Great running into you at Demo Day — you mentioned Sequoia was leaning harder into
          AI tooling this cycle. I've been heads-down on exactly that and would love 20
          minutes to compare notes…
        </p>
        <div className="pt-2 flex gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-card bg-brand text-brand-on px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold">
            <Send size={11} /> Send
          </span>
          <span className="inline-flex items-center rounded-card border border-ink/15 px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold text-subtle">
            Refine
          </span>
        </div>
      </div>
    </div>
  );
}

function LandingFooter() {
  const cols = [
    { head: 'Product', items: ['Directory', 'Network Graph', 'Tracker', 'Templates'] },
    { head: 'Company', items: ['About', 'Privacy', 'Terms'] },
  ];
  return (
    <footer className="border-t border-ink/15 bg-white/50">
      <div className="max-w-6xl mx-auto px-6 md:px-8 py-16 grid grid-cols-2 md:grid-cols-4 gap-10">
        <div className="col-span-2 md:col-span-2">
          <Logo size="sm" kicker={null} />
          <p className="mt-4 font-mono text-xs leading-relaxed text-muted max-w-[34ch]">
            The AI personal CRM for people who live off their relationships.
          </p>
        </div>
        {cols.map((c) => (
          <div key={c.head}>
            <h4 className="font-mono text-[10px] uppercase tracking-widest font-bold text-subtle mb-4">{c.head}</h4>
            <ul className="space-y-2.5">
              {c.items.map((i) => (
                <li key={i}>
                  <span className="font-mono text-xs text-muted hover:text-ink transition-colors cursor-default">{i}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-ink/10">
        <div className="max-w-6xl mx-auto px-6 md:px-8 py-6 flex flex-col sm:flex-row justify-between gap-3 font-mono text-[10px] uppercase tracking-widest text-muted">
          <span>© {new Date().getFullYear()} Cirqle</span>
          <span>Your network is your net worth.</span>
        </div>
      </div>
    </footer>
  );
}

const QUEUE = [
  { name: 'James Taylor', firm: 'Morgan Stanley', status: 'Overdue', tone: 'bg-[var(--color-tier-dormant-bg)] text-[var(--color-tier-dormant-text)]', action: 'Send a check-in note — 92 days quiet.' },
  { name: 'Sarah Chen', firm: 'Sequoia Capital', status: 'Replied', tone: 'bg-emerald-50 text-emerald-700', action: 'She said yes to a call — send times.' },
  { name: 'Marcus Johnson', firm: 'McKinsey & Co', status: 'Follow up', tone: 'bg-[var(--color-tier-warm-bg)] text-[var(--color-tier-warm-text)]', action: 'Bump your last note to the top of his inbox.' },
  { name: 'Olivia Martinez', firm: 'Google', status: 'Thank', tone: 'bg-blue-50 text-blue-700', action: 'She sent the intro — close the loop.' },
  { name: 'Daniel Osei', firm: 'Mayo Clinic', status: 'Re-engage', tone: 'bg-[var(--color-tier-cold-bg)] text-[var(--color-tier-cold-text)]', action: 'Quarterly catch-up is due this week.' },
];
