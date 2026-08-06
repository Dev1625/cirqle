import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasActiveRetentionPolicy,
  isAuthorizedCronRequest,
  runScheduledMaintenanceCycle,
} from '../server/api/_lib/scheduled-maintenance.js';
import {
  createScheduledMaintenanceHandler,
} from '../server/api/cron/maintenance.js';

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test('cron authorization requires a sufficiently strong exact bearer secret', () => {
  const secret = 'a-secure-32-character-maintenance-key';
  assert.equal(
    isAuthorizedCronRequest(`Bearer ${secret}`, secret),
    true,
  );
  assert.equal(
    isAuthorizedCronRequest(`Bearer ${secret}-wrong`, secret),
    false,
  );
  assert.equal(isAuthorizedCronRequest(null, secret), false);
  assert.equal(isAuthorizedCronRequest('Bearer too-short', 'too-short'), false);
});

test('retention scheduling skips forever-only policies', () => {
  assert.equal(hasActiveRetentionPolicy({}), false);
  assert.equal(
    hasActiveRetentionPolicy({
      defaultRetentionMode: 'days',
      defaultRetentionDays: 30,
    }),
    true,
  );
  assert.equal(
    hasActiveRetentionPolicy({
      boundaries: [
        {
          sourceType: 'email',
          retentionMode: 'delete-on-disconnect',
        },
      ],
    }),
    true,
  );
});

test('scheduled cycle is bounded, count-only, and skips inactive policies', async () => {
  let released = null;
  const repository = {
    async acquireLease() {
      return { leaseId: 'lease-1', progress: {} };
    },
    async listNextUserId(afterUserId) {
      if (!afterUserId) return { uid: 'owner-a', wrapped: false };
      if (afterUserId === 'owner-a') {
        return { uid: 'owner-b', wrapped: false };
      }
      return { uid: null, wrapped: false };
    },
    async readPrivacyPolicy(uid) {
      return uid === 'owner-a'
        ? {
            defaultRetentionMode: 'days',
            defaultRetentionDays: 30,
          }
        : {};
    },
    async releaseLease(value) {
      released = value;
    },
  };

  const report = await runScheduledMaintenanceCycle({
    db: {},
    repository,
    maxUsers: 4,
    runContacts: async () => ({
      requestsExamined: 2,
      completed: 1,
      deferred: 1,
      needsReview: 0,
      retryableFailures: 0,
      hasMore: false,
    }),
    runRecoverablePurge: async () => ({
      scanned: 2,
      deleted: 1,
      hasMore: false,
    }),
    runRetention: async ({ uid, dryRun }) => {
      assert.equal(uid, 'owner-a');
      assert.equal(dryRun, false);
      return {
        scanned: 3,
        eligible: 1,
        deleted: 1,
        hasMore: false,
        nextCursor: null,
      };
    },
  });

  assert.deepEqual(report.contacts, {
    examined: 2,
    completed: 1,
    deferred: 1,
    needsReview: 0,
    retryableFailures: 0,
    hasMore: false,
  });
  assert.deepEqual(report.retention, {
    accountsVisited: 2,
    accountsSwept: 1,
    accountsSkipped: 1,
    scanned: 3,
    eligible: 1,
    deleted: 1,
    hasMore: false,
  });
  assert.deepEqual(report.recoverableRecords, {
    accountsSwept: 2,
    scanned: 4,
    deleted: 2,
    hasMore: false,
  });
  assert.equal(released.progress.afterUserId, 'owner-b');
  assert.equal(JSON.stringify(report).includes('owner-a'), false);
  assert.equal(JSON.stringify(report).includes('owner-b'), false);
});

test('scheduled retention persists an opaque cursor for the next run', async () => {
  let released = null;
  const repository = {
    async acquireLease() {
      return {
        leaseId: 'lease-2',
        progress: {
          afterUserId: 'owner-a',
          currentUserId: 'owner-b',
          cursor: 'cursor-in',
        },
      };
    },
    async listNextUserId() {
      throw new Error('current owner should resume before enumeration');
    },
    async readPrivacyPolicy() {
      return {
        defaultRetentionMode: 'days',
        defaultRetentionDays: 7,
      };
    },
    async releaseLease(value) {
      released = value;
    },
  };

  const report = await runScheduledMaintenanceCycle({
    db: {},
    repository,
    runContacts: async () => ({}),
    runRecoverablePurge: async () => ({
      scanned: 0,
      deleted: 0,
      hasMore: false,
    }),
    runRetention: async ({ cursor }) => {
      assert.equal(cursor, 'cursor-in');
      return {
        scanned: 300,
        eligible: 2,
        deleted: 2,
        hasMore: true,
        nextCursor: 'cursor-out',
      };
    },
  });

  assert.equal(report.retention.hasMore, true);
  assert.equal(released.progress.currentUserId, 'owner-b');
  assert.equal(released.progress.cursor, 'cursor-out');
});

test('scheduled cycle exits cleanly when another lease is active', async () => {
  const report = await runScheduledMaintenanceCycle({
    db: {},
    repository: {
      async acquireLease() {
        return null;
      },
    },
    runContacts: async () => {
      throw new Error('must not run');
    },
  });
  assert.deepEqual(report, {
    schemaVersion: 1,
    skipped: true,
    reason: 'lease-active',
  });
});

test('cron endpoint is GET-only, authenticated, and returns sanitized failures', async () => {
  const secret = 'another-32-character-maintenance-secret';
  const handler = createScheduledMaintenanceHandler({
    env: { CRON_SECRET: secret },
    adminServicesFactory: () => ({ db: {} }),
    runCycle: async () => ({ schemaVersion: 1, skipped: false }),
    logger: { error() {} },
  });

  const methodResponse = responseRecorder();
  await handler({ method: 'POST', headers: {} }, methodResponse);
  assert.equal(methodResponse.statusCode, 405);

  const unauthorizedResponse = responseRecorder();
  await handler({ method: 'GET', headers: {} }, unauthorizedResponse);
  assert.equal(unauthorizedResponse.statusCode, 401);

  const okResponse = responseRecorder();
  await handler(
    {
      method: 'GET',
      headers: { authorization: `Bearer ${secret}` },
    },
    okResponse,
  );
  assert.equal(okResponse.statusCode, 200);
  assert.deepEqual(okResponse.body, {
    schemaVersion: 1,
    skipped: false,
  });

  const failureHandler = createScheduledMaintenanceHandler({
    env: { CRON_SECRET: secret },
    adminServicesFactory: () => ({ db: {} }),
    runCycle: async () => {
      const error = new Error('private provider detail');
      error.code = 'internal/provider-secret';
      throw error;
    },
    logger: { error() {} },
  });
  const failedResponse = responseRecorder();
  await failureHandler(
    {
      method: 'GET',
      headers: { authorization: `Bearer ${secret}` },
    },
    failedResponse,
  );
  assert.equal(failedResponse.statusCode, 503);
  assert.equal(
    JSON.stringify(failedResponse.body).includes('provider'),
    false,
  );
});
