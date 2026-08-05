import React, { useId, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import {
  COMMITMENT_DISMISS_REASONS,
  EMPTY_COMMITMENT_FEEDBACK,
  type CommitmentDismissReason,
  type CommitmentFeedbackAction,
  type CommitmentFeedbackState,
  type RelationshipOutcome,
} from '../../lib/moat/commitmentFeedbackCore';
import { recordCommitmentFeedback } from '../../lib/moat/commitmentFeedbackStore';

const DISMISS_LABELS: Record<CommitmentDismissReason, string> = {
  'false-positive': 'Not a commitment',
  duplicate: 'Duplicate',
  'already-completed': 'Already completed',
  'not-actionable': 'Not actionable',
  'no-longer-relevant': 'No longer relevant',
  other: 'Other',
};

export interface CommitmentFeedbackControlsProps {
  state?: CommitmentFeedbackState | null;
  onRecord: (action: CommitmentFeedbackAction) => Promise<void>;
  disabled?: boolean;
  className?: string;
}

/**
 * Controlled feedback UI. The host owns optimistic state and error toasts;
 * this component preserves each explicit user choice and never conflates
 * "not real", "dismissed", and "completed".
 */
export function CommitmentFeedbackControls({
  state = EMPTY_COMMITMENT_FEEDBACK,
  onRecord,
  disabled = false,
  className = '',
}: CommitmentFeedbackControlsProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState('');
  const [snoozeDate, setSnoozeDate] = useState('');
  const [dismissReason, setDismissReason] =
    useState<CommitmentDismissReason>('no-longer-relevant');
  const [dismissNote, setDismissNote] = useState('');
  const [outcome, setOutcome] = useState<RelationshipOutcome>(
    state?.relationshipOutcome || 'unknown',
  );
  const [outcomeNote, setOutcomeNote] = useState('');

  const record = async (action: CommitmentFeedbackAction, success: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      await onRecord(action);
      setMessage(success);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Feedback could not be saved. Your choice was not applied.',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const isDisabled = disabled || busy;
  return (
    <section
      className={`space-y-4 rounded-card border border-ink/15 bg-paper/40 p-4 ${className}`}
      aria-labelledby={`${id}-title`}
    >
      <div>
        <h3 id={`${id}-title`} className="font-serif text-lg font-bold italic">
          Help Cirqle learn from the outcome
        </h3>
        <p className="mt-1 text-sm text-muted">
          These answers are saved as private, auditable feedback—not inferred
          from a tracker status.
        </p>
      </div>

      <fieldset disabled={isDisabled}>
        <legend className="font-mono text-[10px] font-bold uppercase tracking-widest text-subtle">
          Was this a real commitment?
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {(['real', 'not-real'] as const).map((reality) => (
            <Button
              key={reality}
              type="button"
              size="sm"
              variant={state?.reality === reality ? 'default' : 'outline'}
              aria-pressed={state?.reality === reality}
              onClick={() =>
                record(
                  { kind: 'reality-reviewed', reality },
                  reality === 'real'
                    ? 'Recorded as a real commitment.'
                    : 'Recorded as a false positive.',
                )
              }
            >
              {reality === 'real' ? 'Yes, it was real' : 'No, it was not'}
            </Button>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <label
            htmlFor={`${id}-snooze`}
            className="font-mono text-[10px] font-bold uppercase tracking-widest text-subtle"
          >
            Snooze until
          </label>
          <div className="flex gap-2">
            <Input
              id={`${id}-snooze`}
              type="date"
              value={snoozeDate}
              min={new Date(Date.now() + 86_400_000)
                .toISOString()
                .slice(0, 10)}
              onChange={(event) => setSnoozeDate(event.target.value)}
              disabled={isDisabled}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isDisabled || !snoozeDate}
              onClick={() =>
                record(
                  {
                    kind: 'snoozed',
                    snoozedUntil: new Date(`${snoozeDate}T12:00:00`),
                  },
                  'Commitment snoozed.',
                )
              }
            >
              Snooze
            </Button>
          </div>
        </div>

        <div className="flex items-end">
          <Button
            type="button"
            variant="brand"
            disabled={isDisabled}
            onClick={() =>
              record({ kind: 'completed' }, 'Commitment marked complete.')
            }
          >
            Mark complete
          </Button>
        </div>
      </div>

      <fieldset className="space-y-2" disabled={isDisabled}>
        <legend className="font-mono text-[10px] font-bold uppercase tracking-widest text-subtle">
          Dismiss with a reason
        </legend>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,13rem)_1fr_auto]">
          <label className="sr-only" htmlFor={`${id}-dismiss-reason`}>
            Dismiss reason
          </label>
          <select
            id={`${id}-dismiss-reason`}
            value={dismissReason}
            onChange={(event) =>
              setDismissReason(event.target.value as CommitmentDismissReason)
            }
            className="h-9 rounded-card border border-ink/15 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          >
            {COMMITMENT_DISMISS_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {DISMISS_LABELS[reason]}
              </option>
            ))}
          </select>
          <Input
            aria-label="Optional dismissal note"
            placeholder="Optional context"
            value={dismissNote}
            maxLength={500}
            onChange={(event) => setDismissNote(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              record(
                {
                  kind: 'dismissed',
                  reason: dismissReason,
                  note: dismissNote,
                },
                'Commitment dismissed with its reason saved.',
              )
            }
          >
            Dismiss
          </Button>
        </div>
      </fieldset>

      <fieldset className="space-y-2" disabled={isDisabled}>
        <legend className="font-mono text-[10px] font-bold uppercase tracking-widest text-subtle">
          Relationship outcome
        </legend>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,13rem)_1fr_auto]">
          <label className="sr-only" htmlFor={`${id}-outcome`}>
            Relationship outcome
          </label>
          <select
            id={`${id}-outcome`}
            value={outcome}
            onChange={(event) =>
              setOutcome(event.target.value as RelationshipOutcome)
            }
            className="h-9 rounded-card border border-ink/15 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          >
            <option value="unknown">Choose outcome</option>
            <option value="improved">Improved</option>
            <option value="unchanged">Unchanged</option>
            <option value="worsened">Worsened</option>
          </select>
          <Input
            aria-label="Optional relationship outcome note"
            placeholder="Optional context"
            value={outcomeNote}
            maxLength={500}
            onChange={(event) => setOutcomeNote(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={outcome === 'unknown'}
            onClick={() => {
              if (outcome === 'unknown') return;
              void record(
                {
                  kind: 'relationship-outcome-recorded',
                  outcome,
                  note: outcomeNote,
                },
                'Relationship outcome saved.',
              );
            }}
          >
            Save outcome
          </Button>
        </div>
      </fieldset>

      <p className="min-h-5 text-sm text-muted" aria-live="polite">
        {busy ? 'Saving feedback…' : message}
      </p>
    </section>
  );
}

export interface PersistedCommitmentFeedbackControlsProps
  extends Omit<CommitmentFeedbackControlsProps, 'onRecord'> {
  uid: string;
  commitmentId: string;
  onStateChange?: (state: CommitmentFeedbackState) => void;
}

export function PersistedCommitmentFeedbackControls({
  uid,
  commitmentId,
  onStateChange,
  ...props
}: PersistedCommitmentFeedbackControlsProps) {
  return (
    <CommitmentFeedbackControls
      {...props}
      onRecord={async (action) => {
        const result = await recordCommitmentFeedback({
          uid,
          commitmentId,
          action,
        });
        onStateChange?.(result.state);
      }}
    />
  );
}
