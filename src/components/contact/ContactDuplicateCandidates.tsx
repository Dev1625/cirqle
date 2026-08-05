import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, GitMerge } from 'lucide-react';

import { findContactDuplicates } from '../../lib/contactManagement';
import type {
  DuplicateDetection,
  ManagedContact,
} from '../../lib/contactManagementCore';
import { Button } from '../ui/Button';

type Candidate = DuplicateDetection & { contact: ManagedContact };

export interface ContactDuplicateCandidatesProps {
  uid: string;
  contact: ManagedContact;
  onReviewMerge: (duplicate: ManagedContact) => void;
  refreshKey?: string | number;
  className?: string;
}

export function ContactDuplicateCandidates({
  uid,
  contact,
  onReviewMerge,
  refreshKey,
  className = '',
}: ContactDuplicateCandidatesProps) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    findContactDuplicates(uid, contact)
      .then((matches) => {
        if (active) setCandidates(matches);
      })
      .catch(() => {
        if (active) setError('Duplicate candidates could not be checked.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    uid,
    contact.id,
    contact.name,
    contact.company,
    contact.email,
    refreshKey,
  ]);

  return (
    <section
      className={`border border-ink/15 bg-white p-5 ${className}`}
      aria-labelledby={`duplicate-candidates-${contact.id}`}
    >
      <p className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-widest text-subtle">
        <Copy size={13} aria-hidden="true" />
        Data quality
      </p>
      <h2
        id={`duplicate-candidates-${contact.id}`}
        className="mt-1 font-serif text-xl"
      >
        Possible duplicates
      </h2>

      {loading && (
        <p className="mt-4 text-sm text-subtle" role="status">
          Checking exact identity signals…
        </p>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && candidates.length === 0 && (
        <p className="mt-4 flex items-center gap-2 text-sm text-subtle">
          <CheckCircle2 size={16} className="text-emerald-700" aria-hidden="true" />
          No exact email or name-and-company matches found.
        </p>
      )}

      {candidates.length > 0 && (
        <ul className="mt-4 space-y-3">
          {candidates.map((candidate) => (
            <li
              key={candidate.contactId}
              className={`border p-4 ${
                candidate.safeToSuggestMerge
                  ? 'border-ink/15'
                  : 'border-amber-300 bg-amber-50'
              }`}
            >
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{candidate.contact.name}</p>
                    <span className="border border-ink/15 bg-paper px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest">
                      {candidate.confidence} confidence
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-subtle">
                    {[candidate.contact.role, candidate.contact.company]
                      .filter(Boolean)
                      .join(' · ') || 'No role or company'}
                  </p>
                  <p className="mt-2 font-mono text-[9px] uppercase tracking-widest text-muted">
                    Matched by {candidate.matchedBy.join(' and ')}
                  </p>
                  {candidate.warnings.map((warning) => (
                    <p
                      key={warning}
                      className="mt-2 flex items-start gap-2 text-xs text-amber-950"
                    >
                      <AlertTriangle
                        size={13}
                        className="mt-0.5 shrink-0"
                        aria-hidden="true"
                      />
                      {warning}
                    </p>
                  ))}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onReviewMerge(candidate.contact)}
                >
                  <GitMerge size={13} aria-hidden="true" />
                  Compare
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-muted">
        Cirqle only suggests candidates. It never merges contacts
        automatically.
      </p>
    </section>
  );
}
