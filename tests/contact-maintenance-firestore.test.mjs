import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import {
  createFirestoreContactMaintenanceRepository,
  runOwnerContactMaintenance,
} from '../api/_lib/contact-maintenance.js';

const EMULATOR_AVAILABLE = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const PROJECT_ID = 'cirqle-contact-maintenance-test';
const NOW = new Date('2026-07-29T16:00:00.000Z');
const app = EMULATOR_AVAILABLE
  ? initializeApp({ projectId: PROJECT_ID }, 'contact-maintenance-emulator-test')
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

test(
  'Admin repository permanently purges every described reference before its receipt',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'purge-owner';
    const contactId = 'contact-delete';
    await Promise.all([
      set(`_accountSecurity/${uid}`, {
        status: 'active',
        revokedAfterSeconds: 0,
      }),
      set(`users/${uid}/contactPurgeRequests/${contactId}`, {
        contactId,
        actorUid: uid,
        status: 'queued',
        requiresServerExecution: true,
        requestedAt: Timestamp.fromDate(
          new Date('2026-07-29T15:00:00.000Z'),
        ),
        plan: { contactId },
      }),
      set(`users/${uid}/contacts/${contactId}`, {
        name: 'Delete Me',
        lifecycleStatus: 'deleted',
        purgeEligibleAt: Timestamp.fromDate(
          new Date('2026-07-28T00:00:00.000Z'),
        ),
      }),
      ...[
        'notes',
        'outreaches',
        'commitments',
        'threads',
        'voiceEnrichmentJobs',
      ].map(
        (collectionName) =>
          set(`users/${uid}/${collectionName}/${collectionName}-reference`, {
            contactId,
            content: 'private fixture',
          }),
      ),
      set(`users/${uid}/contacts/${contactId}/facts/fact-1`, {
        predicate: 'identity.name',
        value: 'Delete Me',
        current: true,
      }),
      set(`users/${uid}/contacts/${contactId}/jobHistory/job-1`, {
        role: 'Engineer',
        current: true,
      }),
      set(`users/${uid}/commitmentFeedbackEvents/feedback-1`, {
        id: 'feedback-1',
        commitmentId: 'commitments-reference',
        actorUid: uid,
        kind: 'dismissed',
        note: 'Private feedback note',
      }),
      set(`users/${uid}/connections/source-edge`, {
        sourceId: contactId,
        targetId: 'other-contact',
        type: 'private edge',
      }),
      set(`users/${uid}/connections/target-edge`, {
        sourceId: 'other-contact',
        targetId: contactId,
        type: 'private edge',
      }),
      set(`users/${uid}/connections/legacy-self-edge`, {
        sourceId: contactId,
        targetId: contactId,
        type: 'legacy malformed edge',
      }),
      set(`users/${uid}/connections/migrated-visible-edge`, {
        sourceId: 'primary-contact',
        targetId: 'other-contact',
        type: 'preserved merged edge',
        contactMergeOperationId: 'merge-before-purge',
        migratedFromContactId: contactId,
        migratedFromPath:
          `users/${uid}/connections/${contactId}--other-contact`,
        originalConnectionEndpoints: {
          sourceId: contactId,
          targetId: 'other-contact',
        },
        mergeHistorical: false,
      }),
      set(`users/${uid}/contactEvents/direct-private-event`, {
        contactId,
        type: 'profile-updated',
        payload: { changedFields: ['name'] },
      }),
      set(`users/${uid}/contactEvents/indirect-private-event`, {
        contactId: 'primary-contact',
        type: 'merge-completed',
        payload: {
          primaryContactId: 'primary-contact',
          duplicateContactId: contactId,
        },
      }),
    ]);

    const report = await runOwnerContactMaintenance({
      db,
      uid,
      now: NOW,
      maxRequests: 1,
      maxMutations: 40,
      logger: { error: () => undefined },
    });
    assert.equal(report.completed, 1);
    assert.ok(report.mutations <= 40);

    const [
      contact,
      request,
      fact,
      job,
      notes,
      outreaches,
      commitments,
      threads,
      voiceEnrichmentJobs,
      feedbackEvents,
      connections,
      contactEvents,
    ] = await Promise.all([
      db.doc(`users/${uid}/contacts/${contactId}`).get(),
      db.doc(`users/${uid}/contactPurgeRequests/${contactId}`).get(),
      db.doc(`users/${uid}/contacts/${contactId}/facts/fact-1`).get(),
      db.doc(`users/${uid}/contacts/${contactId}/jobHistory/job-1`).get(),
      db.collection(`users/${uid}/notes`).get(),
      db.collection(`users/${uid}/outreaches`).get(),
      db.collection(`users/${uid}/commitments`).get(),
      db.collection(`users/${uid}/threads`).get(),
      db.collection(`users/${uid}/voiceEnrichmentJobs`).get(),
      db.collection(`users/${uid}/commitmentFeedbackEvents`).get(),
      db.collection(`users/${uid}/connections`).get(),
      db.collection(`users/${uid}/contactEvents`).get(),
    ]);
    assert.equal(contact.exists, false);
    assert.equal(fact.exists, false);
    assert.equal(job.exists, false);
    assert.equal(notes.empty, true);
    assert.equal(outreaches.empty, true);
    assert.equal(commitments.empty, true);
    assert.equal(threads.empty, true);
    assert.equal(voiceEnrichmentJobs.empty, true);
    assert.equal(feedbackEvents.empty, true);
    assert.equal(connections.size, 1);
    assert.equal(connections.docs[0].id, 'migrated-visible-edge');
    assert.equal(
      Object.hasOwn(
        connections.docs[0].data(),
        'migratedFromContactId',
      ),
      false,
    );
    assert.equal(contactEvents.empty, true);
    assert.equal(request.data().status, 'completed');
    assert.equal(request.data().requiresServerExecution, false);
    assert.ok(
      request.data().verifiedEmptyCollections.includes(
        'commitment-feedback',
      ),
    );

    const retry = await runOwnerContactMaintenance({
      db,
      uid,
      now: NOW,
      maxRequests: 1,
      maxMutations: 40,
      logger: { error: () => undefined },
    });
    assert.equal(retry.requestsExamined, 0);
    assert.equal(retry.mutations, 0);
  },
);

test(
  'a purge batch rechecks lifecycle state and the exact server lease before deleting',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'purge-race-owner';
    const contactId = 'purge-race-contact';
    const descriptor = {
      kind: 'purge',
      uid,
      id: contactId,
      contactId,
      data: {
        contactId,
        actorUid: uid,
        status: 'queued',
        requiresServerExecution: true,
        requestedAt: Timestamp.fromDate(
          new Date('2026-07-29T15:00:00.000Z'),
        ),
        plan: { contactId },
      },
    };
    await Promise.all([
      set(`_accountSecurity/${uid}`, {
        status: 'active',
        revokedAfterSeconds: 0,
      }),
      set(`users/${uid}/contactPurgeRequests/${contactId}`, descriptor.data),
      set(`users/${uid}/contacts/${contactId}`, {
        name: 'Race target',
        lifecycleStatus: 'deleted',
        purgeEligibleAt: Timestamp.fromDate(
          new Date('2026-07-28T00:00:00.000Z'),
        ),
      }),
      set(`users/${uid}/notes/race-note`, {
        contactId,
        content: 'must survive a stale worker',
      }),
    ]);

    let leaseSequence = 0;
    const repository = createFirestoreContactMaintenanceRepository(db, {
      clock: () => NOW,
      leaseIdFactory: () => `race-lease-${++leaseSequence}`,
    });
    const firstLease = await repository.acquirePurgeFence({
      descriptor,
      now: NOW,
    });

    await db.doc(`users/${uid}/contacts/${contactId}`).update({
      lifecycleStatus: 'active',
    });
    await assert.rejects(
      repository.purgeContactData({
        descriptor,
        lease: firstLease,
        now: NOW,
        limit: 10,
      }),
      (error) => error?.code === 'contact_purge_state_invalid',
    );
    assert.equal(
      (await db.doc(`users/${uid}/notes/race-note`).get()).exists,
      true,
    );

    await db.doc(`users/${uid}/contacts/${contactId}`).update({
      lifecycleStatus: 'deleted',
    });
    const staleLease = await repository.acquirePurgeFence({
      descriptor,
      now: NOW,
    });
    const currentLease = await repository.acquirePurgeFence({
      descriptor,
      now: NOW,
    });
    await assert.rejects(
      repository.purgeContactData({
        descriptor,
        lease: staleLease,
        now: NOW,
        limit: 10,
      }),
      (error) => error?.code === 'contact_purge_lease_lost',
    );
    assert.equal(
      (await db.doc(`users/${uid}/notes/race-note`).get()).exists,
      true,
    );

    const deleted = await repository.purgeContactData({
      descriptor,
      lease: currentLease,
      now: NOW,
      limit: 10,
    });
    assert.equal(deleted, 1);
    assert.equal(
      (await db.doc(`users/${uid}/notes/race-note`).get()).exists,
      false,
    );
  },
);

test(
  'commitment feedback is drained in bounded pages before its parent commitment is deleted',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'feedback-purge-owner';
    const contactId = 'feedback-purge-contact';
    const descriptor = {
      kind: 'purge',
      uid,
      id: contactId,
      contactId,
      data: {
        contactId,
        actorUid: uid,
        status: 'queued',
        requiresServerExecution: true,
        requestedAt: Timestamp.fromDate(
          new Date('2026-07-29T15:00:00.000Z'),
        ),
        plan: { contactId },
      },
    };
    await Promise.all([
      set(`_accountSecurity/${uid}`, {
        status: 'active',
        revokedAfterSeconds: 0,
      }),
      set(`users/${uid}/contactPurgeRequests/${contactId}`, descriptor.data),
      set(`users/${uid}/contacts/${contactId}`, {
        name: 'Feedback purge target',
        lifecycleStatus: 'deleted',
        purgeEligibleAt: Timestamp.fromDate(
          new Date('2026-07-28T00:00:00.000Z'),
        ),
      }),
      set(`users/${uid}/commitments/commitment-with-feedback`, {
        contactId,
        text: 'Private promise',
      }),
      ...[1, 2, 3].map((index) =>
        set(`users/${uid}/commitmentFeedbackEvents/feedback-${index}`, {
          id: `feedback-${index}`,
          commitmentId: 'commitment-with-feedback',
          actorUid: uid,
          kind: 'dismissed',
          note: `Private correction ${index}`,
        }),
      ),
    ]);
    const repository = createFirestoreContactMaintenanceRepository(db, {
      clock: () => NOW,
      leaseIdFactory: () => 'feedback-purge-lease',
    });
    const lease = await repository.acquirePurgeFence({
      descriptor,
      now: NOW,
    });
    assert.equal(
      await repository.purgeContactData({
        descriptor,
        lease,
        now: NOW,
        limit: 2,
      }),
      2,
    );
    assert.equal(
      (
        await db
          .doc(`users/${uid}/commitments/commitment-with-feedback`)
          .get()
      ).exists,
      true,
    );
    assert.equal(
      (await db.collection(`users/${uid}/commitmentFeedbackEvents`).get())
        .size,
      1,
    );
    assert.equal(
      await repository.purgeContactData({
        descriptor,
        lease,
        now: NOW,
        limit: 2,
      }),
      2,
    );
    assert.equal(
      (
        await db
          .doc(`users/${uid}/commitments/commitment-with-feedback`)
          .get()
      ).exists,
      false,
    );
    assert.equal(
      (await db.collection(`users/${uid}/commitmentFeedbackEvents`).get())
        .empty,
      true,
    );
  },
);

test(
  'Admin repository reverses a completed merge with reference and fact provenance intact',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'merge-owner';
    await set(`_accountSecurity/${uid}`, {
      status: 'active',
      revokedAfterSeconds: 0,
    });
    const operationId = 'merge-operation';
    const primaryId = 'primary-contact';
    const duplicateId = 'duplicate-contact';
    const primaryBefore = {
      name: 'Primary Name',
      email: 'primary@example.com',
    };
    const duplicateBefore = {
      name: 'Duplicate Name',
      email: 'duplicate@example.com',
    };
    const resolvedProfile = {
      name: 'Merged Name',
      email: 'primary@example.com',
    };
    await Promise.all([
      set(`users/${uid}/contactMergeRecoveryRequests/${operationId}`, {
        operationId,
        primaryContactId: primaryId,
        duplicateContactId: duplicateId,
        actorUid: uid,
        status: 'queued',
        requiresServerExecution: true,
        recoveryProtocolVersion: 1,
        requestedAt: Timestamp.fromDate(
          new Date('2026-07-29T15:00:00.000Z'),
        ),
      }),
      set(`users/${uid}/contactMergeOperations/${operationId}`, {
        operationId,
        primaryContactId: primaryId,
        duplicateContactId: duplicateId,
        actorUid: uid,
        status: 'completed',
        primaryBefore,
        duplicateBefore,
        resolvedProfile,
      }),
      set(`users/${uid}/contacts/${primaryId}`, {
        ...resolvedProfile,
        lifecycleStatus: 'active',
        aiAllowed: true,
        mergedFromContactIds: [duplicateId],
      }),
      set(`users/${uid}/contacts/${duplicateId}`, {
        ...duplicateBefore,
        lifecycleStatus: 'deleted',
        deletedAt: Timestamp.fromDate(
          new Date('2026-07-20T00:00:00.000Z'),
        ),
        purgeEligibleAt: Timestamp.fromDate(
          new Date('2026-08-19T00:00:00.000Z'),
        ),
        aiAllowed: false,
        aiAllowedBeforeLifecycle: true,
        mergedIntoContactId: primaryId,
        contactMergeOperationId: operationId,
      }),
      ...['notes', 'outreaches', 'commitments', 'threads'].map(
        (collectionName) =>
          set(`users/${uid}/${collectionName}/${collectionName}-reference`, {
            contactId: primaryId,
            contactName: resolvedProfile.name,
            contactMergeOperationId: operationId,
            migratedFromContactId: duplicateId,
            migratedFromContactName: duplicateBefore.name,
            migratedFromHadContactName: true,
            migratedAt: Timestamp.fromDate(
              new Date('2026-07-20T00:00:00.000Z'),
            ),
          }),
      ),
      set(`users/${uid}/contacts/${duplicateId}/facts/source-fact`, {
        predicate: 'identity.company',
        value: 'Duplicate Co',
        current: true,
      }),
      set(`users/${uid}/contacts/${primaryId}/facts/copied-fact`, {
        predicate: 'identity.company',
        value: 'Duplicate Co',
        current: false,
        aiAllowed: false,
        contactMergeOperationId: operationId,
        migratedFromPath:
          `users/${uid}/contacts/${duplicateId}/facts/source-fact`,
      }),
      set(`users/${uid}/contacts/${duplicateId}/jobHistory/source-job`, {
        role: 'Engineer',
        current: true,
      }),
      set(`users/${uid}/contacts/${primaryId}/jobHistory/copied-job`, {
        role: 'Engineer',
        current: false,
        contactMergeOperationId: operationId,
        migratedFromPath:
          `users/${uid}/contacts/${duplicateId}/jobHistory/source-job`,
      }),
      set(`users/${uid}/contacts/${primaryId}/facts/merged-name-fact`, {
        predicate: 'identity.name',
        value: resolvedProfile.name,
        normalizedValue: 'merged name',
        sourceType: 'user-correction',
        sourceId: primaryId,
        current: true,
        aiAllowed: true,
      }),
      set(`users/${uid}/connections/duplicate-source-edge`, {
        sourceId: duplicateId,
        targetId: 'other-contact',
        type: 'recoverable edge',
        contactMergeOperationId: operationId,
        migratedFromContactId: duplicateId,
        migratedToPath:
          `users/${uid}/connections/merge-connection-target`,
        mergeHistorical: true,
        mergeSuppressed: false,
        mergeRecoverySourceOperationId: operationId,
      }),
      set(`users/${uid}/connections/merge-connection-target`, {
        sourceId: primaryId,
        targetId: 'other-contact',
        type: 'recoverable edge',
        contactMergeOperationId: operationId,
        migratedFromContactId: duplicateId,
        migratedFromPath:
          `users/${uid}/connections/duplicate-source-edge`,
        originalConnectionEndpoints: {
          sourceId: duplicateId,
          targetId: 'other-contact',
        },
        mergeHistorical: false,
      }),
      set(`users/${uid}/connections/collapsed-edge`, {
        sourceId: primaryId,
        targetId: duplicateId,
        type: 'identity collapse',
        contactMergeOperationId: operationId,
        migratedFromContactId: duplicateId,
        migratedToPath: null,
        mergeHistorical: true,
        mergeSuppressed: true,
        mergeRecoverySourceOperationId: operationId,
      }),
    ]);

    const report = await runOwnerContactMaintenance({
      db,
      uid,
      now: NOW,
      maxRequests: 1,
      maxMutations: 60,
      logger: { error: () => undefined },
    });
    assert.equal(report.completed, 1);
    assert.ok(report.mutations <= 60);

    const [
      primary,
      duplicate,
      operation,
      request,
      copiedFact,
      sourceFact,
      copiedJob,
      sourceJob,
      currentNameFacts,
      recoveryEvents,
      recoveredSourceConnection,
      removedTargetConnection,
      recoveredCollapsedConnection,
    ] = await Promise.all([
      db.doc(`users/${uid}/contacts/${primaryId}`).get(),
      db.doc(`users/${uid}/contacts/${duplicateId}`).get(),
      db.doc(`users/${uid}/contactMergeOperations/${operationId}`).get(),
      db.doc(`users/${uid}/contactMergeRecoveryRequests/${operationId}`).get(),
      db.doc(`users/${uid}/contacts/${primaryId}/facts/copied-fact`).get(),
      db.doc(`users/${uid}/contacts/${duplicateId}/facts/source-fact`).get(),
      db.doc(`users/${uid}/contacts/${primaryId}/jobHistory/copied-job`).get(),
      db.doc(`users/${uid}/contacts/${duplicateId}/jobHistory/source-job`).get(),
      db
        .collection(`users/${uid}/contacts/${primaryId}/facts`)
        .where('predicate', '==', 'identity.name')
        .where('current', '==', true)
        .get(),
      db
        .collection(`users/${uid}/contactEvents`)
        .where('type', '==', 'merge-recovered')
        .get(),
      db
        .doc(`users/${uid}/connections/duplicate-source-edge`)
        .get(),
      db
        .doc(`users/${uid}/connections/merge-connection-target`)
        .get(),
      db.doc(`users/${uid}/connections/collapsed-edge`).get(),
    ]);
    assert.equal(primary.data().name, primaryBefore.name);
    assert.deepEqual(primary.data().mergedFromContactIds, []);
    assert.equal(duplicate.data().lifecycleStatus, 'active');
    assert.equal(duplicate.data().mergedIntoContactId, null);
    assert.equal(duplicate.data().contactMergeOperationId, null);
    assert.equal(operation.data().status, 'recovered');
    assert.equal(request.data().status, 'completed');
    assert.equal(copiedFact.exists, false);
    assert.equal(copiedJob.exists, false);
    assert.equal(sourceFact.exists, true);
    assert.equal(sourceJob.exists, true);
    assert.equal(currentNameFacts.size, 1);
    assert.equal(currentNameFacts.docs[0].data().value, primaryBefore.name);
    assert.equal(
      currentNameFacts.docs[0].data().contactMergeRecoveryOperationId,
      operationId,
    );
    assert.equal(recoveryEvents.size, 2);
    assert.equal(recoveredSourceConnection.data().sourceId, duplicateId);
    assert.equal(
      Object.hasOwn(
        recoveredSourceConnection.data(),
        'contactMergeOperationId',
      ),
      false,
    );
    assert.equal(removedTargetConnection.exists, false);
    assert.equal(recoveredCollapsedConnection.data().targetId, duplicateId);
    assert.equal(
      Object.hasOwn(
        recoveredCollapsedConnection.data(),
        'mergeSuppressed',
      ),
      false,
    );

    for (const collectionName of [
      'notes',
      'outreaches',
      'commitments',
      'threads',
    ]) {
      const linked = await db
        .doc(
          `users/${uid}/${collectionName}/${collectionName}-reference`,
        )
        .get();
      assert.equal(linked.data().contactId, duplicateId);
      assert.equal(linked.data().contactName, duplicateBefore.name);
      assert.equal(
        Object.hasOwn(linked.data(), 'contactMergeOperationId'),
        false,
      );
    }

    const retry = await runOwnerContactMaintenance({
      db,
      uid,
      now: NOW,
      maxRequests: 1,
      maxMutations: 60,
      logger: { error: () => undefined },
    });
    assert.equal(retry.requestsExamined, 0);
    assert.equal(retry.mutations, 0);
  },
);
