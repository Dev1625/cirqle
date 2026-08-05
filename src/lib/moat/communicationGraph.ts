/**
 * Truthful, closed-loop communication graph.
 *
 * Tracker labels are presentation state, not evidence. This module emits
 * lifecycle events only when a timestamp and matching provenance exist. It
 * never backfills "sent", "delivered", or "replied" merely because a record
 * currently carries a later-looking status.
 */

export const COMMUNICATION_STAGES = [
  'draft',
  'opened',
  'sent-confirmed',
  'sent-provider',
  'delivered',
  'replied',
  'meeting',
  'commitment',
  'outcome',
] as const;

export type CommunicationStage = (typeof COMMUNICATION_STAGES)[number];
export type CommunicationChannel =
  | 'email'
  | 'calendar'
  | 'phone'
  | 'in-person'
  | 'other';
export type CommunicationVerification =
  | 'recorded'
  | 'user-confirmed'
  | 'provider-verified';

export interface ProviderProvenance {
  provider: string;
  threadId?: string | null;
  messageId?: string | null;
  eventId?: string | null;
}

export interface CommunicationProvenance {
  source:
    | 'draft-record'
    | 'mail-client'
    | 'user'
    | 'provider'
    | 'calendar'
    | 'commitment'
    | 'outcome';
  sourceRecordId: string;
  verification: CommunicationVerification;
  provider: ProviderProvenance | null;
}

export interface CommunicationEvent {
  id: string;
  chainId: string;
  contactId: string;
  stage: CommunicationStage;
  occurredAt: string;
  channel: CommunicationChannel;
  provenance: CommunicationProvenance;
  details: {
    outcome?: 'improved' | 'unchanged' | 'worsened';
    commitmentReality?: 'real' | 'not-real' | 'unreviewed';
  };
}

export interface CommunicationEdge {
  id: string;
  chainId: string;
  fromEventId: string;
  toEventId: string;
  elapsedMs: number;
  explicitChain: true;
}

export interface CommunicationEvidenceIssue {
  recordType: 'outreach' | 'meeting' | 'commitment' | 'outcome';
  recordId: string;
  code:
    | 'invalid-timestamp'
    | 'status-without-evidence'
    | 'provider-id-missing'
    | 'chronology-conflict'
    | 'unlinked-record'
    | 'commitment-not-confirmed';
  message: string;
}

export interface ProviderObservation {
  occurredAt: Date | string;
  provider: string;
  threadId: string;
  messageId?: string | null;
  eventId: string;
}

export interface ReplyObservation {
  occurredAt: Date | string;
  source: 'provider' | 'user';
  sourceRecordId: string;
  provider?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  eventId?: string | null;
}

export interface OutreachLifecycleRecord {
  id: string;
  contactId: string;
  channel?: CommunicationChannel;
  status?: string | null;
  verification?:
    | 'none'
    | 'user-confirmed'
    | 'provider-verified'
    | 'preview-simulated'
    | null;
  createdAt?: Date | string | null;
  draftedAt?: Date | string | null;
  openedAt?: Date | string | null;
  sentAt?: Date | string | null;
  provider?: string | null;
  threadId?: string | null;
  providerMessageId?: string | null;
  deliveryEvidence?: ProviderObservation | null;
  replyEvidence?: ReplyObservation | null;
  responseReceived?: string | boolean | null;
  subject?: string | null;
  body?: string | null;
}

export interface MeetingLifecycleRecord {
  id: string;
  contactId: string;
  occurredAt: Date | string;
  source: 'calendar' | 'user';
  outreachId?: string | null;
  threadId?: string | null;
  provider?: string | null;
  providerEventId?: string | null;
}

export interface CommitmentLifecycleRecord {
  id: string;
  contactId: string;
  occurredAt: Date | string;
  sourceRecordId: string;
  outreachId?: string | null;
  meetingId?: string | null;
  reality?: 'real' | 'not-real' | 'unreviewed';
}

export interface OutcomeLifecycleRecord {
  id: string;
  contactId: string;
  occurredAt: Date | string;
  outcome: 'improved' | 'unchanged' | 'worsened';
  commitmentId?: string | null;
  meetingId?: string | null;
  outreachId?: string | null;
}

export interface BuildCommunicationGraphInput {
  outreaches?: OutreachLifecycleRecord[];
  meetings?: MeetingLifecycleRecord[];
  commitments?: CommitmentLifecycleRecord[];
  outcomes?: OutcomeLifecycleRecord[];
}

export interface CommunicationGraph {
  events: CommunicationEvent[];
  edges: CommunicationEdge[];
  issues: CommunicationEvidenceIssue[];
}

const STAGE_ORDER = new Map(
  COMMUNICATION_STAGES.map((stage, index) => [stage, index]),
);

function normalizedId(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '-')
    .slice(0, 180);
}

function normalizedIso(value: unknown): string | null {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function eventId(recordType: string, recordId: string, stage: CommunicationStage) {
  return `${recordType}:${normalizedId(recordId)}:${stage}`;
}

function statusLooksAtLeast(
  status: string | null | undefined,
  words: string[],
): boolean {
  const value = String(status || '').toLowerCase();
  return words.some((word) => value.includes(word));
}

function issue(
  recordType: CommunicationEvidenceIssue['recordType'],
  recordId: string,
  code: CommunicationEvidenceIssue['code'],
  message: string,
): CommunicationEvidenceIssue {
  return { recordType, recordId, code, message };
}

function normalizeOutreach(
  record: OutreachLifecycleRecord,
): {
  events: CommunicationEvent[];
  issues: CommunicationEvidenceIssue[];
} {
  const issues: CommunicationEvidenceIssue[] = [];
  const events: CommunicationEvent[] = [];
  const recordId = normalizedId(record.id);
  const contactId = normalizedId(record.contactId);
  const chainId = `outreach:${recordId}`;
  const channel = record.channel || 'email';
  let lastAt = Number.NEGATIVE_INFINITY;

  const append = (
    stage: CommunicationStage,
    rawTime: unknown,
    provenance: CommunicationProvenance,
  ) => {
    const occurredAt = normalizedIso(rawTime);
    if (!occurredAt) {
      issues.push(
        issue(
          'outreach',
          record.id,
          'invalid-timestamp',
          `${stage} evidence was ignored because it has no valid timestamp.`,
        ),
      );
      return false;
    }
    const at = Date.parse(occurredAt);
    if (at < lastAt) {
      issues.push(
        issue(
          'outreach',
          record.id,
          'chronology-conflict',
          `${stage} evidence predates the preceding verified lifecycle event.`,
        ),
      );
      return false;
    }
    lastAt = at;
    events.push({
      id: eventId('outreach', recordId, stage),
      chainId,
      contactId,
      stage,
      occurredAt,
      channel,
      provenance,
      details: {},
    });
    return true;
  };

  const draftTime = record.draftedAt || record.createdAt;
  if (draftTime) {
    append('draft', draftTime, {
      source: 'draft-record',
      sourceRecordId: recordId,
      verification: 'recorded',
      provider: null,
    });
  }

  if (record.openedAt) {
    append('opened', record.openedAt, {
      source: 'mail-client',
      sourceRecordId: recordId,
      verification: 'user-confirmed',
      provider: null,
    });
  } else if (statusLooksAtLeast(record.status, ['opened in mail client'])) {
    issues.push(
      issue(
        'outreach',
        record.id,
        'status-without-evidence',
        'The mail-client status has no openedAt timestamp.',
      ),
    );
  }

  if (record.verification === 'user-confirmed' && record.sentAt) {
    append('sent-confirmed', record.sentAt, {
      source: 'user',
      sourceRecordId: recordId,
      verification: 'user-confirmed',
      provider: null,
    });
  } else if (record.verification === 'provider-verified' && record.sentAt) {
    if (!record.threadId?.trim() || !record.provider?.trim()) {
      issues.push(
        issue(
          'outreach',
          record.id,
          'provider-id-missing',
          'Provider-verified send was ignored because provider and thread ids are required.',
        ),
      );
    } else {
      append('sent-provider', record.sentAt, {
        source: 'provider',
        sourceRecordId: recordId,
        verification: 'provider-verified',
        provider: {
          provider: record.provider,
          threadId: record.threadId,
          messageId: record.providerMessageId || null,
          eventId: null,
        },
      });
    }
  } else if (
    statusLooksAtLeast(record.status, [
      'sent',
      'delivered',
      'responded',
      'awaiting response',
    ]) &&
    record.verification !== 'preview-simulated'
  ) {
    issues.push(
      issue(
        'outreach',
        record.id,
        'status-without-evidence',
        'A sent-looking tracker status was not converted into an event because no send verification exists.',
      ),
    );
  }

  if (record.deliveryEvidence) {
    const delivery = record.deliveryEvidence;
    if (
      !delivery.provider?.trim() ||
      !delivery.threadId?.trim() ||
      !delivery.eventId?.trim()
    ) {
      issues.push(
        issue(
          'outreach',
          record.id,
          'provider-id-missing',
          'Delivery evidence requires provider, thread, and provider event ids.',
        ),
      );
    } else if (
      record.threadId?.trim() &&
      delivery.threadId.trim() !== record.threadId.trim()
    ) {
      issues.push(
        issue(
          'outreach',
          record.id,
          'provider-id-missing',
          'Delivery evidence belongs to a different provider thread and was not linked.',
        ),
      );
    } else {
      append('delivered', delivery.occurredAt, {
        source: 'provider',
        sourceRecordId: recordId,
        verification: 'provider-verified',
        provider: {
          provider: delivery.provider,
          threadId: delivery.threadId,
          messageId: delivery.messageId || null,
          eventId: delivery.eventId,
        },
      });
    }
  } else if (statusLooksAtLeast(record.status, ['delivered'])) {
    issues.push(
      issue(
        'outreach',
        record.id,
        'status-without-evidence',
        'Delivered status was not converted into an event without a provider delivery observation.',
      ),
    );
  }

  if (record.replyEvidence) {
    const reply = record.replyEvidence;
    if (
      reply.source === 'provider' &&
      (!reply.provider?.trim() ||
        !reply.threadId?.trim() ||
        !reply.eventId?.trim())
    ) {
      issues.push(
        issue(
          'outreach',
          record.id,
          'provider-id-missing',
          'Provider reply evidence requires provider, thread, and provider event ids.',
        ),
      );
    } else if (
      reply.source === 'provider' &&
      record.threadId?.trim() &&
      reply.threadId?.trim() !== record.threadId.trim()
    ) {
      issues.push(
        issue(
          'outreach',
          record.id,
          'provider-id-missing',
          'Reply evidence belongs to a different provider thread and was not linked.',
        ),
      );
    } else if (!reply.sourceRecordId?.trim()) {
      issues.push(
        issue(
          'outreach',
          record.id,
          'provider-id-missing',
          'Reply evidence requires its source record id.',
        ),
      );
    } else {
      append('replied', reply.occurredAt, {
        source: reply.source,
        sourceRecordId: normalizedId(reply.sourceRecordId),
        verification:
          reply.source === 'provider' ? 'provider-verified' : 'user-confirmed',
        provider:
          reply.source === 'provider'
            ? {
                provider: reply.provider as string,
                threadId: reply.threadId,
                messageId: reply.messageId || null,
                eventId: reply.eventId,
              }
            : null,
      });
    }
  } else if (
    record.responseReceived === true ||
    String(record.responseReceived || '').toLowerCase() === 'yes' ||
    statusLooksAtLeast(record.status, ['responded', 'replied'])
  ) {
    issues.push(
      issue(
        'outreach',
        record.id,
        'status-without-evidence',
        'Response status was not converted into a reply event without an explicit reply observation.',
      ),
    );
  }

  return { events, issues };
}

function linkedChain(params: {
  outreachId?: string | null;
  meetingId?: string | null;
  commitmentId?: string | null;
  threadId?: string | null;
  recordType: 'meeting' | 'commitment' | 'outcome';
  recordId: string;
  outreachChains: Set<string>;
  threadChains: Map<string, string>;
  meetingChains: Map<string, string>;
  commitmentChains: Map<string, string>;
}): string | null {
  if (params.outreachId) {
    const candidate = `outreach:${normalizedId(params.outreachId)}`;
    if (params.outreachChains.has(candidate)) return candidate;
  }
  if (params.threadId) {
    const candidate = params.threadChains.get(params.threadId.trim());
    if (candidate) return candidate;
  }
  if (params.meetingId) {
    const candidate = params.meetingChains.get(normalizedId(params.meetingId));
    if (candidate) return candidate;
  }
  if (params.commitmentId) {
    const candidate = params.commitmentChains.get(
      normalizedId(params.commitmentId),
    );
    if (candidate) return candidate;
  }
  return null;
}

export function buildCommunicationGraph(
  input: BuildCommunicationGraphInput,
): CommunicationGraph {
  const events: CommunicationEvent[] = [];
  const issues: CommunicationEvidenceIssue[] = [];
  const outreachChains = new Set<string>();
  const threadChains = new Map<string, string>();
  const meetingChains = new Map<string, string>();
  const commitmentChains = new Map<string, string>();

  const byRecordId = <T extends { id: string }>(records: T[] | undefined) =>
    [...(records || [])].sort(
      (a, b) =>
        normalizedId(a.id).localeCompare(normalizedId(b.id)) ||
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );

  for (const outreach of byRecordId(input.outreaches)) {
    const normalized = normalizeOutreach(outreach);
    events.push(...normalized.events);
    issues.push(...normalized.issues);
    const chainId = `outreach:${normalizedId(outreach.id)}`;
    outreachChains.add(chainId);
    for (const event of normalized.events) {
      const verifiedThread = event.provenance.provider?.threadId?.trim();
      if (verifiedThread) threadChains.set(verifiedThread, chainId);
    }
  }

  for (const meeting of byRecordId(input.meetings)) {
    const occurredAt = normalizedIso(meeting.occurredAt);
    if (!occurredAt) {
      issues.push(
        issue(
          'meeting',
          meeting.id,
          'invalid-timestamp',
          'Meeting was ignored because its occurrence time is invalid.',
        ),
      );
      continue;
    }
    const linked = linkedChain({
      ...meeting,
      recordType: 'meeting',
      recordId: meeting.id,
      outreachChains,
      threadChains,
      meetingChains,
      commitmentChains,
    });
    const chainId = linked || `meeting:${normalizedId(meeting.id)}`;
    if (!linked) {
      issues.push(
        issue(
          'meeting',
          meeting.id,
          'unlinked-record',
          'Meeting is preserved as a standalone event because no exact outreach or thread link exists.',
        ),
      );
    }
    meetingChains.set(normalizedId(meeting.id), chainId);
    const calendarVerified =
      meeting.source === 'calendar' &&
      Boolean(meeting.provider?.trim()) &&
      Boolean(meeting.providerEventId?.trim());
    if (meeting.source === 'calendar' && !calendarVerified) {
      issues.push(
        issue(
          'meeting',
          meeting.id,
          'provider-id-missing',
          'Calendar meeting is recorded, but not provider-verified because provider and event ids are missing.',
        ),
      );
    }
    events.push({
      id: eventId('meeting', meeting.id, 'meeting'),
      chainId,
      contactId: normalizedId(meeting.contactId),
      stage: 'meeting',
      occurredAt,
      channel: 'calendar',
      provenance: {
        source: meeting.source,
        sourceRecordId: normalizedId(meeting.id),
        verification:
          meeting.source === 'calendar'
            ? calendarVerified
              ? 'provider-verified'
              : 'recorded'
            : 'user-confirmed',
        provider:
          calendarVerified
            ? {
                provider: meeting.provider as string,
                threadId: meeting.threadId || null,
                messageId: null,
                eventId: meeting.providerEventId as string,
              }
            : null,
      },
      details: {},
    });
  }

  for (const commitment of byRecordId(input.commitments)) {
    if (commitment.reality !== 'real') {
      issues.push(
        issue(
          'commitment',
          commitment.id,
          'commitment-not-confirmed',
          commitment.reality === 'not-real'
            ? 'A user-marked false positive was excluded from the communication lifecycle.'
            : 'An extracted commitment was excluded until the user confirms it is real.',
        ),
      );
      continue;
    }
    const occurredAt = normalizedIso(commitment.occurredAt);
    if (!occurredAt) {
      issues.push(
        issue(
          'commitment',
          commitment.id,
          'invalid-timestamp',
          'Commitment was ignored because its occurrence time is invalid.',
        ),
      );
      continue;
    }
    const linked = linkedChain({
      ...commitment,
      recordType: 'commitment',
      recordId: commitment.id,
      outreachChains,
      threadChains,
      meetingChains,
      commitmentChains,
    });
    const chainId = linked || `commitment:${normalizedId(commitment.id)}`;
    if (!linked) {
      issues.push(
        issue(
          'commitment',
          commitment.id,
          'unlinked-record',
          'Commitment is preserved as standalone because no exact meeting or outreach link exists.',
        ),
      );
    }
    commitmentChains.set(normalizedId(commitment.id), chainId);
    events.push({
      id: eventId('commitment', commitment.id, 'commitment'),
      chainId,
      contactId: normalizedId(commitment.contactId),
      stage: 'commitment',
      occurredAt,
      channel: 'other',
      provenance: {
        source: 'commitment',
        sourceRecordId: normalizedId(commitment.sourceRecordId),
        verification: 'recorded',
        provider: null,
      },
      details: {
        commitmentReality: commitment.reality || 'unreviewed',
      },
    });
  }

  for (const outcome of byRecordId(input.outcomes)) {
    const occurredAt = normalizedIso(outcome.occurredAt);
    if (!occurredAt) {
      issues.push(
        issue(
          'outcome',
          outcome.id,
          'invalid-timestamp',
          'Outcome was ignored because its occurrence time is invalid.',
        ),
      );
      continue;
    }
    const linked = linkedChain({
      ...outcome,
      recordType: 'outcome',
      recordId: outcome.id,
      outreachChains,
      threadChains,
      meetingChains,
      commitmentChains,
    });
    const chainId = linked || `outcome:${normalizedId(outcome.id)}`;
    if (!linked) {
      issues.push(
        issue(
          'outcome',
          outcome.id,
          'unlinked-record',
          'Outcome is preserved as standalone because no exact commitment, meeting, or outreach link exists.',
        ),
      );
    }
    events.push({
      id: eventId('outcome', outcome.id, 'outcome'),
      chainId,
      contactId: normalizedId(outcome.contactId),
      stage: 'outcome',
      occurredAt,
      channel: 'other',
      provenance: {
        source: 'outcome',
        sourceRecordId: normalizedId(outcome.id),
        verification: 'user-confirmed',
        provider: null,
      },
      details: { outcome: outcome.outcome },
    });
  }

  events.sort(
    (a, b) =>
      Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
      (STAGE_ORDER.get(a.stage) || 0) - (STAGE_ORDER.get(b.stage) || 0) ||
      a.id.localeCompare(b.id),
  );

  const byChain = new Map<string, CommunicationEvent[]>();
  for (const event of events) {
    const list = byChain.get(event.chainId) || [];
    list.push(event);
    byChain.set(event.chainId, list);
  }

  const edges: CommunicationEdge[] = [];
  for (const [chainId, chainEvents] of byChain) {
    for (let index = 1; index < chainEvents.length; index += 1) {
      const from = chainEvents[index - 1];
      const to = chainEvents[index];
      edges.push({
        id: `${from.id}->${to.id}`,
        chainId,
        fromEventId: from.id,
        toEventId: to.id,
        elapsedMs: Date.parse(to.occurredAt) - Date.parse(from.occurredAt),
        explicitChain: true,
      });
    }
  }

  return {
    events,
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
    issues: issues.sort(
      (a, b) =>
        a.recordType.localeCompare(b.recordType) ||
        a.recordId.localeCompare(b.recordId) ||
        a.code.localeCompare(b.code) ||
        a.message.localeCompare(b.message),
    ),
  };
}

export interface TransitionTimingSummary {
  from: CommunicationStage;
  to: CommunicationStage;
  count: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
}

export interface CommunicationSegmentSummary {
  key: string;
  chains: number;
  evidencedSends: number;
  replies: number;
  meetings: number;
  commitments: number;
  outcomes: number;
  improvedOutcomes: number;
  replyRate: number | null;
  meetingRate: number | null;
  improvementRate: number | null;
}

export interface CommunicationSummary {
  stageCounts: Record<CommunicationStage, number>;
  providerVerifiedStageCounts: Record<CommunicationStage, number>;
  transitions: TransitionTimingSummary[];
  byContact: CommunicationSegmentSummary[];
  byChannel: CommunicationSegmentSummary[];
}

export type WordingFeature =
  | 'short'
  | 'medium'
  | 'long'
  | 'clear-ask'
  | 'no-clear-ask'
  | 'time-bound'
  | 'open-timing';

export interface WordingOutcomeSignal {
  feature: WordingFeature;
  evidencedSends: number;
  replies: number;
  replyRate: number | null;
}

export interface WordingOutcomeLearning {
  signals: WordingOutcomeSignal[];
  recommendation: string | null;
  minimumSampleSize: 3;
  privacyNote: string;
}

function wordingFeatures(record: OutreachLifecycleRecord): WordingFeature[] {
  const body = String(record.body || '').trim();
  const wordCount = body ? body.split(/\s+/).length : 0;
  const length: WordingFeature =
    wordCount <= 75 ? 'short' : wordCount <= 160 ? 'medium' : 'long';
  const clearAsk =
    /\?|(?:\b(?:could|can|would|will)\s+you\b)|(?:\b(?:let me know|are you available|does .* work)\b)/i.test(
      body,
    )
      ? 'clear-ask'
      : 'no-clear-ask';
  const timeBound =
    /\b(?:today|tomorrow|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|by \w+|at \d{1,2}(?::\d{2})?)\b/i.test(
      body,
    )
      ? 'time-bound'
      : 'open-timing';
  return [length, clearAsk, timeBound];
}

const WORDING_LABELS: Record<WordingFeature, string> = {
  short: 'short drafts (75 words or fewer)',
  medium: 'medium-length drafts (76–160 words)',
  long: 'long drafts (more than 160 words)',
  'clear-ask': 'drafts with a clear question or ask',
  'no-clear-ask': 'drafts without a clear ask',
  'time-bound': 'drafts with explicit timing',
  'open-timing': 'drafts with open-ended timing',
};

/**
 * Learns only coarse, deterministic wording features. Raw message text never
 * leaves this function, and rates remain hidden until each pattern has at
 * least three evidenced sends. The output is observational, not causal.
 */
export function analyzeWordingOutcomes(
  records: OutreachLifecycleRecord[],
  graph: CommunicationGraph,
): WordingOutcomeLearning {
  const repliedChains = new Set(
    graph.events
      .filter((event) => event.stage === 'replied')
      .map((event) => event.chainId),
  );
  const counts = new Map<WordingFeature, { sends: number; replies: number }>();

  for (const record of records) {
    const chainId = `outreach:${normalizedId(record.id)}`;
    const hasEvidencedSend = graph.events.some(
      (event) =>
        event.chainId === chainId &&
        (event.stage === 'sent-confirmed' ||
          event.stage === 'sent-provider'),
    );
    if (!hasEvidencedSend) continue;
    for (const feature of wordingFeatures(record)) {
      const current = counts.get(feature) || { sends: 0, replies: 0 };
      current.sends += 1;
      if (repliedChains.has(chainId)) current.replies += 1;
      counts.set(feature, current);
    }
  }

  const minimumSampleSize = 3 as const;
  const signals = ([...counts.entries()] as Array<
    [WordingFeature, { sends: number; replies: number }]
  >)
    .map(([feature, count]) => ({
      feature,
      evidencedSends: count.sends,
      replies: count.replies,
      replyRate:
        count.sends >= minimumSampleSize
          ? count.replies / count.sends
          : null,
    }))
    .sort(
      (left, right) =>
        (right.replyRate ?? -1) - (left.replyRate ?? -1) ||
        right.evidencedSends - left.evidencedSends ||
        left.feature.localeCompare(right.feature),
    );
  const best = signals.find((signal) => signal.replyRate != null);
  const recommendation = best
    ? `In your recorded history, ${WORDING_LABELS[best.feature]} had replies on ${best.replies} of ${best.evidencedSends} evidenced sends. Treat this as a personal pattern to test, not proof that the wording caused the reply.`
    : null;

  return {
    signals,
    recommendation,
    minimumSampleSize,
    privacyNote:
      'Computed locally from coarse length, ask, and timing features. No raw message text or cross-user data is used.',
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

interface ChainProjection {
  id: string;
  contactId: string;
  channel: CommunicationChannel;
  stages: Set<CommunicationStage>;
  outcome: 'improved' | 'unchanged' | 'worsened' | null;
}

function segmentSummary(
  projections: ChainProjection[],
  key: (projection: ChainProjection) => string,
): CommunicationSegmentSummary[] {
  const groups = new Map<string, ChainProjection[]>();
  for (const projection of projections) {
    const groupKey = key(projection);
    const list = groups.get(groupKey) || [];
    list.push(projection);
    groups.set(groupKey, list);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([groupKey, chains]) => {
      const evidencedSends = chains.filter(
        (chain) =>
          chain.stages.has('sent-provider') ||
          chain.stages.has('sent-confirmed'),
      ).length;
      const replies = chains.filter((chain) => chain.stages.has('replied')).length;
      const meetings = chains.filter((chain) => chain.stages.has('meeting')).length;
      const commitments = chains.filter((chain) =>
        chain.stages.has('commitment'),
      ).length;
      const outcomes = chains.filter((chain) => chain.stages.has('outcome')).length;
      const improvedOutcomes = chains.filter(
        (chain) => chain.outcome === 'improved',
      ).length;
      const sendToReplyConversions = chains.filter(
        (chain) =>
          (chain.stages.has('sent-provider') ||
            chain.stages.has('sent-confirmed')) &&
          chain.stages.has('replied'),
      ).length;
      const replyToMeetingConversions = chains.filter(
        (chain) =>
          chain.stages.has('replied') && chain.stages.has('meeting'),
      ).length;
      return {
        key: groupKey,
        chains: chains.length,
        evidencedSends,
        replies,
        meetings,
        commitments,
        outcomes,
        improvedOutcomes,
        replyRate:
          evidencedSends > 0 ? sendToReplyConversions / evidencedSends : null,
        meetingRate:
          replies > 0 ? replyToMeetingConversions / replies : null,
        improvementRate: outcomes > 0 ? improvedOutcomes / outcomes : null,
      };
    });
}

/**
 * Computes private, user-local conversion and timing summaries from the exact
 * graph. A missing denominator returns null, not a fabricated 0% rate.
 */
export function summarizeCommunicationGraph(
  graph: CommunicationGraph,
): CommunicationSummary {
  const stageCounts = Object.fromEntries(
    COMMUNICATION_STAGES.map((stage) => [stage, 0]),
  ) as Record<CommunicationStage, number>;
  const providerVerifiedStageCounts = { ...stageCounts };
  const byChain = new Map<string, CommunicationEvent[]>();

  for (const event of graph.events) {
    stageCounts[event.stage] += 1;
    if (event.provenance.verification === 'provider-verified') {
      providerVerifiedStageCounts[event.stage] += 1;
    }
    const list = byChain.get(event.chainId) || [];
    list.push(event);
    byChain.set(event.chainId, list);
  }

  const transitionTimes = new Map<string, number[]>();
  const projections: ChainProjection[] = [];
  for (const [chainId, chainEvents] of byChain) {
    const sorted = [...chainEvents].sort(
      (a, b) =>
        Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
        a.id.localeCompare(b.id),
    );
    for (let index = 1; index < sorted.length; index += 1) {
      const from = sorted[index - 1];
      const to = sorted[index];
      const elapsed = Date.parse(to.occurredAt) - Date.parse(from.occurredAt);
      if (elapsed < 0) continue;
      const key = `${from.stage}->${to.stage}`;
      const values = transitionTimes.get(key) || [];
      values.push(elapsed);
      transitionTimes.set(key, values);
    }
    const first = sorted[0];
    const firstOutreach = sorted.find((event) =>
      ['draft', 'opened', 'sent-confirmed', 'sent-provider', 'delivered', 'replied'].includes(
        event.stage,
      ),
    );
    const outcomeEvent = [...sorted]
      .reverse()
      .find((event) => event.stage === 'outcome');
    projections.push({
      id: chainId,
      contactId: first.contactId,
      channel: firstOutreach?.channel || first.channel,
      stages: new Set(sorted.map((event) => event.stage)),
      outcome: outcomeEvent?.details.outcome || null,
    });
  }

  const transitions = [...transitionTimes.entries()]
    .map(([key, values]) => {
      const [from, to] = key.split('->') as [
        CommunicationStage,
        CommunicationStage,
      ];
      return {
        from,
        to,
        count: values.length,
        medianMs: median(values),
        minMs: Math.min(...values),
        maxMs: Math.max(...values),
      };
    })
    .sort(
      (a, b) =>
        (STAGE_ORDER.get(a.from) || 0) - (STAGE_ORDER.get(b.from) || 0) ||
        (STAGE_ORDER.get(a.to) || 0) - (STAGE_ORDER.get(b.to) || 0),
    );

  return {
    stageCounts,
    providerVerifiedStageCounts,
    transitions,
    byContact: segmentSummary(projections, (projection) => projection.contactId),
    byChannel: segmentSummary(projections, (projection) => projection.channel),
  };
}
