import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Copy, Check, Flame, Mail, Sunrise } from 'lucide-react';
import { Button } from '../ui/Button';
import { AILabel, AISurface } from '../ui/AISurface';
import { AIProvenance } from '../ui/AIProvenance';
import { PreviewBadge } from '../ui/PreviewBadge';
import { LastSynced } from '../ui/LastSynced';
import { HealthPill } from '../ui/HealthPill';
import { useToast } from '../../contexts/ToastContext';
import { buildDigest, draftRevivalNote, sendDigestEmail, type Digest, type DigestItem } from '../../lib/digest';
import { emailMode } from '../../lib/integrations/config';
import type { GroundingDisplay } from '../../lib/grounding';
import { AICancelledError } from '../../lib/ai';

/**
 * "Worth reviving this week."
 *
 * Content generation is fully real — no mock, no external dependency. Only
 * the email delivery of the same digest is scaffolded, and the UI says which
 * is which rather than implying the email went out.
 */
export function DormantDigest({ uid, senderName }: { uid: string; senderName: string }) {
  const { toast } = useToast();
  const [digest, setDigest] = useState<Digest | null>(null);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState('loading');
    setError(null);
    buildDigest(uid)
      .then((result) => {
        setDigest(result);
        setState('ready');
      })
      .catch((err) => {
        setError(err?.message || 'Could not read your network.');
        setState('error');
      });
  }, [uid]);

  useEffect(load, [load]);

  const emailDigest = async () => {
    if (!digest) return;
    try {
      const result = await sendDigestEmail({ to: '', digest, senderName });
      if (result.mode === 'mock') {
        toast('Email delivery is not configured yet — the digest lives here for now.', 'info');
      } else {
        toast('Digest emailed.', 'success');
      }
    } catch {
      toast('Could not send the digest.', 'error');
    }
  };

  const isEmpty = state === 'ready' && (digest?.items.length || 0) === 0;

  return (
    <section className="rounded-card border border-ink/25 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/15 bg-[#F8F5EF] px-6 py-4">
        <div>
          <h2 className="flex items-center gap-2 font-serif text-xl font-bold italic">
            <Sunrise size={17} className="text-brand" />
            Worth reviving.
          </h2>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted">
            {/* "0 gone quiet · top 0" is not a sentence anyone wants to read,
                and showing "top N" when N equals the total is noise. */}
            {!digest
              ? 'Scanning your network'
              : digest.dormantCount === 0
                ? 'Nothing slipping'
                : digest.items.length < digest.dormantCount
                  ? `${digest.dormantCount} gone quiet · top ${digest.items.length}`
                  : `${digest.dormantCount} gone quiet`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {digest && <LastSynced at={digest.generatedAt} prefix="Built" />}
          <Button variant="ghost" size="sm" onClick={emailDigest} disabled={!digest || isEmpty}>
            <Mail size={11} className="mr-1.5" />
            Email it
          </Button>
          {emailMode() === 'mock' && <PreviewBadge label="Email preview" title="No transactional email provider configured — see MANUAL_SETUP.md." />}
        </div>
      </header>

      <div className="p-6">
        <AISurface
          state={isEmpty ? 'empty' : state}
          error={error}
          onRetry={load}
          loadingLine="Working out who's slipping…"
          emptyIcon={Flame}
          emptyLine="Nobody's gone cold. Either you're on top of it or the network is young — both are fine."
        >
          <ul className="space-y-3">
            {(digest?.items || []).map((item, index) => (
              <DigestRow key={item.contactId} item={item} senderName={senderName} index={index} />
            ))}
          </ul>
        </AISurface>
      </div>
    </section>
  );
}

function DigestRow({
  item,
  senderName,
  index,
}: {
  item: DigestItem;
  senderName: string;
  index: number;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [grounding, setGrounding] = useState<GroundingDisplay | null>(null);
  const [draftState, setDraftState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const runDraft = async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setDraftState('loading');
    setDraftError(null);
    setGrounding(null);
    try {
      const generated = await draftRevivalNote({
        contactId: item.contactId,
        contactName: item.name,
        company: item.company,
        role: item.role,
        reason: item.reason,
        lastTouchDays: item.health.lastTouchDays,
        neverContacted: item.health.neverContacted,
        whyTheyMatter: item.whyTheyMatter,
        senderName,
        signal: controller.signal,
      });
      setDraft(generated.text);
      setGrounding(generated.grounding);
      setDraftState('ready');
    } catch (error) {
      if (requestRef.current !== controller) return;
      setDraftError(
        error instanceof AICancelledError
          ? 'Drafting canceled. Your contact record is unchanged.'
          : error instanceof Error
            ? error.message
            : "Couldn't write that one.",
      );
      setDraftState('error');
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  };

  useEffect(
    () => () => {
      requestRef.current?.abort();
      requestRef.current = null;
    },
    [],
  );

  const copy = async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Clipboard blocked — select the text instead.', 'error');
    }
  };

  return (
    <li
      className="animate-fade-slide-up rounded-card border border-ink/15 p-4"
      style={{ animationDelay: `${Math.min(index * 35, 175)}ms` }}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <Link
            to={`/app/directory/${item.contactId}`}
            className="font-serif text-lg font-bold transition-colors hover:text-brand hover:underline"
          >
            {item.name}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted">
            <span>{item.company || 'No firm'}</span>
            <HealthPill health={item.health} />
          </div>
          <p className="mt-2.5 font-mono text-xs leading-relaxed text-subtle">{item.reason}</p>
        </div>

        {draftState !== 'ready' && (
          <Button variant="outline" size="sm" className="shrink-0" onClick={runDraft} disabled={draftState === 'loading'}>
            {draftState === 'loading' ? 'Drafting…' : 'Draft a note'}
          </Button>
        )}
      </div>

      {draftState !== 'idle' && (
        <div className="mt-4 border-t border-ink/15 pt-4">
          <AILabel className="mb-2">Drafted opener</AILabel>
          <AISurface
            state={draftState === 'loading' ? 'loading' : draftState === 'error' ? 'error' : 'ready'}
            error={draftError}
            onRetry={runDraft}
            onCancel={() => requestRef.current?.abort()}
            loadingStages={[
              'Reading the contact record…',
              'Drafting a grounded reason to reach out…',
              'Checking every factual claim…',
            ]}
            usageLabel="Reasoning AI"
            emptyLine="Nothing to draft from."
          >
            <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-subtle">{draft}</p>
            {grounding && (
              <AIProvenance
                className="mt-3"
                sourceIds={grounding.usedSourceIds}
                sourceLabels={grounding.sourceLabels}
                unsupportedAssumptions={grounding.unsupportedAssumptions}
                privacyExclusions={grounding.privacyExclusions}
                generatedAt={grounding.generatedAt}
                sourceObservedAt={grounding.sourceObservedAt}
                consideredSourceCount={grounding.consideredSourceCount}
                dataFreshThrough={grounding.dataFreshThrough}
                generation={grounding.generation}
              />
            )}
            <div className="mt-3 flex gap-2">
              <Button variant="ghost" size="sm" onClick={copy}>
                {copied ? <Check size={11} className="mr-1.5" /> : <Copy size={11} className="mr-1.5" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Link to={`/app/directory/${item.contactId}`}>
                <Button variant="ghost" size="sm">Open record</Button>
              </Link>
            </div>
          </AISurface>
        </div>
      )}
    </li>
  );
}
