import { randomUUID } from 'node:crypto';

import { getAuth } from 'firebase-admin/auth';
import {
  FieldPath,
  getFirestore,
} from 'firebase-admin/firestore';

import { assertAccountActive } from './account-security.js';
import { getFirebaseAdminApp } from './firebase-admin.js';
import {
  openGoogleTokens,
  readGoogleTokenEncryptionKey,
} from './google-token-envelope.js';
import { readHeader } from './http.js';

const RECENT_LOGIN_WINDOW_SECONDS = 5 * 60;
const SECRET_FIELD =
  /(^|_)(access|refresh|id)?_?token($|_)|authorization|password|secret|api_?key|credential/i;

export class AccountAuthenticationError extends Error {
  constructor({
    code = 'unauthorized',
    message = 'Authentication required.',
    status = 401,
  } = {}) {
    super(message);
    this.name = 'AccountAuthenticationError';
    this.code = code;
    this.status = status;
  }
}

export function getAccountAdminServices(env = process.env) {
  const app = getFirebaseAdminApp(env);
  return Object.freeze({
    auth: getAuth(app),
    db: getFirestore(app),
  });
}

function extractBearerToken(req) {
  const authorization = readHeader(req, 'authorization');
  if (typeof authorization !== 'string') {
    throw new AccountAuthenticationError();
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization.trim());
  if (!match) {
    throw new AccountAuthenticationError();
  }

  return match[1];
}

/**
 * Verifies an account-management request and keeps the token's authentication
 * time. The general API helper intentionally returns a smaller identity; these
 * endpoints need auth_time so a stolen long-lived tab cannot export or destroy
 * an account without a fresh sign-in.
 */
export async function verifyAccountIdentity(
  req,
  {
    verifyIdToken = (token, checkRevoked) =>
      getAccountAdminServices().auth.verifyIdToken(token, checkRevoked),
  } = {},
) {
  const token = extractBearerToken(req);

  let decoded;
  try {
    decoded = await verifyIdToken(token, true);
  } catch {
    throw new AccountAuthenticationError();
  }

  const uid =
    typeof decoded?.uid === 'string'
      ? decoded.uid
      : typeof decoded?.sub === 'string'
        ? decoded.sub
        : '';
  if (!uid) throw new AccountAuthenticationError();

  return Object.freeze({
    uid,
    email:
      typeof decoded.email === 'string' && decoded.email.trim()
        ? decoded.email.trim()
        : null,
    emailVerified: decoded.email_verified === true,
    authTime:
      Number.isFinite(Number(decoded.auth_time))
        ? Number(decoded.auth_time)
        : null,
  });
}

export async function verifyActiveAccountIdentity(req, options = {}) {
  const identity = await verifyAccountIdentity(req, options);
  const db =
    options.db ||
    getAccountAdminServices(options.env || process.env).db;
  await assertAccountActive({
    db,
    uid: identity.uid,
    authTime: identity.authTime,
  });
  return identity;
}

export function requireRecentAuthentication(
  identity,
  {
    nowSeconds = Math.floor(Date.now() / 1000),
    maxAgeSeconds = RECENT_LOGIN_WINDOW_SECONDS,
  } = {},
) {
  const authTime = Number(identity?.authTime);
  if (
    !Number.isFinite(authTime) ||
    authTime > nowSeconds + 60 ||
    nowSeconds - authTime > maxAgeSeconds
  ) {
    throw new AccountAuthenticationError({
      code: 'recent_login_required',
      message: 'Please verify your identity again to continue.',
      status: 401,
    });
  }
}

function toSafeJSON(value, fieldName = '') {
  if (fieldName && SECRET_FIELD.test(fieldName)) return undefined;
  if (value == null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return '[binary data omitted]';
  if (Array.isArray(value)) {
    return value
      .map((item) => toSafeJSON(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value?.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (typeof value?.path === 'string' && value?.firestore) {
    return { referencePath: value.path };
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      const safe = toSafeJSON(nested, key);
      if (safe !== undefined) output[key] = safe;
    }
    return output;
  }
  return String(value);
}

export function sanitizeAccountExport(value) {
  return toSafeJSON(value);
}

async function exportDocumentTree(snapshot) {
  const collections = {};
  const collectionRefs = await snapshot.ref.listCollections();

  for (const collectionRef of collectionRefs) {
    const nested = await collectionRef.get();
    collections[collectionRef.id] = await Promise.all(
      nested.docs.map(exportDocumentTree),
    );
  }

  return {
    id: snapshot.id,
    path: snapshot.ref.path,
    exists: snapshot.exists,
    data: sanitizeAccountExport(snapshot.data() || {}),
    collections,
  };
}

export async function buildAccountExport({ db, identity }) {
  const userRef = db.doc(`users/${identity.uid}`);
  const userSnapshot = await userRef.get();
  const cardSnapshot = await db
    .collection('cards')
    .where('ownerUid', '==', identity.uid)
    .get();
  const oauthSnapshot = await db.doc(`oauthTokens/${identity.uid}`).get();

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    account: {
      uid: identity.uid,
      email: identity.email,
      emailVerified: identity.emailVerified,
    },
    // listCollections() also finds orphaned subcollections under a missing
    // root document, which is essential for a complete portability export.
    privateData: await exportDocumentTree(userSnapshot),
    publicCards: await Promise.all(
      cardSnapshot.docs.map(exportDocumentTree),
    ),
    integrations: oauthSnapshot.exists
      ? sanitizeAccountExport(oauthSnapshot.data() || {})
      : null,
  };
}

async function paginatedCollectionDocuments(
  collectionRef,
  visit,
  {
    pageSize = 100,
    shouldContinue = () => true,
  } = {},
) {
  let cursor = null;
  do {
    if (!shouldContinue()) {
      const error = new Error('Account export was cancelled.');
      error.code = 'export_cancelled';
      throw error;
    }
    let query = collectionRef
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const document of snapshot.docs) {
      await visit(document);
    }
    cursor = snapshot.docs.at(-1) || null;
    if (snapshot.size < pageSize) break;
  } while (cursor);
}

async function walkDocumentExport(
  snapshot,
  emit,
  options,
  depth = 0,
) {
  if (depth > 8) {
    const error = new Error('Account export nesting limit exceeded.');
    error.code = 'export_nesting_limit';
    throw error;
  }

  if (snapshot.exists) {
    await emit({
      path: snapshot.ref.path,
      data: sanitizeAccountExport(snapshot.data() || {}),
    });
  }

  const collections = await snapshot.ref.listCollections();
  for (const collectionRef of collections) {
    await paginatedCollectionDocuments(
      collectionRef,
      (document) =>
        walkDocumentExport(
          document,
          emit,
          options,
          depth + 1,
        ),
      options,
    );
  }
}

/**
 * Streams a valid, flat JSON document using bounded Firestore pages. A flat
 * `{path,data}` representation preserves nested collection identity without
 * retaining the complete account tree in server memory.
 */
export async function streamAccountExport({
  db,
  identity,
  write,
  shouldContinue = () => true,
  pageSize = 100,
}) {
  if (typeof write !== 'function') {
    throw new TypeError('An account export writer is required.');
  }
  const options = { pageSize, shouldContinue };
  let first = true;
  let documentCount = 0;
  const emit = async (document) => {
    if (!shouldContinue()) {
      const error = new Error('Account export was cancelled.');
      error.code = 'export_cancelled';
      throw error;
    }
    await write(`${first ? '' : ','}\n${JSON.stringify(document)}`);
    first = false;
    documentCount += 1;
  };

  await write(
    `${JSON.stringify({
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      account: {
        uid: identity.uid,
        email: identity.email,
        emailVerified: identity.emailVerified,
      },
    }).slice(0, -1)},"documents":[`,
  );

  const userSnapshot = await db.doc(`users/${identity.uid}`).get();
  await walkDocumentExport(userSnapshot, emit, options);

  let cardCursor = null;
  do {
    let query = db
      .collection('cards')
      .where('ownerUid', '==', identity.uid)
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (cardCursor) query = query.startAfter(cardCursor);
    const cards = await query.get();
    for (const card of cards.docs) {
      await walkDocumentExport(card, emit, options);
    }
    cardCursor = cards.docs.at(-1) || null;
    if (cards.size < pageSize) break;
  } while (cardCursor);

  const oauthSnapshot = await db.doc(`oauthTokens/${identity.uid}`).get();
  if (oauthSnapshot.exists) {
    await emit({
      path: 'integrations/google',
      data: sanitizeAccountExport(oauthSnapshot.data() || {}),
    });
  }

  await write(`\n],"documentCount":${documentCount}}\n`);
  return { documentCount };
}

export async function revokeGoogleCredential(
  token,
  { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {},
) {
  if (typeof token !== 'string' || !token.trim()) return;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A fetch implementation is required.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token }),
      signal: controller.signal,
    });
  } catch {
    const error = new Error('OAuth credential revocation failed.');
    error.code = controller.signal.aborted
      ? 'oauth_revoke_timeout'
      : 'oauth_revoke_failed';
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  // Google's revocation endpoint returns 400 for an already-invalid token.
  // Treating that as success makes a retry safe after revocation succeeded but
  // the Firestore delete was interrupted.
  if (!response.ok && response.status !== 400) {
    try {
      await response.body?.cancel();
    } catch {
      // The status is sufficient and the body may contain provider details.
    }
    const error = new Error('OAuth credential revocation failed.');
    error.code = 'oauth_revoke_failed';
    error.status = response.status;
    throw error;
  }
}

export async function deleteOAuthIdentity({
  db,
  uid,
  fetchImpl = globalThis.fetch,
  env = process.env,
}) {
  const ref = db.doc(`oauthTokens/${uid}`);
  const snapshot = await ref.get();
  const providerSnapshot = await ref.collection('providers').get();
  const credentials = [];
  if (snapshot.exists) {
    const data = snapshot.data() || {};
    const tokens = openGoogleTokens(data, {
      key: readGoogleTokenEncryptionKey(env, { required: false }),
      context: `${uid}:legacy-root`,
    });
    credentials.push(tokens.refreshToken || tokens.accessToken);
  }
  for (const provider of providerSnapshot.docs) {
    const data = provider.data() || {};
    const tokens = openGoogleTokens(data, {
      key: readGoogleTokenEncryptionKey(env, { required: false }),
      context: `${uid}:${provider.id || 'legacy-provider'}`,
    });
    credentials.push(tokens.refreshToken || tokens.accessToken);
  }

  // OAuth states are short-lived but deleting them immediately closes the
  // callback race: a state minted before account deletion can never reconnect
  // Google or recreate an integration document afterward.
  if (typeof db.collection === 'function') {
    // beginAccountDeletion has already advanced the durable account lock, so
    // createState cannot race new rows into this collection. Drain until empty
    // instead of silently abandoning accounts with more than 2,000 old states.
    for (;;) {
      const states = await db
        .collection('_oauthStates')
        .where('uid', '==', uid)
        .limit(200)
        .get();
      if (states.empty) break;
      const batch = db.batch();
      for (const state of states.docs) batch.delete(state.ref);
      await batch.commit();
      if (states.size < 200) break;
    }
  }

  // Provider credentials are stored in server-only encrypted subdocuments.
  // Google incremental authorization can leave the same user/app grant
  // represented in both provider records, so revoke each distinct credential
  // before recursively deleting the local credential tree.
  for (const credential of new Set(credentials.filter(Boolean))) {
    await revokeGoogleCredential(credential, { fetchImpl });
  }
  await db.recursiveDelete(ref);
}

export async function deletePublicCards({ db, uid }) {
  const snapshot = await db
    .collection('cards')
    .where('ownerUid', '==', uid)
    .get();
  for (const document of snapshot.docs) {
    await db.recursiveDelete(document.ref);
  }
}

export async function deletePrivateUserData({ db, uid }) {
  await db.recursiveDelete(db.doc(`users/${uid}`));
}

/**
 * Stores an opaque, non-identifying deletion receipt outside the account tree.
 * The random receipt ID is returned once to the user; the record deliberately
 * contains no UID, email, IP address, token, or CRM content.
 */
export function createAccountDeletionReceiptRepository(
  db,
  {
    now = () => new Date(),
    createId = randomUUID,
  } = {},
) {
  return Object.freeze({
    async begin() {
      const receiptId = createId();
      const startedAt = now();
      await db.doc(`_accountDeletionReceipts/${receiptId}`).set({
        schemaVersion: 1,
        status: 'pending',
        startedAt,
        updatedAt: startedAt,
        expiresAt: new Date(
          startedAt.getTime() + 365 * 24 * 60 * 60 * 1000,
        ),
      });
      return receiptId;
    },

    async complete(receiptId, completed) {
      const completedAt = now();
      await db.doc(`_accountDeletionReceipts/${receiptId}`).set(
        {
          status: 'completed',
          completedAt,
          updatedAt: completedAt,
          completedSteps: [...completed],
        },
        { merge: true },
      );
    },

    async incomplete(receiptId, completed, failureCode = 'unknown') {
      const updatedAt = now();
      await db.doc(`_accountDeletionReceipts/${receiptId}`).set(
        {
          status: 'incomplete',
          updatedAt,
          completedSteps: [...completed],
          failureCode:
            typeof failureCode === 'string'
              ? failureCode.slice(0, 80)
              : 'unknown',
        },
        { merge: true },
      );
    },
  });
}
