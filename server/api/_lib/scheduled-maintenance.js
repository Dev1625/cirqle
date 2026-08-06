import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { FieldPath } from 'firebase-admin/firestore';

import {
  runScheduledContactMaintenance,
} from './contact-maintenance.js';
import {
  normalizeServerSourcePrivacyPolicy,
  runAdminSourceRetentionSweep,
} from './source-retention.js';
import {
  purgeExpiredRecoverableRecords,
} from './recoverable-records.js';

const STATE_PATH = '_system/maintenance-schedule';
const DEFAULT_LEASE_MS = 4 * 60 * 1000;
const DEFAULT_MAX_USERS = 4;

function digest(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest();
}

/**
 * Vercel sends CRON_SECRET as a bearer token. Hashing both values before the
 * timing-safe comparison keeps invalid lengths from creating a timing oracle.
 */
export function isAuthorizedCronRequest(authorization, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  if (typeof authorization !== 'string') return false;
  return timingSafeEqual(
    digest(authorization.trim()),
    digest(`Bearer ${secret}`),
  );
}

function dateMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toDate === 'function') {
    try {
      return value.toDate().getTime();
    } catch {
      return 0;
    }
  }
  if (!value) return 0;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function safeUid(value) {
  const uid = typeof value === 'string' ? value.trim() : '';
  return uid && uid.length <= 1_500 && !uid.includes('/') ? uid : null;
}

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
}

export function hasActiveRetentionPolicy(value) {
  const policy = normalizeServerSourcePrivacyPolicy(value);
  return (
    policy.defaultRetentionMode !== 'forever' ||
    policy.boundaries.some(
      (boundary) => boundary.retentionMode !== 'forever',
    )
  );
}

function normalizedProgress(value = {}) {
  return {
    afterUserId: safeUid(value.retentionAfterUserId),
    currentUserId: safeUid(value.retentionCurrentUserId),
    cursor:
      typeof value.retentionCursor === 'string' &&
      value.retentionCursor.length <= 4_096
        ? value.retentionCursor
        : null,
  };
}

export function createFirestoreMaintenanceScheduleRepository(db) {
  if (
    !db ||
    typeof db.doc !== 'function' ||
    typeof db.collection !== 'function' ||
    typeof db.runTransaction !== 'function'
  ) {
    throw new TypeError('A Firebase Admin Firestore service is required.');
  }
  const stateRef = db.doc(STATE_PATH);

  return Object.freeze({
    async acquireLease({ now, leaseMs = DEFAULT_LEASE_MS }) {
      const runAt = now instanceof Date ? now : new Date(now);
      const leaseDuration = boundedInteger(
        leaseMs,
        DEFAULT_LEASE_MS,
        10 * 60 * 1000,
      );
      const leaseId = randomUUID();
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(stateRef);
        const state = snapshot.exists ? snapshot.data() || {} : {};
        if (
          typeof state.leaseId === 'string' &&
          dateMillis(state.leaseExpiresAt) > runAt.getTime()
        ) {
          return null;
        }
        transaction.set(
          stateRef,
          {
            schemaVersion: 1,
            leaseId,
            leaseExpiresAt: new Date(runAt.getTime() + leaseDuration),
            lastStartedAt: runAt,
          },
          { merge: true },
        );
        return Object.freeze({
          leaseId,
          progress: Object.freeze(normalizedProgress(state)),
        });
      });
    },

    async listNextUserId(afterUserId = null) {
      const users = db.collection('users');
      const page = async (after = null) => {
        let request = users.orderBy(FieldPath.documentId()).limit(1);
        if (after) request = request.startAfter(after);
        return request.get();
      };
      let snapshot = await page(safeUid(afterUserId));
      let wrapped = false;
      if (snapshot.empty && afterUserId) {
        snapshot = await page();
        wrapped = true;
      }
      const uid = safeUid(snapshot.docs?.[0]?.id);
      return Object.freeze({ uid, wrapped });
    },

    async readPrivacyPolicy(uid) {
      const owner = safeUid(uid);
      if (!owner) return null;
      const snapshot = await db
        .doc(`users/${owner}/settings/privacy`)
        .get();
      return snapshot.exists ? snapshot.data() || {} : null;
    },

    async releaseLease({ leaseId, now, progress, summary, failureCode = null }) {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(stateRef);
        const state = snapshot.exists ? snapshot.data() || {} : {};
        if (state.leaseId !== leaseId) return;
        transaction.set(
          stateRef,
          {
            schemaVersion: 1,
            leaseId: null,
            leaseExpiresAt: now,
            lastFinishedAt: now,
            retentionAfterUserId: progress.afterUserId || null,
            retentionCurrentUserId: progress.currentUserId || null,
            retentionCursor: progress.cursor || null,
            lastSummary: summary || null,
            lastFailureCode: failureCode,
          },
          { merge: true },
        );
      });
    },
  });
}

function emptyRetentionReport() {
  return {
    accountsVisited: 0,
    accountsSwept: 0,
    accountsSkipped: 0,
    scanned: 0,
    eligible: 0,
    deleted: 0,
    hasMore: false,
  };
}

/**
 * One bounded, resumable maintenance cycle. Reports contain counts only:
 * never user IDs, source IDs, contact IDs, or CRM content.
 */
export async function runScheduledMaintenanceCycle({
  db,
  repository = createFirestoreMaintenanceScheduleRepository(db),
  now = new Date(),
  maxUsers = DEFAULT_MAX_USERS,
  runContacts = runScheduledContactMaintenance,
  runRetention = runAdminSourceRetentionSweep,
  runRecoverablePurge = purgeExpiredRecoverableRecords,
  logger = console,
} = {}) {
  const runAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(runAt.getTime())) {
    throw new TypeError('A valid maintenance clock is required.');
  }
  const userLimit = boundedInteger(maxUsers, DEFAULT_MAX_USERS, 20);
  const lease = await repository.acquireLease({ now: runAt });
  if (!lease) {
    return Object.freeze({
      schemaVersion: 1,
      skipped: true,
      reason: 'lease-active',
    });
  }

  const progress = { ...lease.progress };
  const retention = emptyRetentionReport();
  const recoverableRecords = {
    accountsSwept: 0,
    scanned: 0,
    deleted: 0,
    hasMore: false,
  };
  let contactReport = null;

  try {
    contactReport = await runContacts({
      db,
      now: runAt,
      maxRequests: 8,
      maxMutations: 300,
      logger,
    });

    const seenUsers = new Set();
    for (let index = 0; index < userLimit; index += 1) {
      let uid = progress.currentUserId;
      if (!uid) {
        const next = await repository.listNextUserId(progress.afterUserId);
        uid = safeUid(next.uid);
        if (!uid || seenUsers.has(uid)) break;
        progress.cursor = null;
      }
      if (seenUsers.has(uid)) break;
      seenUsers.add(uid);
      retention.accountsVisited += 1;

      const recoverable = await runRecoverablePurge({
        db,
        uid,
        now: runAt,
        maxMutations: 100,
      });
      recoverableRecords.accountsSwept += 1;
      recoverableRecords.scanned += Number(recoverable.scanned) || 0;
      recoverableRecords.deleted += Number(recoverable.deleted) || 0;
      recoverableRecords.hasMore ||= recoverable.hasMore === true;

      const policy = await repository.readPrivacyPolicy(uid);
      if (!hasActiveRetentionPolicy(policy || {})) {
        retention.accountsSkipped += 1;
        progress.afterUserId = uid;
        progress.currentUserId = null;
        progress.cursor = null;
        continue;
      }

      const result = await runRetention({
        db,
        uid,
        dryRun: false,
        now: runAt,
        cursor: progress.cursor,
        maxDocuments: 300,
        pageSize: 75,
        batchSize: 150,
      });
      retention.accountsSwept += 1;
      retention.scanned += Number(result.scanned) || 0;
      retention.eligible += Number(result.eligible) || 0;
      retention.deleted += Number(result.deleted) || 0;

      if (result.hasMore && typeof result.nextCursor === 'string') {
        progress.currentUserId = uid;
        progress.cursor = result.nextCursor;
        retention.hasMore = true;
        break;
      }
      progress.afterUserId = uid;
      progress.currentUserId = null;
      progress.cursor = null;
    }

    const summary = Object.freeze({
      contactsCompleted: Number(contactReport?.completed) || 0,
      contactsDeferred: Number(contactReport?.deferred) || 0,
      retentionAccountsSwept: retention.accountsSwept,
      retentionDeleted: retention.deleted,
      recoverableRecordsDeleted: recoverableRecords.deleted,
    });
    await repository.releaseLease({
      leaseId: lease.leaseId,
      now: runAt,
      progress,
      summary,
    });
    return Object.freeze({
      schemaVersion: 1,
      skipped: false,
      contacts: Object.freeze({
        examined: Number(contactReport?.requestsExamined) || 0,
        completed: Number(contactReport?.completed) || 0,
        deferred: Number(contactReport?.deferred) || 0,
        needsReview: Number(contactReport?.needsReview) || 0,
        retryableFailures:
          Number(contactReport?.retryableFailures) || 0,
        hasMore: contactReport?.hasMore === true,
      }),
      retention: Object.freeze(retention),
      recoverableRecords: Object.freeze(recoverableRecords),
    });
  } catch (error) {
    try {
      await repository.releaseLease({
        leaseId: lease.leaseId,
        now: runAt,
        progress,
        summary: null,
        failureCode:
          typeof error?.code === 'string'
            ? error.code.slice(0, 80)
            : 'maintenance_failed',
      });
    } catch {
      // The original bounded operation error is more useful than unlock noise.
    }
    throw error;
  }
}
