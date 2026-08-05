import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentReference, WriteBatch } from 'firebase/firestore';

import { factsToGroundedSources, type TemporalFact } from '../src/lib/factLedgerCore';
import {
  createSourcePrivacyBoundary,
  filterGroundedSourcesForAI,
  normalizeSourcePrivacyPolicy,
  upsertSourcePrivacyBoundary,
} from '../src/lib/moat/privacyPolicy';
import { queueSourceFacts } from '../src/lib/sourceFacts';
import {
  MAX_SOURCE_FACTS_PER_RECORD,
  meetingSourceFacts,
  noteSourceFacts,
  PROFILE_FACT_PREDICATES,
  profileFactDraft,
  profileSourceFacts,
  sourceFactDocumentId,
  voiceSourceFacts,
} from '../src/lib/sourceFactsCore';

interface CapturedFactWrite {
  reference: DocumentReference;
  data: Record<string, unknown>;
}

function captureQueuedFacts(input: Parameters<typeof queueSourceFacts>[1]) {
  const writes: CapturedFactWrite[] = [];
  const batch = {
    set(
      reference: DocumentReference,
      data: Record<string, unknown>,
    ) {
      writes.push({ reference, data });
      return this;
    },
  } as unknown as WriteBatch;

  const ids = queueSourceFacts(batch, input);
  return { ids, writes };
}

test('profile source facts preserve explicit imported fields without inventing values', () => {
  const facts = profileSourceFacts({
    name: '  Maya   Chen ',
    email: 'maya@example.com',
    company: 'Cirqle',
    role: '',
    tags: ['Investor', ' New York ', '', 42],
  });

  assert.deepEqual(
    facts.map(({ predicate, value }) => [predicate, value]),
    [
      ['identity.name', 'Maya Chen'],
      ['identity.email', 'maya@example.com'],
      ['identity.company', 'Cirqle'],
      ['relationship.tags', 'Investor, New York'],
    ],
  );
  assert.ok(facts.length <= MAX_SOURCE_FACTS_PER_RECORD);
});

test('profile fact drafts cover every editable field and normalize tag provenance', () => {
  const values: Record<string, unknown> = {
    name: 'Maya Chen',
    email: 'maya@example.com',
    phone: '+1 212 555 0100',
    company: 'Cirqle',
    role: 'Founder',
    location: 'New York',
    linkedinUrl: 'https://www.linkedin.com/in/maya',
    relationshipTier: 'Strong',
    whyTheyMatter: 'Trusted collaborator',
    summary: 'Met through the founder community',
    industry: 'Software',
    subIndustry: 'Relationship intelligence',
    school: 'NYU',
    seniority: 'Founder',
    connectionSource: 'Demo Day',
    tags: [' Investor ', '', 'New   York', 42],
  };

  assert.deepEqual(
    Object.keys(PROFILE_FACT_PREDICATES).sort(),
    Object.keys(values).sort(),
  );
  for (const [field, predicate] of Object.entries(PROFILE_FACT_PREDICATES)) {
    const draft = profileFactDraft(field, values[field]);
    assert.ok(draft, `${field} should create a fact`);
    assert.equal(draft.predicate, predicate);
    assert.equal(draft.confidence, 1);
  }
  assert.deepEqual(profileFactDraft('tags', values.tags), {
    predicate: 'relationship.tags',
    value: 'Investor, New York',
    confidence: 1,
  });
  assert.equal(profileFactDraft('tags', []), null);
  assert.equal(profileFactDraft('unknownField', 'value'), null);
});

test('note and voice facts remove control characters and remain bounded', () => {
  const note = noteSourceFacts(`  met\u0000 at the conference   today  `);
  assert.deepEqual(note, [
    {
      predicate: 'relationship.note',
      value: 'met at the conference today',
      confidence: 1,
    },
  ]);

  const voice = voiceSourceFacts('follow up next week', 'Coffee chat');
  assert.deepEqual(
    voice.map(({ predicate, value }) => [predicate, value]),
    [
      ['relationship.voiceMemo', 'follow up next week'],
      ['meeting.title', 'Coffee chat'],
    ],
  );
});

test('meeting facts record only the fields the user explicitly supplied', () => {
  assert.deepEqual(
    meetingSourceFacts({
      date: '2026-07-29',
      discussed: 'Fundraising',
      promised: ' ',
      nextSteps: 'Send deck',
    }).map(({ predicate, value }) => [predicate, value]),
    [
      ['meeting.date', '2026-07-29'],
      ['meeting.discussed', 'Fundraising'],
      ['meeting.nextSteps', 'Send deck'],
    ],
  );
});

test('source fact ids are deterministic, source-scoped, and path safe', () => {
  const first = sourceFactDocumentId({
    sourceType: 'note',
    sourceId: 'note/with unsafe text',
    predicate: 'relationship.note',
  });
  const replay = sourceFactDocumentId({
    sourceType: 'note',
    sourceId: 'note/with unsafe text',
    predicate: 'relationship.note',
  });
  const different = sourceFactDocumentId({
    sourceType: 'voice',
    sourceId: 'note/with unsafe text',
    predicate: 'relationship.note',
  });

  assert.equal(replay, first);
  assert.notEqual(different, first);
  assert.doesNotMatch(first, /\//);
  assert.match(first, /^note-[a-f0-9]{16}$/);
});

test('note, meeting, import, and voice writes use exact immutable fact shapes', () => {
  const observedAt = new Date('2026-07-29T14:30:00.000Z');
  const cases = [
    {
      sourceType: 'note' as const,
      sourceId: 'note-record-1',
      facts: noteSourceFacts(' Met at Demo Day '),
      predicates: ['relationship.note'],
    },
    {
      sourceType: 'meeting' as const,
      sourceId: 'meeting-record-1',
      facts: meetingSourceFacts({
        date: '2026-07-29',
        discussed: 'Fundraising',
        promised: 'Send the deck',
        nextSteps: 'Reconnect Friday',
      }),
      predicates: [
        'meeting.date',
        'meeting.discussed',
        'meeting.promised',
        'meeting.nextSteps',
      ],
    },
    {
      sourceType: 'import' as const,
      sourceId: 'csv:contact-1:row-1',
      facts: profileSourceFacts({
        name: 'Maya Chen',
        email: 'Maya@Example.com',
        company: 'Cirqle',
      }),
      predicates: ['identity.name', 'identity.email', 'identity.company'],
    },
    {
      sourceType: 'voice' as const,
      sourceId: 'voice-record-1',
      facts: voiceSourceFacts(' Follow up NEXT week ', 'Coffee chat'),
      predicates: ['relationship.voiceMemo', 'meeting.title'],
    },
  ];

  for (const source of cases) {
    const { ids, writes } = captureQueuedFacts({
      uid: 'owner-uid',
      contactId: 'contact-1',
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      observedAt,
      facts: source.facts,
      aiAllowed: false,
    });

    assert.deepEqual(
      writes.map(({ data }) => data.predicate),
      source.predicates,
    );
    assert.deepEqual(
      ids,
      writes.map(({ reference }) => reference.id),
    );
    assert.equal(new Set(ids).size, ids.length);

    for (const { reference, data } of writes) {
      assert.equal(
        reference.path,
        `users/owner-uid/contacts/contact-1/facts/${reference.id}`,
      );
      assert.deepEqual(Object.keys(data).sort(), [
        'aiAllowed',
        'confidence',
        'correctionOf',
        'createdAt',
        'current',
        'normalizedValue',
        'observedAt',
        'predicate',
        'sourceId',
        'sourceType',
        'supersededBy',
        'updatedAt',
        'value',
      ]);
      assert.equal(data.sourceType, source.sourceType);
      assert.equal(data.sourceId, source.sourceId);
      assert.equal(data.observedAt, observedAt);
      assert.equal(data.confidence, 1);
      assert.equal(data.current, true);
      assert.equal(data.aiAllowed, false);
      assert.equal(data.correctionOf, null);
      assert.equal(data.supersededBy, null);
      assert.ok(data.createdAt);
      assert.ok(data.updatedAt);
      assert.equal(
        data.normalizedValue,
        String(data.value).trim().replace(/\s+/g, ' ').toLocaleLowerCase(),
      );
    }
  }
});

test('queued fact IDs are stable across retries and isolated by source provenance', () => {
  const input = {
    uid: 'owner-uid',
    contactId: 'contact-1',
    sourceType: 'note' as const,
    sourceId: 'note-record-1',
    observedAt: new Date('2026-07-29T14:30:00.000Z'),
    facts: noteSourceFacts('Met at Demo Day'),
  };
  const first = captureQueuedFacts(input);
  const replay = captureQueuedFacts(input);
  const otherSource = captureQueuedFacts({
    ...input,
    sourceId: 'note-record-2',
  });

  assert.deepEqual(replay.ids, first.ids);
  assert.deepEqual(
    replay.writes.map(({ reference }) => reference.path),
    first.writes.map(({ reference }) => reference.path),
  );
  assert.notDeepEqual(otherSource.ids, first.ids);
});

test('derived source facts preserve exact privacy provenance for AI filtering', () => {
  const observedAt = new Date('2026-07-29T14:30:00.000Z');
  const cases = [
    {
      sourceType: 'note' as const,
      sourceId: 'note-private',
      facts: noteSourceFacts('Private note'),
    },
    {
      sourceType: 'meeting' as const,
      sourceId: 'meeting-private',
      facts: meetingSourceFacts({ discussed: 'Private meeting' }),
    },
    {
      sourceType: 'import' as const,
      sourceId: 'import-private',
      facts: profileSourceFacts({ company: 'Private import' }),
    },
    {
      sourceType: 'voice' as const,
      sourceId: 'voice-private',
      facts: voiceSourceFacts('Private voice memo'),
    },
  ];
  const temporalFacts: TemporalFact[] = cases.flatMap((source) => {
    const { writes } = captureQueuedFacts({
      uid: 'owner-uid',
      contactId: 'contact-1',
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      observedAt,
      facts: source.facts,
    });
    return writes.map(({ reference, data }) => ({
      id: reference.id,
      predicate: String(data.predicate),
      value: String(data.value),
      normalizedValue: String(data.normalizedValue),
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      observedAt,
      confidence: Number(data.confidence),
      current: true,
      aiAllowed: true,
      correctionOf: null,
      supersededBy: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));
  });

  let policy = normalizeSourcePrivacyPolicy(null);
  for (const source of cases) {
    policy = upsertSourcePrivacyBoundary(
      policy,
      createSourcePrivacyBoundary({
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        aiUse: 'never',
      }),
    );
  }

  const grounded = factsToGroundedSources('contact-1', temporalFacts);
  assert.deepEqual(
    grounded.map((source) => [
      source.privacySourceType,
      source.privacySourceId,
    ]),
    temporalFacts.map((fact) => [fact.sourceType, fact.sourceId]),
  );

  const filtered = filterGroundedSourcesForAI(
    grounded,
    policy,
    '2026-07-29T15:00:00.000Z',
  );
  assert.deepEqual(filtered.allowed, []);
  assert.deepEqual(
    filtered.excluded.map(({ decision }) => [
      decision.sourceType,
      decision.sourceId,
      decision.boundaryId,
      decision.reasons,
    ]),
    temporalFacts.map((fact) => [
      fact.sourceType,
      fact.sourceId,
      `source:${fact.sourceType}:${fact.sourceId}`,
      ['never-use-in-ai'],
    ]),
  );
});
