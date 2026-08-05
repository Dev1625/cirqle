import React, { useEffect, useState } from 'react';
import { BriefcaseBusiness, History } from 'lucide-react';

import { listContactJobHistory } from '../../lib/contactManagement';
import type { JobHistoryEntry } from '../../lib/contactManagementCore';
import { Button } from '../ui/Button';

export interface ContactJobHistoryProps {
  uid: string;
  contactId: string;
  refreshKey?: string | number;
  className?: string;
}

function formatDate(value: Date | null): string {
  if (!value) return 'Date not recorded';
  return value.toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  });
}

export function ContactJobHistory({
  uid,
  contactId,
  refreshKey,
  className = '',
}: ContactJobHistoryProps) {
  const [history, setHistory] = useState<JobHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    listContactJobHistory(uid, contactId)
      .then((records) => {
        if (active) setHistory(records);
      })
      .catch(() => {
        if (active) {
          setError('Job history could not be loaded.');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [uid, contactId, refreshKey, reload]);

  return (
    <section
      className={`border border-ink/15 bg-white p-5 ${className}`}
      aria-labelledby={`job-history-${contactId}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-widest text-subtle">
            <History size={13} aria-hidden="true" />
            Career timeline
          </p>
          <h2
            id={`job-history-${contactId}`}
            className="mt-1 font-serif text-xl"
          >
            Job history
          </h2>
        </div>
        {error && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setReload((value) => value + 1)}
          >
            Retry
          </Button>
        )}
      </div>

      {loading && (
        <p className="mt-4 text-sm text-subtle" role="status">
          Loading job history…
        </p>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && history.length === 0 && (
        <p className="mt-4 text-sm text-subtle">
          The next role or company change will preserve the current job here.
        </p>
      )}

      {!loading && history.length > 0 && (
        <ol className="mt-5 space-y-0" aria-label="Contact job history">
          {history.map((entry, index) => (
            <li key={entry.id} className="relative flex gap-4 pb-6 last:pb-0">
              {index < history.length - 1 && (
                <span
                  aria-hidden="true"
                  className="absolute left-[15px] top-8 h-[calc(100%-1rem)] w-px bg-ink/15"
                />
              )}
              <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ink/15 bg-paper">
                <BriefcaseBusiness size={14} aria-hidden="true" />
              </span>
              <div className="min-w-0 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">
                    {entry.role || 'Role not recorded'}
                  </p>
                  {entry.current && (
                    <span className="border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-emerald-900">
                      Current
                    </span>
                  )}
                </div>
                <p className="text-sm text-subtle">
                  {entry.company || 'Company not recorded'}
                  {entry.location ? ` · ${entry.location}` : ''}
                </p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted">
                  {formatDate(entry.startedAt)} –{' '}
                  {entry.current ? 'Present' : formatDate(entry.endedAt)}
                </p>
                <p className="mt-1 text-xs text-muted">
                  Source: {entry.sourceType.replace(/-/g, ' ')}
                  {entry.sourceId ? ` · ${entry.sourceId}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
