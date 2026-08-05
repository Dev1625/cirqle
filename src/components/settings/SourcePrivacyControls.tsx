import React, { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import {
  DEFAULT_SOURCE_PRIVACY_POLICY,
  PRIVACY_SOURCE_TYPES,
  createSourcePrivacyBoundary,
  normalizeSourcePrivacyPolicy,
  sourceTypeBoundaryId,
  upsertSourcePrivacyBoundary,
  type PrivacySourceType,
  type RetentionMode,
  type SourcePrivacyPolicy,
} from '../../lib/moat/privacyPolicy';
import {
  loadSourcePrivacyPolicy,
  saveSourcePrivacyPolicy,
} from '../../lib/moat/privacyPolicyStore';
import { RetentionSweepPanel } from './RetentionSweepPanel';

const SOURCE_LABELS: Record<PrivacySourceType, string> = {
  profile: 'Profiles',
  import: 'Imports',
  note: 'Notes',
  voice: 'Voice memos',
  meeting: 'Meetings',
  calendar: 'Calendar',
  email: 'Email',
  outreach: 'Outreach',
  reply: 'Replies',
  commitment: 'Commitments',
  'public-card-capture': 'Public card captures',
  'user-input': 'One-time user input',
  system: 'System records',
};

const RETENTION_CHOICES: {
  label: string;
  mode: RetentionMode;
  days: number | null;
}[] = [
  { label: 'Keep indefinitely', mode: 'forever', days: null },
  { label: 'Keep 30 days', mode: 'days', days: 30 },
  { label: 'Keep 90 days', mode: 'days', days: 90 },
  { label: 'Keep 1 year', mode: 'days', days: 365 },
  {
    label: 'Delete after disconnect',
    mode: 'delete-on-disconnect',
    days: null,
  },
];

function retentionValue(mode: RetentionMode, days: number | null): string {
  return mode === 'days' ? `days:${days}` : mode;
}

function parseRetention(value: string): {
  mode: RetentionMode;
  days: number | null;
} {
  if (value.startsWith('days:')) {
    return { mode: 'days', days: Number(value.split(':')[1]) };
  }
  return { mode: value as RetentionMode, days: null };
}

export interface SourcePrivacyControlsProps {
  policy: SourcePrivacyPolicy;
  onSave: (policy: SourcePrivacyPolicy) => Promise<void>;
  disabled?: boolean;
}

export function SourcePrivacyControls({
  policy,
  onSave,
  disabled = false,
}: SourcePrivacyControlsProps) {
  const [draft, setDraft] = useState(() =>
    normalizeSourcePrivacyPolicy(policy),
  );
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  useEffect(() => {
    setDraft(normalizeSourcePrivacyPolicy(policy));
  }, [policy]);

  const boundaryFor = (sourceType: PrivacySourceType) =>
    draft.boundaries.find(
      (boundary) => boundary.id === sourceTypeBoundaryId(sourceType),
    ) ||
    createSourcePrivacyBoundary({
      sourceType,
      retentionMode: draft.defaultRetentionMode,
      retentionDays: draft.defaultRetentionDays,
      aiUse: draft.defaultAIUse,
    });

  const update = (
    sourceType: PrivacySourceType,
    patch: {
      retentionMode?: RetentionMode;
      retentionDays?: number | null;
      aiUse?: 'allow' | 'never';
    },
  ) => {
    const current = boundaryFor(sourceType);
    setDraft((value) =>
      upsertSourcePrivacyBoundary(
        value,
        createSourcePrivacyBoundary({
          ...current,
          ...patch,
          sourceType,
        }),
      ),
    );
  };

  const save = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      await onSave(draft);
      setFeedback({
        type: 'success',
        message: 'Privacy boundaries saved.',
      });
    } catch {
      setFeedback({
        type: 'error',
        message:
          'Privacy boundaries could not be saved. No partial change was applied; check your connection and try again.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-card border border-ink/20 bg-white p-5"
      aria-labelledby="source-privacy-title"
    >
      <h2 id="source-privacy-title" className="font-serif text-2xl font-bold italic">
        Source privacy
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
        Choose how long each source is retained and whether it may enter an AI
        evidence packet. “Never use in AI” is enforced before generation; the
        source can remain visible to you.
      </p>

      <div
        className="mt-5 overflow-x-auto"
        tabIndex={0}
        aria-label="Source privacy settings. Scroll horizontally on narrow screens."
      >
        <table className="w-full min-w-[38rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-ink/15 font-mono text-[10px] uppercase tracking-widest text-subtle">
              <th scope="col" className="px-2 py-3">
                Source
              </th>
              <th scope="col" className="px-2 py-3">
                Retention
              </th>
              <th scope="col" className="px-2 py-3">
                AI boundary
              </th>
            </tr>
          </thead>
          <tbody>
            {PRIVACY_SOURCE_TYPES.map((sourceType) => {
              const boundary = boundaryFor(sourceType);
              return (
                <tr key={sourceType} className="border-b border-ink/10">
                  <th scope="row" className="px-2 py-3 text-sm font-semibold">
                    {SOURCE_LABELS[sourceType]}
                  </th>
                  <td className="px-2 py-3">
                    <label className="sr-only" htmlFor={`retention-${sourceType}`}>
                      Retention for {SOURCE_LABELS[sourceType]}
                    </label>
                    <select
                      id={`retention-${sourceType}`}
                      value={retentionValue(
                        boundary.retentionMode,
                        boundary.retentionDays,
                      )}
                      disabled={disabled || busy}
                      onChange={(event) => {
                        const retention = parseRetention(event.target.value);
                        update(sourceType, {
                          retentionMode: retention.mode,
                          retentionDays: retention.days,
                        });
                      }}
                      className="h-11 w-full min-w-44 rounded-card border border-ink/20 bg-white px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-50 sm:text-sm"
                    >
                      {RETENTION_CHOICES.map((choice) => (
                        <option
                          key={retentionValue(choice.mode, choice.days)}
                          value={retentionValue(choice.mode, choice.days)}
                        >
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-3">
                    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={boundary.aiUse === 'never'}
                        disabled={disabled || busy}
                        onChange={(event) =>
                          update(sourceType, {
                            aiUse: event.target.checked ? 'never' : 'allow',
                          })
                        }
                        className="h-5 w-5 accent-brand"
                      />
                      Never use in AI
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="brand"
          disabled={disabled || busy}
          onClick={save}
          aria-busy={busy}
        >
          {busy ? 'Saving…' : 'Save privacy boundaries'}
        </Button>
        {feedback && (
          <p
            className={`text-sm ${
              feedback.type === 'error' ? 'text-red-700' : 'text-muted'
            }`}
            role={feedback.type === 'error' ? 'alert' : 'status'}
            aria-live={feedback.type === 'error' ? 'assertive' : 'polite'}
            aria-atomic="true"
          >
            {feedback.message}
          </p>
        )}
      </div>
    </section>
  );
}

export function PersistedSourcePrivacyControls({
  uid,
}: {
  uid: string;
}) {
  const [policy, setPolicy] = useState<SourcePrivacyPolicy | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [policyRevision, setPolicyRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(false);
    loadSourcePrivacyPolicy(uid)
      .then((loaded) => {
        if (active) setPolicy(loaded);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [uid]);

  if (loadError) {
    return (
      <p role="alert" className="rounded-card border border-red-200 bg-red-50 p-4 text-sm">
        Privacy settings could not be loaded. Reload before changing source
        permissions.
      </p>
    );
  }
  if (!policy) {
    return (
      <p role="status" aria-live="polite" className="font-mono text-xs text-muted">
        Loading source privacy settings…
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <SourcePrivacyControls
        policy={policy || DEFAULT_SOURCE_PRIVACY_POLICY}
        onSave={async (next) => {
          const saved = await saveSourcePrivacyPolicy(uid, next);
          setPolicy(saved);
          setPolicyRevision((revision) => revision + 1);
        }}
      />
      <RetentionSweepPanel policyRevision={policyRevision} />
    </div>
  );
}
