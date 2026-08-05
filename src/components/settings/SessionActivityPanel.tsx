import React, { useCallback, useEffect, useState } from 'react';
import { Laptop, RefreshCw, ShieldCheck } from 'lucide-react';

import {
  listKnownSessions,
  type KnownSession,
} from '../../lib/sessionRegistry';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';

function relativeTime(value: Date | null): string {
  if (!value) return 'Activity time pending';
  const elapsed = Date.now() - value.getTime();
  if (elapsed < 60_000) return 'Active now';
  if (elapsed < 60 * 60_000) {
    return `${Math.max(1, Math.floor(elapsed / 60_000))}m ago`;
  }
  if (elapsed < 24 * 60 * 60_000) {
    return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  }
  return value.toLocaleDateString();
}

export function SessionActivityPanel({ uid }: { uid: string }) {
  const [sessions, setSessions] = useState<KnownSession[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    setSessions(null);
    try {
      setSessions(await listKnownSessions(uid));
    } catch {
      setError(
        'Cirqle could not refresh browser activity. Sign out everywhere is still available below.',
      );
      setSessions([]);
    }
  }, [uid]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="rounded-card border border-ink/15 bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Laptop size={20} className="mt-0.5 text-brand" aria-hidden="true" />
          <div>
            <h2 className="font-serif text-xl font-bold italic">
              Browser activity.
            </h2>
            <p className="mt-1 max-w-2xl font-mono text-xs leading-relaxed text-muted">
              Privacy-safe browser labels seen by Cirqle in the last 90 days.
              Firebase does not expose a precise device inventory, so use
              “Sign out everywhere” below if anything looks unfamiliar.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={sessions === null}>
          <RefreshCw
            size={12}
            className={`mr-1.5 ${sessions === null ? 'animate-spin motion-reduce:animate-none' : ''}`}
            aria-hidden="true"
          />
          Refresh
        </Button>
      </div>

      {error && (
        <p role="alert" className="mt-4 font-mono text-xs text-red-700">
          {error}
        </p>
      )}

      {sessions === null ? (
        <p
          className="mt-5 font-mono text-xs text-muted"
          role="status"
          aria-live="polite"
        >
          Reading browser activity…
        </p>
      ) : sessions.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={Laptop}
            title="No browser activity available"
            description="This browser will appear after the secure activity record is refreshed."
          />
        </div>
      ) : (
        <ul className="mt-5 divide-y divide-ink/10 border-y border-ink/10">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex min-h-16 items-center justify-between gap-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-xs font-bold">
                  {session.deviceLabel}
                </p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted">
                  {relativeTime(session.lastSeenAt)}
                  {session.createdAt
                    ? ` · First seen ${session.createdAt.toLocaleDateString()}`
                    : ''}
                </p>
              </div>
              {session.current && (
                <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-emerald-700">
                  <ShieldCheck size={12} aria-hidden="true" />
                  This browser
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
