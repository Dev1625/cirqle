import React, { useEffect, useId, useMemo, useState } from 'react';
import {
  Check,
  Eye,
  EyeOff,
  History,
  Pencil,
  Shield,
  X,
} from 'lucide-react';

import {
  correctContactFact,
  listContactFacts,
  setFactAIAllowed,
} from '../../lib/factLedger';
import {
  groupFactHistory,
  type TemporalFact,
} from '../../lib/factLedgerCore';
import {
  isContactAIEligible,
  type ContactLifecycleState,
} from '../../lib/contactManagementCore';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

export interface FactLedgerPanelProps {
  uid: string;
  contactId: string;
  contactState?: ContactLifecycleState;
  refreshKey?: string | number;
  onFactsChanged?: () => void;
  className?: string;
}

function predicateLabel(predicate: string): string {
  return (
    predicate
      .split('.')
      .at(-1)
      ?.replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[-_]/g, ' ')
      .replace(/^./, (letter) => letter.toUpperCase()) || 'Fact'
  );
}

function formatDate(value: Date | null): string {
  if (!value) return 'Date not recorded';
  return value.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function FactLedgerPanel({
  uid,
  contactId,
  contactState = { lifecycleStatus: 'active', aiAllowed: true },
  refreshKey,
  onFactsChanged,
  className = '',
}: FactLedgerPanelProps) {
  const id = useId();
  const [facts, setFacts] = useState<TemporalFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyFactId, setBusyFactId] = useState<string | null>(null);
  const [editingFactId, setEditingFactId] = useState<string | null>(null);
  const [correction, setCorrection] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    listContactFacts(uid, contactId)
      .then((records) => {
        if (active) setFacts(records);
      })
      .catch(() => {
        if (active) setError('Relationship facts could not be loaded.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [uid, contactId, refreshKey, revision]);

  const grouped = useMemo(() => groupFactHistory(facts), [facts]);
  const contactAIEligible = isContactAIEligible(contactState);

  const toggleAI = async (fact: TemporalFact) => {
    setBusyFactId(fact.id);
    setError(null);
    try {
      await setFactAIAllowed(uid, contactId, fact.id, !fact.aiAllowed);
      setFacts((current) =>
        current.map((item) =>
          item.id === fact.id
            ? { ...item, aiAllowed: !item.aiAllowed }
            : item,
        ),
      );
      onFactsChanged?.();
    } catch {
      setError('The fact privacy setting could not be changed.');
    } finally {
      setBusyFactId(null);
    }
  };

  const startCorrection = (fact: TemporalFact) => {
    setEditingFactId(fact.id);
    setCorrection(fact.value);
    setError(null);
  };

  const saveCorrection = async (fact: TemporalFact) => {
    const value = correction.trim();
    if (!value || value === fact.value.trim()) return;
    setBusyFactId(fact.id);
    setError(null);
    try {
      await correctContactFact(uid, contactId, fact.id, value);
      setEditingFactId(null);
      setCorrection('');
      setRevision((value) => value + 1);
      onFactsChanged?.();
    } catch {
      setError('The correction could not be saved.');
    } finally {
      setBusyFactId(null);
    }
  };

  return (
    <section
      className={`border border-ink/15 bg-white ${className}`}
      aria-labelledby={`${id}-title`}
    >
      <header className="border-b border-ink/10 p-5">
        <p className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-widest text-brand">
          <Shield size={13} aria-hidden="true" />
          Evidence and privacy
        </p>
        <h2 id={`${id}-title`} className="mt-1 font-serif text-2xl">
          Fact history
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-subtle">
          Every update creates a correction record. Earlier values and their
          original sources remain visible, and each fact can be withheld from
          AI independently.
        </p>
      </header>

      {!contactAIEligible && (
        <div
          className="m-5 flex gap-3 border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
          role="status"
        >
          <EyeOff size={18} className="shrink-0" aria-hidden="true" />
          <p>
            This contact is excluded from AI because it is private, archived,
            deleted, or part of a completed merge. Individual fact settings
            remain saved for a future restore.
          </p>
        </div>
      )}

      {error && (
        <p className="m-5 border border-red-300 bg-red-50 p-3 text-sm text-red-950" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p className="p-5 text-sm text-subtle" role="status">
          Loading fact history…
        </p>
      )}
      {!loading && facts.length === 0 && (
        <div className="p-8 text-center">
          <History size={24} className="mx-auto text-muted" aria-hidden="true" />
          <p className="mt-3 font-medium">No fact history yet</p>
          <p className="mt-1 text-sm text-subtle">
            Profile edits and reviewed relationship memories will appear here.
          </p>
        </div>
      )}

      {!loading && grouped.size > 0 && (
        <div className="divide-y divide-ink/10">
          {Array.from(grouped.entries()).map(([predicate, history]) => {
            const current = history.find((fact) => fact.current) || history[0];
            return (
              <details key={predicate} className="group p-5" open>
                <summary className="flex cursor-pointer list-none items-start justify-between gap-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-subtle">
                      {predicateLabel(predicate)}
                    </p>
                    <p className="mt-1 break-words text-base font-medium">
                      {current.value}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-muted">
                    {history.length} version{history.length === 1 ? '' : 's'}
                  </span>
                </summary>

                <ol className="mt-5 space-y-3" aria-label={`${predicateLabel(predicate)} history`}>
                  {history.map((fact) => (
                    <li
                      key={fact.id}
                      className={`border p-4 ${
                        fact.current
                          ? 'border-ink/20 bg-paper/50'
                          : 'border-ink/10 bg-white'
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {fact.current ? (
                              <span className="border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-emerald-900">
                                Current
                              </span>
                            ) : (
                              <span className="border border-ink/15 bg-white px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-subtle">
                                Historical
                              </span>
                            )}
                            {fact.correctionOf && (
                              <span className="font-mono text-[9px] uppercase tracking-widest text-brand">
                                User correction
                              </span>
                            )}
                          </div>

                          {editingFactId === fact.id ? (
                            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                              <label
                                htmlFor={`${id}-correction-${fact.id}`}
                                className="sr-only"
                              >
                                Corrected {predicateLabel(predicate)}
                              </label>
                              <Input
                                id={`${id}-correction-${fact.id}`}
                                value={correction}
                                autoFocus
                                onChange={(event) =>
                                  setCorrection(event.target.value)
                                }
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="brand"
                                disabled={
                                  !correction.trim() ||
                                  correction.trim() === fact.value.trim() ||
                                  busyFactId === fact.id
                                }
                                onClick={() => saveCorrection(fact)}
                              >
                                <Check size={13} aria-hidden="true" />
                                Save
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingFactId(null)}
                              >
                                <X size={13} aria-hidden="true" />
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <p className="mt-3 break-words">{fact.value}</p>
                          )}

                          <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-2">
                            <div>
                              <dt className="inline font-medium text-subtle">Observed: </dt>
                              <dd className="inline">{formatDate(fact.observedAt)}</dd>
                            </div>
                            <div>
                              <dt className="inline font-medium text-subtle">Source: </dt>
                              <dd className="inline">
                                {fact.sourceType.replace(/-/g, ' ')}
                                {fact.sourceId ? ` · ${fact.sourceId}` : ''}
                              </dd>
                            </div>
                            <div>
                              <dt className="inline font-medium text-subtle">Confidence: </dt>
                              <dd className="inline">
                                {Math.round(fact.confidence * 100)}%
                              </dd>
                            </div>
                            {fact.correctionOf && (
                              <div>
                                <dt className="inline font-medium text-subtle">Corrects: </dt>
                                <dd className="inline">{fact.correctionOf}</dd>
                              </div>
                            )}
                          </dl>
                        </div>

                        <div className="flex shrink-0 flex-wrap gap-2">
                          {fact.current && editingFactId !== fact.id && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => startCorrection(fact)}
                            >
                              <Pencil size={13} aria-hidden="true" />
                              Correct
                            </Button>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant={fact.aiAllowed ? 'outline' : 'ghost'}
                            disabled={busyFactId === fact.id}
                            aria-pressed={fact.aiAllowed}
                            aria-label={
                              fact.aiAllowed
                                ? `Exclude ${predicateLabel(predicate)} from AI`
                                : `Allow AI to use ${predicateLabel(predicate)}`
                            }
                            onClick={() => toggleAI(fact)}
                          >
                            {fact.aiAllowed ? (
                              <Eye size={13} aria-hidden="true" />
                            ) : (
                              <EyeOff size={13} aria-hidden="true" />
                            )}
                            {fact.aiAllowed ? 'AI allowed' : 'AI excluded'}
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}
