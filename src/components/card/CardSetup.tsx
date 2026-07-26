import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  Link2,
  Radio,
  Sparkles,
  SquarePen,
  Globe,
  Users,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { AILabel, AISurface } from '../ui/AISurface';
import { EmptyState } from '../ui/EmptyState';
import { QRCode } from './QRCode';
import { useToast } from '../../contexts/ToastContext';
import {
  CARD_ACCENTS,
  DEFAULT_CARD,
  accentHex,
  cardUrl,
  generateCardId,
  publishCard,
  type CardConfig,
  type CardLayout,
  type CardMode,
} from '../../lib/card';
import { cardFromProfile, composeFallbackIntro, generateCardDraft } from '../../lib/cardAI';
import {
  buildEventRecap,
  readEventMode,
  startEventMode,
  stopEventMode,
  suggestedEvent,
  type EventModeState,
  type EventRecap,
} from '../../lib/eventMode';
import type { CalendarEvent } from '../../lib/integrations/calendar';

/**
 * Owner-side setup for the NFC card, lives in Settings → Connections.
 *
 * Three routes to a published card, in the order they reduce friction:
 * AI draft (default), manual customiser, or port an existing page. The AI
 * route is first because the other two both start from a blank field.
 */

type Route = 'choose' | 'ai' | 'custom' | 'ported';

export function CardSetup({
  uid,
  profile,
  events,
  onPublished,
}: {
  uid: string;
  profile: any;
  events: CalendarEvent[];
  onPublished: (cardId: string, config: CardConfig) => void;
}) {
  const { toast } = useToast();

  const existingCardId: string | null = profile?.cardId || null;
  const existingConfig: CardConfig | null = profile?.card?.published ? { ...DEFAULT_CARD, ...profile.card } : null;

  const [route, setRoute] = useState<Route>('choose');
  const [config, setConfig] = useState<CardConfig>(() =>
    cardFromProfile(profile, existingConfig || DEFAULT_CARD)
  );
  const [publishing, setPublishing] = useState(false);
  const [copied, setCopied] = useState(false);

  const [aiState, setAiState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const [aiError, setAiError] = useState<string | null>(null);

  const cardId = useMemo(() => existingCardId || generateCardId(), [existingCardId]);
  const url = cardUrl(cardId);

  useEffect(() => {
    setConfig((current) => cardFromProfile(profile, existingConfig || current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.name, profile?.role, profile?.company, profile?.cardId]);

  const runAIDraft = async () => {
    setAiState('loading');
    setAiError(null);
    try {
      const draft = await generateCardDraft(profile || {});
      setConfig((current) => ({
        ...current,
        mode: 'ai' as CardMode,
        intro: draft.intro,
        accent: draft.accent,
        layout: draft.layout,
      }));
      setAiState('ready');
    } catch (error: any) {
      setAiError(error?.message || 'The model did not come back.');
      setAiState('error');
    }
  };

  const useFallbackDraft = () => {
    setConfig((current) => ({
      ...current,
      mode: 'ai' as CardMode,
      intro: composeFallbackIntro(profile || {}),
    }));
    setAiState('ready');
  };

  const handlePublish = async () => {
    if (!config.name.trim()) {
      toast('Your card needs a name on it.', 'error');
      return;
    }
    setPublishing(true);
    const isFirstPublish = !existingConfig;
    try {
      await publishCard(uid, cardId, { ...config, published: true });
      onPublished(cardId, { ...config, published: true });
      // Return to the published view. Staying in the editor left the user
      // with no confirmation the card was live and no sight of its URL or
      // QR — the two things they came here for.
      setRoute('choose');
      toast(isFirstPublish ? 'Card published. Tap-ready.' : 'Card updated.', 'success');
    } catch {
      toast('Could not publish the card. Try again.', 'error');
    } finally {
      setPublishing(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Clipboard blocked — the link is shown above.', 'error');
    }
  };

  // ── Published state ────────────────────────────────────────────────────
  if (existingConfig && route === 'choose') {
    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <div className="shrink-0">
            <QRCode value={url} size={140} />
          </div>

          <div className="min-w-0 flex-1 space-y-4">
            <div>
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
                Your card
              </span>
              <p className="mt-1.5 truncate font-mono text-sm">{url}</p>
            </div>

            <p className="font-mono text-xs leading-relaxed text-subtle">
              No physical card yet? Open this link and you'll see exactly what someone sees the moment
              they tap.
            </p>

            <div className="flex flex-wrap gap-2">
              <a href={url} target="_blank" rel="noopener noreferrer">
                <Button variant="brand" size="sm">
                  <ExternalLink size={12} className="mr-1.5" />
                  Preview my card
                </Button>
              </a>
              <Button variant="outline" size="sm" onClick={copyLink}>
                {copied ? <Check size={12} className="mr-1.5" /> : <Copy size={12} className="mr-1.5" />}
                {copied ? 'Copied' : 'Copy link'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRoute(config.mode === 'ported' ? 'ported' : 'custom')}>
                <SquarePen size={12} className="mr-1.5" />
                Edit
              </Button>
            </div>
          </div>
        </div>

        <EventModePanel uid={uid} profile={profile} events={events} />
      </div>
    );
  }

  // ── Route chooser ──────────────────────────────────────────────────────
  if (route === 'choose') {
    return (
      <div className="space-y-4">
        <p className="font-mono text-xs leading-relaxed text-subtle">
          A card page is a URL. Tapping a chip opens it, a QR opens it, and so does the link — so the
          page is the whole product and the hardware is just a shortcut.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <RouteCard
            icon={Sparkles}
            title="Generate it"
            body="Drafted from your bio and resume. Edit anything after."
            recommended
            onClick={() => {
              setRoute('ai');
              runAIDraft();
            }}
          />
          <RouteCard
            icon={SquarePen}
            title="Build it"
            body="Pick an accent and a layout. Write your own intro."
            onClick={() => {
              setConfig((c) => ({ ...c, mode: 'custom' }));
              setRoute('custom');
            }}
          />
          <RouteCard
            icon={Globe}
            title="Point at a page"
            body="Already have a portfolio? Use it, with the name prompt on top."
            onClick={() => {
              setConfig((c) => ({ ...c, mode: 'ported' }));
              setRoute('ported');
            }}
          />
        </div>
      </div>
    );
  }

  // ── Editors ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {route === 'ai' && (
        <div className="space-y-3">
          <AILabel>Drafted from your profile</AILabel>
          <AISurface
            state={aiState === 'idle' ? 'loading' : aiState === 'ready' ? 'ready' : aiState}
            error={aiError}
            onRetry={runAIDraft}
            loadingLine="Reading your bio and resume…"
            emptyLine="Nothing to draft from yet — add a bio in Settings first."
          >
            <p className="font-mono text-xs leading-relaxed text-muted">
              Draft ready below. Change anything you like before publishing.
            </p>
          </AISurface>
          {aiState === 'error' && (
            <Button variant="ghost" size="sm" onClick={useFallbackDraft}>
              Compose without AI
            </Button>
          )}
        </div>
      )}

      {route === 'ported' && (
        <div>
          <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Your existing page
          </label>
          <Input
            value={config.portedUrl || ''}
            onChange={(e) => setConfig({ ...config, portedUrl: e.target.value })}
            placeholder="https://your-portfolio.com"
          />
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted">
            Visitors still get the name prompt and the save-contact action — your page sits behind it.
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Name on the card
          </label>
          <Input value={config.name} onChange={(e) => setConfig({ ...config, name: e.target.value })} />
        </div>
        <div>
          <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Role
          </label>
          <Input value={config.role} onChange={(e) => setConfig({ ...config, role: e.target.value })} />
        </div>
        <div>
          <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Company
          </label>
          <Input value={config.company} onChange={(e) => setConfig({ ...config, company: e.target.value })} />
        </div>
        <div>
          <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Contact email
          </label>
          <Input
            value={config.email || ''}
            onChange={(e) => setConfig({ ...config, email: e.target.value })}
            placeholder="you@company.com"
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
          Intro
        </label>
        <textarea
          className="h-24 w-full rounded-card border border-ink/15 bg-paper/50 p-3 font-mono text-sm transition-colors focus-visible:border-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          value={config.intro}
          maxLength={240}
          onChange={(e) => setConfig({ ...config, intro: e.target.value })}
          placeholder="One or two lines. What's worth talking to you about?"
        />
        <p className="mt-1 text-right font-mono text-[10px] uppercase tracking-widest text-muted">
          {config.intro.length}/240
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <span className="mb-2 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Accent
          </span>
          <div className="flex flex-wrap gap-2">
            {CARD_ACCENTS.map((accent) => {
              const active = config.accent === accent.id;
              return (
                <button
                  key={accent.id}
                  type="button"
                  onClick={() => setConfig({ ...config, accent: accent.id })}
                  aria-pressed={active}
                  title={accent.label}
                  className={`h-7 w-7 rounded-full transition-transform duration-150 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
                    active ? 'ring-2 ring-ink ring-offset-2 ring-offset-white' : ''
                  }`}
                  style={{ backgroundColor: accent.hex }}
                >
                  <span className="sr-only">{accent.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <span className="mb-2 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Layout
          </span>
          <div className="inline-flex rounded-card border border-ink/15 p-0.5">
            {(['compact', 'expanded'] as CardLayout[]).map((layout) => (
              <button
                key={layout}
                type="button"
                onClick={() => setConfig({ ...config, layout })}
                className={`rounded-card px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors duration-150 ${
                  config.layout === layout ? 'bg-ink text-paper' : 'text-muted hover:text-ink'
                }`}
              >
                {layout}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Live preview — the accent band and layout choice read instantly. */}
      <div className="rounded-card border border-ink/25 bg-white">
        <div style={{ backgroundColor: accentHex(config.accent) }} className="h-1.5 rounded-t-card" />
        <div className={config.layout === 'compact' ? 'p-5' : 'p-7'}>
          <p className={`font-serif ${config.layout === 'compact' ? 'text-2xl' : 'text-3xl'} font-black italic`}>
            {config.name || 'Your name'}
          </p>
          {(config.role || config.company) && (
            <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted">
              {[config.role, config.company].filter(Boolean).join(' · ')}
            </p>
          )}
          {config.intro && (
            <p className="mt-3 font-mono text-xs leading-relaxed text-subtle">{config.intro}</p>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t border-ink/15 pt-5">
        <Button variant="ghost" onClick={() => setRoute('choose')}>
          Back
        </Button>
        <Button variant="brand" onClick={handlePublish} disabled={publishing}>
          {publishing ? 'Publishing…' : existingConfig ? 'Save card' : 'Publish card'}
        </Button>
      </div>
    </div>
  );
}

function RouteCard({
  icon: Icon,
  title,
  body,
  recommended,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  body: string;
  recommended?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start gap-2 rounded-card border border-ink/15 bg-white p-4 text-left transition-colors duration-150 hover:border-ink/25 hover:bg-paper/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
    >
      <span className="flex w-full items-center justify-between">
        <Icon size={15} className="text-brand" />
        {recommended && (
          <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-muted">
            Suggested
          </span>
        )}
      </span>
      <span className="font-serif text-lg font-bold italic">{title}</span>
      <span className="font-mono text-[11px] leading-relaxed text-muted">{body}</span>
    </button>
  );
}

// ── Event Mode ────────────────────────────────────────────────────────────

function EventModePanel({
  uid,
  profile,
  events,
}: {
  uid: string;
  profile: any;
  events: CalendarEvent[];
}) {
  const { toast } = useToast();
  const [state, setState] = useState<EventModeState>(() => readEventMode(profile));
  const [manualName, setManualName] = useState('');
  const [recap, setRecap] = useState<EventRecap | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setState(readEventMode(profile));
  }, [profile?.eventMode]);

  const suggestion = useMemo(() => suggestedEvent(events), [events]);

  const begin = async (name: string, source: 'manual' | 'calendar') => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await startEventMode(uid, name.trim(), source);
      setState({ active: true, eventName: name.trim(), startedAt: new Date(), endedAt: null, source });
      setRecap(null);
      toast(`Event Mode on — captures tag as "${name.trim()}".`, 'success');
    } catch {
      toast('Could not start Event Mode.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    const name = state.eventName;
    setBusy(true);
    try {
      await stopEventMode(uid);
      setState({ ...state, active: false, endedAt: new Date() });
      if (name) setRecap(await buildEventRecap(uid, name));
    } catch {
      toast('Could not end Event Mode.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-card border border-ink/15 bg-paper/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
            <Radio size={11} className={state.active ? 'text-brand' : ''} />
            Event Mode
          </span>
          <p className="mt-1.5 font-mono text-xs leading-relaxed text-subtle">
            {state.active
              ? `On. Every capture is filed under "${state.eventName}".`
              : 'Batch-tag everyone who taps your card during a conference.'}
          </p>
        </div>
        {state.active && (
          <Button variant="outline" size="sm" onClick={end} disabled={busy}>
            End
          </Button>
        )}
      </div>

      {!state.active && (
        <div className="mt-4 space-y-3">
          {suggestion && (
            <div className="flex flex-wrap items-center gap-3 rounded-card border border-ink/15 bg-white px-3 py-2.5">
              <span className="font-mono text-xs">
                Calendar says you're at <span className="font-bold">{suggestion.title}</span>.
              </span>
              <Button
                variant="brand"
                size="sm"
                onClick={() => begin(suggestion.title, 'calendar')}
                disabled={busy}
              >
                Turn on
              </Button>
            </div>
          )}
          <div className="flex gap-2">
            <Input
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              placeholder="Or name the event yourself"
              onKeyDown={(e) => {
                if (e.key === 'Enter') begin(manualName, 'manual');
              }}
            />
            <Button variant="outline" onClick={() => begin(manualName, 'manual')} disabled={busy || !manualName.trim()}>
              Start
            </Button>
          </div>
        </div>
      )}

      {recap && (
        <div className="animate-fade-slide-up mt-4 rounded-card border border-ink/15 bg-white p-4">
          <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">Recap</span>
          <p className="mt-1.5 font-serif text-lg font-bold italic">{recap.headline}</p>
          {recap.contacts.length > 0 ? (
            <ul className="mt-3 space-y-1.5 border-t border-ink/15 pt-3">
              {recap.contacts.slice(0, 6).map((contact) => (
                <li key={contact.id} className="flex items-center gap-2 font-mono text-xs text-subtle">
                  <Users size={11} className="shrink-0 text-muted" />
                  <span className="truncate">
                    {contact.name}
                    {contact.company ? ` — ${contact.company}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              className="mt-3"
              icon={Link2}
              line="Nobody tapped during that window. The card link still works if you'd rather send it."
            />
          )}
        </div>
      )}
    </div>
  );
}
