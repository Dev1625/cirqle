import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import {
  ContactMergeError,
  executeAdminContactMerge,
} from '../api/_lib/contact-merge.js';
import {
  runOwnerContactMaintenance,
} from '../api/_lib/contact-maintenance.js';

const EMULATOR_AVAILABLE = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const PROJECT_ID = 'cirqle-contact-merge-test';
const NOW = new Date('2026-07-29T16:00:00.000Z');
const AUTH_TIME = Math.floor(NOW.getTime() / 1_000);
const app = EMULATOR_AVAILABLE
  ? initializeApp({ projectId: PROJECT_ID }, 'contact-merge-emulator-test')
  : null;
const db = app ? getFirestore(app) : null;

before(async () => {
  if (!EMULATOR_AVAILABLE) return;
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.equal(response.ok, true);
});

after(async () => {
  if (app) await deleteApp(app);
});

async function set(path, data) {
  await db.doc(path).set(data);
}

function expectedContact(name, company, role = '') {
  return {
    profile: {
      name,
      email: '',
      phone: '',
      company,
      role,
      location: '',
      linkedinUrl: '',
      summary: '',
      relationshipTier: 'Cold',
      industry: '',
      subIndustry: '',
      school: '',
      seniority: '',
      connectionSource: '',
      whyTheyMatter: '',
      tags: [],
    },
    lifecycleStatus: 'active',
    aiAllowed: true,
    mergedIntoContactId: null,
    contactMergeOperationId: null,
  };
}

function input(operationId, overrides = {}) {
  return {
    operationId,
    primaryContactId: 'primary-contact',
    duplicateContactId: 'duplicate-contact',
    choices: [
      { field: 'name', strategy: 'primary' },
      { field: 'company', strategy: 'duplicate' },
    ],
    confirmed: true,
    expectedPrimary: expectedContact('Primary Person', 'Primary Co'),
    expectedDuplicate: expectedContact(
      'Duplicate Person',
      'Duplicate Co',
    ),
    ...overrides,
  };
}

function fact({
  predicate,
  value,
  sourceId,
  current = true,
}) {
  return {
    predicate,
    value,
    normalizedValue: value.toLocaleLowerCase(),
    sourceType: 'profile',
    sourceId,
    observedAt: Timestamp.fromDate(
      new Date('2026-07-01T00:00:00.000Z'),
    ),
    confidence: 1,
    current,
    aiAllowed: true,
    correctionOf: null,
    supersededBy: null,
    createdAt: Timestamp.fromDate(
      new Date('2026-07-01T00:00:00.000Z'),
    ),
    updatedAt: Timestamp.fromDate(
      new Date('2026-07-01T00:00:00.000Z'),
    ),
  };
}

function job(sourceId) {
  return {
    role: 'Engineer',
    company: 'Duplicate Co',
    location: 'New York',
    startedAt: Timestamp.fromDate(
      new Date('2025-01-01T00:00:00.000Z'),
    ),
    endedAt: null,
    current: true,
    sourceType: 'profile',
    sourceId,
    correctionOf: null,
    supersededBy: null,
    recordedAt: Timestamp.fromDate(
      new Date('2025-01-01T00:00:00.000Z'),
    ),
    createdAt: Timestamp.fromDate(
      new Date('2025-01-01T00:00:00.000Z'),
    ),
    immutableProvenance: {
      sourceType: 'profile',
      sourceId,
      recordedByUid: 'fixture',
    },
  };
}

test(
  'Admin merge atomically migrates root references, facts, jobs, profile truth, and audit receipts',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'complete-merge-owner';
    const operationId = '00000000-0000-4000-8000-000000000101';
    await Promise.all([
      set(`_accountSecurity/${uid}`, {
        status: 'active',
        revokedAfterSeconds: 0,
      }),
      set(`users/${uid}/contacts/primary-contact`, {
        name: 'Primary Person',
        company: 'Primary Co',
        role: '',
        lifecycleStatus: 'active',
        aiAllowed: true,
        profileRevision: 3,
      }),
      set(`users/${uid}/contacts/duplicate-contact`, {
        name: 'Duplicate Person',
        company: 'Duplicate Co',
        role: 'Engineer',
        lifecycleStatus: 'active',
        aiAllowed: true,
      }),
      set(`users/${uid}/notes/note-1`, {
        contactId: 'duplicate-contact',
        contactName: 'Duplicate Person',
        content: 'Met at the product summit.',
      }),
      set(`users/${uid}/connections/duplicate-contact--other-contact`, {
        sourceId: 'duplicate-contact',
        targetId: 'other-contact',
        type: 'outbound edge',
      }),
      set(`users/${uid}/connections/other-contact--duplicate-contact`, {
        sourceId: 'other-contact',
        targetId: 'duplicate-contact',
        type: 'inbound edge',
      }),
      set(`users/${uid}/connections/primary-contact--duplicate-contact`, {
        sourceId: 'primary-contact',
        targetId: 'duplicate-contact',
        type: 'identity edge',
      }),
      set(
        `users/${uid}/contacts/primary-contact/facts/shared-fact`,
        fact({
          predicate: 'identity.company',
          value: 'Primary Co',
          sourceId: 'primary-contact',
        }),
      ),
      set(
        `users/${uid}/contacts/duplicate-contact/facts/shared-fact`,
        fact({
          predicate: 'relationship.context',
          value: 'Product summit',
          sourceId: 'duplicate-contact',
        }),
      ),
      set(
        `users/${uid}/contacts/duplicate-contact/jobHistory/source-job`,
        job('duplicate-contact'),
      ),
    ]);

    const result = await executeAdminContactMerge({
      db,
      uid,
      authTime: AUTH_TIME,
      input: input(operationId, {
        expectedDuplicate: expectedContact(
          'Duplicate Person',
          'Duplicate Co',
          'Engineer',
        ),
      }),
      now: NOW,
    });
    assert.equal(result.operationId, operationId);
    assert.equal(result.migratedReferences.note, 1);
    assert.equal(result.migratedReferences.connection, 3);
    assert.equal(result.migratedReferences.fact, 1);
    assert.equal(result.migratedReferences['job-history'], 1);

    const [
      primary,
      duplicate,
      note,
      operation,
      sourceFact,
      copiedFacts,
      sourceJob,
      copiedJobs,
      supersededCompanyFact,
      currentCompanyFacts,
      currentRoleFacts,
      events,
      mergedConnections,
    ] = await Promise.all([
      db.doc(`users/${uid}/contacts/primary-contact`).get(),
      db.doc(`users/${uid}/contacts/duplicate-contact`).get(),
      db.doc(`users/${uid}/notes/note-1`).get(),
      db
        .doc(`users/${uid}/contactMergeOperations/${operationId}`)
        .get(),
      db
        .doc(
          `users/${uid}/contacts/duplicate-contact/facts/shared-fact`,
        )
        .get(),
      db
        .collection(`users/${uid}/contacts/primary-contact/facts`)
        .where('contactMergeOperationId', '==', operationId)
        .get(),
      db
        .doc(
          `users/${uid}/contacts/duplicate-contact/jobHistory/source-job`,
        )
        .get(),
      db
        .collection(`users/${uid}/contacts/primary-contact/jobHistory`)
        .where('contactMergeOperationId', '==', operationId)
        .get(),
      db
        .doc(
          `users/${uid}/contacts/primary-contact/facts/shared-fact`,
        )
        .get(),
      db
        .collection(`users/${uid}/contacts/primary-contact/facts`)
        .where('predicate', '==', 'identity.company')
        .where('current', '==', true)
        .get(),
      db
        .collection(`users/${uid}/contacts/primary-contact/facts`)
        .where('predicate', '==', 'identity.role')
        .where('current', '==', true)
        .get(),
      db
        .collection(`users/${uid}/contactEvents`)
        .where('sourceId', '==', operationId)
        .get(),
      db
        .collection(`users/${uid}/connections`)
        .where('contactMergeOperationId', '==', operationId)
        .get(),
    ]);

    assert.equal(primary.data().name, 'Primary Person');
    assert.equal(primary.data().company, 'Duplicate Co');
    assert.equal(primary.data().role, 'Engineer');
    assert.deepEqual(primary.data().mergedFromContactIds, [
      'duplicate-contact',
    ]);
    assert.equal(primary.data().profileRevision, 4);
    assert.equal(duplicate.data().lifecycleStatus, 'deleted');
    assert.equal(
      duplicate.data().mergedIntoContactId,
      'primary-contact',
    );
    assert.equal(
      duplicate.data().contactMergeOperationId,
      operationId,
    );
    assert.equal(
      duplicate.data().purgeEligibleAt.toDate().toISOString(),
      '2026-08-28T16:00:00.000Z',
    );
    assert.equal(note.data().contactId, 'primary-contact');
    assert.equal(note.data().contactMergeOperationId, operationId);
    assert.equal(note.data().migratedFromContactId, 'duplicate-contact');
    assert.equal(operation.data().status, 'completed');
    assert.equal(operation.data().actorUid, uid);
    assert.equal(operation.data().resolvedProfile.company, 'Duplicate Co');
    assert.equal(sourceFact.exists, true);
    assert.equal(copiedFacts.size, 1);
    assert.equal(copiedFacts.docs[0].data().current, false);
    assert.equal(copiedFacts.docs[0].data().aiAllowed, false);
    assert.equal(
      copiedFacts.docs[0].data().migratedFromPath,
      `users/${uid}/contacts/duplicate-contact/facts/shared-fact`,
    );
    assert.equal(sourceJob.exists, true);
    assert.equal(copiedJobs.size, 1);
    assert.equal(copiedJobs.docs[0].data().current, false);
    assert.equal(supersededCompanyFact.data().current, false);
    assert.equal(
      supersededCompanyFact.data().supersededBy,
      currentCompanyFacts.docs[0].id,
    );
    assert.equal(currentCompanyFacts.size, 1);
    assert.equal(currentCompanyFacts.docs[0].data().value, 'Duplicate Co');
    assert.equal(
      currentCompanyFacts.docs[0].data().sourceId,
      'shared-fact',
    );
    assert.equal(
      currentCompanyFacts.docs[0].data().correctionOf,
      'shared-fact',
    );
    assert.equal(
      currentCompanyFacts.docs[0].data().sourceType,
      'user-correction',
    );
    assert.equal(currentRoleFacts.size, 1);
    assert.equal(currentRoleFacts.docs[0].data().value, 'Engineer');
    assert.equal(currentRoleFacts.docs[0].data().sourceType, 'profile');
    assert.equal(
      currentRoleFacts.docs[0].data().sourceId,
      `merge:${operationId}`,
    );
    assert.equal(events.size, 2);
    assert.equal(mergedConnections.size, 5);
    const historicalConnections = mergedConnections.docs.filter(
      (document) => document.data().mergeHistorical === true,
    );
    const visibleConnections = mergedConnections.docs.filter(
      (document) => document.data().mergeHistorical === false,
    );
    assert.equal(historicalConnections.length, 3);
    assert.equal(visibleConnections.length, 2);
    assert.ok(
      visibleConnections.every(
        (document) =>
          !document.id.includes('duplicate-contact') &&
          document.data().sourceId !== 'duplicate-contact' &&
          document.data().targetId !== 'duplicate-contact',
      ),
    );
    assert.equal(
      historicalConnections.filter(
        (document) => document.data().mergeSuppressed === true,
      ).length,
      1,
    );

    const retry = await executeAdminContactMerge({
      db,
      uid,
      authTime: AUTH_TIME,
      input: input(operationId, {
        expectedDuplicate: expectedContact(
          'Duplicate Person',
          'Duplicate Co',
          'Engineer',
        ),
      }),
      now: NOW,
    });
    assert.deepEqual(retry.migratedReferences, result.migratedReferences);
    const eventsAfterRetry = await db
      .collection(`users/${uid}/contactEvents`)
      .where('sourceId', '==', operationId)
      .get();
    assert.equal(eventsAfterRetry.size, 2);

    await set(
      `users/${uid}/contactMergeRecoveryRequests/${operationId}`,
      {
        operationId,
        primaryContactId: 'primary-contact',
        duplicateContactId: 'duplicate-contact',
        actorUid: uid,
        status: 'queued',
        requestedAt: Timestamp.fromDate(NOW),
        requiresServerExecution: true,
        recoveryProtocolVersion: 1,
      },
    );
    const recovery = await runOwnerContactMaintenance({
      db,
      uid,
      now: new Date('2026-07-30T16:00:00.000Z'),
      maxRequests: 1,
      maxMutations: 80,
      logger: { error: () => undefined },
    });
    assert.equal(recovery.completed, 1);

    const [
      recoveredPrimary,
      recoveredDuplicate,
      recoveredNote,
      recoveredOperation,
      remainingFactCopies,
      remainingJobCopies,
      recoveredCompanyFacts,
      recoveredRoleFacts,
      recoveredConnections,
    ] = await Promise.all([
      db.doc(`users/${uid}/contacts/primary-contact`).get(),
      db.doc(`users/${uid}/contacts/duplicate-contact`).get(),
      db.doc(`users/${uid}/notes/note-1`).get(),
      db
        .doc(`users/${uid}/contactMergeOperations/${operationId}`)
        .get(),
      db
        .collection(`users/${uid}/contacts/primary-contact/facts`)
        .where('contactMergeOperationId', '==', operationId)
        .get(),
      db
        .collection(`users/${uid}/contacts/primary-contact/jobHistory`)
        .where('contactMergeOperationId', '==', operationId)
        .get(),
      db
        .collection(`users/${uid}/contacts/primary-contact/facts`)
        .where('predicate', '==', 'identity.company')
        .where('current', '==', true)
        .get(),
      db
        .collection(`users/${uid}/contacts/primary-contact/facts`)
        .where('predicate', '==', 'identity.role')
        .where('current', '==', true)
        .get(),
      db.collection(`users/${uid}/connections`).get(),
    ]);
    assert.equal(recoveredPrimary.data().company, 'Primary Co');
    assert.equal(recoveredPrimary.data().role, '');
    assert.deepEqual(recoveredPrimary.data().mergedFromContactIds, []);
    assert.equal(recoveredDuplicate.data().lifecycleStatus, 'active');
    assert.equal(recoveredDuplicate.data().mergedIntoContactId, null);
    assert.equal(recoveredNote.data().contactId, 'duplicate-contact');
    assert.equal(recoveredNote.data().contactName, 'Duplicate Person');
    assert.equal(recoveredOperation.data().status, 'recovered');
    assert.equal(remainingFactCopies.empty, true);
    assert.equal(remainingJobCopies.empty, true);
    assert.equal(recoveredCompanyFacts.size, 1);
    assert.equal(recoveredCompanyFacts.docs[0].data().value, 'Primary Co');
    assert.equal(recoveredRoleFacts.size, 1);
    assert.equal(recoveredRoleFacts.docs[0].data().value, '[removed]');
    assert.equal(recoveredRoleFacts.docs[0].data().aiAllowed, false);
    assert.equal(recoveredConnections.size, 3);
    assert.deepEqual(
      recoveredConnections.docs
        .map((document) => [
          document.id,
          document.data().sourceId,
          document.data().targetId,
        ])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        [
          'duplicate-contact--other-contact',
          'duplicate-contact',
          'other-contact',
        ],
        [
          'other-contact--duplicate-contact',
          'other-contact',
          'duplicate-contact',
        ],
        [
          'primary-contact--duplicate-contact',
          'primary-contact',
          'duplicate-contact',
        ],
      ],
    );
    assert.ok(
      recoveredConnections.docs.every(
        (document) =>
          !Object.hasOwn(document.data(), 'contactMergeOperationId'),
      ),
    );
  },
);

test(
  'an injected failure after every write is planned commits no partial merge state',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'failed-merge-owner';
    const operationId = '00000000-0000-4000-8000-000000000102';
    await Promise.all([
      set(`_accountSecurity/${uid}`, {
        status: 'active',
        revokedAfterSeconds: 0,
      }),
      set(`users/${uid}/contacts/primary-contact`, {
        name: 'Primary Person',
        company: 'Primary Co',
        lifecycleStatus: 'active',
        aiAllowed: true,
      }),
      set(`users/${uid}/contacts/duplicate-contact`, {
        name: 'Duplicate Person',
        company: 'Duplicate Co',
        lifecycleStatus: 'active',
        aiAllowed: true,
      }),
      set(`users/${uid}/notes/note-1`, {
        contactId: 'duplicate-contact',
        contactName: 'Duplicate Person',
      }),
      set(`users/${uid}/connections/failure-edge`, {
        sourceId: 'duplicate-contact',
        targetId: 'other-contact',
        type: 'must remain unchanged',
      }),
      set(
        `users/${uid}/contacts/duplicate-contact/facts/source-fact`,
        fact({
          predicate: 'relationship.context',
          value: 'Conference',
          sourceId: 'duplicate-contact',
        }),
      ),
      set(
        `users/${uid}/contacts/duplicate-contact/jobHistory/source-job`,
        job('duplicate-contact'),
      ),
    ]);

    await assert.rejects(
      executeAdminContactMerge({
        db,
        uid,
        authTime: AUTH_TIME,
        input: input(operationId),
        now: NOW,
        beforeCommit: () => {
          throw new Error('injected transaction failure');
        },
      }),
      /injected transaction failure/,
    );

    const [
      primary,
      duplicate,
      note,
      operation,
      targetFacts,
      targetJobs,
      events,
      connection,
    ] = await Promise.all([
      db.doc(`users/${uid}/contacts/primary-contact`).get(),
      db.doc(`users/${uid}/contacts/duplicate-contact`).get(),
      db.doc(`users/${uid}/notes/note-1`).get(),
      db
        .doc(`users/${uid}/contactMergeOperations/${operationId}`)
        .get(),
      db
        .collection(`users/${uid}/contacts/primary-contact/facts`)
        .get(),
      db
        .collection(`users/${uid}/contacts/primary-contact/jobHistory`)
        .get(),
      db
        .collection(`users/${uid}/contactEvents`)
        .where('sourceId', '==', operationId)
        .get(),
      db.doc(`users/${uid}/connections/failure-edge`).get(),
    ]);
    assert.equal(primary.data().company, 'Primary Co');
    assert.equal(
      Object.hasOwn(primary.data(), 'mergedFromContactIds'),
      false,
    );
    assert.equal(duplicate.data().lifecycleStatus, 'active');
    assert.equal(
      Object.hasOwn(duplicate.data(), 'mergedIntoContactId'),
      false,
    );
    assert.equal(note.data().contactId, 'duplicate-contact');
    assert.equal(operation.exists, false);
    assert.equal(targetFacts.empty, true);
    assert.equal(targetJobs.empty, true);
    assert.equal(events.empty, true);
    assert.equal(connection.data().sourceId, 'duplicate-contact');
    assert.equal(
      Object.hasOwn(connection.data(), 'contactMergeOperationId'),
      false,
    );
  },
);

test(
  'permanent purge removes recovery-path identifiers while preserving the merged visible edge',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'merge-then-purge-owner';
    const operationId = '00000000-0000-4000-8000-000000000105';
    await Promise.all([
      set(`_accountSecurity/${uid}`, {
        status: 'active',
        revokedAfterSeconds: 0,
      }),
      set(`users/${uid}/contacts/primary-contact`, {
        name: 'Primary Person',
        company: 'Primary Co',
        lifecycleStatus: 'active',
        aiAllowed: true,
      }),
      set(`users/${uid}/contacts/duplicate-contact`, {
        name: 'Duplicate Person',
        company: 'Duplicate Co',
        lifecycleStatus: 'active',
        aiAllowed: true,
      }),
      set(`users/${uid}/connections/duplicate-contact--other-contact`, {
        sourceId: 'duplicate-contact',
        targetId: 'other-contact',
        type: 'edge retained after recovery expires',
      }),
    ]);

    await executeAdminContactMerge({
      db,
      uid,
      authTime: AUTH_TIME,
      input: input(operationId),
      now: NOW,
    });
    const purgeAt = new Date('2026-08-29T16:00:00.000Z');
    await set(`users/${uid}/contactPurgeRequests/duplicate-contact`, {
      contactId: 'duplicate-contact',
      actorUid: uid,
      status: 'queued',
      requiresServerExecution: true,
      requestedAt: Timestamp.fromDate(purgeAt),
      plan: { contactId: 'duplicate-contact' },
    });
    await set(
      `users/${uid}/contactMergeRecoveryRequests/${operationId}`,
      {
        operationId,
        primaryContactId: 'primary-contact',
        duplicateContactId: 'duplicate-contact',
        actorUid: uid,
        status: 'completed',
        requestedAt: Timestamp.fromDate(NOW),
        requiresServerExecution: false,
        recoveryProtocolVersion: 1,
      },
    );
    const report = await runOwnerContactMaintenance({
      db,
      uid,
      now: purgeAt,
      maxRequests: 1,
      maxMutations: 100,
      logger: { error: () => undefined },
    });
    assert.equal(report.completed, 1);

    const [
      primary,
      duplicate,
      operation,
      recoveryRequest,
      connections,
      directEvents,
      primaryPayloadEvents,
    ] =
      await Promise.all([
        db.doc(`users/${uid}/contacts/primary-contact`).get(),
        db.doc(`users/${uid}/contacts/duplicate-contact`).get(),
        db
          .doc(`users/${uid}/contactMergeOperations/${operationId}`)
          .get(),
        db
          .doc(
            `users/${uid}/contactMergeRecoveryRequests/${operationId}`,
          )
          .get(),
        db.collection(`users/${uid}/connections`).get(),
        db
          .collection(`users/${uid}/contactEvents`)
          .where('contactId', '==', 'duplicate-contact')
          .get(),
        db
          .collection(`users/${uid}/contactEvents`)
          .where(
            'payload.duplicateContactId',
            '==',
            'duplicate-contact',
          )
          .get(),
      ]);
    assert.equal(duplicate.exists, false);
    assert.deepEqual(primary.data().mergedFromContactIds, []);
    assert.equal(operation.data().recoveryScrubbed, true);
    for (const field of [
      'duplicateContactId',
      'requestFingerprint',
      'choices',
      'primaryBefore',
      'duplicateBefore',
      'resolvedProfile',
    ]) {
      assert.equal(Object.hasOwn(operation.data(), field), false);
    }
    assert.equal(recoveryRequest.exists, false);
    assert.equal(connections.size, 1);
    const connection = connections.docs[0];
    assert.ok(!connection.id.includes('duplicate-contact'));
    assert.equal(connection.data().sourceId, 'primary-contact');
    assert.equal(connection.data().targetId, 'other-contact');
    assert.equal(
      Object.hasOwn(connection.data(), 'migratedFromContactId'),
      false,
    );
    assert.equal(
      Object.hasOwn(connection.data(), 'contactMergeOperationId'),
      false,
    );
    assert.equal(directEvents.empty, true);
    assert.equal(primaryPayloadEvents.empty, true);
  },
);

test(
  'the Admin transaction refuses a locked account without creating a receipt',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'locked-merge-owner';
    const operationId = '00000000-0000-4000-8000-000000000103';
    await Promise.all([
      set(`_accountSecurity/${uid}`, {
        status: 'deleting',
        revokedAfterSeconds: AUTH_TIME,
      }),
      set(`users/${uid}/contacts/primary-contact`, {
        name: 'Primary Person',
        lifecycleStatus: 'active',
      }),
      set(`users/${uid}/contacts/duplicate-contact`, {
        name: 'Duplicate Person',
        lifecycleStatus: 'active',
      }),
    ]);

    await assert.rejects(
      executeAdminContactMerge({
        db,
        uid,
        authTime: AUTH_TIME,
        input: input(operationId, {
          choices: [{ field: 'name', strategy: 'primary' }],
        }),
        now: NOW,
      }),
      (error) =>
        error instanceof ContactMergeError &&
        error.code === 'contact_merge_account_locked',
    );
    const operation = await db
      .doc(`users/${uid}/contactMergeOperations/${operationId}`)
      .get();
    assert.equal(operation.exists, false);
  },
);

test(
  'the Admin transaction rejects contact state changed after the reviewed preview',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'stale-preview-owner';
    const operationId = '00000000-0000-4000-8000-000000000104';
    await Promise.all([
      set(`_accountSecurity/${uid}`, {
        status: 'active',
        revokedAfterSeconds: 0,
      }),
      set(`users/${uid}/contacts/primary-contact`, {
        name: 'Primary Person',
        company: 'Changed After Preview',
        lifecycleStatus: 'active',
        aiAllowed: true,
      }),
      set(`users/${uid}/contacts/duplicate-contact`, {
        name: 'Duplicate Person',
        company: 'Duplicate Co',
        lifecycleStatus: 'active',
        aiAllowed: true,
      }),
    ]);

    await assert.rejects(
      executeAdminContactMerge({
        db,
        uid,
        authTime: AUTH_TIME,
        input: input(operationId),
        now: NOW,
      }),
      (error) =>
        error instanceof ContactMergeError &&
        error.code === 'contact_merge_state_changed',
    );
    const operation = await db
      .doc(`users/${uid}/contactMergeOperations/${operationId}`)
      .get();
    assert.equal(operation.exists, false);
  },
);
