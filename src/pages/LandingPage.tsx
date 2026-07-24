import React from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion, type Variants } from 'motion/react';
import { ArrowRight, Sparkles, Send, ListTodo, Network } from 'lucide-react';
import { CountUp } from '../components/landing/CountUp';
import { Reveal, RevealGroup } from '../components/landing/motion';
import { LandingGraph } from '../components/landing/LandingGraph';

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
  const reduce = useReducedMotion();

  return (
    <div className="w-full overflow-x-clip">
      {/* ── Hero ───────────────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-6 md:px-8 pt-16 pb-20 md:pt-24 md:pb-28">
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
      <section className="py-20 md:py-28 border-t border-ink/15 overflow-x-clip">
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

        {/* row deliberately wider than the viewport — last card runs off-frame */}
        <RevealGroup className="mt-12 flex gap-4 px-6 md:px-8 max-w-none overflow-visible" stagger={0.09}>
          {QUEUE.map((q) => (
            <Reveal key={q.name} className="shrink-0 w-[290px]">
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
            </Reveal>
          ))}
        </RevealGroup>
      </section>

      {/* ── Network graph showcase ─────────────────────────────── */}
      <section id="network" className="scroll-mt-24 py-20 md:py-28 border-t border-ink/15 bg-white/40">
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

      {/* ── Closing CTA ────────────────────────────────────────── */}
      <section className="py-24 md:py-32 border-t border-ink/15">
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
    <section className="py-20 md:py-28 border-t border-ink/15">
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
          <div className="font-serif text-2xl font-black italic tracking-tight">Cirqle</div>
          <p className="mt-3 font-mono text-xs leading-relaxed text-muted max-w-[34ch]">
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
