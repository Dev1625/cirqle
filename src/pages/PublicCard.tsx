import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
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
 * /c/:cardId — what a physical NFC card opens when tapped.
 *
 * Fully public: no login, no account, no gate. The only thing asked of a
 * first-time viewer is a name, once, so the reverse capture has something to
 * file. Everything else about the visit is optional.
 *
 * This page deliberately does not use AppLayout — a stranger who tapped a
 * chip should land on a card, not on a product's chrome.
 */

type Phase = 'loading' | 'missing' | 'ready';

export default function PublicCard() {
  const { cardId = '' } = useParams();
  const [phase, setPhase] = useState<Phase>('loading');
  const [card, setCard] = useState<PublicCardType | null>(null);

  const [visitorName, setVisitorName] = useState<string>(() => getStoredVisitorName() || '');
  const [askName, setAskName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
        // First visit for this viewer, ever — ask once, name only.
        if (!getStoredVisitorName()) setAskName(true);
      })
      .catch(() => {
        if (!cancelled) setPhase('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  useEffect(() => {
    if (askName) {
      // Focus after the entrance animation has committed, not during it.
      const id = window.setTimeout(() => nameInputRef.current?.focus(), 60);
      return () => window.clearTimeout(id);
    }
  }, [askName]);

  const accent = useMemo(() => accentHex(card?.accent), [card?.accent]);

  const confirmName = () => {
    const cleaned = nameDraft.trim();
    if (!cleaned) return;
    storeVisitorName(cleaned);
    setVisitorName(cleaned);
    setAskName(false);
  };

  const handleSave = async () => {
    if (!card) return;
    // Downloading the vCard is the viewer's half and must never be blocked on
    // the network write that is the owner's half.
    downloadVCard(card);

    setSaving(true);
    setSaveError(null);
    try {
      await submitCapture({
        cardId: card.cardId,
        visitorName: visitorName || 'Someone',
      });
      setSaved(true);
    } catch {
      setSaveError('Contact saved to your phone, but we could not notify ' + (card.name || 'them') + '.');
    } finally {
      setSaving(false);
    }
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
                onClick={handleSave}
              >
                {saving ? 'Saving…' : 'Save contact'}
              </Button>
            )}

            {saveError && (
              <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted">{saveError}</p>
            )}

            {!saved && (
              <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-widest text-muted">
                {visitorName ? `Saving as ${visitorName}` : 'Downloads a contact card'}
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

      {/* First visit, once ever, name only. Nothing else is required and
          nothing is created on the viewer's behalf. */}
      {askName && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm animate-fade-in">
          <div className="animate-fade-scale-in w-full max-w-sm rounded-card border border-ink/15 bg-white shadow-float">
            <div className="p-6">
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
                Before you look
              </span>
              <h2 className="mt-2 font-serif text-2xl font-bold italic">Who should we say tapped?</h2>
              <p className="mt-2 font-mono text-xs leading-relaxed text-subtle">
                Just a name. {card.name?.split(' ')[0] || 'They'} gets it back so you don't have to spell it out later.
              </p>
              <div className="mt-5">
                <label htmlFor="visitor-name" className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
                  Your name
                </label>
                <Input
                  id="visitor-name"
                  ref={nameInputRef}
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmName();
                  }}
                  placeholder="Alex Rivera"
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 p-6 pt-0">
              <button
                onClick={() => setAskName(false)}
                className="font-mono text-[10px] uppercase tracking-widest text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
              >
                Skip
              </button>
              <Button variant="brand" onClick={confirmName} disabled={!nameDraft.trim()}>
                Continue
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
