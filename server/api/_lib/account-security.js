import { FieldValue } from 'firebase-admin/firestore';

export const ACCOUNT_SECURITY_COLLECTION = '_accountSecurity';

export class AccountSecurityError extends Error {
  constructor({
    code = 'account_security_unavailable',
    message = 'Account security state is unavailable.',
    status = 503,
  } = {}) {
    super(message);
    this.name = 'AccountSecurityError';
    this.code = code;
    this.status = status;
  }
}

function safeUid(uid) {
  if (
    typeof uid !== 'string' ||
    !uid ||
    uid.length > 128 ||
    uid.includes('/')
  ) {
    throw new AccountSecurityError({
      code: 'unauthorized',
      message: 'Authentication required.',
      status: 401,
    });
  }
  return uid;
}

function nowSeconds(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(value)) {
    throw new AccountSecurityError();
  }
  return Math.floor(value / 1000);
}

function securityRef(db, uid) {
  return db.doc(`${ACCOUNT_SECURITY_COLLECTION}/${safeUid(uid)}`);
}

function assertFreshAuthentication(account, authTime) {
  const authenticatedAt = Number(authTime);
  const revokedAfterSeconds =
    Number(account?.revokedAfterSeconds) || 0;
  if (
    !Number.isFinite(authenticatedAt) ||
    authenticatedAt <= revokedAfterSeconds
  ) {
    throw new AccountSecurityError({
      code: 'session_revoked',
      message: 'Please sign in again to continue.',
      status: 401,
    });
  }
}

export async function bootstrapVerifiedAccount({
  db,
  identity,
  now = new Date(),
}) {
  if (
    !identity?.uid ||
    !identity.email ||
    identity.emailVerified !== true
  ) {
    throw new AccountSecurityError({
      code: 'email_verification_required',
      message: 'Verify your email before creating CRM data.',
      status: 403,
    });
  }
  const uid = safeUid(identity.uid);
  const accountRef = securityRef(db, uid);
  const profileRef = db.doc(`users/${uid}`);

  return db.runTransaction(async (transaction) => {
    const [accountSnapshot, profileSnapshot] = await Promise.all([
      transaction.get(accountRef),
      transaction.get(profileRef),
    ]);
    const account = accountSnapshot.exists
      ? accountSnapshot.data() || {}
      : null;
    if (account && account.status !== 'active') {
      throw new AccountSecurityError({
        code: 'account_unavailable',
        message: 'This account is not available.',
        status: 410,
      });
    }
    if (account) {
      assertFreshAuthentication(account, identity.authTime);
    }

    if (!account) {
      transaction.create(accountRef, {
        status: 'active',
        revokedAfterSeconds: 0,
        activatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (!profileSnapshot.exists) {
      transaction.create(profileRef, {
        userId: uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        name:
          typeof identity.name === 'string' && identity.name.trim()
            ? identity.name.trim().slice(0, 160)
            : null,
        role: null,
        company: null,
        bio: null,
        resumeText: null,
        targetIndustries: [],
      });
    }

    return {
      ready: true,
      profileCreated: !profileSnapshot.exists,
      accountCreated: !account,
      checkedAtSeconds: nowSeconds(now),
    };
  });
}

export async function assertAccountActive({ db, uid, authTime }) {
  const snapshot = await securityRef(db, uid).get();
  if (!snapshot.exists || snapshot.data()?.status !== 'active') {
    throw new AccountSecurityError({
      code: 'account_unavailable',
      message: 'This account is not available.',
      status: 410,
    });
  }
  const account = snapshot.data();
  assertFreshAuthentication(account, authTime);
  return account;
}

export async function beginAccountDeletion({
  db,
  uid,
  now = new Date(),
}) {
  const ref = securityRef(db, uid);
  const revokedAfterSeconds = nowSeconds(now);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() || {} : {};
    if (current.status === 'deleted') return;
    transaction.set(
      ref,
      {
        status: 'deleting',
        revokedAfterSeconds: Math.max(
          Number(current.revokedAfterSeconds) || 0,
          revokedAfterSeconds,
        ),
        deletionStartedAt:
          current.deletionStartedAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
  return { revokedAfterSeconds };
}

export async function completeAccountDeletion({
  db,
  uid,
  now = new Date(),
}) {
  const ref = securityRef(db, uid);
  const deletionTime =
    now instanceof Date ? new Date(now.getTime()) : new Date(Number(now));
  const expiresAt = new Date(
    deletionTime.getTime() + 48 * 60 * 60 * 1000,
  );
  await ref.set(
    {
      status: 'deleted',
      revokedAfterSeconds: nowSeconds(now),
      deletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      // Firebase ID tokens expire after one hour. Retaining this minimal,
      // non-profile tombstone for 48 hours prevents an already-issued token
      // from recreating data, while still allowing automatic privacy cleanup.
      expiresAt,
    },
    { merge: true },
  );
}

export async function revokeAccountSessionsAt({
  db,
  uid,
  now = new Date(),
}) {
  const ref = securityRef(db, uid);
  const revokedAfterSeconds = nowSeconds(now);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data()?.status !== 'active') {
      throw new AccountSecurityError({
        code: 'account_unavailable',
        message: 'This account is not available.',
        status: 410,
      });
    }
    transaction.update(ref, {
      revokedAfterSeconds: Math.max(
        Number(snapshot.data()?.revokedAfterSeconds) || 0,
        revokedAfterSeconds,
      ),
      sessionsRevokedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { revokedAfterSeconds };
}
