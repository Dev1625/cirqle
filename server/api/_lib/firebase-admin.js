import {
  applicationDefault,
  cert,
  getApp,
  initializeApp,
} from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

import { assertAccountActive } from './account-security.js';
import { readHeader } from './http.js';

const ADMIN_APP_NAME = 'cirqle-api';
export const PRODUCTION_FIREBASE_PROJECT_ID = 'cirqle-9dd06';

export class AuthError extends Error {
  constructor(message = 'Authentication required.') {
    super(message);
    this.name = 'AuthError';
    this.code = 'unauthorized';
    this.status = 401;
  }
}

export class FirebaseAuthUnavailableError extends Error {
  constructor() {
    super('Firebase Admin authentication is unavailable.');
    this.name = 'FirebaseAuthUnavailableError';
    this.code = 'authentication_unavailable';
    this.status = 503;
  }
}

const INVALID_ID_TOKEN_CODES = new Set([
  'auth/argument-error',
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/invalid-id-token',
  'auth/user-disabled',
  'auth/user-not-found',
]);

function projectIdFromFirebaseConfig(value) {
  if (!value || typeof value !== 'string' || !value.trim().startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed.projectId === 'string' ? parsed.projectId : undefined;
  } catch {
    return undefined;
  }
}

function parseServiceAccount(env) {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let parsed;
    try {
      parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch {
      const error = new Error(
        'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.',
      );
      error.code = 'firebase_admin_config_invalid';
      throw error;
    }

    if (typeof parsed.private_key === 'string') {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  }

  const projectId = env.FIREBASE_PROJECT_ID;
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    return {
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    };
  }

  return null;
}

function normalizedProjectId(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

export function resolveFirebaseAdminProjectId(env = process.env) {
  let serviceAccountProjectId = null;
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let parsed;
    try {
      parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch {
      const error = new Error(
        'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.',
      );
      error.code = 'firebase_admin_config_invalid';
      throw error;
    }
    serviceAccountProjectId = normalizedProjectId(
      parsed.project_id || parsed.projectId,
    );
  }

  const candidates = [
    normalizedProjectId(env.FIREBASE_PROJECT_ID),
    serviceAccountProjectId,
    normalizedProjectId(env.GOOGLE_CLOUD_PROJECT),
    normalizedProjectId(env.GCLOUD_PROJECT),
    normalizedProjectId(
      projectIdFromFirebaseConfig(env.FIREBASE_CONFIG),
    ),
  ].filter(Boolean);
  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    const error = new Error(
      'Firebase Admin project configuration is inconsistent.',
    );
    error.code = 'firebase_admin_environment_invalid';
    throw error;
  }

  const projectId = unique[0] || null;
  if (env.VERCEL_ENV === 'preview') {
    if (!projectId || projectId === PRODUCTION_FIREBASE_PROJECT_ID) {
      const error = new Error(
        'Preview Firebase Admin must use an explicit isolated project.',
      );
      error.code = 'firebase_admin_environment_invalid';
      throw error;
    }
  } else if (env.VERCEL_ENV === 'production') {
    if (projectId !== PRODUCTION_FIREBASE_PROJECT_ID) {
      const error = new Error(
        'Production Firebase Admin must use the reviewed project.',
      );
      error.code = 'firebase_admin_environment_invalid';
      throw error;
    }
  }
  return projectId;
}

export function getFirebaseAdminApp(env = process.env) {
  try {
    return getApp(ADMIN_APP_NAME);
  } catch {
    const serviceAccount = parseServiceAccount(env);
    const projectId = resolveFirebaseAdminProjectId(env);

    return initializeApp(
      {
        credential: serviceAccount
          ? cert(serviceAccount)
          : applicationDefault(),
        ...(projectId ? { projectId } : {}),
      },
      ADMIN_APP_NAME,
    );
  }
}

export function getFirebaseAdminAuth(env = process.env) {
  return getAuth(getFirebaseAdminApp(env));
}

function extractBearerToken(req) {
  const authorization = readHeader(req, 'authorization');
  if (typeof authorization !== 'string') {
    throw new AuthError();
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization.trim());
  if (!match) {
    throw new AuthError();
  }

  return match[1];
}

export async function verifyBearerFirebaseToken(
  req,
  {
    verifyIdToken = (token, checkRevoked) =>
      getFirebaseAdminAuth().verifyIdToken(token, checkRevoked),
  } = {},
) {
  const token = extractBearerToken(req);

  let decoded;
  try {
    // Revocation checking rejects disabled users and explicitly revoked
    // sessions instead of trusting a still-unexpired client token.
    decoded = await verifyIdToken(token, true);
  } catch (error) {
    if (INVALID_ID_TOKEN_CODES.has(error?.code)) {
      throw new AuthError();
    }
    // Unknown/Admin credential/network failures are operational outages. Do
    // not mislabel them as bad user credentials or expose their internals.
    throw new FirebaseAuthUnavailableError();
  }

  const uid =
    typeof decoded?.uid === 'string'
      ? decoded.uid
      : typeof decoded?.sub === 'string'
        ? decoded.sub
        : '';
  if (!uid) {
    throw new AuthError();
  }

  return Object.freeze({
    uid,
    email:
      typeof decoded.email === 'string' && decoded.email.trim()
        ? decoded.email.trim()
        : null,
    emailVerified: decoded.email_verified === true,
    name:
      typeof decoded.name === 'string' && decoded.name.trim()
        ? decoded.name.trim()
        : null,
    authTime:
      Number.isFinite(Number(decoded.auth_time))
        ? Number(decoded.auth_time)
        : null,
  });
}

/**
 * Verifies Firebase Auth and the durable account-security lock. Normal API
 * routes use this helper so an unexpired token cannot keep using server-side
 * features after session revocation or while account deletion is running.
 * Bootstrap and deletion deliberately use the raw verifier.
 */
export async function verifyActiveBearerFirebaseToken(req, options = {}) {
  const identity = await verifyBearerFirebaseToken(req, options);
  const db =
    options.db ||
    getFirestore(getFirebaseAdminApp(options.env || process.env));
  await assertAccountActive({
    db,
    uid: identity.uid,
    authTime: identity.authTime,
  });
  return identity;
}
