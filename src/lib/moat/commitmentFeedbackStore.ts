import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';
import { db } from '../../config/firebase';
import {
  COMMITMENT_DISMISS_REASONS,
  EMPTY_COMMITMENT_FEEDBACK,
  applyCommitmentFeedbackEvent,
  createCommitmentFeedbackEvent,
  legacyCommitmentStatus,
  type CommitmentFeedbackAction,
  type CommitmentFeedbackEvent,
  type CommitmentFeedbackState,
} from './commitmentFeedbackCore';

export interface RecordCommitmentFeedbackInput {
  uid: string;
  commitmentId: string;
  action: CommitmentFeedbackAction;
  eventId?: string;
  occurredAt?: Date | string;
}

function randomEventId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function persistedState(value: unknown): CommitmentFeedbackState {
  if (!value || typeof value !== 'object') {
    return {
      ...EMPTY_COMMITMENT_FEEDBACK,
      counters: { ...EMPTY_COMMITMENT_FEEDBACK.counters },
    };
  }
  const candidate = value as Partial<CommitmentFeedbackState>;
  const counters = candidate.counters || EMPTY_COMMITMENT_FEEDBACK.counters;
  const count = (value: unknown) => {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  return {
    schemaVersion: 1,
    reality: ['unreviewed', 'real', 'not-real'].includes(
      String(candidate.reality),
    )
      ? (candidate.reality as CommitmentFeedbackState['reality'])
      : 'unreviewed',
    resolution: ['open', 'completed', 'snoozed', 'dismissed'].includes(
      String(candidate.resolution),
    )
      ? (candidate.resolution as CommitmentFeedbackState['resolution'])
      : 'open',
    snoozedUntil:
      typeof candidate.snoozedUntil === 'string'
        ? candidate.snoozedUntil
        : null,
    dismissReason:
      typeof candidate.dismissReason === 'string' &&
      COMMITMENT_DISMISS_REASONS.includes(candidate.dismissReason)
        ? candidate.dismissReason
        : null,
    dismissNote:
      typeof candidate.dismissNote === 'string' ? candidate.dismissNote : null,
    relationshipOutcome: [
      'unknown',
      'improved',
      'unchanged',
      'worsened',
    ].includes(String(candidate.relationshipOutcome))
      ? (candidate.relationshipOutcome as CommitmentFeedbackState['relationshipOutcome'])
      : 'unknown',
    relationshipOutcomeNote:
      typeof candidate.relationshipOutcomeNote === 'string'
        ? candidate.relationshipOutcomeNote
        : null,
    lastEventId:
      typeof candidate.lastEventId === 'string' ? candidate.lastEventId : null,
    lastEventAt:
      typeof candidate.lastEventAt === 'string' ? candidate.lastEventAt : null,
    counters: {
      events: count(counters.events),
      realityReviews: count(counters.realityReviews),
      markedReal: count(counters.markedReal),
      markedNotReal: count(counters.markedNotReal),
      completed: count(counters.completed),
      snoozed: count(counters.snoozed),
      dismissed: count(counters.dismissed),
      outcomesRecorded: count(counters.outcomesRecorded),
    },
  };
}

function sameEventAction(
  existing: Record<string, unknown>,
  event: CommitmentFeedbackEvent,
): boolean {
  if (
    existing.commitmentId !== event.commitmentId ||
    existing.actorUid !== event.actorUid ||
    existing.kind !== event.kind ||
    existing.source !== event.source
  ) {
    return false;
  }
  switch (event.kind) {
    case 'reality-reviewed':
      return existing.reality === event.reality;
    case 'completed':
      return true;
    case 'snoozed':
      return existing.snoozedUntil === event.snoozedUntil;
    case 'dismissed':
      return existing.reason === event.reason && existing.note === event.note;
    case 'relationship-outcome-recorded':
      return existing.outcome === event.outcome && existing.note === event.note;
  }
}

/**
 * Atomically appends an immutable event and refreshes the commitment's
 * aggregate projection. A repeated event id is an idempotent no-op.
 *
 * Events live in a user-level collection so export/deletion tooling can
 * enumerate them without recursive collection-group discovery.
 */
export async function recordCommitmentFeedback(
  input: RecordCommitmentFeedbackInput,
  firestore: Firestore = db,
): Promise<{ event: CommitmentFeedbackEvent; state: CommitmentFeedbackState }> {
  const event = createCommitmentFeedbackEvent({
    eventId: input.eventId || randomEventId(),
    commitmentId: input.commitmentId,
    actorUid: input.uid,
    action: input.action,
    occurredAt: input.occurredAt,
  });

  const commitmentRef = doc(
    firestore,
    `users/${input.uid}/commitments/${input.commitmentId}`,
  );
  const eventRef = doc(
    collection(firestore, `users/${input.uid}/commitmentFeedbackEvents`),
    event.id,
  );

  return runTransaction(firestore, async (transaction) => {
    const [commitmentSnapshot, eventSnapshot] = await Promise.all([
      transaction.get(commitmentRef),
      transaction.get(eventRef),
    ]);

    if (!commitmentSnapshot.exists()) {
      throw new Error('That commitment no longer exists.');
    }

    const current = persistedState(commitmentSnapshot.data().feedback);
    if (eventSnapshot.exists()) {
      if (!sameEventAction(eventSnapshot.data(), event)) {
        throw new Error('That feedback event id has already been used.');
      }
      return { event, state: current };
    }

    const next = applyCommitmentFeedbackEvent(current, event);
    transaction.set(eventRef, {
      ...event,
      recordedAt: serverTimestamp(),
    });
    transaction.update(commitmentRef, {
      feedback: next,
      status: legacyCommitmentStatus(next),
      snoozedUntil: next.snoozedUntil,
      resolvedAt:
        next.resolution === 'completed' || next.resolution === 'dismissed'
          ? serverTimestamp()
          : null,
      feedbackUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { event, state: next };
  });
}
