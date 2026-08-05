import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTACT_RECOVERY_WINDOW_DAYS,
  ContactProfileValidationError,
  UnresolvedContactMergeError,
  analyzeContactMerge,
  buildMailtoUrl,
  buildPermanentPurgePlan,
  contactFactsForAI,
  detectDuplicate,
  findDuplicateCandidates,
  isContactAIEligible,
  isContactPurgeEligible,
  localDateFromISODate,
  managedContactFromRecord,
  nextContactLifecycle,
  normalizeCompanyName,
  normalizeEmail,
  normalizeHttpsUrl,
  normalizePersonName,
  planContactReferenceMigration,
  planJobHistoryChange,
  resolveContactMerge,
  sanitizeContactProfile,
  type ContactProfile,
  type JobHistoryEntry,
} from '../src/lib/contactManagementCore';
import type { TemporalFact } from '../src/lib/factLedgerCore';

const profile = (overrides: Partial<ContactProfile> = {}): ContactProfile => ({
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '',
  company: 'Analytical Engines',
  role: 'Founder',
  location: 'London',
  linkedinUrl: 'https://www.linkedin.com/in/ada',
  summary: '',
  relationshipTier: 'Warm',
  industry: 'Technology',
  subIndustry: '',
  school: '',
  seniority: 'Founder',
  connectionSource: 'Conference',
  whyTheyMatter: '',
  tags: ['Founder'],
  ...overrides,
});

const fact = (
  id: string,
  overrides: Partial<TemporalFact> = {},
): TemporalFact => ({
  id,
  predicate: 'identity.company',
  value: 'Analytical Engines',
  normalizedValue: 'analytical engines',
  sourceType: 'profile',
  sourceId: 'contact-1',
  observedAt: new Date('2026-07-01T00:00:00Z'),
  confidence: 1,
  current: true,
  aiAllowed: true,
  correctionOf: null,
  supersededBy: null,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
  ...overrides,
});

test('normalizes identity keys conservatively and rejects invalid email keys', () => {
  assert.equal(normalizeEmail('  ADA@Example.COM '), 'ada@example.com');
  assert.equal(normalizeEmail('not-an-email'), '');
  assert.equal(normalizePersonName(' Ada   Lovelace '), 'ada lovelace');
  assert.equal(normalizeCompanyName('Acme, Inc.'), 'acme inc');
  assert.notEqual(
    normalizeCompanyName('Acme'),
    normalizeCompanyName('Acme Ventures'),
  );
});

test('keeps date-only form values on the selected local calendar day', () => {
  const parsed = localDateFromISODate('2026-07-29');
  assert.ok(parsed);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 6);
  assert.equal(parsed.getDate(), 29);
  assert.equal(parsed.getHours(), 12);
  assert.equal(localDateFromISODate('2026-02-29'), null);
  assert.ok(localDateFromISODate('2028-02-29'));
  assert.equal(localDateFromISODate('2026-07-29T00:00:00Z'), null);
});

test('rejects executable, credential-bearing, and malformed contact links', () => {
  assert.equal(normalizeHttpsUrl('javascript:alert(1)'), '');
  assert.equal(normalizeHttpsUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(normalizeHttpsUrl('http://example.com/profile'), '');
  assert.equal(normalizeHttpsUrl('https://user:secret@example.com/profile'), '');
  assert.equal(normalizeHttpsUrl('https://example.com/profile'), 'https://example.com/profile');
});

test('builds mail links only from normalized addresses and encodes header input', () => {
  assert.equal(
    buildMailtoUrl('victim@example.com\r\nBcc: attacker@example.com', 'Hello', 'Body'),
    null,
  );
  const mailto = buildMailtoUrl(
    'Ada@Example.com',
    'Hello\r\nBcc: attacker@example.com',
    'First line\r\nSecond line',
  );
  assert.ok(mailto);
  assert.equal(mailto?.startsWith('mailto:ada%40example.com?'), true);
  assert.equal(mailto?.includes('\r'), false);
  assert.equal(mailto?.includes('\n'), false);
  assert.equal(mailto?.includes('Bcc%3A+attacker%40example.com'), true);
});

test('sanitizes a full profile without silently accepting unsafe URLs', () => {
  const sanitized = sanitizeContactProfile({
    ...profile(),
    name: '  Ada   Lovelace ',
    tags: ['Founder', 'founder', '  Speaker '],
  });
  assert.equal(sanitized.name, 'Ada Lovelace');
  assert.deepEqual(sanitized.tags, ['Founder', 'Speaker']);

  assert.throws(
    () =>
      sanitizeContactProfile({
        ...profile(),
        linkedinUrl: 'javascript:alert(1)',
      }),
    (error: unknown) =>
      error instanceof ContactProfileValidationError &&
      Boolean(error.errors.linkedinUrl),
  );
  assert.throws(
    () =>
      sanitizeContactProfile({
        ...profile(),
        linkedinUrl: 'https://user:secret@example.com/profile',
      }),
    (error: unknown) =>
      error instanceof ContactProfileValidationError &&
      Boolean(error.errors.linkedinUrl),
  );
});

test('adapts legacy Firestore records into a managed contact safely', () => {
  const deletedAt = new Date('2026-07-29T12:00:00Z');
  const managed = managedContactFromRecord('contact-1', {
    name: 'Ada Lovelace',
    email: 'ADA@EXAMPLE.COM',
    relationshipTier: 'Warm',
    lifecycleStatus: 'deleted',
    deletedAt: { toDate: () => deletedAt },
    purgeEligibleAt: '2026-08-28T12:00:00Z',
    aiAllowed: false,
    contactMergeOperationId: 'merge-1',
  });
  assert.equal(managed.id, 'contact-1');
  assert.equal(managed.email, 'ada@example.com');
  assert.equal(managed.lifecycleStatus, 'deleted');
  assert.equal(managed.deletedAt?.toISOString(), deletedAt.toISOString());
  assert.equal(
    managed.purgeEligibleAt?.toISOString(),
    '2026-08-28T12:00:00.000Z',
  );
  assert.equal(managed.aiAllowed, false);
  assert.equal(managed.contactMergeOperationId, 'merge-1');
});

test('finds normalized-email duplicates without ever auto-merging them', () => {
  const match = detectDuplicate(
    {
      id: 'incoming',
      name: 'Ada Lovelace',
      company: 'Analytical Engines',
      email: 'ADA@example.com',
    },
    {
      id: 'existing',
      name: 'A. Lovelace',
      company: 'Different Company',
      email: 'ada@EXAMPLE.com',
    },
  );
  assert.equal(match.isCandidate, true);
  assert.equal(match.safeToSuggestMerge, true);
  assert.equal(match.confidence, 'high');
  assert.deepEqual(match.matchedBy, ['email']);
});

test('avoids name-only and fuzzy-name false positives', () => {
  const sameNameOnly = detectDuplicate(
    { id: 'one', name: 'Alex Kim', company: '', email: '' },
    { id: 'two', name: 'Alex Kim', company: '', email: '' },
  );
  assert.equal(sameNameOnly.isCandidate, false);

  const nearName = detectDuplicate(
    { id: 'one', name: 'Alex J. Kim', company: 'Acme', email: '' },
    { id: 'two', name: 'Alex Kim', company: 'Acme', email: '' },
  );
  assert.equal(nearName.isCandidate, false);
});

test('flags name-and-company matches with conflicting emails as low-confidence review', () => {
  const match = detectDuplicate(
    {
      id: 'one',
      name: 'Alex Kim',
      company: 'Acme',
      email: 'alex.one@example.com',
    },
    {
      id: 'two',
      name: 'Alex Kim',
      company: 'Acme',
      email: 'alex.two@example.com',
    },
  );
  assert.equal(match.isCandidate, true);
  assert.equal(match.safeToSuggestMerge, false);
  assert.equal(match.confidence, 'low');
  assert.match(match.warnings[0], /email addresses differ/i);

  const candidates = findDuplicateCandidates(
    {
      id: 'one',
      name: 'Alex Kim',
      company: 'Acme',
      email: 'alex.one@example.com',
    },
    [
      {
        id: 'two',
        name: 'Alex Kim',
        company: 'Acme',
        email: 'alex.two@example.com',
        lifecycleStatus: 'active',
      },
      {
        id: 'deleted',
        name: 'Alex Kim',
        company: 'Acme',
        email: '',
        lifecycleStatus: 'deleted',
      },
    ],
  );
  assert.deepEqual(candidates.map((candidate) => candidate.contactId), ['two']);
});

test('archives and restores without losing the prior AI privacy preference', () => {
  const at = new Date('2026-07-29T12:00:00Z');
  const archived = nextContactLifecycle(
    { lifecycleStatus: 'active', aiAllowed: true },
    'archive',
    at,
  );
  assert.equal(archived.lifecycleStatus, 'archived');
  assert.equal(archived.aiAllowed, false);
  assert.equal(archived.aiAllowedBeforeLifecycle, true);

  const restored = nextContactLifecycle(
    archived,
    'restore',
    new Date('2026-07-30T12:00:00Z'),
  );
  assert.equal(restored.lifecycleStatus, 'active');
  assert.equal(restored.aiAllowed, true);
  assert.equal(restored.aiAllowedBeforeLifecycle, null);

  const privateArchived = nextContactLifecycle(
    { lifecycleStatus: 'active', aiAllowed: false },
    'archive',
    at,
  );
  assert.equal(
    nextContactLifecycle(privateArchived, 'restore', at).aiAllowed,
    false,
  );
});

test('soft deletion has an explicit recovery window and purge boundary', () => {
  const deletedAt = new Date('2026-07-29T12:00:00Z');
  const deleted = nextContactLifecycle(
    { lifecycleStatus: 'active', aiAllowed: true },
    'delete',
    deletedAt,
  );
  assert.equal(deleted.lifecycleStatus, 'deleted');
  assert.equal(deleted.aiAllowed, false);
  assert.equal(
    deleted.purgeEligibleAt?.toISOString(),
    '2026-08-28T12:00:00.000Z',
  );
  assert.equal(
    CONTACT_RECOVERY_WINDOW_DAYS,
    30,
  );
  assert.equal(
    isContactPurgeEligible(deleted, new Date('2026-08-28T11:59:59Z')),
    false,
  );
  assert.equal(
    isContactPurgeEligible(deleted, new Date('2026-08-28T12:00:00Z')),
    true,
  );
  assert.throws(
    () =>
      nextContactLifecycle(
        deleted,
        'restore',
        new Date('2026-08-28T12:00:00Z'),
      ),
    /recovery window has expired/i,
  );
});

test('excludes archived, deleted, merged, and private contacts from all AI facts', () => {
  const facts = [
    fact('usable'),
    fact('private-fact', { aiAllowed: false }),
    fact('old-fact', { current: false }),
  ];
  assert.deepEqual(
    contactFactsForAI({ lifecycleStatus: 'active', aiAllowed: true }, facts).map(
      (item) => item.id,
    ),
    ['usable'],
  );
  assert.deepEqual(
    contactFactsForAI({ lifecycleStatus: 'archived', aiAllowed: true }, facts),
    [],
  );
  assert.deepEqual(
    contactFactsForAI({ lifecycleStatus: 'deleted', aiAllowed: true }, facts),
    [],
  );
  assert.equal(
    isContactAIEligible({
      lifecycleStatus: 'active',
      aiAllowed: true,
      mergedIntoContactId: 'contact-2',
    }),
    false,
  );
});

test('records both the previous and next job when legacy history is empty', () => {
  const changedAt = new Date('2026-07-29T12:00:00Z');
  const plan = planJobHistoryChange({
    contactId: 'contact-1',
    previous: {
      company: 'Old Co',
      role: 'Associate',
      location: 'New York',
    },
    next: {
      company: 'New Co',
      role: 'Vice President',
      location: 'Boston',
    },
    history: [],
    changedAt,
  });
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.closeEntryIds, []);
  assert.equal(plan.additions.length, 2);
  assert.deepEqual(
    plan.additions.map((entry) => ({
      company: entry.company,
      role: entry.role,
      current: entry.current,
    })),
    [
      { company: 'Old Co', role: 'Associate', current: false },
      { company: 'New Co', role: 'Vice President', current: true },
    ],
  );
  assert.equal(plan.additions[0].sourceType, 'profile-backfill');
  assert.equal(plan.additions[1].correctionOf, null);
});

test('closes existing current jobs and ignores cosmetic role edits', () => {
  const current: JobHistoryEntry = {
    id: 'job-old',
    company: 'Old Co',
    role: 'Associate',
    location: 'New York',
    startedAt: new Date('2025-01-01T00:00:00Z'),
    endedAt: null,
    current: true,
    sourceType: 'profile',
    sourceId: 'contact-1',
    correctionOf: null,
    supersededBy: null,
    recordedAt: new Date('2025-01-01T00:00:00Z'),
  };
  const changed = planJobHistoryChange({
    contactId: 'contact-1',
    previous: current,
    next: { company: 'New Co', role: 'VP', location: 'Boston' },
    history: [current],
    changedAt: new Date('2026-07-29T00:00:00Z'),
  });
  assert.deepEqual(changed.closeEntryIds, ['job-old']);
  assert.equal(changed.additions[0].correctionOf, 'job-old');

  const cosmetic = planJobHistoryChange({
    contactId: 'contact-1',
    previous: current,
    next: {
      company: '  OLD CO ',
      role: ' associate ',
      location: 'Boston',
    },
    history: [current],
    changedAt: new Date('2026-07-29T00:00:00Z'),
  });
  assert.deepEqual(cosmetic, {
    changed: false,
    closeEntryIds: [],
    additions: [],
  });
});

test('requires a field-level decision for every merge conflict', () => {
  const primary = profile({
    email: 'ada@primary.example',
    company: 'Primary Co',
    tags: ['Founder'],
  });
  const duplicate = profile({
    email: 'ada@duplicate.example',
    company: 'Duplicate Co',
    tags: ['Speaker'],
  });
  const analysis = analyzeContactMerge(primary, duplicate);
  assert.deepEqual(
    analysis.conflicts.map((conflict) => conflict.field),
    ['email', 'company', 'tags'],
  );
  assert.throws(
    () => resolveContactMerge(primary, duplicate, []),
    (error: unknown) =>
      error instanceof UnresolvedContactMergeError &&
      error.fields.includes('email') &&
      error.fields.includes('company'),
  );
});

test('resolves side-by-side merge choices and preserves a decision audit', () => {
  const primary = profile({
    email: 'ada@primary.example',
    company: 'Primary Co',
    tags: ['Founder'],
  });
  const duplicate = profile({
    email: 'ada@duplicate.example',
    company: 'Duplicate Co',
    tags: ['Speaker', 'Founder'],
  });
  const result = resolveContactMerge(primary, duplicate, [
    { field: 'email', strategy: 'primary' },
    { field: 'company', strategy: 'duplicate' },
    { field: 'tags', strategy: 'combine' },
  ]);
  assert.equal(result.profile.email, 'ada@primary.example');
  assert.equal(result.profile.company, 'Duplicate Co');
  assert.deepEqual(result.profile.tags, ['Founder', 'Speaker']);
  assert.equal(
    result.decisions.find((decision) => decision.field === 'company')?.strategy,
    'duplicate',
  );
});

test('plans root reference rewrites, nested history copies, and collision-safe IDs', () => {
  const migrations = planContactReferenceMigration({
    uid: 'user-1',
    fromContactId: 'duplicate-1',
    toContactId: 'primary-1',
    toContactName: 'Ada Lovelace',
    operationId: 'merge-1',
    records: [
      {
        kind: 'note',
        id: 'note-1',
        sourcePath: 'users/user-1/notes/note-1',
        contactId: 'duplicate-1',
        data: { content: 'Preserve me' },
      },
      {
        kind: 'fact',
        id: 'fact-1',
        sourcePath:
          'users/user-1/contacts/duplicate-1/facts/fact-1',
        contactId: 'duplicate-1',
        data: {
          predicate: 'identity.company',
          value: 'Old Co',
          sourceType: 'note',
          sourceId: 'note-1',
        },
      },
      {
        kind: 'fact',
        id: 'fact-2',
        sourcePath:
          'users/user-1/contacts/duplicate-1/facts/fact-2',
        contactId: 'duplicate-1',
        data: {
          predicate: 'identity.company',
          value: 'New Co',
          sourceType: 'user-correction',
          sourceId: 'fact-1',
          correctionOf: 'fact-1',
          supersededBy: null,
        },
      },
      {
        kind: 'outreach',
        id: 'outreach-1',
        sourcePath: 'users/user-1/outreaches/outreach-1',
        contactId: 'duplicate-1',
        data: { status: 'Drafted' },
      },
      {
        kind: 'commitment',
        id: 'commitment-1',
        sourcePath: 'users/user-1/commitments/commitment-1',
        contactId: 'duplicate-1',
        data: { text: 'Send the document' },
      },
      {
        kind: 'thread',
        id: 'thread-1',
        sourcePath: 'users/user-1/threads/thread-1',
        contactId: 'duplicate-1',
        data: { threadId: 'thread-1' },
      },
      {
        kind: 'job-history',
        id: 'job-1',
        sourcePath:
          'users/user-1/contacts/duplicate-1/jobHistory/job-1',
        contactId: 'duplicate-1',
        data: {
          company: 'Old Co',
          role: 'Associate',
          sourceType: 'profile',
          sourceId: 'duplicate-1',
        },
      },
      {
        kind: 'outreach',
        id: 'unrelated',
        sourcePath: 'users/user-1/outreaches/unrelated',
        contactId: 'someone-else',
        data: {},
      },
    ],
    reservedFactIds: ['fact-1'],
    reservedJobHistoryIds: ['job-1'],
  });
  assert.equal(migrations.length, 7);
  assert.deepEqual(migrations[0], {
    kind: 'note',
    sourcePath: 'users/user-1/notes/note-1',
    targetPath: 'users/user-1/notes/note-1',
    action: 'update',
    patch: {
      contactId: 'primary-1',
      contactName: 'Ada Lovelace',
      contactMergeOperationId: 'merge-1',
      migratedFromContactId: 'duplicate-1',
      migratedFromContactName: null,
      migratedFromHadContactName: false,
    },
    preserveSource: true,
  });
  assert.match(
    migrations[1].targetPath,
    /contacts\/primary-1\/facts\/fact-1--merged-duplicate1$/,
  );
  assert.equal(migrations[1].patch.sourceType, 'note');
  assert.equal(migrations[1].patch.sourceId, 'note-1');
  assert.equal(migrations[1].preserveSource, true);
  assert.deepEqual(
    migrations.map((migration) => migration.kind),
    [
      'note',
      'fact',
      'fact',
      'outreach',
      'commitment',
      'thread',
      'job-history',
    ],
  );
  assert.match(
    migrations[6].targetPath,
    /contacts\/primary-1\/jobHistory\/job-1--merged-duplicate1$/,
  );
  assert.equal(
    migrations[2].patch.correctionOf,
    'fact-1--merged-duplicate1',
  );
  assert.equal(
    migrations[2].patch.sourceId,
    'fact-1--merged-duplicate1',
  );
  assert.equal(
    (migrations[2].patch.originalHistoryLinks as Record<string, unknown>)
      .correctionOf,
    'fact-1',
  );
  for (const migration of migrations.filter(
    (item) => item.action === 'update',
  )) {
    assert.equal(migration.patch.contactId, 'primary-1');
    assert.equal(migration.patch.contactMergeOperationId, 'merge-1');
  }
});

test('permanent purge remains a server-only seam after the recovery window', () => {
  const plan = buildPermanentPurgePlan(
    'user-1',
    {
      id: 'contact-1',
      lifecycleStatus: 'deleted',
      purgeEligibleAt: new Date('2026-08-28T12:00:00Z'),
    },
    new Date('2026-08-29T12:00:00Z'),
  );
  assert.equal(plan.eligible, true);
  assert.equal(plan.requiresServerExecution, true);
  assert.deepEqual(plan.relatedCollections, [
    'note',
    'outreach',
    'commitment',
    'commitment-feedback',
    'thread',
    'voice-enrichment',
    'connection',
    'contact-event',
  ]);
  assert.match(plan.collectionPaths[0], /contacts\/contact-1\/facts$/);
});
