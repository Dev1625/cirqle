import 'dotenv/config';

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { FieldPath } from 'firebase-admin/firestore';

import { getAccountAdminServices } from '../api/_lib/account-admin.js';

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 400;
const APPLY_CONFIRMATION =
  '--confirm=DELETE-ORPHAN-COMMITMENT-FEEDBACK';

function safeSegment(value) {
  const segment = typeof value === 'string' ? value.trim() : '';
  return segment &&
    segment.length <= 1_500 &&
    !segment.includes('/')
    ? segment
    : null;
}

function subject(value) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 16);
}

export function findOrphanCommitmentFeedback(
  feedbackRecords,
  existingCommitmentIds,
) {
  const existing = new Set(existingCommitmentIds);
  return feedbackRecords.filter((record) => {
    const commitmentId = safeSegment(record?.commitmentId);
    return !commitmentId || !existing.has(commitmentId);
  });
}

export function orphanFeedbackApplyRequested(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const apply = argv.includes('--apply');
  if (
    apply &&
    (!argv.includes(APPLY_CONFIRMATION) ||
      env.CIRQLE_ORPHAN_FEEDBACK_CLEANUP_ALLOW !== 'true')
  ) {
    throw new Error(
      'Apply mode requires the exact confirmation argument and CIRQLE_ORPHAN_FEEDBACK_CLEANUP_ALLOW=true.',
    );
  }
  return apply;
}

function boundedPageSize(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
}

async function listUserPage(db, afterId, pageSize) {
  let query = db
    .collection('users')
    .orderBy(FieldPath.documentId())
    .limit(pageSize);
  if (afterId) query = query.startAfter(afterId);
  return query.get();
}

async function loadOwnerCandidates(db, uid, pageSize) {
  const candidates = [];
  let afterId = null;
  do {
    let query = db
      .collection(`users/${uid}/commitmentFeedbackEvents`)
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (afterId) query = query.startAfter(afterId);
    const page = await query.get();
    if (page.empty) break;

    const commitmentIds = [
      ...new Set(
        page.docs
          .map((document) => safeSegment(document.data()?.commitmentId))
          .filter(Boolean),
      ),
    ];
    const commitmentSnapshots = commitmentIds.length
      ? await db.getAll(
          ...commitmentIds.map((commitmentId) =>
            db.doc(`users/${uid}/commitments/${commitmentId}`),
          ),
        )
      : [];
    const existing = commitmentSnapshots
      .filter((snapshot) => snapshot.exists)
      .map((snapshot) => snapshot.id);

    const orphanIds = new Set(
      findOrphanCommitmentFeedback(
        page.docs.map((document) => ({
          id: document.id,
          commitmentId: document.data()?.commitmentId,
        })),
        existing,
      ).map((record) => record.id),
    );
    candidates.push(
      ...page.docs.filter((document) => orphanIds.has(document.id)),
    );
    afterId = page.docs.at(-1)?.id || null;
    if (page.size < pageSize) break;
  } while (afterId);
  return candidates;
}

async function deleteCandidates(db, uid, candidates) {
  let deleted = 0;
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const page = candidates.slice(offset, offset + 100);
    deleted += await db.runTransaction(async (transaction) => {
      const feedbackSnapshots = await Promise.all(
        page.map((candidate) => transaction.get(candidate.ref)),
      );
      const parentRefs = feedbackSnapshots.map((snapshot) => {
        if (!snapshot.exists) return null;
        const commitmentId = safeSegment(snapshot.data()?.commitmentId);
        return commitmentId
          ? db.doc(`users/${uid}/commitments/${commitmentId}`)
          : null;
      });
      const parentSnapshots = await Promise.all(
        parentRefs.map((reference) =>
          reference ? transaction.get(reference) : null,
        ),
      );
      let transactionDeletes = 0;
      feedbackSnapshots.forEach((snapshot, index) => {
        if (
          snapshot.exists &&
          (!parentRefs[index] || !parentSnapshots[index]?.exists)
        ) {
          transaction.delete(snapshot.ref);
          transactionDeletes += 1;
        }
      });
      return transactionDeletes;
    });
  }
  return deleted;
}

/**
 * Audits feedback events left by legacy deletes before dependent cleanup was
 * enforced. Dry-run is the default, output is count-only, and apply mode
 * transactionally rechecks that every referenced commitment is still absent.
 */
export async function auditOrphanCommitmentFeedback({
  db,
  argv = process.argv.slice(2),
  env = process.env,
  logger = console,
  pageSize = DEFAULT_PAGE_SIZE,
} = {}) {
  const apply = orphanFeedbackApplyRequested(argv, env);
  const limit = boundedPageSize(pageSize);
  let usersScanned = 0;
  let found = 0;
  let deleted = 0;
  let afterUserId = null;

  while (true) {
    const users = await listUserPage(db, afterUserId, limit);
    if (users.empty) break;
    for (const user of users.docs) {
      const uid = safeSegment(user.id);
      if (!uid) continue;
      usersScanned += 1;
      const candidates = await loadOwnerCandidates(db, uid, limit);
      found += candidates.length;
      if (candidates.length > 0) {
        logger.log(
          `Owner ${subject(uid)}: ${candidates.length} orphan feedback event(s).`,
        );
        if (apply) {
          deleted += await deleteCandidates(db, uid, candidates);
        }
      }
    }
    afterUserId = users.docs.at(-1)?.id || null;
    if (!afterUserId || users.size < limit) break;
  }

  logger.log(`Owners scanned: ${usersScanned}`);
  logger.log(`Orphan feedback events: ${found}`);
  logger.log(
    apply
      ? `Deleted after transactional recheck: ${deleted}`
      : 'Dry run only. Nothing was deleted.',
  );
  return Object.freeze({ apply, usersScanned, found, deleted });
}

async function main() {
  const { db } = getAccountAdminServices();
  await auditOrphanCommitmentFeedback({ db });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(
      `Orphan feedback audit failed (${String(
        error?.code || 'unknown',
      ).slice(0, 80)}).`,
    );
    process.exitCode = 1;
  });
}
