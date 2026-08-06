import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTACT_MAINTENANCE_SCHEMA,
  ContactMaintenanceError,
  normalizeContactMaintenanceLimits,
  planContactMergeFactRestoration,
  runOwnerContactMaintenance,
  runScheduledContactMaintenance,
} from '../server/api/_lib/contact-maintenance.js';
import {
  createContactMaintenanceHandler,
} from '../server/api/contacts/maintenance.js';

const NOW = new Date('2026-07-29T16:00:00.000Z');
const UID = 'owner-uid';

function purgeRequest({
  uid = UID,
  contactId = 'contact-delete',
  actorUid = uid,
} = {}) {
  return {
    kind: 'purge',
    uid,
    id: contactId,
    data: {
      contactId,
      actorUid,
      status: 'queued',
      requiresServerExecution: true,
      plan: { contactId },
      requestedAt: new Date('2026-07-29T15:00:00.000Z'),
    },
  };
}

function mergeRequest({
  uid = UID,
  operationId = 'merge-operation',
  actorUid = uid,
} = {}) {
  return {
    kind: 'merge-recovery',
    uid,
    id: operationId,
    data: {
      operationId,
      primaryContactId: 'primary-contact',
      duplicateContactId: 'duplicate-contact',
      actorUid,
      status: 'queued',
      requiresServerExecution: true,
      recoveryProtocolVersion: 1,
      requestedAt: new Date('2026-07-29T15:00:00.000Z'),
    },
  };
}

function mergeContext(
  request,
  {
    operationStatus = 'completed',
    primaryName = 'Merged Name',
    duplicateEligibleAt = new Date('2026-08-20T00:00:00.000Z'),
  } = {},
) {
  return {
    request,
    operation: {
      id: request.id,
      data: {
        actorUid: request.uid,
        primaryContactId: request.data.primaryContactId,
        duplicateContactId: request.data.duplicateContactId,
        status: operationStatus,
        primaryBefore: { name: 'Primary Name', email: 'primary@example.com' },
        duplicateBefore: {
          name: 'Duplicate Name',
          email: 'duplicate@example.com',
        },
        resolvedProfile: {
          name: 'Merged Name',
          email: 'primary@example.com',
        },
        ...(operationStatus === 'recovered'
          ? {
              recoveryRequestId: request.id,
              recoveryProtocolVersion: 1,
            }
          : {}),
      },
    },
    primary: {
      id: request.data.primaryContactId,
      data: {
        name: primaryName,
        email: 'primary@example.com',
        lifecycleStatus: 'active',
        mergedFromContactIds: [request.data.duplicateContactId],
      },
    },
    duplicate: {
      id: request.data.duplicateContactId,
      data: {
        name: 'Duplicate Name',
        email: 'duplicate@example.com',
        lifecycleStatus: 'deleted',
        mergedIntoContactId: request.data.primaryContactId,
        contactMergeOperationId: request.id,
        purgeEligibleAt: duplicateEligibleAt,
        aiAllowedBeforeLifecycle: true,
      },
    },
  };
}

class FakeRepository {
  constructor({
    requests = [],
    purgeRemaining = 0,
    mergeRemaining = 0,
    purgeEligibleAt = new Date('2026-07-01T00:00:00.000Z'),
    mergeOptions,
  } = {}) {
    this.requests = requests;
    this.purgeRemaining = purgeRemaining;
    this.mergeRemaining = mergeRemaining;
    this.purgeEligibleAt = purgeEligibleAt;
    this.mergeOptions = mergeOptions;
    this.updates = [];
    this.fenceCalls = [];
    this.purgeCalls = [];
    this.mergeCalls = [];
    this.finalizedPurges = 0;
    this.finalizedMerges = 0;
    this.ownerListUIDs = [];
    this.scheduledListCalls = 0;
  }

  async listOwnerRequests(uid, maxRequests) {
    this.ownerListUIDs.push(uid);
    return {
      requests: this.requests.slice(0, maxRequests),
      hasMore: this.requests.length > maxRequests,
    };
  }

  async listScheduledRequests(maxRequests) {
    this.scheduledListCalls += 1;
    return {
      requests: this.requests.slice(0, maxRequests),
      hasMore: this.requests.length > maxRequests,
    };
  }

  async loadPurgeContext(descriptor) {
    return {
      request: descriptor,
      contact: {
        id: descriptor.contactId || descriptor.id,
        data: {
          lifecycleStatus: 'deleted',
          purgeEligibleAt: this.purgeEligibleAt,
        },
      },
    };
  }

  async loadMergeContext(descriptor) {
    return mergeContext(descriptor, this.mergeOptions);
  }

  async updateRequest(descriptor, patch) {
    this.updates.push({ descriptor, patch });
  }

  async acquirePurgeFence({ descriptor, now }) {
    const lease = {
      requestId: descriptor.id,
      leaseId: `lease-${this.fenceCalls.length + 1}`,
      leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      writes: 1,
    };
    this.fenceCalls.push({ descriptor, lease });
    this.activeLease = lease;
    return lease;
  }

  assertActiveLease(lease) {
    if (lease?.leaseId !== this.activeLease?.leaseId) {
      throw new ContactMaintenanceError({
        code: 'contact_purge_lease_lost',
        status: 409,
        disposition: 'deferred',
      });
    }
  }

  async purgeContactData({ lease, limit }) {
    this.assertActiveLease(lease);
    const count = Math.min(limit, this.purgeRemaining);
    this.purgeRemaining -= count;
    this.purgeCalls.push({ limit, count });
    return count;
  }

  async hasPurgeData({ lease }) {
    this.assertActiveLease(lease);
    return this.purgeRemaining > 0;
  }

  async finalizePurge({ lease }) {
    this.assertActiveLease(lease);
    this.finalizedPurges += 1;
    return { completed: true, writes: 2 };
  }

  async restoreMergeReferences({ limit }) {
    const count = Math.min(limit, this.mergeRemaining);
    this.mergeRemaining -= count;
    this.mergeCalls.push({ limit, count });
    return count;
  }

  async hasMergeReferences() {
    return this.mergeRemaining > 0;
  }

  async estimateMergeFinalization() {
    return 6;
  }

  async finalizeMergeRecovery() {
    this.finalizedMerges += 1;
    return { completed: true, writes: 6 };
  }
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('maintenance schema covers every reference kind described by contact management', () => {
  assert.deepEqual(CONTACT_MAINTENANCE_SCHEMA.rootReferenceCollections, [
    'notes',
    'outreaches',
    'commitments',
    'threads',
    'voiceEnrichmentJobs',
  ]);
  assert.deepEqual(CONTACT_MAINTENANCE_SCHEMA.nestedReferenceCollections, [
    'facts',
    'jobHistory',
  ]);
  assert.deepEqual(
    CONTACT_MAINTENANCE_SCHEMA.endpointReferenceCollections,
    ['connections'],
  );
  assert.deepEqual(
    CONTACT_MAINTENANCE_SCHEMA.dependentReferenceCollections,
    ['commitmentFeedbackEvents'],
  );
  assert.deepEqual(
    CONTACT_MAINTENANCE_SCHEMA.eventReferenceCollections,
    ['contactEvents'],
  );
});

test('owner purge is bounded, retryable, and only finalizes after every reference is gone', async () => {
  const request = purgeRequest();
  const repository = new FakeRepository({
    requests: [request],
    purgeRemaining: 10,
  });

  const first = await runOwnerContactMaintenance({
    uid: UID,
    repository,
    now: NOW,
    maxRequests: 1,
    maxMutations: 10,
  });
  assert.equal(first.completed, 0);
  assert.equal(first.deferred, 1);
  assert.equal(first.mutations, 9);
  assert.equal(repository.purgeRemaining, 3);
  assert.equal(repository.finalizedPurges, 0);
  assert.equal(repository.updates[0].patch.status, 'queued');
  assert.equal(repository.updates[0].patch.workerReasonCode, 'contact_purge_in_progress');

  const second = await runOwnerContactMaintenance({
    uid: UID,
    repository,
    now: NOW,
    maxRequests: 1,
    maxMutations: 10,
  });
  assert.equal(second.completed, 1);
  assert.equal(second.mutations, 6);
  assert.equal(repository.purgeRemaining, 0);
  assert.equal(repository.finalizedPurges, 1);
  assert.ok(first.mutations <= 10);
  assert.ok(second.mutations <= 10);
});

test('a purge worker that loses its lease cannot delete contact data', async () => {
  const repository = new FakeRepository({
    requests: [purgeRequest()],
    purgeRemaining: 3,
  });
  repository.purgeContactData = async ({ lease }) => {
    repository.activeLease = {
      ...lease,
      leaseId: 'replacement-lease',
    };
    repository.assertActiveLease(lease);
  };

  const report = await runOwnerContactMaintenance({
    uid: UID,
    repository,
    now: NOW,
    maxRequests: 1,
    maxMutations: 20,
  });

  assert.equal(report.completed, 0);
  assert.equal(report.deferred, 1);
  assert.equal(repository.purgeRemaining, 3);
  assert.equal(repository.finalizedPurges, 0);
  assert.equal(
    repository.updates[0].patch.workerReasonCode,
    'contact_purge_lease_lost',
  );
});

test('purge eligibility is rechecked from the authoritative contact, not the queued plan', async () => {
  const repository = new FakeRepository({
    requests: [purgeRequest()],
    purgeRemaining: 2,
    purgeEligibleAt: new Date('2026-08-20T00:00:00.000Z'),
  });
  const report = await runOwnerContactMaintenance({
    uid: UID,
    repository,
    now: NOW,
    maxRequests: 1,
    maxMutations: 20,
  });
  assert.equal(report.deferred, 1);
  assert.equal(repository.purgeCalls.length, 0);
  assert.equal(repository.finalizedPurges, 0);
  assert.equal(repository.updates[0].patch.status, 'queued');
  assert.equal(
    repository.updates[0].patch.workerReasonCode,
    'contact_purge_not_yet_eligible',
  );
});

test('a mismatched queue actor is quarantined without touching contact data', async () => {
  const repository = new FakeRepository({
    requests: [purgeRequest({ actorUid: 'different-user' })],
    purgeRemaining: 3,
  });
  const report = await runOwnerContactMaintenance({
    uid: UID,
    repository,
    now: NOW,
    maxRequests: 1,
    maxMutations: 20,
  });
  assert.equal(report.needsReview, 1);
  assert.equal(repository.purgeCalls.length, 0);
  assert.equal(repository.finalizedPurges, 0);
  assert.equal(repository.updates[0].patch.status, 'needs-review');
  assert.equal(
    repository.updates[0].patch.workerReasonCode,
    'contact_maintenance_ownership_invalid',
  );
});

test('owner-scoped runner rejects a repository that returns another owner', async () => {
  const repository = new FakeRepository({
    requests: [purgeRequest({ uid: 'other-owner' })],
  });
  await assert.rejects(
    runOwnerContactMaintenance({
      uid: UID,
      repository,
      now: NOW,
    }),
    (error) =>
      error instanceof ContactMaintenanceError &&
      error.code === 'contact_maintenance_ownership_invalid',
  );
});

test('merge recovery restores bounded references before atomically restoring contacts', async () => {
  const request = mergeRequest();
  const repository = new FakeRepository({
    requests: [request],
    mergeRemaining: 12,
  });

  const first = await runOwnerContactMaintenance({
    uid: UID,
    repository,
    now: NOW,
    maxRequests: 1,
    maxMutations: 10,
  });
  assert.equal(first.deferred, 1);
  assert.equal(first.mutations, 10);
  assert.equal(repository.mergeRemaining, 3);
  assert.equal(repository.finalizedMerges, 0);

  const second = await runOwnerContactMaintenance({
    uid: UID,
    repository,
    now: NOW,
    maxRequests: 1,
    maxMutations: 10,
  });
  assert.equal(second.completed, 1);
  assert.equal(second.mutations, 9);
  assert.equal(repository.mergeRemaining, 0);
  assert.equal(repository.finalizedMerges, 1);
});

test('merge recovery refuses to overwrite a profile edited after merge', async () => {
  const repository = new FakeRepository({
    requests: [mergeRequest()],
    mergeRemaining: 5,
    mergeOptions: { primaryName: 'User changed this after merge' },
  });
  const report = await runOwnerContactMaintenance({
    uid: UID,
    repository,
    now: NOW,
    maxRequests: 1,
    maxMutations: 20,
  });
  assert.equal(report.needsReview, 1);
  assert.equal(repository.mergeCalls.length, 0);
  assert.equal(repository.finalizedMerges, 0);
  assert.equal(repository.updates[0].patch.status, 'needs-review');
  assert.equal(
    repository.updates[0].patch.workerReasonCode,
    'contact_merge_profile_changed',
  );
});

test('merge recovery is expired at the exact permanent-purge boundary', async () => {
  const repository = new FakeRepository({
    requests: [mergeRequest()],
    mergeOptions: { duplicateEligibleAt: NOW },
  });
  const report = await runOwnerContactMaintenance({
    uid: UID,
    repository,
    now: NOW,
    maxRequests: 1,
    maxMutations: 20,
  });
  assert.equal(report.expired, 1);
  assert.equal(repository.updates[0].patch.status, 'expired');
  assert.equal(repository.mergeCalls.length, 0);
});

test('already-recovered merge operations complete idempotently', async () => {
  const repository = new FakeRepository({
    requests: [mergeRequest()],
    mergeOptions: { operationStatus: 'recovered' },
  });
  const report = await runOwnerContactMaintenance({
    uid: UID,
    repository,
    now: NOW,
    maxRequests: 1,
    maxMutations: 20,
  });
  assert.equal(report.completed, 1);
  assert.equal(repository.mergeCalls.length, 0);
  assert.equal(repository.finalizedMerges, 1);
});

test('fact restoration supersedes only the resolved merge value and blocks later truth', () => {
  const plan = planContactMergeFactRestoration({
    uid: UID,
    operationId: 'merge-operation',
    primaryBefore: { name: 'Before Name', company: '' },
    resolvedProfile: { name: 'Resolved Name', company: 'Merged Co' },
    currentFacts: [
      {
        id: 'name-fact',
        predicate: 'identity.name',
        value: 'Resolved Name',
      },
      {
        id: 'company-fact',
        predicate: 'identity.company',
        value: 'Merged Co',
      },
    ],
  });
  assert.deepEqual(
    plan.map((entry) => ({
      predicate: entry.predicate,
      beforeValue: entry.beforeValue,
      currentFactId: entry.currentFactId,
      hasCorrection: Boolean(entry.correctionId),
    })),
    [
      {
        predicate: 'identity.name',
        beforeValue: 'Before Name',
        currentFactId: 'name-fact',
        hasCorrection: true,
      },
      {
        predicate: 'identity.company',
        beforeValue: '',
        currentFactId: 'company-fact',
        hasCorrection: true,
      },
    ],
  );

  assert.throws(
    () =>
      planContactMergeFactRestoration({
        uid: UID,
        operationId: 'merge-operation',
        primaryBefore: { name: 'Before Name' },
        resolvedProfile: { name: 'Resolved Name' },
        currentFacts: [
          {
            id: 'later-fact',
            predicate: 'identity.name',
            value: 'A later user correction',
          },
        ],
      }),
    (error) =>
      error instanceof ContactMaintenanceError &&
      error.code === 'contact_merge_fact_changed',
  );
});

test('fact restoration normalizes multi-value tags before checking for later edits', () => {
  const plan = planContactMergeFactRestoration({
    uid: UID,
    operationId: 'merge-operation',
    primaryBefore: { tags: ['Founder', 'Speaker'] },
    resolvedProfile: { tags: ['Founder', 'Speaker', 'VIP'] },
    currentFacts: [
      {
        id: 'tags-fact',
        predicate: 'relationship.tags',
        value: 'Founder, Speaker, VIP',
        aiAllowed: false,
      },
    ],
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].predicate, 'relationship.tags');
  assert.deepEqual(plan[0].beforeValue, ['Founder', 'Speaker']);
  assert.equal(plan[0].currentFactId, 'tags-fact');
  assert.ok(plan[0].correctionId);
});

test('scheduler seam discovers owners from queued paths and has no UID input', async () => {
  const repository = new FakeRepository({
    requests: [purgeRequest()],
  });
  const report = await runScheduledContactMaintenance({
    repository,
    now: NOW,
    maxRequests: 1,
    maxMutations: 20,
  });
  assert.equal(report.completed, 1);
  assert.equal(repository.scheduledListCalls, 1);
  assert.deepEqual(repository.ownerListUIDs, []);
});

test('retryable failures are sanitized and remain queued', async () => {
  const repository = new FakeRepository({
    requests: [purgeRequest()],
  });
  repository.loadPurgeContext = async () => {
    const error = new Error(
      'Firestore failed for alice@example.com / Secret Contact Name',
    );
    error.code = 'firestore/internal alice@example.com';
    throw error;
  };
  const logs = [];
  const report = await runOwnerContactMaintenance({
    uid: UID,
    repository,
    now: NOW,
    maxRequests: 1,
    maxMutations: 20,
    logger: { error: (...items) => logs.push(items) },
  });
  assert.equal(report.retryableFailures, 1);
  assert.equal(repository.updates[0].patch.status, 'queued');
  assert.equal(
    repository.updates[0].patch.workerReasonCode,
    'contact_maintenance_retryable',
  );
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /alice@example\.com|Secret Contact Name/);
  assert.match(serialized, /unknown/);
  assert.doesNotMatch(serialized, new RegExp(UID));
});

test('limits are always finite and bounded', () => {
  assert.deepEqual(normalizeContactMaintenanceLimits(), {
    maxRequests: 4,
    maxMutations: 200,
  });
  assert.throws(
    () => normalizeContactMaintenanceLimits({ maxMutations: 401 }),
    /maxMutations/i,
  );
  assert.throws(
    () => normalizeContactMaintenanceLimits({ maxRequests: 0 }),
    /maxRequests/i,
  );
});

test('authenticated endpoint derives UID from Firebase and rejects every UID field', async () => {
  let maintenanceArguments = null;
  const handler = createContactMaintenanceHandler({
    verifyIdentity: async () => ({
      uid: UID,
      authTime: Math.floor(NOW.getTime() / 1_000),
    }),
    assertRecent: () => undefined,
    now: () => NOW,
    runMaintenance: async (arguments_) => {
      maintenanceArguments = arguments_;
      return {
        schemaVersion: 1,
        requestsExamined: 0,
        completed: 0,
        deferred: 0,
        needsReview: 0,
        expired: 0,
        retryableFailures: 0,
        mutations: 0,
        hasMore: false,
      };
    },
  });

  const forbidden = response();
  await handler(
    {
      method: 'POST',
      headers: { authorization: 'Bearer valid' },
      body: { uid: 'other-owner' },
    },
    forbidden,
  );
  assert.equal(forbidden.statusCode, 400);
  assert.equal(
    forbidden.body.error.code,
    'contact_maintenance_field_not_allowed',
  );
  assert.equal(maintenanceArguments, null);

  const accepted = response();
  await handler(
    {
      method: 'POST',
      headers: { authorization: 'Bearer valid' },
      body: { maxRequests: 2, maxMutations: 40 },
    },
    accepted,
  );
  assert.equal(accepted.statusCode, 200);
  assert.equal(maintenanceArguments.uid, UID);
  assert.equal(maintenanceArguments.maxRequests, 2);
  assert.equal(maintenanceArguments.maxMutations, 40);
  assert.equal(maintenanceArguments.now.toISOString(), NOW.toISOString());
});

test('endpoint requires a recent Firebase session and never invokes the worker on failure', async () => {
  let invoked = false;
  const handler = createContactMaintenanceHandler({
    verifyIdentity: async () => ({ uid: UID, authTime: 1 }),
    assertRecent: () => {
      const error = new Error('stale');
      error.code = 'recent_login_required';
      throw error;
    },
    runMaintenance: async () => {
      invoked = true;
    },
  });
  const res = response();
  await handler(
    {
      method: 'POST',
      headers: { authorization: 'Bearer valid' },
      body: {},
    },
    res,
  );
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'recent_login_required');
  assert.equal(invoked, false);
});

test('endpoint rejects wrong methods and missing authentication before any worker access', async () => {
  let authCalls = 0;
  let workerCalls = 0;
  const wrongMethodHandler = createContactMaintenanceHandler({
    verifyIdentity: async () => {
      authCalls += 1;
      return { uid: UID };
    },
    runMaintenance: async () => {
      workerCalls += 1;
    },
  });
  const wrongMethod = response();
  await wrongMethodHandler({ method: 'GET', headers: {} }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.Allow, 'POST');
  assert.equal(authCalls, 0);
  assert.equal(workerCalls, 0);

  const unauthenticatedHandler = createContactMaintenanceHandler({
    verifyIdentity: async () => {
      const error = new Error('missing');
      error.code = 'unauthorized';
      throw error;
    },
    runMaintenance: async () => {
      workerCalls += 1;
    },
  });
  const unauthenticated = response();
  await unauthenticatedHandler(
    { method: 'POST', headers: {}, body: {} },
    unauthenticated,
  );
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.body.error.code, 'unauthorized');
  assert.equal(workerCalls, 0);
});

test('endpoint returns and logs only sanitized retry guidance for unexpected failures', async () => {
  const logs = [];
  const handler = createContactMaintenanceHandler({
    verifyIdentity: async () => ({ uid: UID }),
    assertRecent: () => undefined,
    runMaintenance: async () => {
      const error = new Error(
        'Database path contained alice@example.com and Secret Contact Name',
      );
      error.code = 'internal alice@example.com';
      throw error;
    },
    logger: { error: (...items) => logs.push(items) },
  });
  const res = response();
  await handler(
    {
      method: 'POST',
      headers: { authorization: 'Bearer valid' },
      body: {},
    },
    res,
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, 'contact_maintenance_unavailable');
  const serialized = JSON.stringify({ body: res.body, logs });
  assert.doesNotMatch(serialized, /alice@example\.com|Secret Contact Name/);
  assert.match(serialized, /unknown/);
  assert.doesNotMatch(serialized, new RegExp(UID));
});
