import React, { useEffect, useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { Handshake, ShieldAlert } from 'lucide-react';

import { db } from '../../config/firebase';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

type Willingness = 'unknown' | 'yes' | 'likely' | 'reluctant' | 'no';

function boundedInteger(
  value: string,
  minimum: number,
  maximum: number,
): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  return Math.max(minimum, Math.min(maximum, parsed));
}

export function IntroductionSignalsPanel({
  uid,
  contactId,
  contact,
}: {
  uid: string;
  contactId: string;
  contact: Record<string, any>;
}) {
  const [willingness, setWillingness] = useState<Willingness>('unknown');
  const [active, setActive] = useState('');
  const [capacity, setCapacity] = useState('');
  const [recentAsks, setRecentAsks] = useState('');
  const [lastAsked, setLastAsked] = useState('');
  const [staleAfterDays, setStaleAfterDays] = useState('180');
  const [conflict, setConflict] = useState('');
  const [context, setContext] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setWillingness(
      ['yes', 'likely', 'reluctant', 'no'].includes(
        contact.introductionWillingness,
      )
        ? contact.introductionWillingness
        : 'unknown',
    );
    setActive(
      Number.isFinite(contact.activeIntroductionRequests)
        ? String(contact.activeIntroductionRequests)
        : '',
    );
    setCapacity(
      Number.isFinite(contact.introductionCapacity)
        ? String(contact.introductionCapacity)
        : '',
    );
    setRecentAsks(
      Number.isFinite(contact.introductionRequestsLast90Days)
        ? String(contact.introductionRequestsLast90Days)
        : '',
    );
    const last = contact.lastIntroductionRequestAt?.toDate?.() ||
      (contact.lastIntroductionRequestAt
        ? new Date(contact.lastIntroductionRequestAt)
        : null);
    setLastAsked(
      last && !Number.isNaN(last.getTime())
        ? last.toISOString().slice(0, 10)
        : '',
    );
    setStaleAfterDays(
      Number.isFinite(contact.introductionStaleAfterDays)
        ? String(contact.introductionStaleAfterDays)
        : '180',
    );
    setConflict(contact.introductionConflicts?.[0]?.label || '');
    setContext(contact.introductionMutualContext || '');
  }, [contact]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const activeValue = boundedInteger(active, 0, 100);
    const capacityValue = boundedInteger(capacity, 1, 100);
    const recentValue = boundedInteger(recentAsks, 0, 500);
    const staleValue = boundedInteger(staleAfterDays, 30, 1_825);
    if (
      (active && activeValue == null) ||
      (capacity && capacityValue == null) ||
      (recentAsks && recentValue == null) ||
      staleValue == null
    ) {
      setMessage('Review the numeric introduction signals.');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await updateDoc(doc(db, `users/${uid}/contacts/${contactId}`), {
        introductionWillingness: willingness,
        activeIntroductionRequests: activeValue,
        introductionCapacity: capacityValue,
        introductionRequestsLast90Days: recentValue,
        lastIntroductionRequestAt: lastAsked
          ? new Date(`${lastAsked}T12:00:00`)
          : null,
        introductionStaleAfterDays: staleValue,
        introductionConflicts: conflict.trim()
          ? [
              {
                id: `user-${contactId}`,
                label: conflict.trim().slice(0, 240),
                severity: 'warning',
              },
            ]
          : [],
        introductionMutualContext: context.trim().slice(0, 500),
        introductionSignalsUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setMessage('Introduction signals saved with user-recorded provenance.');
    } catch {
      setMessage('Introduction signals could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="rounded-card border border-ink/15 bg-white">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 p-5 font-mono text-[10px] font-bold uppercase tracking-widest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
        <Handshake size={14} className="text-brand" aria-hidden="true" />
        Introduction readiness
      </summary>
      <form className="space-y-4 border-t border-ink/10 p-5" onSubmit={save}>
        <p className="text-sm leading-relaxed text-subtle">
          These are explicit operating signals for warm-path ranking. Unknown
          values stay unknown; Cirqle never infers willingness or capacity from
          message activity.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs font-medium">
            Willingness to introduce
            <select
              value={willingness}
              onChange={(event) =>
                setWillingness(event.target.value as Willingness)
              }
              className="mt-1 h-11 w-full rounded-card border border-ink/20 bg-white px-3"
            >
              <option value="unknown">Unknown</option>
              <option value="yes">Yes</option>
              <option value="likely">Likely</option>
              <option value="reluctant">Reluctant</option>
              <option value="no">No</option>
            </select>
          </label>
          <label className="text-xs font-medium">
            Active introduction asks
            <Input
              className="mt-1"
              type="number"
              min={0}
              max={100}
              value={active}
              onChange={(event) => setActive(event.target.value)}
              placeholder="Unknown"
            />
          </label>
          <label className="text-xs font-medium">
            Comfortable capacity
            <Input
              className="mt-1"
              type="number"
              min={1}
              max={100}
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
              placeholder="Unknown"
            />
          </label>
          <label className="text-xs font-medium">
            Asks in the last 90 days
            <Input
              className="mt-1"
              type="number"
              min={0}
              max={500}
              value={recentAsks}
              onChange={(event) => setRecentAsks(event.target.value)}
              placeholder="Unknown"
            />
          </label>
          <label className="text-xs font-medium">
            Last introduction ask
            <Input
              className="mt-1"
              type="date"
              value={lastAsked}
              onChange={(event) => setLastAsked(event.target.value)}
            />
          </label>
          <label className="text-xs font-medium">
            Stale after days
            <Input
              className="mt-1"
              type="number"
              min={30}
              max={1825}
              value={staleAfterDays}
              onChange={(event) => setStaleAfterDays(event.target.value)}
            />
          </label>
        </div>
        <label className="block text-xs font-medium">
          Conflict or caution
          <Input
            className="mt-1"
            value={conflict}
            maxLength={240}
            onChange={(event) => setConflict(event.target.value)}
            placeholder="For example: avoid recruiting introductions this quarter"
          />
        </label>
        <label className="block text-xs font-medium">
          Mutual context worth mentioning
          <textarea
            className="mt-1 min-h-24 w-full rounded-card border border-ink/20 bg-white p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            value={context}
            maxLength={500}
            onChange={(event) => setContext(event.target.value)}
            placeholder="Only record context you can point back to."
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
            <ShieldAlert
              size={13}
              className="mt-0.5 shrink-0"
              aria-hidden="true"
            />
            Saved as your explicit correction, not an AI inference.
          </p>
          <Button type="submit" variant="outline" disabled={saving}>
            {saving ? 'Saving…' : 'Save introduction signals'}
          </Button>
        </div>
        {message && (
          <p
            className="text-xs text-subtle"
            role={message.includes('could not') ? 'alert' : 'status'}
          >
            {message}
          </p>
        )}
      </form>
    </details>
  );
}
