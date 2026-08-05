import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  Plus,
  Radio,
  Sparkles,
  SquarePen,
  Globe,
  Trash2,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { AILabel, AISurface } from '../ui/AISurface';
import { AIProvenance } from '../ui/AIProvenance';
import { QRCode } from './QRCode';
import { EventModeRecap } from './EventModeRecap';
import { useToast } from '../../contexts/ToastContext';
import {
  CARD_ACCENTS,
  DEFAULT_CARD,
  accentHex,
  cardUrl,
  generateCardId,
  publishCard,
  type CardConfig,
  type CardCaptureChannel,
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
import type { GroundingDisplay } from '../../lib/grounding';
import { AICancelledError } from '../../lib/ai';
import {
  hasCardValidationErrors,
  validateCardConfig,
  type CardField,
  type CardValidationErrors,
} from '../../lib/cardValidation';

/**
 * Owner-side setup for the public card and its NFC, QR, and shared-link
 * distribution paths. Lives in Settings → Connections.
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
  const [publishError, setPublishError] = useState<string | null>(null);
  const [copied, setCopied] = useState<CardCaptureChannel | null>(null);

  const [aiState, setAiState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiGrounding, setAiGrounding] = useState<GroundingDisplay | null>(
    profile?.cardAIGrounding || null,
  );
  const [draftMode, setDraftMode] = useState<'model' | 'local' | null>(null);
  const [fieldErrors, setFieldErrors] = useState<CardValidationErrors>({});
  const aiRequestRef = useRef<AbortController | null>(null);

  const cardId = useMemo(() => existingCardId || generateCardId(), [existingCardId]);
  const url = cardUrl(cardId);
  const qrUrl = cardUrl(cardId, 'qr');
  const nfcUrl = cardUrl(cardId, 'nfc');
  const sharedLinkUrl = cardUrl(cardId, 'link');

  useEffect(() => {
    setConfig((current) => cardFromProfile(profile, existingConfig || current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.name, profile?.role, profile?.company, profile?.cardId]);

  useEffect(
    () => () => {
      aiRequestRef.current?.abort();
      aiRequestRef.current = null;
    },
    [],
  );

  const runAIDraft = async () => {
    aiRequestRef.current?.abort();
    const controller = new AbortController();
    aiRequestRef.current = controller;
    setAiState('loading');
    setAiError(null);
    setAiGrounding(null);
    setDraftMode(null);
    try {
      const generated = await generateCardDraft({
        ...(profile || {}),
        signal: controller.signal,
      });
      const draft = generated.draft;
      setConfig((current) => ({
        ...current,
        mode: 'ai' as CardMode,
        intro: draft.intro,
        accent: draft.accent,
        layout: draft.layout,
      }));
      setAiGrounding(generated.grounding);
      setDraftMode('model');
      setAiState('ready');
    } catch (error: any) {
      if (aiRequestRef.current !== controller) return;
      setAiError(
        error instanceof AICancelledError
          ? 'Card drafting canceled. Your current card fields are unchanged.'
          : error?.message || 'The model did not come back.',
      );
      setAiState('error');
    } finally {
      if (aiRequestRef.current === controller) aiRequestRef.current = null;
    }
  };

  const useFallbackDraft = () => {
    aiRequestRef.current?.abort();
    aiRequestRef.current = null;
    setConfig((current) => ({
      ...current,
      mode: 'ai' as CardMode,
      intro: composeFallbackIntro(profile || {}),
    }));
    setAiGrounding(null);
    setDraftMode('local');
    setAiState('ready');
  };

  const handlePublish = async () => {
    setPublishError(null);
    const errors = validateCardConfig(config);
    setFieldErrors(errors);
    if (hasCardValidationErrors(errors)) {
      toast(Object.values(errors)[0] || 'Check the highlighted card fields.', 'error');
      return;
    }
    setPublishing(true);
    const isFirstPublish = !existingConfig;
    try {
      await publishCard(
        uid,
        cardId,
        { ...config, published: true },
        config.mode === 'ai' ? aiGrounding : null,
      );
      if (config.mode !== 'ai') setAiGrounding(null);
      onPublished(cardId, { ...config, published: true });
      // Return to the published view. Staying in the editor left the user
      // with no confirmation the card was live and no sight of its URL or
      // QR — the two things they came here for.
      setRoute('choose');
      toast(isFirstPublish ? 'Card published. Tap-ready.' : 'Card updated.', 'success');
    } catch (error: any) {
      const code = String(error?.code || '').replace(/^firestore\//, '');
      const message =
        code === 'permission-denied'
          ? 'Your draft is preserved. Card publishing was rejected by the current Firestore policy; verify the deployed card rules, then retry here.'
          : !navigator.onLine
            ? 'Your draft is preserved. Reconnect to the internet, then retry publishing here.'
            : 'Your draft is preserved. The card service did not accept this publish; wait a moment and retry here.';
      setPublishError(message);
      toast(message, 'error');
    } finally {
      setPublishing(false);
    }
  };

  const clearFieldError = (field: CardField) => {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const copyLink = async (
    value: string,
    channel: CardCaptureChannel,
  ) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(channel);
      window.setTimeout(
        () =>
          setCopied((current) =>
            current === channel ? null : current,
          ),
        2000,
      );
    } catch {
      toast('Clipboard blocked — copy the visible card URL instead.', 'error');
    }
  };

  // ── Published state ────────────────────────────────────────────────────
  if (existingConfig && route === 'choose') {
    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <div className="shrink-0">
            <QRCode value={qrUrl} size={140} />
            <p className="mt-2 text-center font-mono text-[9px] font-bold uppercase tracking-widest text-muted">
              QR-marked URL
            </p>
          </div>

          <div className="min-w-0 flex-1 space-y-4">
            <div>
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
                Your card
              </span>
              <p className="mt-1.5 truncate font-mono text-sm">{url}</p>
            </div>

            <p className="font-mono text-xs leading-relaxed text-subtle">
              Each distribution path gets its own URL marker, so the private
              recap can distinguish a QR scan, NFC tap, shared link, or direct
              preview. It records the issued URL, not verified hardware.
            </p>

            {config.mode === 'ai' && aiGrounding && (
              <AIProvenance
                sourceIds={aiGrounding.usedSourceIds || []}
                sourceLabels={aiGrounding.sourceLabels || {}}
                unsupportedAssumptions={
                  aiGrounding.unsupportedAssumptions || []
                }
                privacyExclusions={
                  aiGrounding.privacyExclusions || []
                }
                generatedAt={aiGrounding.generatedAt}
                sourceObservedAt={aiGrounding.sourceObservedAt}
                consideredSourceCount={aiGrounding.consideredSourceCount}
                dataFreshThrough={aiGrounding.dataFreshThrough}
                generation={aiGrounding.generation}
              />
            )}

            <div className="flex flex-wrap gap-2">
              <a href={url} target="_blank" rel="noopener noreferrer">
                <Button variant="brand" size="sm">
                  <ExternalLink size={12} className="mr-1.5" />
                  Preview my card
                </Button>
              </a>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyLink(sharedLinkUrl, 'link')}
                title={sharedLinkUrl}
              >
                {copied === 'link' ? <Check size={12} className="mr-1.5" /> : <Copy size={12} className="mr-1.5" />}
                {copied === 'link' ? 'Copied' : 'Copy share link'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyLink(nfcUrl, 'nfc')}
                title={nfcUrl}
              >
                {copied === 'nfc' ? <Check size={12} className="mr-1.5" /> : <Copy size={12} className="mr-1.5" />}
                {copied === 'nfc' ? 'Copied' : 'Copy NFC URL'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyLink(qrUrl, 'qr')}
                title={qrUrl}
              >
                {copied === 'qr' ? <Check size={12} className="mr-1.5" /> : <Copy size={12} className="mr-1.5" />}
                {copied === 'qr' ? 'Copied' : 'Copy QR URL'}
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
          <AILabel>
            {draftMode === 'local' ? 'Composed locally from your profile' : 'Drafted from your profile'}
          </AILabel>
          <AISurface
            state={aiState === 'idle' ? 'loading' : aiState === 'ready' ? 'ready' : aiState}
            error={aiError}
            onRetry={runAIDraft}
            onCancel={() => aiRequestRef.current?.abort()}
            loadingStages={[
              'Reading eligible profile sources…',
              'Drafting the card introduction…',
              'Checking every claim against your profile…',
            ]}
            usageLabel="Premium drafting AI"
            emptyLine="Nothing to draft from yet — add a bio in Settings first."
          >
            <p className="font-mono text-xs leading-relaxed text-muted">
              {draftMode === 'local'
                ? 'Local fallback ready below; no model was used.'
                : 'Draft ready below. Change anything you like before publishing.'}
            </p>
            {aiGrounding && (
              <AIProvenance
                className="mt-3"
                sourceIds={aiGrounding.usedSourceIds}
                sourceLabels={aiGrounding.sourceLabels}
                unsupportedAssumptions={aiGrounding.unsupportedAssumptions}
                privacyExclusions={aiGrounding.privacyExclusions}
                generatedAt={aiGrounding.generatedAt}
                sourceObservedAt={aiGrounding.sourceObservedAt}
                consideredSourceCount={aiGrounding.consideredSourceCount}
                dataFreshThrough={aiGrounding.dataFreshThrough}
                generation={aiGrounding.generation}
              />
            )}
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
          <label htmlFor="card-ported-url" className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Your existing page
          </label>
          <Input
            id="card-ported-url"
            value={config.portedUrl || ''}
            maxLength={2048}
            aria-invalid={Boolean(fieldErrors.portedUrl)}
            aria-describedby={fieldErrors.portedUrl ? 'card-ported-url-error' : undefined}
            onChange={(e) => {
              clearFieldError('portedUrl');
              setConfig({ ...config, portedUrl: e.target.value });
            }}
            placeholder="https://your-portfolio.com"
          />
          <FieldError id="card-ported-url-error" message={fieldErrors.portedUrl} />
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted">
            Visitors still get the name prompt and the save-contact action — your page sits behind it.
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="card-name" className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Name on the card
          </label>
          <Input
            id="card-name"
            value={config.name}
            maxLength={120}
            aria-invalid={Boolean(fieldErrors.name)}
            aria-describedby={fieldErrors.name ? 'card-name-error' : undefined}
            onChange={(e) => {
              clearFieldError('name');
              setConfig({ ...config, name: e.target.value });
            }}
          />
          <FieldError id="card-name-error" message={fieldErrors.name} />
        </div>
        <div>
          <label htmlFor="card-role" className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Role
          </label>
          <Input
            id="card-role"
            value={config.role}
            maxLength={160}
            aria-invalid={Boolean(fieldErrors.role)}
            aria-describedby={fieldErrors.role ? 'card-role-error' : undefined}
            onChange={(e) => {
              clearFieldError('role');
              setConfig({ ...config, role: e.target.value });
            }}
          />
          <FieldError id="card-role-error" message={fieldErrors.role} />
        </div>
        <div>
          <label htmlFor="card-company" className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Company
          </label>
          <Input
            id="card-company"
            value={config.company}
            maxLength={160}
            aria-invalid={Boolean(fieldErrors.company)}
            aria-describedby={fieldErrors.company ? 'card-company-error' : undefined}
            onChange={(e) => {
              clearFieldError('company');
              setConfig({ ...config, company: e.target.value });
            }}
          />
          <FieldError id="card-company-error" message={fieldErrors.company} />
        </div>
        <div>
          <label htmlFor="card-email" className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Contact email
          </label>
          <Input
            id="card-email"
            value={config.email || ''}
            maxLength={320}
            type="email"
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? 'card-email-error' : undefined}
            onChange={(e) => {
              clearFieldError('email');
              setConfig({ ...config, email: e.target.value });
            }}
            placeholder="you@company.com"
          />
          <FieldError id="card-email-error" message={fieldErrors.email} />
        </div>
      </div>

      <div>
        <label htmlFor="card-intro" className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
          Intro
        </label>
        <textarea
          id="card-intro"
          className="h-24 w-full rounded-card border border-ink/15 bg-paper/50 p-3 font-mono text-sm transition-colors focus-visible:border-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          value={config.intro}
          maxLength={240}
          aria-invalid={Boolean(fieldErrors.intro)}
          aria-describedby={fieldErrors.intro ? 'card-intro-error' : undefined}
          onChange={(e) => {
            clearFieldError('intro');
            setConfig({ ...config, intro: e.target.value });
          }}
          placeholder="One or two lines. What's worth talking to you about?"
        />
        <p className="mt-1 text-right font-mono text-[10px] uppercase tracking-widest text-muted">
          {config.intro.length}/240
        </p>
        <FieldError id="card-intro-error" message={fieldErrors.intro} />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <span className="block font-mono text-[10px] uppercase tracking-widest text-muted">
              Links
            </span>
            <span className="font-mono text-[10px] text-muted">
              Up to six full HTTPS links
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={(config.links || []).length >= 6}
            onClick={() => {
              clearFieldError('links');
              setConfig({
                ...config,
                links: [...(config.links || []), { label: '', url: '' }],
              });
            }}
          >
            <Plus size={11} className="mr-1.5" />
            Add link
          </Button>
        </div>
        {(config.links || []).length > 0 && (
          <div className="space-y-2">
            {(config.links || []).map((link, index) => (
              <div
                key={index}
                className="grid gap-2 rounded-card border border-ink/15 bg-paper/40 p-3 sm:grid-cols-[0.8fr_1.4fr_auto]"
              >
                <Input
                  value={link.label}
                  maxLength={80}
                  aria-label={`Link ${index + 1} label`}
                  aria-invalid={Boolean(fieldErrors.links)}
                  aria-describedby={fieldErrors.links ? 'card-links-error' : undefined}
                  placeholder="Portfolio"
                  onChange={(event) => {
                    clearFieldError('links');
                    const links = [...(config.links || [])];
                    links[index] = { ...links[index], label: event.target.value };
                    setConfig({ ...config, links });
                  }}
                />
                <Input
                  value={link.url}
                  maxLength={2048}
                  inputMode="url"
                  aria-label={`Link ${index + 1} HTTPS URL`}
                  aria-invalid={Boolean(fieldErrors.links)}
                  aria-describedby={fieldErrors.links ? 'card-links-error' : undefined}
                  placeholder="https://example.com"
                  onChange={(event) => {
                    clearFieldError('links');
                    const links = [...(config.links || [])];
                    links[index] = { ...links[index], url: event.target.value };
                    setConfig({ ...config, links });
                  }}
                />
                <button
                  type="button"
                  aria-label={`Remove link ${index + 1}`}
                  onClick={() => {
                    clearFieldError('links');
                    setConfig({
                      ...config,
                      links: (config.links || []).filter((_, itemIndex) => itemIndex !== index),
                    });
                  }}
                  className="flex h-9 w-9 items-center justify-center rounded-card border border-ink/15 text-muted transition-colors hover:border-red-300 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <FieldError id="card-links-error" message={fieldErrors.links} />
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
        {publishError && (
          <p
            className="mr-auto max-w-md border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950"
            role="alert"
          >
            {publishError}
          </p>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            aiRequestRef.current?.abort();
            aiRequestRef.current = null;
            setRoute('choose');
          }}
        >
          Back
        </Button>
        <Button variant="brand" onClick={handlePublish} disabled={publishing}>
          {publishing ? 'Publishing…' : existingConfig ? 'Save card' : 'Publish card'}
        </Button>
      </div>
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 font-mono text-[11px] leading-relaxed text-red-700">
      {message}
    </p>
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
    let cancelled = false;
    const nextState = readEventMode(profile);
    setState(nextState);
    if (
      !nextState.active &&
      nextState.sessionId &&
      nextState.eventName
    ) {
      buildEventRecap(
        uid,
        nextState.eventName,
        nextState.sessionId,
        nextState,
      )
        .then((result) => {
          if (!cancelled) setRecap(result);
        })
        .catch(() => {
          // The recap is derived from saved contacts. A temporary read
          // failure must not make the card or Event Mode unavailable.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [profile?.eventMode, uid]);

  const suggestion = useMemo(() => suggestedEvent(events), [events]);

  const begin = async (name: string, source: 'manual' | 'calendar') => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const sessionId = await startEventMode(uid, name.trim(), source);
      setState({
        active: true,
        sessionId,
        eventName: name.trim(),
        startedAt: new Date(),
        endedAt: null,
        source,
      });
      setRecap(null);
      setManualName('');
      toast(`Event Mode on — captures tag as "${name.trim()}".`, 'success');
    } catch {
      toast('Could not start Event Mode.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    const name = state.eventName;
    const sessionId = state.sessionId;
    setBusy(true);
    try {
      await stopEventMode(uid);
      const completedState = {
        ...state,
        active: false,
        endedAt: new Date(),
      };
      setState(completedState);
      if (name) {
        setRecap(
          await buildEventRecap(
            uid,
            name,
            sessionId,
            completedState,
          ),
        );
      }
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
              ? `On. Every capture is filed under "${state.eventName}" in session ${state.sessionId?.slice(0, 8)}.`
              : 'Batch-tag everyone who taps your card during a conference.'}
          </p>
          {state.active && (
            <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">
              Captures keep their consent state, timestamp, and recorded
              QR/NFC/public-card provenance.
            </p>
          )}
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
        <EventModeRecap
          recap={recap}
          organizerLabel={profile?.name || null}
        />
      )}
    </div>
  );
}
