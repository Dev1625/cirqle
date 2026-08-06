import 'dotenv/config';

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { FieldPath } from 'firebase-admin/firestore';

import {
  deleteOAuthIdentity,
  deletePrivateUserData,
  deletePublicCards,
  getAccountAdminServices,
} from '../server/api/_lib/account-admin.js';
import {
  deleteLiteLLMIdentity,
  runAccountDeletion,
} from '../server/api/_lib/account-lifecycle.js';

export function orphanSubject(uid) {
  return createHash('sha256').update(uid).digest('hex').slice(0, 16);
}

export function findOrphanUserIds(authUserIds, firestoreUserIds) {
  const active = new Set(authUserIds);
  return [...new Set(firestoreUserIds)]
    .filter((uid) => !active.has(uid))
    .sort();
}

async function listAuthUserIds(auth) {
  const ids = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1_000, pageToken);
    ids.push(...page.users.map((user) => user.uid));
    pageToken = page.pageToken;
  } while (pageToken);
  return ids;
}

async function listFirestoreUserIds(db) {
  const ids = [];
  let afterId = null;
  while (true) {
    let request = db
      .collection('users')
      .orderBy(FieldPath.documentId())
      .limit(500);
    if (afterId) request = request.startAfter(afterId);
    const page = await request.get();
    if (page.empty) break;
    ids.push(...page.docs.map((document) => document.id));
    afterId = page.docs.at(-1).id;
    if (page.size < 500) break;
  }
  return ids;
}

function requestedApply(argv, env) {
  const apply = argv.includes('--apply');
  const confirm = argv.includes(
    '--confirm=DELETE-ORPHAN-ACCOUNTS',
  );
  const allowed = env.CIRQLE_ORPHAN_CLEANUP_ALLOW === 'true';
  if (apply && (!confirm || !allowed)) {
    throw new Error(
      'Apply mode requires the exact confirmation argument and CIRQLE_ORPHAN_CLEANUP_ALLOW=true.',
    );
  }
  return apply;
}

export async function auditOrphanAccounts({
  auth,
  db,
  env = process.env,
  argv = process.argv.slice(2),
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  const apply = requestedApply(argv, env);
  const [authIds, firestoreIds] = await Promise.all([
    listAuthUserIds(auth),
    listFirestoreUserIds(db),
  ]);
  const orphans = findOrphanUserIds(authIds, firestoreIds);
  logger.log(`Auth accounts: ${authIds.length}`);
  logger.log(`Firestore account roots: ${firestoreIds.length}`);
  logger.log(`Orphan roots: ${orphans.length}`);
  orphans.forEach((uid) =>
    logger.log(`  orphan subject ${orphanSubject(uid)}`),
  );

  if (!apply || orphans.length === 0) {
    logger.log(
      apply
        ? 'No orphan cleanup was needed.'
        : 'Dry run only. Nothing was deleted.',
    );
    return { apply, found: orphans.length, deleted: 0 };
  }

  let deleted = 0;
  for (const uid of orphans) {
    const snapshot = await db.doc(`users/${uid}`).get();
    const data = snapshot.exists ? snapshot.data() || {} : {};
    await runAccountDeletion({
      identity: {
        uid,
        email: typeof data.email === 'string' ? data.email : null,
      },
      legacyApiKey:
        typeof data.apiKey === 'string' ? data.apiKey : null,
      services: {
        deleteLiteLLMIdentity: (input) =>
          deleteLiteLLMIdentity({
            ...input,
            env,
            fetchImpl,
            logger,
          }),
        deleteOAuthIdentity: (input) =>
          deleteOAuthIdentity({ ...input, db, fetchImpl }),
        deletePublicCards: (input) =>
          deletePublicCards({ ...input, db }),
        deletePrivateUserData: (input) =>
          deletePrivateUserData({ ...input, db }),
        deleteAuthUser: (orphanUid) => auth.deleteUser(orphanUid),
      },
    });
    deleted += 1;
    logger.log(`  deleted orphan subject ${orphanSubject(uid)}`);
  }
  return { apply, found: orphans.length, deleted };
}

async function main() {
  const { auth, db } = getAccountAdminServices();
  await auditOrphanAccounts({ auth, db });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(
      `Orphan audit failed (${String(error?.code || 'unknown').slice(0, 80)}).`,
    );
    process.exitCode = 1;
  });
}
