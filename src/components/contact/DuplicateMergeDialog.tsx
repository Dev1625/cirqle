import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  GitMerge,
  X,
} from 'lucide-react';

import {
  executeContactMerge,
  loadContactMergePreview,
  type ContactMergePreview,
  type ExecuteContactMergeResult,
} from '../../lib/contactManagement';
import {
  CONTACT_PROFILE_FIELDS,
  analyzeContactMerge,
  detectDuplicate,
  type ContactMergeChoice,
  type ContactProfileField,
  type ManagedContact,
  type MergeStrategy,
} from '../../lib/contactManagementCore';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';

export interface DuplicateMergeDialogProps {
  uid: string;
  primary: ManagedContact;
  duplicate: ManagedContact;
  onMerged?: (result: ExecuteContactMergeResult) => void;
  onCancel: () => void;
  className?: string;
}

const FIELD_LABELS: Record<ContactProfileField, string> = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  company: 'Company',
  role: 'Role',
  location: 'Location',
  linkedinUrl: 'LinkedIn URL',
  summary: 'Summary',
  relationshipTier: 'Relationship tier',
  industry: 'Industry',
  subIndustry: 'Sub-industry',
  school: 'School',
  seniority: 'Seniority',
  connectionSource: 'Connection source',
  whyTheyMatter: 'Why they matter',
  tags: 'Tags',
};

function displayValue(value: string | string[]): string {
  if (Array.isArray(value)) return value.join(', ') || '—';
  return value || '—';
}

function strategyLabel(
  strategy: MergeStrategy,
  primaryName: string,
  duplicateName: string,
): string {
  if (strategy === 'primary') return `Keep ${primaryName || 'primary'} value`;
  if (strategy === 'duplicate') return `Use ${duplicateName || 'duplicate'} value`;
  if (strategy === 'combine') return 'Combine both';
  return 'Enter a custom value';
}

export function DuplicateMergeDialog({
  uid,
  primary,
  duplicate,
  onMerged,
  onCancel,
  className = '',
}: DuplicateMergeDialogProps) {
  const id = useId();
  const operationKey = `${primary.id}\u0000${duplicate.id}`;
  const operationRef = useRef<{ key: string; id: string } | null>(null);
  if (!operationRef.current || operationRef.current.key !== operationKey) {
    operationRef.current = {
      key: operationKey,
      id: crypto.randomUUID(),
    };
  }
  const analysis = useMemo(
    () => analyzeContactMerge(primary, duplicate),
    [primary, duplicate],
  );
  const duplicateEvidence = useMemo(
    () => detectDuplicate(duplicate, primary),
    [duplicate, primary],
  );
  const [choices, setChoices] = useState<
    Partial<Record<ContactProfileField, ContactMergeChoice>>
  >({});
  const [preview, setPreview] = useState<ContactMergePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [confirmation, setConfirmation] = useState('');
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExecuteContactMergeResult | null>(null);

  useEffect(() => {
    let active = true;
    setLoadingPreview(true);
    setError(null);
    loadContactMergePreview({
      uid,
      primaryContactId: primary.id,
      duplicateContactId: duplicate.id,
    })
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((caught) => {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Linked records could not be counted.',
          );
        }
      })
      .finally(() => {
        if (active) setLoadingPreview(false);
      });
    return () => {
      active = false;
    };
  }, [uid, primary.id, duplicate.id]);

  const choose = (field: ContactProfileField, strategy: MergeStrategy) => {
    setChoices((current) => ({
      ...current,
      [field]: {
        field,
        strategy,
        customValue:
          strategy === 'custom' ? current[field]?.customValue || '' : undefined,
      },
    }));
    setError(null);
  };

  const setCustomValue = (field: ContactProfileField, value: string) => {
    setChoices((current) => ({
      ...current,
      [field]: {
        field,
        strategy: 'custom',
        customValue:
          field === 'tags'
            ? value
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean)
            : value,
      },
    }));
  };

  const unresolved = analysis.conflicts.filter(
    (conflict) => !choices[conflict.field],
  );
  const customMissing = analysis.conflicts.some((conflict) => {
    const choice = choices[conflict.field];
    if (choice?.strategy !== 'custom') return false;
    return Array.isArray(choice.customValue)
      ? choice.customValue.length === 0
      : !String(choice.customValue || '').trim();
  });
  const canMerge =
    Boolean(preview) &&
    unresolved.length === 0 &&
    !customMissing &&
    confirmation === 'MERGE' &&
    !merging &&
    !result;

  const merge = async () => {
    if (!canMerge || !preview) return;
    setMerging(true);
    setError(null);
    try {
      const merged = await executeContactMerge({
        uid,
        primaryContactId: primary.id,
        duplicateContactId: duplicate.id,
        expectedPrimary: preview.primary,
        expectedDuplicate: preview.duplicate,
        choices: Object.values(choices).filter(
          (choice): choice is ContactMergeChoice => Boolean(choice),
        ),
        confirmed: true,
        operationId: operationRef.current.id,
      });
      setResult(merged);
      onMerged?.(merged);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The contacts could not be merged.',
      );
    } finally {
      setMerging(false);
    }
  };

  if (result) {
    return (
      <Dialog
        open
        onClose={onCancel}
        title="Contacts merged"
        description={`${duplicate.name} was merged into ${primary.name}.`}
        className={`max-w-xl ${className}`}
      >
        <section className="p-6">
          <CheckCircle2
            size={32}
            className="text-emerald-700"
            aria-hidden="true"
          />
          <h2 id={`${id}-success-title`} className="mt-3 font-serif text-2xl">
            Contacts merged
          </h2>
          <p className="mt-2 text-sm text-subtle">
            Linked records now point to {primary.name}. {duplicate.name} remains
            recoverable for 30 days, with its original nested history retained.
          </p>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-muted">
            Recovery operation {result.operationId}
          </p>
          {result.warnings.map((warning) => (
            <p
              key={warning}
              className="mt-4 border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
              role="alert"
            >
              {warning}
            </p>
          ))}
          <div className="mt-6 flex justify-end">
            <Button type="button" variant="brand" onClick={onCancel}>
              Done
            </Button>
          </div>
        </section>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={() => {
        if (!merging) onCancel();
      }}
      title="Merge duplicate contacts"
      description="Review every field and choose the final value before merging."
      className={`max-w-5xl ${className}`}
      closeOnBackdrop={!merging}
    >
      <section>
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-ink/15 bg-white p-5">
        <div>
          <p className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-widest text-brand">
            <GitMerge size={13} aria-hidden="true" />
            Review every field
          </p>
          <h2 id={`${id}-title`} className="mt-1 font-serif text-2xl">
            Merge duplicate contacts
          </h2>
          <p id={`${id}-description`} className="mt-2 text-sm text-subtle">
            The left contact survives. Nothing is selected for you when saved
            values conflict.
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Close merge review"
          disabled={merging}
          onClick={onCancel}
        >
          <X size={18} aria-hidden="true" />
        </Button>
        </header>

        <div className="space-y-6 p-5">
        {(!duplicateEvidence.isCandidate ||
          !duplicateEvidence.safeToSuggestMerge) && (
          <div
            className="flex gap-3 border border-amber-300 bg-amber-50 p-4 text-amber-950"
            role="alert"
          >
            <AlertTriangle size={18} className="shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">Identity needs careful review</p>
              <p className="mt-1 text-sm">
                {!duplicateEvidence.isCandidate
                  ? 'These contacts do not share an exact normalized email or exact name-and-company pair.'
                  : duplicateEvidence.warnings.join(' ')}
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-[minmax(7rem,0.6fr)_minmax(0,1fr)_minmax(0,1fr)] border border-ink/15 text-sm">
          <div className="border-b border-ink/15 bg-paper p-3 font-mono text-[10px] font-bold uppercase tracking-widest text-subtle">
            Field
          </div>
          <div className="border-b border-l border-ink/15 bg-paper p-3">
            <span className="block font-mono text-[9px] uppercase tracking-widest text-subtle">
              Keep this contact
            </span>
            <span className="mt-1 block font-medium">{primary.name}</span>
          </div>
          <div className="border-b border-l border-ink/15 bg-paper p-3">
            <span className="block font-mono text-[9px] uppercase tracking-widest text-subtle">
              Merge this duplicate
            </span>
            <span className="mt-1 block font-medium">{duplicate.name}</span>
          </div>

          {CONTACT_PROFILE_FIELDS.map((field) => {
            const conflict = analysis.conflicts.find(
              (item) => item.field === field,
            );
            const choice = choices[field];
            return (
              <React.Fragment key={field}>
                <div className="border-b border-ink/10 p-3 font-medium">
                  {FIELD_LABELS[field]}
                  {conflict && (
                    <span className="mt-1 block font-mono text-[9px] uppercase tracking-widest text-amber-800">
                      Choice required
                    </span>
                  )}
                </div>
                <div
                  className={`min-w-0 break-words border-b border-l border-ink/10 p-3 ${
                    choice?.strategy === 'primary'
                      ? 'bg-emerald-50 ring-1 ring-inset ring-emerald-400'
                      : ''
                  }`}
                >
                  {displayValue(primary[field])}
                </div>
                <div
                  className={`min-w-0 break-words border-b border-l border-ink/10 p-3 ${
                    choice?.strategy === 'duplicate'
                      ? 'bg-emerald-50 ring-1 ring-inset ring-emerald-400'
                      : ''
                  }`}
                >
                  {displayValue(duplicate[field])}
                </div>
                {conflict && (
                  <div className="col-span-3 border-b border-ink/15 bg-paper/40 p-3">
                    <label
                      htmlFor={`${id}-${field}-choice`}
                      className="font-mono text-[9px] font-bold uppercase tracking-widest text-subtle"
                    >
                      Final {FIELD_LABELS[field]}
                    </label>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <select
                        id={`${id}-${field}-choice`}
                        value={choice?.strategy || ''}
                        onChange={(event) =>
                          choose(field, event.target.value as MergeStrategy)
                        }
                        className="h-11 border border-ink/20 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                      >
                        <option value="" disabled>
                          Choose a value
                        </option>
                        {conflict.allowedStrategies.map((strategy) => (
                          <option key={strategy} value={strategy}>
                            {strategyLabel(
                              strategy,
                              primary.name,
                              duplicate.name,
                            )}
                          </option>
                        ))}
                      </select>
                      {choice?.strategy === 'custom' && (
                        <Input
                          aria-label={`Custom ${FIELD_LABELS[field]}`}
                          value={
                            Array.isArray(choice.customValue)
                              ? choice.customValue.join(', ')
                              : String(choice.customValue || '')
                          }
                          placeholder={
                            field === 'tags'
                              ? 'Comma-separated tags'
                              : `Custom ${FIELD_LABELS[field].toLowerCase()}`
                          }
                          onChange={(event) =>
                            setCustomValue(field, event.target.value)
                          }
                        />
                      )}
                    </div>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        <section
          className="border border-ink/15 p-4"
          aria-labelledby={`${id}-linked-title`}
        >
          <h3
            id={`${id}-linked-title`}
            className="font-mono text-[10px] font-bold uppercase tracking-widest"
          >
            Linked history migration
          </h3>
          {loadingPreview && (
            <p className="mt-2 text-sm text-subtle" role="status">
              Counting linked records…
            </p>
          )}
          {preview && (
            <>
              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
                {Object.entries(preview.referenceCounts).map(([kind, count]) => (
                  <div key={kind} className="border border-ink/10 bg-paper/40 p-3">
                    <dt className="font-mono text-[9px] uppercase tracking-widest text-subtle">
                      {kind.replace(/-/g, ' ')}
                    </dt>
                    <dd className="mt-1 font-serif text-xl">{count}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 flex items-start gap-2 text-xs text-subtle">
                <ArrowRight size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                Notes, outreach, commitments, and tracked threads are relinked.
                Facts and job history are copied as non-AI historical evidence
                while the recoverable duplicate retains its originals.
              </p>
            </>
          )}
        </section>

        {error && (
          <p
            className="border border-red-300 bg-red-50 p-3 text-sm text-red-950"
            role="alert"
          >
            {error}
          </p>
        )}

        <div className="border border-red-200 bg-red-50 p-4">
          <label
            htmlFor={`${id}-confirmation`}
            className="font-mono text-[10px] font-bold uppercase tracking-widest text-red-900"
          >
            Type MERGE to confirm
          </label>
          <p className="mt-1 text-sm text-red-900">
            {duplicate.name} will enter a 30-day recovery state after all
            references have migrated.
          </p>
          <Input
            id={`${id}-confirmation`}
            value={confirmation}
            className="mt-3 max-w-xs border-red-300 bg-white"
            autoComplete="off"
            onChange={(event) => setConfirmation(event.target.value)}
          />
          {unresolved.length > 0 && (
            <p className="mt-2 text-xs text-red-900">
              Choose {unresolved.length} remaining conflicting field
              {unresolved.length === 1 ? '' : 's'}.
            </p>
          )}
        </div>
        </div>

        <footer className="sticky bottom-0 flex justify-end gap-3 border-t border-ink/15 bg-white p-5">
        <Button type="button" variant="ghost" disabled={merging} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={!canMerge}
          onClick={merge}
        >
          <GitMerge size={14} aria-hidden="true" />
          {merging ? 'Merging…' : 'Merge contacts'}
        </Button>
        </footer>
      </section>
    </Dialog>
  );
}
