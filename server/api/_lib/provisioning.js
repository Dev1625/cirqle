import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

import {
  hashLiteLLMKey,
  LiteLLMRequestError,
} from './litellm.js';
import { PRODUCTION_MODEL_ALIASES } from './ai-feature-policy.js';

export { PRODUCTION_MODEL_ALIASES };
export const BUDGET_LIMIT_USD = 5;
export const BUDGET_DURATION = '30d';
export const KEY_RPM_LIMIT = 60;
export const KEY_MAX_PARALLEL_REQUESTS = 4;

export const MANAGED_KEY_VERSION = 2;
const RACE_RECHECK_DELAYS_MS = Object.freeze([0, 30, 100]);

/**
 * LiteLLM's `/user/new` and `/user/update` accept only four `user_role`
 * values: proxy_admin, proxy_admin_viewer, internal_user, and
 * internal_user_viewer. `customer` exists in the LitellmUserRoles enum but is
 * a separate end-user concept and is excluded from these request models, so
 * sending it fails pydantic validation with a 422 before provisioning starts.
 * A Cirqle account is a budgeted key holder: internal_user.
 */
export const MANAGED_USER_ROLE = 'internal_user';

export function deriveManagedVirtualKey(uid, secret) {
  if (typeof uid !== 'string' || !uid) {
    throw new TypeError('A Firebase UID is required.');
  }
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError(
      'The virtual-key derivation secret must be at least 16 characters.',
    );
  }

  const digest = createHmac('sha256', secret)
    .update(`cirqle:litellm-key:v${MANAGED_KEY_VERSION}:${uid}`)
    .digest('base64url');
  return `sk-cirqle-${digest}`;
}

function managedMetadata(uid) {
  return {
    app: 'cirqle-web',
    firebase_uid: uid,
    managed_by: 'cirqle-provisioner',
    credential_version: MANAGED_KEY_VERSION,
  };
}

function managedKeyAlias(uid) {
  const subject = createHash('sha256')
    .update(uid)
    .digest('hex')
    .slice(0, 24);
  return `cirqle-firebase-${subject}`;
}

function managedPolicy(uid) {
  return {
    models: [...PRODUCTION_MODEL_ALIASES],
    max_budget: BUDGET_LIMIT_USD,
    budget_duration: BUDGET_DURATION,
    rpm_limit: KEY_RPM_LIMIT,
    max_parallel_requests: KEY_MAX_PARALLEL_REQUESTS,
    metadata: managedMetadata(uid),
  };
}

function managedUserPayload(identity) {
  return {
    user_id: identity.uid,
    ...(identity.email ? { user_email: identity.email } : {}),
    user_alias: identity.email || `Cirqle user ${identity.uid.slice(0, 8)}`,
    user_role: MANAGED_USER_ROLE,
    auto_create_key: false,
    ...managedPolicy(identity.uid),
  };
}

function managedKeyPayload(identity, apiKey) {
  return {
    key: apiKey,
    key_alias: managedKeyAlias(identity.uid),
    user_id: identity.uid,
    ...managedPolicy(identity.uid),
  };
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

function getKeyMetadata(keyInfo) {
  return (
    keyInfo?.metadata ||
    keyInfo?.info?.metadata ||
    keyInfo?.key?.metadata ||
    keyInfo?.key_info?.metadata ||
    {}
  );
}

function listedKeys(payload) {
  if (Array.isArray(payload)) return payload;
  for (const field of ['keys', 'data', 'key_list']) {
    if (Array.isArray(payload?.[field])) return payload[field];
  }
  return [];
}

function listedKeyIdentifier(record) {
  const candidates = [
    record?.token,
    record?.key,
    record?.key_name,
    record?.hashed_token,
    record?.token_hash,
    record?.info?.key,
    record?.info?.key_name,
  ];
  return candidates.find(
    (value) => typeof value === 'string' && value.trim(),
  ) || null;
}

async function revokeStaleManagedKeys(
  client,
  identity,
  currentKeyHash,
) {
  if (
    typeof client.listUserKeys !== 'function' ||
    typeof client.deleteKeys !== 'function'
  ) {
    return 0;
  }
  const records = listedKeys(
    await client.listUserKeys(identity.uid),
  );
  const stale = [];
  for (const record of records) {
    const metadata = getKeyMetadata(record);
    if (
      metadata.managed_by !== 'cirqle-provisioner' ||
      metadata.firebase_uid !== identity.uid
    ) {
      continue;
    }
    assertKeyOwner(record, identity.uid, {
      allowHistoricalVersion: true,
    });
    const identifier = listedKeyIdentifier(record);
    if (!identifier) {
      const error = new Error(
        'A managed key could not be identified for rotation.',
      );
      error.code = 'managed_key_rotation_unavailable';
      throw error;
    }
    const identifierHash = identifier.startsWith('sk-')
      ? hashLiteLLMKey(identifier)
      : identifier;
    if (identifierHash !== currentKeyHash) stale.push(identifier);
  }
  if (stale.length === 0) return 0;

  // Revoke previous managed credentials before creating the new one. During
  // a secret/version rotation this prefers a short, retryable AI outage over
  // two simultaneously active $5 allowances.
  await client.deleteKeys([...new Set(stale)]);
  for (const identifier of stale) {
    const identifierHash = identifier.startsWith('sk-')
      ? hashLiteLLMKey(identifier)
      : identifier;
    if (await client.getKey(identifierHash)) {
      const error = new Error(
        'A previous managed key remains active.',
      );
      error.code = 'managed_key_rotation_incomplete';
      throw error;
    }
  }
  return stale.length;
}

function assertKeyOwner(
  keyInfo,
  uid,
  { allowHistoricalVersion = false } = {},
) {
  const owner = getKeyOwner(keyInfo);
  if (typeof owner !== 'string' || !owner) {
    const error = new Error(
      'Managed virtual-key ownership could not be verified.',
    );
    error.code = 'managed_key_owner_mismatch';
    throw error;
  }

  const actual = Buffer.from(owner);
  const expected = Buffer.from(uid);
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    const error = new Error(
      'Managed virtual-key ownership could not be verified.',
    );
    error.code = 'managed_key_owner_mismatch';
    throw error;
  }

  const metadata = getKeyMetadata(keyInfo);
  const version = Number(metadata.credential_version);
  if (
    metadata.app !== 'cirqle-web' ||
    metadata.managed_by !== 'cirqle-provisioner' ||
    metadata.firebase_uid !== uid ||
    !Number.isInteger(version) ||
    version < 1 ||
    (
      allowHistoricalVersion
        ? version > MANAGED_KEY_VERSION
        : version !== MANAGED_KEY_VERSION
    )
  ) {
    const error = new Error(
      'Managed virtual-key metadata could not be verified.',
    );
    error.code = 'managed_key_metadata_mismatch';
    throw error;
  }
}

function delay(ms) {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

async function recheckAfterRace(getResource) {
  for (const waitMs of RACE_RECHECK_DELAYS_MS) {
    await delay(waitMs);
    const resource = await getResource();
    if (resource) return resource;
  }
  return null;
}

async function ensureManagedUser(client, identity) {
  let user = await client.getUser(identity.uid);
  if (!user) {
    try {
      await client.createUser(managedUserPayload(identity));
      return { created: true };
    } catch (createError) {
      // Another cold-start may have inserted the deterministic user between
      // our read and write. Re-read before treating the conflict as an outage.
      user = await recheckAfterRace(() => client.getUser(identity.uid));
      if (!user) throw createError;
    }
  }

  await client.updateUser({
    user_id: identity.uid,
    ...(identity.email ? { user_email: identity.email } : {}),
    user_alias: identity.email || `Cirqle user ${identity.uid.slice(0, 8)}`,
    user_role: MANAGED_USER_ROLE,
    ...managedPolicy(identity.uid),
  });
  return { created: false };
}

async function reconcileManagedKey(client, identity, keyHash, keyInfo) {
  assertKeyOwner(keyInfo, identity.uid);
  await client.updateKey({
    key: keyHash,
    key_alias: managedKeyAlias(identity.uid),
    user_id: identity.uid,
    ...managedPolicy(identity.uid),
  });
}

export async function provisionLiteLLMIdentity({
  client,
  identity,
  apiKey,
  beforeCreate,
}) {
  if (!client || !identity?.uid || !apiKey) {
    throw new TypeError('Provisioning requires a client, identity, and key.');
  }

  await ensureManagedUser(client, identity);

  const keyHash = hashLiteLLMKey(apiKey);
  const rotatedKeys = await revokeStaleManagedKeys(
    client,
    identity,
    keyHash,
  );
  let keyInfo = await client.getKey(keyHash);
  if (keyInfo) {
    await reconcileManagedKey(client, identity, keyHash, keyInfo);
    return {
      reused: true,
      keyHash,
      ...(rotatedKeys ? { rotatedKeys } : {}),
    };
  }

  try {
    if (beforeCreate) {
      await beforeCreate();
    }
    const created = await client.createKey(
      managedKeyPayload(identity, apiKey),
    );
    if (created?.key && created.key !== apiKey) {
      throw new LiteLLMRequestError({
        code: 'litellm_key_mismatch',
        status: 502,
      });
    }
    return {
      reused: false,
      keyHash,
      ...(rotatedKeys ? { rotatedKeys } : {}),
    };
  } catch (createError) {
    // The custom key is deterministic, so racing requests compete for the
    // same unique hash. The loser can safely return that same raw key after
    // ownership is verified; it never needs to mint a second credential.
    keyInfo = await recheckAfterRace(() => client.getKey(keyHash));
    if (!keyInfo) throw createError;

    await reconcileManagedKey(client, identity, keyHash, keyInfo);
    return {
      reused: true,
      keyHash,
      ...(rotatedKeys ? { rotatedKeys } : {}),
    };
  }
}
