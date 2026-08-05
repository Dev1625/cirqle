import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_COMMITMENT_FEEDBACK,
  createCommitmentFeedbackEvent,
  reduceCommitmentFeedbackEvents,
  type CommitmentFeedbackEvent,
} from '../src/lib/moat/commitmentFeedbackCore';
import {
  buildCommunicationGraph,
  summarizeCommunicationGraph,
  type BuildCommunicationGraphInput,
} from '../src/lib/moat/communicationGraph';
import {
  rankWarmIntroductionPaths,
  type IntroductionNode,
  type IntroductionRelationshipEdge,
} from '../src/lib/moat/introductionPaths';
import {
  createSourcePrivacyBoundary,
  filterGroundedSourcesForAI,
  filterSourcesForAI,
  normalizeSourcePrivacyPolicy,
  sourcesDueForDeletion,
  upsertSourcePrivacyBoundary,
  type PrivacyEvaluatedSource,
} from '../src/lib/moat/privacyPolicy';
import { factsToGroundedSources, type TemporalFact } from '../src/lib/factLedgerCore';

const uid = 'user-test-1';
const commitmentId = 'commitment-1';

function feedback(
  eventId: string,
  action: Parameters<typeof createCommitmentFeedbackEvent>[0]['action'],
  day: number,
): CommitmentFeedbackEvent {
  return createCommitmentFeedbackEvent({
    eventId,
    commitmentId,
    actorUid: uid,
    action,
    occurredAt: `2026-01-${String(day).padStart(2, '0')}T12:00:00.000Z`,
  });
}

test('commitment feedback preserves false-positive, dismissal, and outcome as distinct immutable events', () => {
  const events = [
    feedback(
      'event-outcome',
      {
        kind: 'relationship-outcome-recorded',
        outcome: 'unchanged',
        note: ' No relationship change. ',
      },
      4,
    ),
    feedback(
      'event-dismiss',
      {
        kind: 'dismissed',
        reason: 'false-positive',
        note: 'Model extracted a suggestion, not a promise.',
      },
      3,
    ),
    feedback(
      'event-reality',
      { kind: 'reality-reviewed', reality: 'not-real' },
      1,
    ),
    // Duplicate delivery/retry of the same immutable event id is ignored.
    feedback(
      'event-reality',
      { kind: 'reality-reviewed', reality: 'not-real' },
      1,
    ),
  ];

  const state = reduceCommitmentFeedbackEvents(events);
  assert.equal(state.reality, 'not-real');
  assert.equal(state.resolution, 'dismissed');
  assert.equal(state.dismissReason, 'false-positive');
  assert.equal(
    state.dismissNote,
    'Model extracted a suggestion, not a promise.',
  );
  assert.equal(state.relationshipOutcome, 'unchanged');
  assert.equal(state.relationshipOutcomeNote, 'No relationship change.');
  assert.equal(state.counters.events, 3);
  assert.equal(state.counters.markedNotReal, 1);
  assert.equal(state.counters.dismissed, 1);
  assert.equal(state.counters.outcomesRecorded, 1);
  assert.equal(state.lastEventId, 'event-outcome');
  assert.equal(EMPTY_COMMITMENT_FEEDBACK.counters.events, 0);
});

test('commitment feedback distinguishes snooze from complete and rejects past snoozes', () => {
  const snoozed = feedback(
    'event-snooze',
    { kind: 'snoozed', snoozedUntil: '2026-02-01T12:00:00.000Z' },
    2,
  );
  const completed = feedback('event-complete', { kind: 'completed' }, 5);
  const state = reduceCommitmentFeedbackEvents([completed, snoozed]);

  assert.equal(state.resolution, 'completed');
  assert.equal(state.snoozedUntil, null);
  assert.equal(state.counters.snoozed, 1);
  assert.equal(state.counters.completed, 1);
  assert.throws(
    () =>
      feedback(
        'event-invalid-snooze',
        { kind: 'snoozed', snoozedUntil: '2025-12-01T12:00:00.000Z' },
        2,
      ),
    /future/,
  );
});

test('misleading tracker statuses never become sent, delivered, or replied events', () => {
  const graph = buildCommunicationGraph({
    outreaches: [
      {
        id: 'misleading-outreach',
        contactId: 'contact-a',
        createdAt: '2026-03-01T10:00:00.000Z',
        sentAt: '2026-03-01T10:05:00.000Z',
        status: 'Delivered',
        verification: 'none',
        responseReceived: 'Yes',
      },
    ],
  });

  assert.deepEqual(
    graph.events.map((event) => event.stage),
    ['draft'],
  );
  assert.ok(
    graph.issues.filter((item) => item.code === 'status-without-evidence')
      .length >= 3,
  );
  const summary = summarizeCommunicationGraph(graph);
  assert.equal(summary.stageCounts['sent-confirmed'], 0);
  assert.equal(summary.stageCounts['sent-provider'], 0);
  assert.equal(summary.stageCounts.delivered, 0);
  assert.equal(summary.stageCounts.replied, 0);
  assert.equal(summary.byContact[0].replyRate, null);
});

test('a user-confirmed send stays distinct from provider-verified delivery', () => {
  const graph = buildCommunicationGraph({
    outreaches: [
      {
        id: 'manual-send',
        contactId: 'contact-manual',
        createdAt: '2026-03-01T10:00:00.000Z',
        openedAt: '2026-03-01T10:01:00.000Z',
        sentAt: '2026-03-01T10:02:00.000Z',
        status: 'Sent (User Confirmed)',
        verification: 'user-confirmed',
      },
    ],
  });
  assert.deepEqual(
    graph.events.map((event) => event.stage),
    ['draft', 'opened', 'sent-confirmed'],
  );
  const summary = summarizeCommunicationGraph(graph);
  assert.equal(summary.stageCounts['sent-confirmed'], 1);
  assert.equal(summary.providerVerifiedStageCounts['sent-confirmed'], 0);
  assert.equal(summary.stageCounts.delivered, 0);
});

test('provider observations from a different thread are rejected', () => {
  const graph = buildCommunicationGraph({
    outreaches: [
      {
        id: 'thread-mismatch',
        contactId: 'contact-a',
        createdAt: '2026-03-01T10:00:00.000Z',
        sentAt: '2026-03-01T10:01:00.000Z',
        status: 'Delivered',
        verification: 'provider-verified',
        provider: 'gmail',
        threadId: 'thread-a',
        deliveryEvidence: {
          occurredAt: '2026-03-01T10:02:00.000Z',
          provider: 'gmail',
          threadId: 'thread-b',
          eventId: 'delivery-b',
        },
      },
    ],
  });
  assert.deepEqual(
    graph.events.map((event) => event.stage),
    ['draft', 'sent-provider'],
  );
  assert.ok(
    graph.issues.some((item) =>
      item.message.includes('different provider thread'),
    ),
  );
});

test('conversion rates never join unrelated send and reply chains for one contact', () => {
  const graph = buildCommunicationGraph({
    outreaches: [
      {
        id: 'send-only',
        contactId: 'same-contact',
        createdAt: '2026-03-01T10:00:00.000Z',
        sentAt: '2026-03-01T10:01:00.000Z',
        verification: 'user-confirmed',
      },
      {
        id: 'reply-only',
        contactId: 'same-contact',
        createdAt: '2026-03-02T10:00:00.000Z',
        replyEvidence: {
          occurredAt: '2026-03-02T10:01:00.000Z',
          source: 'user',
          sourceRecordId: 'pasted-reply',
        },
      },
    ],
  });
  const summary = summarizeCommunicationGraph(graph);
  assert.equal(summary.byContact[0].evidencedSends, 1);
  assert.equal(summary.byContact[0].replies, 1);
  assert.equal(summary.byContact[0].replyRate, 0);
});

const verifiedLifecycle: BuildCommunicationGraphInput = {
  outreaches: [
    {
      id: 'outreach-1',
      contactId: 'contact-a',
      channel: 'email',
      createdAt: '2026-03-01T10:00:00.000Z',
      sentAt: '2026-03-01T10:05:00.000Z',
      status: 'Responded',
      verification: 'provider-verified',
      provider: 'gmail',
      threadId: 'thread-verified-1',
      providerMessageId: 'message-sent-1',
      deliveryEvidence: {
        occurredAt: '2026-03-01T10:06:00.000Z',
        provider: 'gmail',
        threadId: 'thread-verified-1',
        messageId: 'message-sent-1',
        eventId: 'gmail-delivery-event-1',
      },
      replyEvidence: {
        occurredAt: '2026-03-02T10:05:00.000Z',
        source: 'provider',
        sourceRecordId: 'reply-record-1',
        provider: 'gmail',
        threadId: 'thread-verified-1',
        messageId: 'message-reply-1',
        eventId: 'gmail-reply-event-1',
      },
    },
  ],
  meetings: [
    {
      id: 'meeting-1',
      contactId: 'contact-a',
      occurredAt: '2026-03-05T15:00:00.000Z',
      source: 'calendar',
      outreachId: 'outreach-1',
      provider: 'google-calendar',
      providerEventId: 'calendar-event-1',
    },
  ],
  commitments: [
    {
      id: 'commitment-real',
      contactId: 'contact-a',
      occurredAt: '2026-03-05T15:30:00.000Z',
      sourceRecordId: 'meeting-1',
      meetingId: 'meeting-1',
      reality: 'real',
    },
    {
      id: 'commitment-false',
      contactId: 'contact-a',
      occurredAt: '2026-03-05T15:35:00.000Z',
      sourceRecordId: 'meeting-1',
      meetingId: 'meeting-1',
      reality: 'not-real',
    },
  ],
  outcomes: [
    {
      id: 'outcome-1',
      contactId: 'contact-a',
      occurredAt: '2026-03-08T12:00:00.000Z',
      outcome: 'improved',
      commitmentId: 'commitment-real',
    },
  ],
};

test('verified communication lifecycle preserves provider ids and excludes false commitments', () => {
  const graph = buildCommunicationGraph(verifiedLifecycle);
  assert.deepEqual(
    graph.events.map((event) => event.stage),
    [
      'draft',
      'sent-provider',
      'delivered',
      'replied',
      'meeting',
      'commitment',
      'outcome',
    ],
  );
  const delivered = graph.events.find((event) => event.stage === 'delivered');
  assert.equal(
    delivered?.provenance.provider?.eventId,
    'gmail-delivery-event-1',
  );
  assert.equal(
    delivered?.provenance.provider?.threadId,
    'thread-verified-1',
  );
  assert.ok(
    graph.issues.some(
      (item) =>
        item.recordId === 'commitment-false' &&
        item.code === 'commitment-not-confirmed',
    ),
  );

  const summary = summarizeCommunicationGraph(graph);
  assert.equal(summary.stageCounts.commitment, 1);
  assert.equal(summary.providerVerifiedStageCounts['sent-provider'], 1);
  assert.equal(summary.providerVerifiedStageCounts.delivered, 1);
  assert.equal(summary.providerVerifiedStageCounts.replied, 1);
  assert.equal(summary.byContact[0].replyRate, 1);
  assert.equal(summary.byContact[0].meetingRate, 1);
  assert.equal(summary.byContact[0].improvementRate, 1);
});

test('communication graph output is deterministic regardless of input collection order', () => {
  const first = buildCommunicationGraph(verifiedLifecycle);
  const second = buildCommunicationGraph({
    outreaches: [...(verifiedLifecycle.outreaches || [])].reverse(),
    meetings: [...(verifiedLifecycle.meetings || [])].reverse(),
    commitments: [...(verifiedLifecycle.commitments || [])].reverse(),
    outcomes: [...(verifiedLifecycle.outcomes || [])].reverse(),
  });
  assert.deepEqual(second, first);
  assert.deepEqual(
    summarizeCommunicationGraph(second),
    summarizeCommunicationGraph(first),
  );
});

const introNodes: IntroductionNode[] = [
  { id: 'me', label: 'You' },
  { id: 'stale', label: 'Stale Strong Contact' },
  { id: 'fresh', label: 'Fresh Willing Contact' },
  { id: 'blocked', label: 'Conflicted Contact' },
  { id: 'target', label: 'Target Person' },
];

const introEdges: IntroductionRelationshipEdge[] = [
  {
    id: 'me-stale',
    fromId: 'me',
    toId: 'stale',
    strength: 0.95,
    willingness: 'reluctant',
    lastInteractionAt: '2024-01-01T00:00:00.000Z',
    activeIntroductionRequests: 3,
    introductionCapacity: 3,
    introductionRequestsLast90Days: 5,
    lastIntroductionRequestAt: '2026-06-29T00:00:00.000Z',
    provenance: {
      sourceType: 'meeting',
      sourceId: 'old-meeting',
      observedAt: '2024-01-01T00:00:00.000Z',
    },
  },
  {
    id: 'stale-target',
    fromId: 'stale',
    toId: 'target',
    strength: 0.96,
    willingness: 'unknown',
    lastInteractionAt: '2024-02-01T00:00:00.000Z',
    activeIntroductionRequests: 2,
    introductionCapacity: 2,
    introductionRequestsLast90Days: 4,
    lastIntroductionRequestAt: '2026-07-25T00:00:00.000Z',
    provenance: {
      sourceType: 'profile',
      sourceId: 'stale-profile-edge',
      observedAt: '2024-02-01T00:00:00.000Z',
    },
  },
  {
    id: 'me-fresh',
    fromId: 'me',
    toId: 'fresh',
    strength: 0.78,
    willingness: 'yes',
    lastInteractionAt: '2026-07-20T00:00:00.000Z',
    activeIntroductionRequests: 0,
    introductionCapacity: 3,
    introductionRequestsLast90Days: 0,
    provenance: {
      sourceType: 'meeting',
      sourceId: 'fresh-meeting',
      observedAt: '2026-07-20T00:00:00.000Z',
    },
  },
  {
    id: 'fresh-target',
    fromId: 'fresh',
    toId: 'target',
    strength: 0.8,
    willingness: 'likely',
    lastInteractionAt: '2026-07-18T00:00:00.000Z',
    activeIntroductionRequests: 0,
    introductionCapacity: 3,
    introductionRequestsLast90Days: 1,
    lastIntroductionRequestAt: '2026-05-01T00:00:00.000Z',
    provenance: {
      sourceType: 'note',
      sourceId: 'note-fresh-target',
      observedAt: '2026-07-18T00:00:00.000Z',
    },
    mutualContext: {
      text: 'Both worked on the Atlas recruiting initiative.',
      sourceType: 'note',
      sourceId: 'note-atlas-context',
    },
  },
  {
    id: 'me-blocked',
    fromId: 'me',
    toId: 'blocked',
    strength: 1,
    willingness: 'yes',
    lastInteractionAt: '2026-07-28T00:00:00.000Z',
    conflicts: [
      {
        id: 'conflict-1',
        label: 'Explicit do-not-introduce boundary',
        severity: 'block',
      },
    ],
    provenance: {
      sourceType: 'user-correction',
      sourceId: 'boundary-1',
      observedAt: '2026-07-28T00:00:00.000Z',
    },
  },
  {
    id: 'blocked-target',
    fromId: 'blocked',
    toId: 'target',
    strength: 1,
    willingness: 'yes',
    lastInteractionAt: '2026-07-28T00:00:00.000Z',
    provenance: {
      sourceType: 'profile',
      sourceId: 'blocked-target-profile',
      observedAt: '2026-07-28T00:00:00.000Z',
    },
  },
];

test('warm-path ranking favors fresh willing low-fatigue path and explains exact edges', () => {
  const result = rankWarmIntroductionPaths({
    nodes: introNodes,
    edges: introEdges,
    startId: 'me',
    targetId: 'target',
    now: '2026-07-29T00:00:00.000Z',
  });

  assert.deepEqual(result.paths[0].nodeIds, ['me', 'fresh', 'target']);
  assert.ok(result.paths[0].score > result.paths[1].score);
  assert.match(result.paths[0].explanation, /Fresh Willing Contact/);
  assert.match(result.paths[0].explanation, /note · note-fresh-target/);
  assert.match(result.paths[0].explanation, /willingness likely/);
  assert.match(
    result.paths[0].explanation,
    /Atlas recruiting initiative.*note · note-atlas-context/,
  );
  assert.ok(
    result.excludedEdges.some(
      (edge) =>
        edge.edgeId === 'me-blocked' &&
        edge.reasons.some((reason) => reason.includes('do-not-introduce')),
    ),
  );
});

test('warm-path ranking is deterministic', () => {
  const params = {
    nodes: introNodes,
    edges: introEdges,
    startId: 'me',
    targetId: 'target',
    now: '2026-07-29T00:00:00.000Z',
  };
  const first = rankWarmIntroductionPaths(params);
  const second = rankWarmIntroductionPaths({
    ...params,
    edges: [...introEdges].reverse(),
  });
  assert.deepEqual(second, first);
});

test('privacy policy excludes never-AI, expired, exact-source, and undated finite-retention sources', () => {
  let policy = normalizeSourcePrivacyPolicy(null);
  policy = upsertSourcePrivacyBoundary(
    policy,
    createSourcePrivacyBoundary({
      sourceType: 'note',
      aiUse: 'never',
    }),
  );
  policy = upsertSourcePrivacyBoundary(
    policy,
    createSourcePrivacyBoundary({
      sourceType: 'email',
      retentionMode: 'days',
      retentionDays: 30,
    }),
  );
  policy = upsertSourcePrivacyBoundary(
    policy,
    createSourcePrivacyBoundary({
      sourceType: 'profile',
      sourceId: 'private-profile-field',
      aiUse: 'never',
    }),
  );

  const sources: PrivacyEvaluatedSource[] = [
    {
      id: 'note-fresh',
      sourceType: 'note',
      observedAt: '2026-07-28T00:00:00.000Z',
    },
    {
      id: 'email-old',
      sourceType: 'email',
      observedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'email-undated',
      sourceType: 'email',
      observedAt: null,
    },
    {
      id: 'private-profile-field',
      sourceType: 'profile',
      observedAt: '2026-07-28T00:00:00.000Z',
    },
    {
      id: 'meeting-allowed',
      sourceType: 'meeting',
      observedAt: '2026-07-28T00:00:00.000Z',
    },
  ];
  const result = filterSourcesForAI(
    sources,
    policy,
    '2026-07-29T00:00:00.000Z',
  );

  assert.deepEqual(
    result.allowed.map((source) => source.id),
    ['meeting-allowed'],
  );
  assert.deepEqual(
    result.excluded.map((item) => [
      item.source.id,
      item.decision.reasons,
      item.decision.retained,
    ]),
    [
      ['note-fresh', ['never-use-in-ai'], true],
      ['email-old', ['retention-expired'], false],
      ['email-undated', ['observed-at-missing'], true],
      ['private-profile-field', ['never-use-in-ai'], true],
    ],
  );
  assert.deepEqual(
    sourcesDueForDeletion(
      sources,
      policy,
      '2026-07-29T00:00:00.000Z',
    ).map((item) => item.source.id),
    ['email-old'],
  );
});

test('grounded evidence filtering applies the same never-use-in-AI boundary before generation', () => {
  const policy = upsertSourcePrivacyBoundary(
    normalizeSourcePrivacyPolicy(null),
    createSourcePrivacyBoundary({
      sourceType: 'note',
      aiUse: 'never',
    }),
  );
  const result = filterGroundedSourcesForAI(
    [
      {
        id: 'note-secret',
        kind: 'note',
        label: 'Private note',
        text: 'Sensitive material',
        observedAt: '2026-07-28T00:00:00.000Z',
      },
      {
        id: 'meeting-safe',
        kind: 'meeting',
        label: 'Meeting',
        text: 'Approved evidence',
        observedAt: '2026-07-28T00:00:00.000Z',
      },
    ],
    policy,
    '2026-07-29T00:00:00.000Z',
  );
  assert.deepEqual(
    result.allowed.map((source) => source.id),
    ['meeting-safe'],
  );
  assert.equal(result.excluded[0].source.id, 'note-secret');
  assert.deepEqual(result.excluded[0].decision.reasons, ['never-use-in-ai']);
});

test('derived note, import, and voice facts retain their privacy boundary', () => {
  let policy = normalizeSourcePrivacyPolicy(null);
  for (const sourceType of ['note', 'import', 'voice'] as const) {
    policy = upsertSourcePrivacyBoundary(
      policy,
      createSourcePrivacyBoundary({
        sourceType,
        aiUse: 'never',
      }),
    );
  }
  const facts: TemporalFact[] = (
    ['note', 'import', 'voice'] as const
  ).map((sourceType, index) => ({
    id: `${sourceType}-fact`,
    predicate: 'identity.context',
    value: `private ${sourceType} value`,
    normalizedValue: `private ${sourceType} value`,
    sourceType,
    sourceId: `${sourceType}-source-${index}`,
    observedAt: new Date('2026-07-28T00:00:00.000Z'),
    confidence: 1,
    current: true,
    aiAllowed: true,
    correctionOf: null,
    supersededBy: null,
    createdAt: new Date('2026-07-28T00:00:00.000Z'),
    updatedAt: new Date('2026-07-28T00:00:00.000Z'),
  }));
  const result = filterGroundedSourcesForAI(
    factsToGroundedSources('contact-1', facts),
    policy,
    '2026-07-29T00:00:00.000Z',
  );
  assert.deepEqual(result.allowed, []);
  assert.deepEqual(
    result.excluded.map((item) => [
      item.source.id,
      item.decision.sourceType,
      item.decision.sourceId,
    ]),
    [
      ['fact-note-fact', 'note', 'note-source-0'],
      ['fact-import-fact', 'import', 'import-source-1'],
      ['fact-voice-fact', 'voice', 'voice-source-2'],
    ],
  );
});

test('privacy policy normalization is deterministic and fails closed for a corrupt finite default', () => {
  const boundaries = [
    createSourcePrivacyBoundary({
      sourceType: 'voice',
      aiUse: 'never',
    }),
    createSourcePrivacyBoundary({
      sourceType: 'email',
      retentionMode: 'days',
      retentionDays: 90,
    }),
  ];
  const first = normalizeSourcePrivacyPolicy({
    schemaVersion: 1,
    defaultRetentionMode: 'forever',
    defaultRetentionDays: null,
    defaultAIUse: 'allow',
    boundaries,
  });
  const second = normalizeSourcePrivacyPolicy({
    schemaVersion: 1,
    defaultRetentionMode: 'forever',
    defaultRetentionDays: null,
    defaultAIUse: 'allow',
    boundaries: [...boundaries].reverse(),
  });
  assert.deepEqual(second, first);

  const corrupted = normalizeSourcePrivacyPolicy({
    schemaVersion: 1,
    defaultRetentionMode: 'days',
    defaultRetentionDays: null,
    defaultAIUse: 'allow',
    boundaries: [],
  });
  assert.equal(corrupted.defaultRetentionMode, 'days');
  assert.equal(corrupted.defaultRetentionDays, 30);
});
