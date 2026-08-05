/**
 * Immutable, deterministic feedback for AI-extracted commitments.
 *
 * The event log is the source of truth. `CommitmentFeedbackState` is only a
 * query-friendly projection that can be rebuilt from the events at any time.
 * This distinction matters: a false-positive correction must never disappear
 * just because the commitment's current status changes later.
 */

export const COMMITMENT_DISMISS_REASONS = [
  'false-positive',
  'duplicate',
  'already-completed',
  'not-actionable',
  'no-longer-relevant',
  'other',
] as const;

export type CommitmentDismissReason =
  (typeof COMMITMENT_DISMISS_REASONS)[number];
export type CommitmentReality = 'unreviewed' | 'real' | 'not-real';
export type CommitmentResolution = 'open' | 'completed' | 'snoozed' | 'dismissed';
export type RelationshipOutcome =
  | 'unknown'
  | 'improved'
  | 'unchanged'
  | 'worsened';

export interface CommitmentFeedbackEventBase {
  /** Client-generated idempotency key; one id may be applied only once. */
  id: string;
  commitmentId: string;
  actorUid: string;
  /** ISO-8601 occurrence time. The persistence layer also adds server time. */
  occurredAt: string;
  source: 'user-explicit';
}
export type CommitmentFeedbackEvent =
  | (CommitmentFeedbackEventBase & {
      kind: 'reality-reviewed';
      reality: Exclude<CommitmentReality, 'unreviewed'>;
    })
  | (CommitmentFeedbackEventBase & {
      kind: 'completed';
    })
  | (CommitmentFeedbackEventBase & {
      kind: 'snoozed';
      snoozedUntil: string;
    })
  | (CommitmentFeedbackEventBase & {
      kind: 'dismissed';
      reason: CommitmentDismissReason;
      note: string | null;
    })
  | (CommitmentFeedbackEventBase & {
      kind: 'relationship-outcome-recorded';
      outcome: Exclude<RelationshipOutcome, 'unknown'>;
      note: string | null;
    });

export type CommitmentFeedbackAction =
  | {
      kind: 'reality-reviewed';
      reality: Exclude<CommitmentReality, 'unreviewed'>;
    }
  | { kind: 'completed' }
  | { kind: 'snoozed'; snoozedUntil: Date | string }
  | {
      kind: 'dismissed';
      reason: CommitmentDismissReason;
      note?: string | null;
    }
  | {
      kind: 'relationship-outcome-recorded';
      outcome: Exclude<RelationshipOutcome, 'unknown'>;
      note?: string | null;
    };

export interface CommitmentFeedbackCounters {
  events: number;
  realityReviews: number;
  markedReal: number;
  markedNotReal: number;
  completed: number;
  snoozed: number;
  dismissed: number;
  outcomesRecorded: number;
}

export interface CommitmentFeedbackState {
  schemaVersion: 1;
  reality: CommitmentReality;
  resolution: CommitmentResolution;
  snoozedUntil: string | null;
  dismissReason: CommitmentDismissReason | null;
  dismissNote: string | null;
  relationshipOutcome: RelationshipOutcome;
  relationshipOutcomeNote: string | null;
  lastEventId: string | null;
  lastEventAt: string | null;
  counters: CommitmentFeedbackCounters;
}

export const EMPTY_COMMITMENT_FEEDBACK: CommitmentFeedbackState = {
  schemaVersion: 1,
  reality: 'unreviewed',
  resolution: 'open',
  snoozedUntil: null,
  dismissReason: null,
  dismissNote: null,
  relationshipOutcome: 'unknown',
  relationshipOutcomeNote: null,
  lastEventId: null,
  lastEventAt: null,
  counters: {
    events: 0,
    realityReviews: 0,
    markedReal: 0,
    markedNotReal: 0,
    completed: 0,
    snoozed: 0,
    dismissed: 0,
    outcomesRecorded: 0,
  },
};

function validIso(value: unknown, field: string): string {
  const normalized = value instanceof Date ? value.toISOString() : String(value || '');
  const timestamp = Date.parse(normalized);
  if (!normalized || !Number.isFinite(timestamp)) {
    throw new Error(`${field} must be a valid date.`);
  }
  return new Date(timestamp).toISOString();
}

function safeIdentifier(value: unknown, field: string): string {
  const normalized = String(value || '').trim();
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(normalized)) {
    throw new Error(`${field} is invalid.`);
  }
  return normalized;
}

function safeNote(value: unknown): string | null {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, 500) : null;
}

/**
 * Creates one validated event from an explicit UI action. This function does
 * no status inference: selecting "not real" records exactly that correction;
 * it does not silently complete or dismiss the item.
 */
export function createCommitmentFeedbackEvent(params: {
  eventId: string;
  commitmentId: string;
  actorUid: string;
  action: CommitmentFeedbackAction;
  occurredAt?: Date | string;
}): CommitmentFeedbackEvent {
  const base: CommitmentFeedbackEventBase = {
    id: safeIdentifier(params.eventId, 'eventId'),
    commitmentId: safeIdentifier(params.commitmentId, 'commitmentId'),
    actorUid: safeIdentifier(params.actorUid, 'actorUid'),
    occurredAt: validIso(params.occurredAt || new Date(), 'occurredAt'),
    source: 'user-explicit',
  };

  switch (params.action.kind) {
    case 'reality-reviewed':
      if (!['real', 'not-real'].includes(params.action.reality)) {
        throw new Error('reality must be real or not-real.');
      }
      return { ...base, ...params.action };
    case 'completed':
      return { ...base, kind: 'completed' };
    case 'snoozed': {
      const snoozedUntil = validIso(params.action.snoozedUntil, 'snoozedUntil');
      if (Date.parse(snoozedUntil) <= Date.parse(base.occurredAt)) {
        throw new Error('A snooze date must be in the future.');
      }
      return { ...base, kind: 'snoozed', snoozedUntil };
    }
    case 'dismissed':
      if (!COMMITMENT_DISMISS_REASONS.includes(params.action.reason)) {
        throw new Error('Dismiss reason is invalid.');
      }
      return {
        ...base,
        kind: 'dismissed',
        reason: params.action.reason,
        note: safeNote(params.action.note),
      };
    case 'relationship-outcome-recorded':
      if (!['improved', 'unchanged', 'worsened'].includes(params.action.outcome)) {
        throw new Error('Relationship outcome is invalid.');
      }
      return {
        ...base,
        kind: 'relationship-outcome-recorded',
        outcome: params.action.outcome,
        note: safeNote(params.action.note),
      };
  }
}

function cloneState(state: CommitmentFeedbackState): CommitmentFeedbackState {
  return {
    ...state,
    counters: { ...state.counters },
  };
}

export function applyCommitmentFeedbackEvent(
  state: CommitmentFeedbackState,
  event: CommitmentFeedbackEvent,
): CommitmentFeedbackState {
  if (state.lastEventId === event.id) return cloneState(state);

  const next = cloneState(state);
  next.counters.events += 1;
  next.lastEventId = event.id;
  next.lastEventAt = event.occurredAt;

  switch (event.kind) {
    case 'reality-reviewed':
      next.reality = event.reality;
      next.counters.realityReviews += 1;
      if (event.reality === 'real') next.counters.markedReal += 1;
      else next.counters.markedNotReal += 1;
      break;
    case 'completed':
      next.resolution = 'completed';
      next.snoozedUntil = null;
      next.dismissReason = null;
      next.dismissNote = null;
      next.counters.completed += 1;
      break;
    case 'snoozed':
      next.resolution = 'snoozed';
      next.snoozedUntil = event.snoozedUntil;
      next.dismissReason = null;
      next.dismissNote = null;
      next.counters.snoozed += 1;
      break;
    case 'dismissed':
      next.resolution = 'dismissed';
      next.snoozedUntil = null;
      next.dismissReason = event.reason;
      next.dismissNote = event.note;
      next.counters.dismissed += 1;
      break;
    case 'relationship-outcome-recorded':
      next.relationshipOutcome = event.outcome;
      next.relationshipOutcomeNote = event.note;
      next.counters.outcomesRecorded += 1;
      break;
  }

  return next;
}

/**
 * Rebuilds the projection deterministically. Duplicate event ids are ignored,
 * then the log is ordered by occurrence time and id for stable cross-device
 * results.
 */
export function reduceCommitmentFeedbackEvents(
  events: CommitmentFeedbackEvent[],
): CommitmentFeedbackState {
  const unique = new Map<string, CommitmentFeedbackEvent>();
  for (const event of events) {
    if (!unique.has(event.id)) unique.set(event.id, event);
  }
  return [...unique.values()]
    .sort(
      (a, b) =>
        Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
        a.id.localeCompare(b.id),
    )
    .reduce(applyCommitmentFeedbackEvent, cloneState(EMPTY_COMMITMENT_FEEDBACK));
}

export function legacyCommitmentStatus(
  state: CommitmentFeedbackState,
): 'open' | 'done' | 'dismissed' {
  if (state.resolution === 'completed') return 'done';
  if (state.resolution === 'dismissed') return 'dismissed';
  return 'open';
}
