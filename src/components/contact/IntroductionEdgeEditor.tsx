import React, { useEffect, useMemo, useState } from 'react';
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { Link2 } from 'lucide-react';

import { db } from '../../config/firebase';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

interface EdgeContact {
  id: string;
  name: string;
}

export function IntroductionEdgeEditor({
  uid,
  contacts,
}: {
  uid: string;
  contacts: EdgeContact[];
}) {
  const ordered = useMemo(
    () =>
      [...contacts]
        .filter((contact) => contact.id && contact.name)
        .sort((left, right) => left.name.localeCompare(right.name)),
    [contacts],
  );
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [direction, setDirection] = useState<'directed' | 'mutual'>('mutual');
  const [strength, setStrength] = useState('3');
  const [willingness, setWillingness] = useState('unknown');
  const [lastInteraction, setLastInteraction] = useState('');
  const [activeRequests, setActiveRequests] = useState('');
  const [capacity, setCapacity] = useState('');
  const [recentAsks, setRecentAsks] = useState('');
  const [lastAsked, setLastAsked] = useState('');
  const [context, setContext] = useState('');
  const [conflict, setConflict] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!sourceId && ordered[0]) setSourceId(ordered[0].id);
    if (!targetId && ordered[1]) setTargetId(ordered[1].id);
  }, [ordered, sourceId, targetId]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !sourceId ||
      !targetId ||
      sourceId === targetId ||
      !lastInteraction
    ) {
      setMessage(
        'Choose two different people and record the last known interaction.',
      );
      return;
    }
    const strengthValue = Math.max(1, Math.min(5, Number(strength))) / 5;
    const activeValue = activeRequests ? Number(activeRequests) : null;
    const capacityValue = capacity ? Number(capacity) : null;
    const recentValue = recentAsks ? Number(recentAsks) : null;
    if (
      !Number.isFinite(strengthValue) ||
      (activeValue != null && (!Number.isInteger(activeValue) || activeValue < 0)) ||
      (capacityValue != null &&
        (!Number.isInteger(capacityValue) || capacityValue < 1)) ||
      (recentValue != null && (!Number.isInteger(recentValue) || recentValue < 0))
    ) {
      setMessage('Review the relationship load values.');
      return;
    }

    setSaving(true);
    setMessage(null);
    const connectionId = `${sourceId}--${targetId}`.slice(0, 600);
    const observedAt = new Date(`${lastInteraction}T12:00:00`);
    try {
      const connectionRef = doc(
        db,
        `users/${uid}/connections/${connectionId}`,
      );
      const existingConnection = await getDoc(connectionRef);
      await setDoc(
        connectionRef,
        {
          userId: uid,
          sourceId,
          targetId,
          type: 'user-recorded introduction path',
          inferred: false,
          direction,
          strength: strengthValue,
          weight: Number(strength),
          willingness,
          lastInteractionAt: observedAt,
          activeIntroductionRequests: activeValue,
          introductionCapacity: capacityValue,
          introductionRequestsLast90Days: recentValue,
          lastIntroductionRequestAt: lastAsked
            ? new Date(`${lastAsked}T12:00:00`)
            : null,
          conflicts: conflict.trim()
            ? [
                {
                  id: `user-${connectionId}`,
                  label: conflict.trim().slice(0, 240),
                  severity: 'warning',
                },
              ]
            : [],
          mutualContext: context.trim()
            ? {
                text: context.trim().slice(0, 500),
                sourceType: 'user-correction',
                sourceId: `connection:${connectionId}:context`,
              }
            : null,
          provenance: {
            sourceType: 'user-correction',
            sourceId: `connection:${connectionId}`,
            observedAt,
          },
          createdAt:
            existingConnection.data()?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      setMessage('Relationship edge saved. Warm paths will use it immediately.');
    } catch {
      setMessage('The relationship edge could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="border-b border-[#8C7A65]/25 bg-white/60">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-5 py-3 font-mono text-[10px] font-bold uppercase tracking-widest text-[#6E604F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#617672] md:px-6">
        <Link2 size={13} aria-hidden="true" />
        Record a relationship between two contacts
      </summary>
      <form
        className="space-y-4 border-t border-[#8C7A65]/20 p-5 md:p-6"
        onSubmit={save}
      >
        <p className="max-w-3xl text-xs leading-relaxed text-subtle">
          This creates an explicit edge. Shared schools, firms, or industries
          remain visual hints and never become introduction claims.
        </p>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-medium">
            From
            <select
              className="mt-1 h-11 w-full border border-ink/20 bg-white px-3"
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              {ordered.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium">
            To
            <select
              className="mt-1 h-11 w-full border border-ink/20 bg-white px-3"
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
            >
              {ordered.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium">
            Direction
            <select
              className="mt-1 h-11 w-full border border-ink/20 bg-white px-3"
              value={direction}
              onChange={(event) =>
                setDirection(event.target.value as 'directed' | 'mutual')
              }
            >
              <option value="mutual">Mutual</option>
              <option value="directed">From → to only</option>
            </select>
          </label>
          <label className="text-xs font-medium">
            Strength (1–5)
            <Input
              className="mt-1"
              type="number"
              min={1}
              max={5}
              value={strength}
              onChange={(event) => setStrength(event.target.value)}
            />
          </label>
          <label className="text-xs font-medium">
            Last known interaction
            <Input
              className="mt-1"
              type="date"
              required
              value={lastInteraction}
              onChange={(event) => setLastInteraction(event.target.value)}
            />
          </label>
          <label className="text-xs font-medium">
            Willingness
            <select
              className="mt-1 h-11 w-full border border-ink/20 bg-white px-3"
              value={willingness}
              onChange={(event) => setWillingness(event.target.value)}
            >
              <option value="unknown">Unknown</option>
              <option value="yes">Yes</option>
              <option value="likely">Likely</option>
              <option value="reluctant">Reluctant</option>
              <option value="no">No</option>
            </select>
          </label>
          <label className="text-xs font-medium">
            Active asks / capacity
            <span className="mt-1 grid grid-cols-2 gap-2">
              <Input
                type="number"
                min={0}
                placeholder="Active"
                value={activeRequests}
                onChange={(event) => setActiveRequests(event.target.value)}
              />
              <Input
                type="number"
                min={1}
                placeholder="Capacity"
                value={capacity}
                onChange={(event) => setCapacity(event.target.value)}
              />
            </span>
          </label>
          <label className="text-xs font-medium">
            Asks in 90 days / last ask
            <span className="mt-1 grid grid-cols-2 gap-2">
              <Input
                type="number"
                min={0}
                placeholder="Count"
                value={recentAsks}
                onChange={(event) => setRecentAsks(event.target.value)}
              />
              <Input
                type="date"
                value={lastAsked}
                onChange={(event) => setLastAsked(event.target.value)}
              />
            </span>
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-xs font-medium">
            Evidence-backed mutual context
            <textarea
              className="mt-1 min-h-24 w-full border border-ink/20 bg-white p-3 text-sm"
              value={context}
              maxLength={500}
              onChange={(event) => setContext(event.target.value)}
            />
          </label>
          <label className="text-xs font-medium">
            Conflict or caution
            <textarea
              className="mt-1 min-h-24 w-full border border-ink/20 bg-white p-3 text-sm"
              value={conflict}
              maxLength={240}
              onChange={(event) => setConflict(event.target.value)}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {message ? (
            <p
              role={message.includes('could not') ? 'alert' : 'status'}
              className="text-xs text-subtle"
            >
              {message}
            </p>
          ) : (
            <span />
          )}
          <Button
            type="submit"
            variant="outline"
            disabled={saving || ordered.length < 2}
          >
            {saving ? 'Saving…' : 'Save explicit edge'}
          </Button>
        </div>
      </form>
    </details>
  );
}
