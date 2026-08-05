import {
  collection,
  doc,
  getDoc,
  serverTimestamp,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { db } from '../../config/firebase';
import {
  DEFAULT_SOURCE_PRIVACY_POLICY,
  normalizeSourcePrivacyPolicy,
  type SourcePrivacyPolicy,
} from './privacyPolicy';

function changeId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `privacy-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
export async function loadSourcePrivacyPolicy(
  uid: string,
  firestore: Firestore = db,
): Promise<SourcePrivacyPolicy> {
  const snapshot = await getDoc(
    doc(firestore, `users/${uid}/settings/privacy`),
  );
  if (!snapshot.exists()) {
    return {
      ...DEFAULT_SOURCE_PRIVACY_POLICY,
      boundaries: [],
    };
  }
  return normalizeSourcePrivacyPolicy(snapshot.data() as SourcePrivacyPolicy);
}

/**
 * Persists the current policy and an append-only audit event together. The
 * audit event contains policy settings only—never source content.
 */
export async function saveSourcePrivacyPolicy(
  uid: string,
  policy: SourcePrivacyPolicy,
  firestore: Firestore = db,
): Promise<SourcePrivacyPolicy> {
  const normalized = normalizeSourcePrivacyPolicy(policy);
  const batch = writeBatch(firestore);
  const policyRef = doc(firestore, `users/${uid}/settings/privacy`);
  const auditRef = doc(
    collection(firestore, `users/${uid}/privacyPolicyEvents`),
    changeId(),
  );
  batch.set(policyRef, {
    ...normalized,
    updatedAt: serverTimestamp(),
  });
  batch.set(auditRef, {
    schemaVersion: 1,
    kind: 'privacy-policy-replaced',
    policy: normalized,
    actorUid: uid,
    recordedAt: serverTimestamp(),
  });
  await batch.commit();
  return normalized;
}
