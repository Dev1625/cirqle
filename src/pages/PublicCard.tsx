import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router';
import { ArrowUpRight, Check, Link2, Loader2, UserRoundX } from 'lucide-react';
import {
  loadPublicCard,
  submitCapture,
  downloadVCard,
  getStoredVisitorName,
  storeVisitorName,
  accentHex,
  type PublicCard as PublicCardType,
} from '../lib/card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Avatar } from '../components/ui/Avatar';

/**
 * /c/:cardId — what an NFC tap, QR scan, or shared link opens.
 *
 * Fully public: no login, no account, no gate. A viewer confirms the name that
 * will be shared immediately before each reverse capture. The name is kept
 * only in this tab for a short period; everything else remains optional.
 *
 * This page deliberately does not use AppLayout — a stranger who tapped a
 * chip should land on a card, not on a product's chrome.
 */

type Phase = 'loading' | 'missing' | 'ready';
type IdentityIntent = 'edit' | 'submit' | null;

export default function PublicCard() {
  const { cardId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const [phase, setPhase] = useState<Phase>('loading');
  const [card, setCard] = useState<PublicCardType | null>(null);

  const [visitorName, setVisitorName] = useState<string>(() => getStoredVisitorName() || '');
  const [identityIntent, setIdentityIntent] = useState<IdentityIntent>(null);
  const [nameDraft, setNameDraft] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [website, setWebsite] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [visitorEmail, setVisitorEmail] = useState('');
  const [visitorCompany, setVisitorCompany] = useState('');
  const [visitorNote, setVisitorNote] = useState('');
  const [consentToFollowUp, setConsentToFollowUp] = useState(false);
  const captureChannel =
    searchParams.get('via') === 'qr'
      ? 'qr'
      : searchParams.get('via') === 'nfc'
        ? 'nfc'
        : searchParams.get('via') === 'link'
          ? 'link'
          : 'direct';

  useEffect(() => {
    let cancelled = false;
    loadPublicCard(cardId)
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setPhase('missing');
          return;
        }
        setCard(result);
        setPhase('ready');
      })
      .catch(() => {
        if (!cancelled) setPhase('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  useEffect(() => {
    if (identityIntent) {
      // Focus after the entrance animation has committed, not during it.
      const id = window.setTimeout(() => nameInputRef.current?.focus(), 60);
      return () => window.clearTimeout(id);
    }
  }, [identityIntent]);

  const accent = useMemo(() => accentHex(card?.accent), [card?.accent]);

  const openIdentity = (intent: Exclude<IdentityIntent, null>) => {
    setNameDraft(visitorName);
    setIdentityIntent(intent);
  };

  const saveWithConfirmedIdentity = async (confirmedName: string) => {
    if (!card) return;
    // Downloading the vCard is the viewer's half and must never be blocked on
    // the network write that is the owner's half.
    downloadVCard(card);

    setSaving(true);
    setSaveError(null);
    try {
      await submitCapture({
        cardId: card.cardId,
        visitorName: confirmedName,
        visitorEmail: consentToFollowUp ? visitorEmail : null,
        visitorCompany: consentToFollowUp ? visitorCompany : null,
        note: consentToFollowUp ? visitorNote : null,
        consentToFollowUp,
        captureChannel,
        website,
      });
      setSaved(true);
    } catch (error) {
      const detail =
        error instanceof Error && error.message
          ? error.message
          : 'We could not notify them.';
      setSaveError(`Contact saved to your phone. ${detail}`);
    } finally {
      setSaving(false);
    }
  };

  const confirmIdentity = () => {
    const cleaned = nameDraft.trim().replace(/\s+/g, ' ');
    if (!cleaned || cleaned.length > 120) return;
    storeVisitorName(cleaned);
    setVisitorName(cleaned);
    const shouldSubmit = identityIntent === 'submit';
    setIdentityIntent(null);
    if (shouldSubmit) void saveWithConfirmedIdentity(cleaned);
  };

  if (phase === 'loading') {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <span className="flex items-center gap-2.5 font-mono text-xs uppercase tracking-widest text-muted">
          <Loader2 size={14} className="animate-spin" />
          Opening card
        </span>
      </div>
    );
  }

  if (phase === 'missing' || !card) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <div className="animate-fade-slide-up flex max-w-sm flex-col items-center gap-4 rounded-card border border-dashed border-ink/25 px-8 py-12 text-center">
          <UserRoundX size={22} className="text-muted" />
          <h1 className="font-serif text-2xl font-bold italic">No card here.</h1>
          <p className="font-mono text-xs leading-relaxed text-muted">
            This link is retired, or the card was never published. Nothing was lost — ask for it again.
          </p>
          <Link to="/">
            <Button variant="outline" size="sm">What is Cirqle?</Button>
          </Link>
        </div>
      </div>
    );
  }

  const compact = card.layout === 'compact';

  return (
    <div className="flex min-h-svh flex-col items-center justify-center px-5 py-12">
      <main
        className={`animate-fade-slide-up w-full ${compact ? 'max-w-sm' : 'max-w-md'} rounded-card border border-ink/25 bg-white shadow-card`}
      >
        {/* The accent reads as a printed edge band rather than a coloured
            header block — one confident stripe, the card's only saturation. */}
        <div style={{ backgroundColor: accent }} className="h-1.5 rounded-t-card" />

        <div className={compact ? 'p-6 sm:p-7' : 'p-6 sm:p-9'}>
          {/* Stacks below sm. Side-by-side, an 80px avatar eats a quarter of a
              375px screen and forces the name to wrap — "Devarshi / Dalal"
              broken across two lines is the first thing someone sees after
              tapping a physical card, which is the worst possible place for it.
              Stacked, the name gets the full width and stays on one line. */}
          <div className="flex flex-col items-start gap-4 sm:flex-row">
            <Avatar name={card.name} size={compact ? 'lg' : 'xl'} tone={accent} />
            <div className="min-w-0 flex-1 sm:pt-1">
              <h1
                className={`font-serif ${compact ? 'text-2xl sm:text-3xl' : 'text-3xl sm:text-4xl'} font-black italic leading-tight`}
              >
                {card.name || 'Unnamed'}
              </h1>
              {(card.role || card.company) && (
                <p className="mt-1.5 font-mono text-[11px] uppercase leading-relaxed tracking-widest text-muted">
                  {[card.role, card.company].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          </div>

          {card.intro && !compact && (
            <p className="mt-6 border-t border-ink/15 pt-6 font-mono text-sm leading-relaxed text-subtle">
              {card.intro}
            </p>
          )}
          {card.intro && compact && (
            <p className="mt-5 font-mono text-xs leading-relaxed text-subtle">{card.intro}</p>
          )}

          {card.links.length > 0 && (
            <ul className="mt-6 flex flex-col gap-2 border-t border-ink/15 pt-5">
              {card.links.map((link, index) => (
                <li key={`${link.url}-${index}`}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center justify-between gap-3 rounded-card px-2 py-2 font-mono text-xs transition-colors hover:bg-paper"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Link2 size={12} className="shrink-0 text-muted" />
                      <span className="truncate">{link.label}</span>
                    </span>
                    <ArrowUpRight
                      size={13}
                      className="shrink-0 text-muted transition-colors group-hover:text-brand"
                    />
                  </a>
                </li>
              ))}
            </ul>
          )}

          {card.mode === 'ported' && card.portedUrl && (
            <a
              href={card.portedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 flex items-center justify-between gap-3 rounded-card border border-ink/15 bg-paper/60 px-3 py-2.5 font-mono text-[11px] transition-colors hover:border-ink/25"
            >
              <span className="truncate">Full site — {new URL(card.portedUrl).hostname}</span>
              <ArrowUpRight size={13} className="shrink-0 text-muted" />
            </a>
          )}

          <div className="mt-7 border-t border-ink/15 pt-6">
            <label
              aria-hidden="true"
              className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden"
            >
              Website
              <input
                name="website"
                value={website}
                onChange={(event) => setWebsite(event.target.value)}
                tabIndex={-1}
                autoComplete="off"
              />
            </label>
            {!saved && (
              <div className="mb-4 space-y-4">
                <div
                  className="flex items-start justify-between gap-4 rounded-card border border-ink/15 bg-paper/50 p-4"
                  aria-label="Identity shared when saving"
                >
                  <div>
                    <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-muted">
                      Identity shared when saving
                    </p>
                    <p className="mt-1 font-mono text-xs font-bold text-ink">
                      {visitorName || 'No name set for this tab'}
                    </p>
                    <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">
                      {visitorName
                        ? 'Check this name on a shared device. You will confirm it again before anything is sent.'
                        : 'Add and confirm your name before anything is sent.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openIdentity('edit')}
                    className="min-h-11 shrink-0 px-2 font-mono text-[10px] font-bold uppercase tracking-widest text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    {visitorName ? 'Change' : 'Add name'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setDetailsOpen((current) => !current)}
                  aria-expanded={detailsOpen}
                  className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
                >
                  {detailsOpen ? 'Hide follow-up details' : 'Share follow-up details (optional)'}
                </button>

                {detailsOpen && (
                  <div className="mt-3 space-y-3 rounded-card border border-ink/15 bg-paper/50 p-4">
                    <div>
                      <label
                        htmlFor="visitor-email"
                        className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted"
                      >
                        Your email
                      </label>
                      <Input
                        id="visitor-email"
                        type="email"
                        value={visitorEmail}
                        maxLength={200}
                        onChange={(event) => setVisitorEmail(event.target.value)}
                        placeholder="alex@example.com"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="visitor-company"
                        className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted"
                      >
                        Company
                      </label>
                      <Input
                        id="visitor-company"
                        value={visitorCompany}
                        maxLength={200}
                        onChange={(event) => setVisitorCompany(event.target.value)}
                        placeholder="Optional"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="visitor-note"
                        className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted"
                      >
                        What should they remember?
                      </label>
                      <textarea
                        id="visitor-note"
                        className="h-20 w-full rounded-card border border-ink/15 bg-white p-3 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                        value={visitorNote}
                        maxLength={500}
                        onChange={(event) => setVisitorNote(event.target.value)}
                        placeholder="Where you met or what to follow up on"
                      />
                    </div>
                    <label className="flex cursor-pointer items-start gap-2.5 font-mono text-[11px] leading-relaxed text-subtle">
                      <input
                        type="checkbox"
                        checked={consentToFollowUp}
                        onChange={(event) => setConsentToFollowUp(event.target.checked)}
                        className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
                      />
                      <span>
                        Share these optional details with {card.name?.split(' ')[0] || 'this person'} and allow a follow-up.
                      </span>
                    </label>
                    {!consentToFollowUp && (visitorEmail || visitorCompany || visitorNote) && (
                      <p role="status" className="font-mono text-[10px] leading-relaxed text-muted">
                        Optional details stay on this page until you consent. Your name is still shared when you save.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
            {saved ? (
              <div className="animate-fade-in flex items-center gap-2.5 font-mono text-xs text-subtle">
                <Check size={14} style={{ color: accent }} />
                Saved. {card.name?.split(' ')[0] || 'They'} has your name too.
              </div>
            ) : (
              // The owner's chosen accent is applied inline, which outranks the
              // variant's hover class — so press/hover feedback comes from
              // brightness instead, and works for all six presets.
              <Button
                variant="brand"
                size="lg"
                className="w-full transition-[filter,transform] hover:brightness-110"
                style={{ backgroundColor: accent }}
                disabled={saving}
                onClick={() => openIdentity('submit')}
              >
                {saving ? 'Saving…' : 'Save contact'}
              </Button>
            )}

            {saveError && (
              <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted">{saveError}</p>
            )}

            {!saved && (
              <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-muted">
                You will confirm the displayed name before Cirqle downloads their vCard and privately records this tap. No account is created for you.
              </p>
            )}
          </div>
        </div>
      </main>

      <Link
        to="/"
        className="mt-8 font-mono text-[10px] uppercase tracking-widest text-muted transition-colors hover:text-ink"
      >
        Powered by Cirqle
      </Link>

      {identityIntent && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm animate-fade-in"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) {
              setIdentityIntent(null);
            }
          }}
        >
          <div
            className="animate-fade-scale-in w-full max-w-sm rounded-card border border-ink/15 bg-white shadow-float"
            role="dialog"
            aria-modal="true"
            aria-labelledby="visitor-identity-title"
            aria-describedby="visitor-identity-description"
          >
            <div className="p-6">
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
                {identityIntent === 'submit'
                  ? 'Confirm before sharing'
                  : 'Identity for this tab'}
              </span>
              <h2
                id="visitor-identity-title"
                className="mt-2 font-serif text-2xl font-bold italic"
              >
                Is this the right name?
              </h2>
              <p
                id="visitor-identity-description"
                className="mt-2 font-mono text-xs leading-relaxed text-subtle"
              >
                Cirqle will share this name with {card.name?.split(' ')[0] || 'this person'} only after you confirm. It is remembered only in this tab for up to two hours.
              </p>
              <div className="mt-5">
                <label htmlFor="visitor-name" className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
                  Your name
                </label>
                <Input
                  id="visitor-name"
                  ref={nameInputRef}
                  value={nameDraft}
                  maxLength={120}
                  autoComplete="name"
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmIdentity();
                  }}
                  placeholder="Alex Rivera"
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 p-6 pt-0">
              <button
                type="button"
                onClick={() => setIdentityIntent(null)}
                className="font-mono text-[10px] uppercase tracking-widest text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
              >
                Cancel
              </button>
              <Button
                variant="brand"
                onClick={confirmIdentity}
                disabled={!nameDraft.trim() || nameDraft.trim().length > 120}
              >
                {identityIntent === 'submit' ? 'Confirm and save' : 'Use this name'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
