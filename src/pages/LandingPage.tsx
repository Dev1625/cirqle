import React from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion, type Variants } from 'motion/react';
import { ArrowRight, Sparkles, Mail, CalendarDays, Compass } from 'lucide-react';
import { CountUp } from '../components/landing/CountUp';
import { Reveal, RevealGroup } from '../components/landing/motion';
import { StoryScrollProvider } from '../components/landing/StoryScroll';
import { StoryRail, STORY_STAGES } from '../components/landing/StoryRail';
import { ScrollProbe } from '../components/landing/ScrollProbe';
import { STORY_COLUMN } from '../components/landing/story/StorySection';
import { TapSection } from '../components/landing/story/TapSection';
import { ParseSection } from '../components/landing/story/ParseSection';
import { AskSection } from '../components/landing/story/AskSection';
import { MapSection } from '../components/landing/story/MapSection';
import { HealthSection } from '../components/landing/story/HealthSection';
import { DraftSection } from '../components/landing/story/DraftSection';
import { STORY_CONTACT } from '../components/landing/storyContact';
import { Logo } from '../components/Logo';

/* ────────────────────────────────────────────────────────────────────────
   The landing page is one story, told in six beats, about one person.

   You tap his card (01), the tap becomes a record (02), you ask a question
   and he is in the answer (03), he takes his place on the map (04), he
   carries a health signal that is already ticking down (05), and the note
   you owe him writes itself (06). Nothing on the page introduces a second
   sample contact as the subject of a beat — see storyContact.ts.

   The sections are not slides any more. Scroll-snap is gone, Lenis carries
   the smoothing, and one MotionValue owned by StoryScroll drives everything
   scroll-linked on the page.
   ──────────────────────────────────────────────────────────────────────── */

const HOUSE_EASE = [0.22, 1, 0.36, 1] as const;
// Ease-out-back — the single deliberate overshoot, used only on the hero's
// first paint (per CIRQLE_DESIGN_SYSTEM.md Part 4). Not a house-wide curve.
const OVERSHOOT = [0.34, 1.4, 0.64, 1] as const;

const primaryCta =
  'inline-flex items-center justify-center gap-2 rounded-card bg-brand text-brand-on px-7 py-3.5 font-mono text-xs uppercase tracking-widest font-bold hover:bg-[#8E2A3A] active:bg-[#661D29] active:scale-[0.98] transition-[transform,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper';
const secondaryCta =
  'inline-flex items-center justify-center gap-2 rounded-card border border-ink/15 px-7 py-3.5 font-mono text-xs uppercase tracking-widest font-bold hover:bg-ink hover:text-paper transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper';

export default function LandingPage() {
  return (
    <StoryScrollProvider>
      <LandingStory />
    </StoryScrollProvider>
  );
}

function LandingStory() {
  return (
    <div className="w-full overflow-x-clip">
      <ScrollProbe />
      <StoryRail />

      <Hero />

      {/* ── The story, in order. Indices 0–5 match STORY_STAGES. ──────── */}
      <TapSection />
      <ParseSection />
      <AskSection />
      <MapSection />
      <HealthSection />
      <DraftSection />

      {/* ── Everything below is outside the narrative ─────────────────── */}
      <StatsStrip />
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

      <ClosingCta />
      <LandingFooter />
    </div>
  );
}

/* ── Hero ──────────────────────────────────────────────────────────────
   The right-hand panel is the story's table of contents rather than a
   product screenshot. Every screenshot worth showing is a beat further down
   the page, and showing one here would spend it twice; listing the six
   stages instead tells the visitor up front that this page goes somewhere,
   and teaches the numbered language the thread uses all the way down.
   ────────────────────────────────────────────────────────────────────── */

function Hero() {
  const reduce = useReducedMotion();

  return (
    <section className="story-section">
      <div className={`${STORY_COLUMN} pb-20 pt-16 md:pb-28 md:pt-24`}>
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-12 lg:gap-8">
          <div className="lg:col-span-7">
            <motion.p
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: HOUSE_EASE }}
              className="mb-6 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted"
            >
              <Sparkles size={13} className="text-brand" /> AI personal CRM
            </motion.p>

            <HeroHeadline />

            <motion.p
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.6, ease: HOUSE_EASE }}
              className="mt-8 max-w-[52ch] font-mono text-sm leading-relaxed text-subtle md:text-base"
            >
              Cirqle turns scattered contacts, half-remembered conversations, and cold
              threads into one living map — with AI that parses, drafts, and remembers, so
              you stay in touch like it matters. Because it does.
            </motion.p>

            <motion.div
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.75, ease: HOUSE_EASE }}
              className="mt-10 flex flex-col gap-3 sm:flex-row"
            >
              <Link to="/signup" className={primaryCta}>
                Start for free <ArrowRight size={15} />
              </Link>
              <a href="#tap" className={secondaryCta}>
                Follow one contact
              </a>
            </motion.div>
          </div>

          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.35, ease: HOUSE_EASE }}
            className="lg:col-span-5"
          >
            <div className="rounded-card border border-ink/15 bg-white p-6 md:p-7">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
                One contact, start to finish
              </p>
              <p className="mt-2 font-serif text-xl font-bold italic">{STORY_CONTACT.name}</p>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted">
                {STORY_CONTACT.role} · {STORY_CONTACT.company}
              </p>

              <ol className="mt-6 space-y-0">
                {STORY_STAGES.map((stage) => {
                  const Icon = stage.icon;
                  return (
                    <li
                      key={stage.key}
                      className="flex items-center gap-3 border-t border-ink/10 py-3 first:border-t-0 first:pt-0"
                    >
                      <span className="font-mono text-[10px] tracking-widest text-muted">
                        {stage.index}
                      </span>
                      <Icon size={13} className="shrink-0 text-brand" />
                      <span className="font-mono text-xs font-semibold uppercase tracking-widest">
                        {stage.label}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

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
      className="text-balance font-serif text-[clamp(2.6rem,7vw,5.25rem)] leading-[0.98] tracking-tight"
    >
      <span className="inline-flex flex-wrap gap-x-[0.28em]">
        {line1.map((w, i) => (
          <motion.span key={i} variants={word} className="inline-block">
            {w}
          </motion.span>
        ))}
      </span>
      <motion.span variants={word} className="mt-1 block italic text-brand">
        Manage it like it.
      </motion.span>
    </motion.h1>
  );
}

/* ── Non-narrative sections ───────────────────────────────────────────── */

function StatsStrip() {
  return (
    <section className="border-y border-ink/15 bg-white/60">
      <RevealGroup
        className={`${STORY_COLUMN} grid grid-cols-1 divide-y divide-ink/12 sm:grid-cols-3 sm:divide-x sm:divide-y-0`}
      >
        {[
          { value: 12000, suffix: '+', label: 'contacts parsed from raw text' },
          { value: 40000, suffix: '+', label: 'follow-ups kept on time' },
          { value: 3.4, suffix: '×', decimals: 1, label: 'more replies than cold sends' },
        ].map((s) => (
          <Reveal key={s.label} className="px-6 py-10 md:px-8">
            <div className="font-serif text-4xl font-black leading-none md:text-5xl">
              <CountUp value={s.value} suffix={s.suffix} decimals={s.decimals || 0} />
            </div>
            <p className="mt-3 max-w-[24ch] font-mono text-[11px] uppercase tracking-widest text-muted">
              {s.label}
            </p>
          </Reveal>
        ))}
      </RevealGroup>
    </section>
  );
}

/* Everything below the RoadmapIntro divider is a plan, not a feature. The
   copy stays in the future tense, each beat carries a visible "Planned"
   marker, and the mock visuals use dashed hairlines rather than the solid
   ones the shipped sections use — reusing the app's own dashed = "nothing
   here yet" empty-state language. */

function PlannedChip() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-card border border-dashed border-ink/35 px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-widest text-muted">
      Planned
    </span>
  );
}

function RoadmapIntro() {
  return (
    <section className="border-t border-ink/15 bg-white/30 py-20 md:py-28">
      <div className={STORY_COLUMN}>
        <RevealGroup className="mx-auto max-w-3xl text-center">
          <Reveal>
            <p className="mb-5 flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-brand">
              <Compass size={13} /> Roadmap
            </p>
          </Reveal>
          <Reveal>
            <h2 className="text-balance font-serif text-4xl font-black italic tracking-tight md:text-6xl">
              What we're building next.
            </h2>
          </Reveal>
          <Reveal>
            <p className="mx-auto mt-6 max-w-[52ch] font-mono text-sm leading-relaxed text-subtle">
              Everything in the story above works today — including the card. Everything
              below is where Cirqle is headed: two integrations that close the last gap, so
              the things you already do in your inbox and your calendar file themselves.
            </p>
          </Reveal>
          <Reveal>
            <div className="mt-9 flex justify-center">
              <PlannedChip />
            </div>
          </Reveal>
        </RevealGroup>
      </div>
    </section>
  );
}

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
    <section className="border-t border-ink/15 py-20 md:py-28">
      <div className={`${STORY_COLUMN} grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16`}>
        <RevealGroup className={reverse ? 'lg:order-2' : ''}>
          <Reveal>
            <p className="mb-4 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.22em] text-brand">
              <Icon size={13} /> Coming soon
            </p>
          </Reveal>
          <Reveal>
            <h2 className="max-w-[16ch] text-balance font-serif text-3xl font-bold italic tracking-tight md:text-5xl">
              {title}
            </h2>
          </Reveal>
          <Reveal>
            <p className="mt-5 max-w-[52ch] font-mono text-sm leading-relaxed text-subtle">{body}</p>
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
    <div className="overflow-hidden rounded-card border border-dashed border-ink/30 bg-white/70">
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
              <p className="truncate font-mono text-[11px] text-muted">{m.gist}</p>
            </div>
            <span className={`shrink-0 rounded-card px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest ${m.tone}`}>
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
      <div className="mb-4 flex items-center gap-2 border-b border-dashed border-ink/20 pb-4 font-mono text-[10px] uppercase tracking-widest text-muted">
        <CalendarDays size={13} className="text-brand" /> This week · synced
      </div>
      <div className="space-y-3">
        {[
          { day: 'Tue', time: '09:30', who: `Coffee — ${STORY_CONTACT.firstName}`, note: 'Logged · follow-up queued Thu' },
          { day: 'Wed', time: '14:00', who: 'Intro call — Priya Nair', note: 'Logged · notes attached' },
          { day: 'Fri', time: '11:15', who: 'Catch-up — Olivia Martinez', note: 'Quarterly sync · auto-scheduled' },
        ].map((e) => (
          <div key={e.who} className="flex gap-4 rounded-card border border-dashed border-ink/20 bg-paper/40 px-4 py-3">
            <div className="shrink-0 text-center">
              <div className="font-mono text-[9px] uppercase tracking-widest text-muted">{e.day}</div>
              <div className="mt-0.5 font-serif text-lg font-black leading-none">{e.time}</div>
            </div>
            <div className="min-w-0 border-l border-dashed border-ink/20 pl-4">
              <p className="truncate font-mono text-xs font-semibold">{e.who}</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted">{e.note}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ClosingCta() {
  return (
    <section className="border-t border-ink/15 py-24 md:py-32">
      <div className={STORY_COLUMN}>
        <RevealGroup className="mx-auto max-w-3xl text-center">
          <Reveal>
            <h2 className="text-balance font-serif text-4xl font-black italic tracking-tight md:text-6xl">
              Start building your circle.
            </h2>
          </Reveal>
          <Reveal>
            <p className="mx-auto mt-6 max-w-[46ch] font-mono text-sm leading-relaxed text-subtle">
              Free to start. Bring one messy list of contacts and watch it become a network
              you can actually work.
            </p>
          </Reveal>
          <Reveal>
            <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
              <Link to="/signup" className={primaryCta}>
                Get started free <ArrowRight size={15} />
              </Link>
              <Link to="/login" className={secondaryCta}>
                Log in
              </Link>
            </div>
          </Reveal>
        </RevealGroup>
      </div>
    </section>
  );
}

function LandingFooter() {
  const cols = [
    { head: 'Product', items: ['Directory', 'Network Graph', 'Tracker', 'Templates'] },
    { head: 'Company', items: ['About', 'Privacy', 'Terms'] },
  ];
  return (
    <footer className="border-t border-ink/15 bg-white/50">
      <div className={`${STORY_COLUMN} grid grid-cols-2 gap-10 py-16 md:grid-cols-4`}>
        <div className="col-span-2 md:col-span-2">
          <Logo size="sm" kicker={null} />
          <p className="mt-4 max-w-[34ch] font-mono text-xs leading-relaxed text-muted">
            The AI personal CRM for people who live off their relationships.
          </p>
        </div>
        {cols.map((c) => (
          <div key={c.head}>
            <h4 className="mb-4 font-mono text-[10px] font-bold uppercase tracking-widest text-subtle">
              {c.head}
            </h4>
            <ul className="space-y-2.5">
              {c.items.map((i) => (
                <li key={i}>
                  <span className="cursor-default font-mono text-xs text-muted transition-colors hover:text-ink">
                    {i}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-ink/10">
        <div className={`${STORY_COLUMN} flex flex-col justify-between gap-3 py-6 font-mono text-[10px] uppercase tracking-widest text-muted sm:flex-row`}>
          <span>© {new Date().getFullYear()} Cirqle</span>
          <span>Your network is your net worth.</span>
        </div>
      </div>
    </footer>
  );
}
