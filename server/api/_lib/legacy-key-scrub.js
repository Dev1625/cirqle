import {
  FieldValue,
  getFirestore,
} from 'firebase-admin/firestore';

import { deleteLegacyLiteLLMCredentials } from './account-lifecycle.js';
import { getFirebaseAdminApp } from './firebase-admin.js';

export const LEGACY_AI_KEY_FIELDS = Object.freeze([
  'apiKey',
  'liteLLMApiKey',
  'litellmApiKey',
  'liteLLMKey',
  'litellmKey',
]);

function isMissingDocument(error) {
  return (
    error?.code === 5 ||
    error?.code === '5' ||
    error?.code === 'not-found'
  );
}

function legacyKeysFromData(data) {
  return [
    ...new Set(
      LEGACY_AI_KEY_FIELDS.map((field) => data?.[field]).filter(
        (value) => typeof value === 'string' && value,
      ),
    ),
  ];
}

/**
 * Migrates legacy client-readable AI credentials safely.
 *
 * Historical values exist only in this server function's memory. Every key
 * is ownership-verified and revoked before the Firestore fields are removed.
 * A partial gateway failure leaves the fields intact, making retry possible
 * instead of orphaning an active spend credential.
 */
export async function scrubLegacyAIKeyFields({
  uid,
  email = null,
  env = process.env,
  db,
  client,
  revokeLegacyKeys = deleteLegacyLiteLLMCredentials,
  deleteField = () => FieldValue.delete(),
}) {
  if (typeof uid !== 'string' || !uid) {
    const error = new Error('A Firebase UID is required.');
    error.code = 'legacy_key_scrub_failed';
    throw error;
  }

  const firestore =
    db || getFirestore(getFirebaseAdminApp(env));
  let snapshot;
  try {
    snapshot = await firestore.doc(`users/${uid}`).get();
  } catch (error) {
    const readError = new Error(
      'Legacy AI credential cleanup could not be completed.',
    );
    readError.code = 'legacy_key_scrub_failed';
    throw readError;
  }
  if (!snapshot?.exists) return { scrubbed: false, revoked: 0 };

  const legacyApiKeys = legacyKeysFromData(snapshot.data());
  if (legacyApiKeys.length > 0) {
    try {
      await revokeLegacyKeys({
        uid,
        email,
        legacyApiKeys,
        env,
        client,
      });
    } catch {
      const revokeError = new Error(
        'Legacy AI credential cleanup could not be completed.',
      );
      revokeError.code = 'legacy_key_scrub_failed';
      throw revokeError;
    }
  }

  const patch = Object.fromEntries(
    LEGACY_AI_KEY_FIELDS.map((field) => [field, deleteField()]),
  );

  try {
    await firestore.doc(`users/${uid}`).update(patch);
    return { scrubbed: true, revoked: legacyApiKeys.length };
  } catch (error) {
    if (isMissingDocument(error)) {
      return { scrubbed: false, revoked: legacyApiKeys.length };
    }
    const scrubError = new Error(
      'Legacy AI credential cleanup could not be completed.',
    );
    scrubError.code = 'legacy_key_scrub_failed';
    throw scrubError;
  }
}
