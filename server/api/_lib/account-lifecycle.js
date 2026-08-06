import {
  createLiteLLMClient,
  hashLiteLLMKey,
  LiteLLMRequestError,
} from './litellm.js';
import {
  deriveManagedVirtualKey,
} from './provisioning.js';
import { getExplicitLiteLLMConfig } from './litellm-config.js';

function getLiteLLMConfig(env) {
  return getExplicitLiteLLMConfig(env, {
    requireMasterKey: true,
    errorCode: 'account_cleanup_not_configured',
  });
}

function getKeyOwner(keyInfo) {
  return (
    keyInfo?.user_id ||
    keyInfo?.info?.user_id ||
    keyInfo?.key?.user_id ||
    keyInfo?.key_info?.user_id ||
    null
  );
}

function getMetadata(resource) {
  return (
    resource?.metadata ||
    resource?.info?.metadata ||
    resource?.key?.metadata ||
    resource?.key_info?.metadata ||
    {}
  );
}

function getUserEmail(user) {
  return (
    user?.user_email ||
    user?.email ||
    user?.info?.user_email ||
    user?.info?.email ||
    null
  );
}

async function assertLiteLLMOwnership(client, keyInfo, identity) {
  const owner = getKeyOwner(keyInfo);
  const keyFirebaseUid = getMetadata(keyInfo)?.firebase_uid;
  if (owner === identity.uid || keyFirebaseUid === identity.uid) return owner;

  if (owner) {
    const user = await client.getUser(owner);
    const userFirebaseUid = getMetadata(user)?.firebase_uid;
    const userEmail = getUserEmail(user);
    const emailsMatch =
      typeof identity.email === 'string' &&
      typeof userEmail === 'string' &&
      identity.email.toLowerCase() === userEmail.toLowerCase();
    if (userFirebaseUid === identity.uid || emailsMatch) return owner;
  }

  const error = new Error('LiteLLM key ownership could not be verified.');
  error.code = 'litellm_key_owner_mismatch';
  throw error;
}

async function deleteKeyIfPresent(client, apiKey, identity) {
  if (typeof apiKey !== 'string' || !apiKey) return null;

  const keyHash = hashLiteLLMKey(apiKey);
  const keyInfo = await client.getKey(keyHash);
  if (!keyInfo) return null;
  const owner = await assertLiteLLMOwnership(client, keyInfo, identity);

  try {
    await client.request('/key/delete', {
      method: 'POST',
      body: { keys: [apiKey] },
    });
  } catch (error) {
    // A concurrent retry may have deleted the key between our read and write.
    // Re-reading turns that race into a successful idempotent outcome.
    if (error instanceof LiteLLMRequestError) {
      const remaining = await client.getKey(keyHash);
      if (!remaining) return owner;
    }
    throw error;
  }

  return owner;
}

async function deleteUserIfPresent(client, userId) {
  if (typeof userId !== 'string' || !userId) return;
  const user = await client.getUser(userId);
  if (!user) return;

  try {
    await client.request('/user/delete', {
      method: 'POST',
      body: { user_ids: [userId] },
    });
  } catch (error) {
    if (error instanceof LiteLLMRequestError) {
      const remaining = await client.getUser(userId);
      if (!remaining) return;
    }
    throw error;
  }
}

/**
 * Deletes both the deterministic managed credential and any legacy raw key
 * that an older build stored on the private user document. Key ownership is
 * read before deletion so legacy LiteLLM users with generated UUIDs are also
 * removed instead of leaving spend metadata behind.
 */
export async function deleteLiteLLMIdentity({
  uid,
  email = null,
  legacyApiKey,
  legacyApiKeys = [],
  env = process.env,
  client,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  const config = getLiteLLMConfig(env);
  const liteLLM =
    client ||
    createLiteLLMClient({
      baseUrl: config.baseUrl,
      masterKey: config.masterKey,
      fetchImpl,
      logger,
    });
  const managedApiKey = deriveManagedVirtualKey(
    uid,
    config.derivationSecret,
  );
  const keys = new Set([managedApiKey]);
  if (typeof legacyApiKey === 'string' && legacyApiKey) {
    keys.add(legacyApiKey);
  }
  for (const candidate of legacyApiKeys) {
    if (typeof candidate === 'string' && candidate) {
      keys.add(candidate);
    }
  }

  const userIds = new Set([uid]);
  const identity = { uid, email };
  for (const apiKey of keys) {
    const owner = await deleteKeyIfPresent(liteLLM, apiKey, identity);
    if (owner) userIds.add(owner);
  }
  for (const userId of userIds) {
    await deleteUserIfPresent(liteLLM, userId);
  }
}

/**
 * Revokes historical browser-stored credentials without disturbing the
 * newly provisioned deterministic key. A legacy UUID user is removed only
 * after every supplied key has been deleted and ownership has been proven.
 * The current Firebase-UID LiteLLM user is deliberately retained.
 */
export async function deleteLegacyLiteLLMCredentials({
  uid,
  email = null,
  legacyApiKeys = [],
  env = process.env,
  client,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  const keys = new Set(
    legacyApiKeys.filter(
      (candidate) => typeof candidate === 'string' && candidate,
    ),
  );
  if (keys.size === 0) return { deletedKeys: 0, deletedLegacyUsers: 0 };

  const config = getLiteLLMConfig(env);
  const liteLLM =
    client ||
    createLiteLLMClient({
      baseUrl: config.baseUrl,
      masterKey: config.masterKey,
      fetchImpl,
      logger,
    });
  const identity = { uid, email };
  const legacyUserIds = new Set();

  for (const apiKey of keys) {
    const owner = await deleteKeyIfPresent(liteLLM, apiKey, identity);
    if (owner && owner !== uid) legacyUserIds.add(owner);
  }
  for (const userId of legacyUserIds) {
    await deleteUserIfPresent(liteLLM, userId);
  }

  return {
    deletedKeys: keys.size,
    deletedLegacyUsers: legacyUserIds.size,
  };
}

export const ACCOUNT_DELETION_STEPS = Object.freeze([
  'aiIdentity',
  'oauthIdentity',
  'publicCards',
  'privateData',
  'firebaseAuth',
]);

/**
 * Ordered and retry-safe by contract: every dependency must tolerate missing
 * state, and Firebase Auth is always last so a failed earlier step leaves the
 * caller able to reauthenticate and retry.
 */
export async function runAccountDeletion({
  identity,
  legacyApiKey,
  legacyApiKeys = [],
  services,
  receiptRepository = null,
}) {
  const completed = [];
  let accountLockStatus = services.finalizeAccountLock
    ? 'deleting'
    : 'not-managed';
  const receiptId = receiptRepository
    ? await receiptRepository.begin()
    : null;

  try {
    await services.deleteLiteLLMIdentity({
      uid: identity.uid,
      email: identity.email,
      legacyApiKey,
      legacyApiKeys,
    });
    completed.push('aiIdentity');

    await services.deleteOAuthIdentity({ uid: identity.uid });
    completed.push('oauthIdentity');

    await services.deletePublicCards({ uid: identity.uid });
    completed.push('publicCards');

    await services.deletePrivateUserData({ uid: identity.uid });
    completed.push('privateData');

    try {
      await services.deleteAuthUser(identity.uid);
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
    completed.push('firebaseAuth');

    // Only a successfully removed Auth identity may receive the expiring
    // terminal tombstone. If Auth deletion fails, the non-expiring `deleting`
    // lock created by the endpoint remains in place and the still-signed-in
    // user can safely retry without ever being reactivated by TTL cleanup.
    if (services.finalizeAccountLock) {
      try {
        await services.finalizeAccountLock({ uid: identity.uid });
        accountLockStatus = 'deleted';
      } catch {
        // Auth is already gone, so a retained non-expiring `deleting` marker
        // is safe and cannot be retried by the former user. Operational
        // cleanup can finalize this minimal tombstone later.
        accountLockStatus = 'deleting';
      }
    }
  } catch (error) {
    if (receiptId) {
      await receiptRepository
        .incomplete(receiptId, completed, error?.code || 'unknown')
        .catch(() => undefined);
      error.deletionReceipt = {
        id: receiptId,
        status: 'incomplete',
        completedSteps: [...completed],
      };
    }
    throw error;
  }

  let receiptStatus = receiptId ? 'completed' : 'not-recorded';
  if (receiptId) {
    try {
      await receiptRepository.complete(receiptId, completed);
    } catch {
      // The pending receipt was durably created before deletion. A transient
      // completion update must not misreport a successfully deleted account.
      receiptStatus = 'pending';
    }
  }

  return {
    completed,
    receiptId,
    receiptStatus,
    accountLockStatus,
  };
}
