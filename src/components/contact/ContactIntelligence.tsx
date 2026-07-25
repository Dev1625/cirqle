import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { Check, Handshake, Heart, Mail, Mic, X } from 'lucide-react';
import { db } from '../../config/firebase';
import { Button } from '../ui/Button';
import { HealthPanel } from '../ui/HealthPill';
import { EmptyState } from '../ui/EmptyState';
import { PreviewBadge } from '../ui/PreviewBadge';
import { LastSynced } from '../ui/LastSynced';
import { AILabel } from '../ui/AISurface';
import { useToast } from '../../contexts/ToastContext';
import { VoiceMemo } from '../voice/VoiceMemo';
import { computeHealth, setPinned } from '../../lib/health';
import { listCommitments, setCommitmentStatus, type Commitment } from '../../lib/commitments';
import { listTrackedThreads, type TrackedThread } from '../../lib/integrations/gmail';
import { isMock } from '../../lib/integrations/config';

/**
 * Everything this pass adds to a contact record, in one block so the edit to
 * ContactDetail.tsx stays a single insertion — that file is heavily modified
 * on the concurrent polish branch and every extra hunk is another conflict.
 *
 * Order is deliberate: why they matter, then health, then what you owe them,
 * then what you sent. Human context first, machine context last.
 */
export function ContactIntelligence({
  uid,
  contactId,
  contact,
  notes,
  outreaches,
}: {
  uid: string;
  contactId: string;
  contact: any;
  notes: any[];
  outreaches: any[];
}) {
  return (
    <div className="space-y-4">
      <WhyTheyMatter uid={uid} contactId={contactId} contact={contact} />
      <HealthBlock uid={uid} contactId={contactId} contact={contact} notes={notes} outreaches={outreaches} />
      <ContactCommitments uid={uid} contactId={contactId} contactName={contact?.name || 'this contact'} />
      <TrackedThreads uid={uid} contactId={contactId} />
    </div>
  );
}

// ── Why they matter ───────────────────────────────────────────────────────

/**
 * A text field with good placement, not a subsystem. It earns its keep by
 * being the first thing the pre-meeting brief reads and the thing the dormant
 * digest quotes back — the answer to "why am I even reaching out to this
 * person" is the one piece of context that never survives in a notes list.
 */
function WhyTheyMatter({ uid, contactId, contact }: { uid: string; contactId: string; contact: any }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string>(contact?.whyTheyMatter || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(contact?.whyTheyMatter || '');
  }, [contact?.whyTheyMatter]);

  const save = async () => {
    setSaving(true);
    try {
      await updateDoc(doc(db, `users/${uid}/contacts/${contactId}`), {
        whyTheyMatter: value.trim() || null,
        updatedAt: serverTimestamp(),
      });
      setEditing(false);
      toast('Saved.', 'success');
    } catch {
      toast('Could not save that.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-card border border-ink/15 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
          <Heart size={11} className="text-brand" />
          Why they matter
        </span>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="font-mono text-[10px] uppercase tracking-widest text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
          >
            {value ? 'Edit' : 'Add'}
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          <textarea
            autoFocus
            className="h-24 w-full rounded-card border border-ink/15 bg-paper/50 p-3 font-mono text-xs leading-relaxed transition-colors focus-visible:border-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            value={value}
            maxLength={400}
            onChange={(e) => setValue(e.target.value)}
            placeholder="How you met, and what makes them worth staying in touch with."
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setValue(contact?.whyTheyMatter || ''); }}>
              Cancel
            </Button>
            <Button variant="brand" size="sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : value ? (
        <p className="mt-2.5 font-mono text-xs leading-relaxed text-subtle">{value}</p>
      ) : (
        <p className="mt-2.5 font-mono text-xs leading-relaxed text-muted">
          Not recorded. This is the line you'll want in six months.
        </p>
      )}
    </div>
  );
}

// ── Health ────────────────────────────────────────────────────────────────

function HealthBlock({
  uid,
  contactId,
  contact,
  notes,
  outreaches,
}: {
  uid: string;
  contactId: string;
  contact: any;
  notes: any[];
  outreaches: any[];
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [pinnedOverride, setPinnedOverride] = useState<boolean | null>(null);

  const health = useMemo(
    () =>
      computeHealth({
        contact: pinnedOverride === null ? contact : { ...contact, healthPinned: pinnedOverride },
        notes,
        outreaches,
      }),
    [contact, notes, outreaches, pinnedOverride]
  );

  const togglePin = async () => {
    const next = !health.pinned;
    setBusy(true);
    setPinnedOverride(next);
    try {
      await setPinned(uid, contactId, next);
      toast(next ? "Pinned. This one won't decay." : 'Unpinned.', 'success');
    } catch {
      setPinnedOverride(!next);
      toast('Could not update that.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return <HealthPanel health={health} onTogglePin={togglePin} busy={busy} />;
}

// ── Commitments on this contact ───────────────────────────────────────────

function ContactCommitments({
  uid,
  contactId,
  contactName,
}: {
  uid: string;
  contactId: string;
  contactName: string;
}) {
  const [items, setItems] = useState<Commitment[] | null>(null);
  const [memoOpen, setMemoOpen] = useState(false);

  const load = useCallback(() => {
    listCommitments(uid, { contactId, status: 'open' })
      .then(setItems)
      .catch(() => setItems([]));
  }, [uid, contactId]);

  useEffect(load, [load]);

  const resolve = async (commitment: Commitment, status: 'done' | 'dismissed') => {
    setItems((current) => (current || []).filter((c) => c.id !== commitment.id));
    try {
      await setCommitmentStatus(uid, commitment.id, status);
    } catch {
      load();
    }
  };

  return (
    <div className="rounded-card border border-ink/15 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
          <Handshake size={11} className="text-brand" />
          Open commitments
        </span>
        {/* The manual voice-memo path — always available, never blocked on
            whether Calendar happens to be connected. */}
        <Button variant="ghost" size="sm" onClick={() => setMemoOpen(true)}>
          <Mic size={11} className="mr-1.5" />
          Voice memo
        </Button>
      </div>

      {items && items.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {items.map((commitment) => (
            <li key={commitment.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-xs leading-relaxed">{commitment.text}</p>
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                  {commitment.owedBy === 'you' ? 'You owe' : 'They owe'}
                  {commitment.dueHint ? ` · ${commitment.dueHint}` : ''}
                </span>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  onClick={() => resolve(commitment, 'dismissed')}
                  title="Not a real commitment"
                  className="flex h-7 w-7 items-center justify-center rounded-card border border-ink/15 text-muted transition-colors hover:text-ink"
                >
                  <X size={12} />
                  <span className="sr-only">Dismiss</span>
                </button>
                <button
                  onClick={() => resolve(commitment, 'done')}
                  title="Done"
                  className="flex h-7 w-7 items-center justify-center rounded-card bg-ink text-paper transition-colors hover:bg-zinc-800"
                >
                  <Check size={12} />
                  <span className="sr-only">Mark done</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2.5 font-mono text-xs leading-relaxed text-muted">
          Nothing outstanding. Log a memo and anything you promised gets pulled out automatically.
        </p>
      )}

      {memoOpen && (
        <VoiceMemo
          uid={uid}
          contactId={contactId}
          contactName={contactName}
          onClose={() => setMemoOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}

// ── Gmail threads ─────────────────────────────────────────────────────────

const THREAD_STATUS_COPY: Record<TrackedThread['status'], string> = {
  sent: 'Sent',
  delivered: 'Delivered — no reply yet',
  replied: 'They replied',
};

function TrackedThreads({ uid, contactId }: { uid: string; contactId: string }) {
  const [threads, setThreads] = useState<TrackedThread[] | null>(null);

  useEffect(() => {
    listTrackedThreads(uid, contactId)
      .then(setThreads)
      .catch(() => setThreads([]));
  }, [uid, contactId]);

  if (threads === null) return null;

  return (
    <div className="rounded-card border border-ink/15 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
          <Mail size={11} className="text-brand" />
          Tracked threads
        </span>
        {isMock() && threads.length > 0 && <PreviewBadge />}
      </div>

      {threads.length === 0 ? (
        <p className="mt-2.5 font-mono text-xs leading-relaxed text-muted">
          Nothing sent through Cirqle yet. Outreach sent from here gets tracked automatically.
        </p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {threads.slice(0, 4).map((thread) => (
            <li key={thread.id} className="border-b border-ink/15 pb-2.5 last:border-b-0 last:pb-0">
              <p className="truncate font-mono text-xs">{thread.subject}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span
                  className={`font-mono text-[10px] uppercase tracking-widest ${
                    thread.status === 'replied' ? 'text-brand' : 'text-muted'
                  }`}
                >
                  {THREAD_STATUS_COPY[thread.status]}
                </span>
                <LastSynced at={thread.lastCheckedAt} prefix="Checked" />
              </div>
            </li>
          ))}
        </ul>
      )}

      {threads.length > 0 && (
        <AILabel className="mt-3">Only threads Cirqle started</AILabel>
      )}
    </div>
  );
}
