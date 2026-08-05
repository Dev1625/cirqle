import type { User } from 'firebase/auth';
import {
  doc,
  getDoc,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';

import { db } from '../config/firebase';
import { authenticatedFetch } from './authenticatedFetch';

export function initialUserProfile(
  user: Pick<User, 'uid' | 'displayName'>,
) {
  return {
    userId: user.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    name: user.displayName || null,
    role: null,
    company: null,
    bio: null,
    resumeText: null,
    targetIndustries: [],
  };
}

/**
 * Asks the authenticated server to activate the account-security boundary and
 * create the private root document if needed. Browsers can never recreate a
 * deleted account root with a stale token.
 */
export async function ensureVerifiedUserProfile(
  user: Pick<User, 'uid' | 'displayName' | 'emailVerified'>,
  firestore: Firestore = db,
) {
  if (!user.emailVerified) {
    const error = new Error('Email verification is required.');
    error.name = 'EmailVerificationRequiredError';
    throw error;
  }

  const response = await authenticatedFetch('/api/account/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const error = new Error(
      response.status === 410
        ? 'This account is no longer available.'
        : 'Your account could not be prepared. It is safe to retry.',
    );
    error.name = 'AccountBootstrapError';
    throw error;
  }

  const profileRef = doc(firestore, 'users', user.uid);
  const snapshot = await getDoc(profileRef);
  if (snapshot.exists()) return snapshot.data();

  const error = new Error(
    'Your account profile is still being prepared. Try again.',
  );
  error.name = 'AccountBootstrapError';
  throw error;
}
