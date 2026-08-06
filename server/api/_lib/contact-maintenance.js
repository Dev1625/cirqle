import { createHash, randomUUID } from 'node:crypto';

import { FieldValue } from 'firebase-admin/firestore';

const PURGE_REQUESTS = 'contactPurgeRequests';
const MERGE_RECOVERY_REQUESTS = 'contactMergeRecoveryRequests';
const MAINTENANCE_PROTOCOL_VERSION = 1;
const DEFAULT_MAX_REQUESTS = 4;
const MAX_MAX_REQUESTS = 20;
const DEFAULT_MAX_MUTATIONS = 200;
const MAX_MAX_MUTATIONS = 400;
const MIN_MAX_MUTATIONS = 10;
const PURGE_FENCE_WRITES = 1;
const PURGE_FINALIZATION_WRITES = 2;
const MERGE_BASE_FINALIZATION_WRITES = 6;
const PURGE_LEASE_DURATION_MS = 5 * 60 * 1000;

const ROOT_REFERENCES = Object.freeze([
  Object.freeze({ collectionName: 'notes', kind: 'note' }),
  Object.freeze({ collectionName: 'outreaches', kind: 'outreach' }),
  Object.freeze({ collectionName: 'commitments', kind: 'commitment' }),
  Object.freeze({ collectionName: 'threads', kind: 'thread' }),
  Object.freeze({
    collectionName: 'voiceEnrichmentJobs',
    kind: 'voice-enrichment',
  }),
]);

const NESTED_REFERENCES = Object.freeze([
  Object.freeze({ collectionName: 'facts', kind: 'fact' }),
  Object.freeze({ collectionName: 'jobHistory', kind: 'job-history' }),
]);

const CONTACT_EVENT_REFERENCE_FIELDS = Object.freeze([
  'contactId',
  'payload.primaryContactId',
  'payload.duplicateContactId',
  'payload.mergedIntoContactId',
]);

const CONNECTION_REFERENCE_FIELDS = Object.freeze([
  'sourceId',
  'targetId',
  'migratedFromContactId',
]);

const CONNECTION_MERGE_FIELDS = Object.freeze([
  'contactMergeOperationId',
  'migratedFromContactId',
  'migratedFromPath',
  'migratedToPath',
  'originalConnectionEndpoints',
  'mergeHistorical',
  'mergeSuppressed',
  'mergeRecoverySourceOperationId',
  'migrationRecordedAt',
]);

const MERGE_OPERATION_PRIVATE_FIELDS = Object.freeze([
  'duplicateContactId',
  'requestFingerprint',
  'choices',
  'primaryBefore',
  'duplicateBefore',
  'resolvedProfile',
]);

const PROFILE_FIELDS = Object.freeze([
  'name',
  'email',
  'phone',
  'company',
  'role',
  'location',
  'linkedinUrl',
  'summary',
  'relationshipTier',
  'industry',
  'subIndustry',
  'school',
  'seniority',
  'connectionSource',
  'whyTheyMatter',
  'tags',
]);

const PROFILE_FACT_FIELDS = Object.freeze({
  name: 'identity.name',
  email: 'identity.email',
  phone: 'identity.phone',
  company: 'identity.company',
  role: 'identity.role',
  location: 'identity.location',
  linkedinUrl: 'identity.linkedinUrl',
  summary: 'identity.summary',
  industry: 'identity.industry',
  subIndustry: 'identity.subIndustry',
  school: 'identity.school',
  seniority: 'identity.seniority',
  relationshipTier: 'relationship.tier',
  whyTheyMatter: 'relationship.whyTheyMatter',
  connectionSource: 'relationship.connectionSource',
  tags: 'relationship.tags',
});

const COMPLETED_MERGE_STATUSES = new Set([
  'completed',
  'completed-fact-sync-pending',
]);

export class ContactMaintenanceError extends Error {
  constructor({
    code = 'contact_maintenance_invalid',
    message = 'The contact-maintenance request is invalid.',
    status = 400,
    disposition = 'needs-review',
  } = {}) {
    super(message);
    this.name = 'ContactMaintenanceError';
    this.code = code;
    this.status = status;
    this.disposition = disposition;
  }
}

function maintenanceError(code, disposition = 'needs-review') {
  return new ContactMaintenanceError({
    code,
    disposition,
    status: disposition === 'deferred' ? 409 : 400,
  });
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ContactMaintenanceError({
      code: 'contact_maintenance_invalid',
      message: `${field} must be an integer between ${minimum} and ${maximum}.`,
    });
  }
  return parsed;
}

export function normalizeContactMaintenanceLimits({
  maxRequests,
  maxMutations,
} = {}) {
  return Object.freeze({
    maxRequests: boundedInteger(
      maxRequests,
      DEFAULT_MAX_REQUESTS,
      1,
      MAX_MAX_REQUESTS,
      'maxRequests',
    ),
    maxMutations: boundedInteger(
      maxMutations,
      DEFAULT_MAX_MUTATIONS,
      MIN_MAX_MUTATIONS,
      MAX_MAX_MUTATIONS,
      'maxMutations',
    ),
  });
}

function safeSegment(value) {
  const segment = typeof value === 'string' ? value.trim() : '';
  if (!segment || segment.length > 1_500 || segment.includes('/')) {
    throw maintenanceError('contact_maintenance_metadata_invalid');
  }
  return segment;
}

function valueDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (value && typeof value.toDate === 'function') {
    try {
      const converted = value.toDate();
      return converted instanceof Date && !Number.isNaN(converted.getTime())
        ? converted
        : null;
    } catch {
      return null;
    }
  }
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function requestTime(data) {
  return valueDate(data?.requestedAt)?.getTime() || 0;
}

function cleanProfileText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeProfileTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const tags = [];
  for (const candidate of value) {
    const tag = cleanProfileText(candidate).slice(0, 80);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === 40) break;
  }
  return tags;
}

function profileSnapshot(value) {
  const source = value && typeof value === 'object' ? value : {};
  const profile = {};
  for (const field of PROFILE_FIELDS) {
    if (field === 'tags') {
      profile.tags = normalizeProfileTags(source.tags);
    } else if (field === 'relationshipTier') {
      profile.relationshipTier = ['Cold', 'Warm', 'Strong'].includes(
        source.relationshipTier,
      )
        ? source.relationshipTier
        : 'Cold';
    } else if (field === 'summary' || field === 'whyTheyMatter') {
      profile[field] = String(source[field] ?? '')
        .normalize('NFKC')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trim().replace(/[ \t]+/g, ' '))
        .join('\n')
        .trim();
    } else {
      profile[field] = cleanProfileText(source[field]);
    }
  }
  return profile;
}

function profilesEqual(left, right) {
  return (
    JSON.stringify(profileSnapshot(left)) === JSON.stringify(profileSnapshot(right))
  );
}

function normalizeFactValue(value) {
  const scalar = Array.isArray(value) ? value.join(', ') : value;
  return String(scalar ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function deterministicId(prefix, ...parts) {
  const digest = createHash('sha256')
    .update(parts.join('\u001f'))
    .digest('hex')
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

function subjectHash(uid) {
  return createHash('sha256').update(uid).digest('hex').slice(0, 16);
}

function safeErrorCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9._/-]{1,80}$/.test(code) ? code : 'unknown';
}

function requestCollection(kind) {
  if (kind === 'purge') return PURGE_REQUESTS;
  if (kind === 'merge-recovery') return MERGE_RECOVERY_REQUESTS;
  throw maintenanceError('contact_maintenance_metadata_invalid');
}

function requestPath(uid, kind, requestId) {
  return `users/${safeSegment(uid)}/${requestCollection(kind)}/${safeSegment(
    requestId,
  )}`;
}

function contactPath(uid, contactId) {
  return `users/${safeSegment(uid)}/contacts/${safeSegment(contactId)}`;
}

function mergeOperationPath(uid, operationId) {
  return `users/${safeSegment(uid)}/contactMergeOperations/${safeSegment(
    operationId,
  )}`;
}

function documentRecord(snapshot) {
  return snapshot?.exists
    ? Object.freeze({
        id: snapshot.id,
        path: snapshot.ref.path,
        data: snapshot.data() || {},
      })
    : null;
}

function parseScheduledDescriptor(kind, snapshot) {
  const parts = String(snapshot?.ref?.path || '').split('/');
  if (
    parts.length !== 4 ||
    parts[0] !== 'users' ||
    parts[2] !== requestCollection(kind) ||
    parts[3] !== snapshot.id
  ) {
    return null;
  }
  try {
    return Object.freeze({
      kind,
      uid: safeSegment(parts[1]),
      id: safeSegment(parts[3]),
      data: snapshot.data() || {},
    });
  } catch {
    return null;
  }
}

function validateDescriptor(descriptor) {
  const uid = safeSegment(descriptor?.uid);
  const id = safeSegment(descriptor?.id);
  const kind = descriptor?.kind;
  const data =
    descriptor?.data && typeof descriptor.data === 'object'
      ? descriptor.data
      : {};

  if (
    data.status !== 'queued' ||
    data.requiresServerExecution !== true ||
    data.actorUid !== uid
  ) {
    throw maintenanceError('contact_maintenance_ownership_invalid');
  }

  if (kind === 'purge') {
    if (
      data.contactId !== id ||
      (data.plan?.contactId != null && data.plan.contactId !== id)
    ) {
      throw maintenanceError('contact_maintenance_metadata_invalid');
    }
    return Object.freeze({ kind, uid, id, contactId: id, data });
  }

  if (kind === 'merge-recovery') {
    if (
      data.operationId !== id ||
      data.recoveryProtocolVersion !== MAINTENANCE_PROTOCOL_VERSION
    ) {
      throw maintenanceError('contact_maintenance_metadata_invalid');
    }
    const primaryContactId = safeSegment(data.primaryContactId);
    const duplicateContactId = safeSegment(data.duplicateContactId);
    if (primaryContactId === duplicateContactId) {
      throw maintenanceError('contact_maintenance_metadata_invalid');
    }
    return Object.freeze({
      kind,
      uid,
      id,
      operationId: id,
      primaryContactId,
      duplicateContactId,
      data,
    });
  }

  throw maintenanceError('contact_maintenance_metadata_invalid');
}

function assertPurgeContext({ request, contact, now }) {
  const descriptor = validateDescriptor(request);
  if (descriptor.kind !== 'purge') {
    throw maintenanceError('contact_maintenance_metadata_invalid');
  }
  if (!contact || contact.id !== descriptor.contactId) {
    throw maintenanceError('contact_purge_contact_missing');
  }
  const data = contact.data || {};
  const eligibleAt = valueDate(data.purgeEligibleAt);
  if (data.lifecycleStatus !== 'deleted' || !eligibleAt) {
    throw maintenanceError('contact_purge_state_invalid');
  }
  if (now.getTime() < eligibleAt.getTime()) {
    throw maintenanceError('contact_purge_not_yet_eligible', 'deferred');
  }
  return Object.freeze({ descriptor, eligibleAt });
}

function assertPurgeLease({
  descriptor,
  contact,
  lease,
  now,
}) {
  const validated = validateDescriptor(descriptor);
  const checkedAt = valueDate(now);
  const leaseExpiresAt = valueDate(lease?.leaseExpiresAt);
  const fence = contact?.data?.purgeFence;
  const fenceExpiresAt = valueDate(fence?.leaseExpiresAt);
  if (
    !checkedAt ||
    !leaseExpiresAt ||
    !fenceExpiresAt ||
    lease?.requestId !== validated.id ||
    typeof lease?.leaseId !== 'string' ||
    !lease.leaseId ||
    fence?.protocolVersion !== MAINTENANCE_PROTOCOL_VERSION ||
    fence?.requestId !== validated.id ||
    fence?.leaseId !== lease.leaseId ||
    fenceExpiresAt.getTime() !== leaseExpiresAt.getTime()
  ) {
    throw maintenanceError('contact_purge_lease_lost', 'deferred');
  }
  if (checkedAt.getTime() >= fenceExpiresAt.getTime()) {
    throw maintenanceError('contact_purge_lease_expired', 'deferred');
  }
  return Object.freeze({
    requestId: validated.id,
    leaseId: lease.leaseId,
    leaseExpiresAt,
  });
}

function assertMergeContext({ request, operation, primary, duplicate, now }) {
  const descriptor = validateDescriptor(request);
  if (descriptor.kind !== 'merge-recovery') {
    throw maintenanceError('contact_maintenance_metadata_invalid');
  }
  if (!operation || operation.id !== descriptor.operationId) {
    throw maintenanceError('contact_merge_operation_missing');
  }
  const operationData = operation.data || {};

  if (
    operationData.actorUid !== descriptor.uid ||
    operationData.primaryContactId !== descriptor.primaryContactId ||
    operationData.duplicateContactId !== descriptor.duplicateContactId
  ) {
    throw maintenanceError('contact_maintenance_ownership_invalid');
  }

  if (operationData.status === 'recovered') {
    if (
      operationData.recoveryRequestId === descriptor.id &&
      operationData.recoveryProtocolVersion === MAINTENANCE_PROTOCOL_VERSION
    ) {
      return Object.freeze({ descriptor, alreadyRecovered: true });
    }
    throw maintenanceError('contact_merge_operation_state_invalid');
  }

  if (!COMPLETED_MERGE_STATUSES.has(operationData.status)) {
    throw maintenanceError('contact_merge_operation_state_invalid');
  }
  if (
    !primary ||
    !duplicate ||
    primary.id !== descriptor.primaryContactId ||
    duplicate.id !== descriptor.duplicateContactId
  ) {
    throw maintenanceError('contact_merge_contact_missing');
  }

  const primaryData = primary.data || {};
  const duplicateData = duplicate.data || {};
  const eligibleAt = valueDate(duplicateData.purgeEligibleAt);
  if (!eligibleAt || now.getTime() >= eligibleAt.getTime()) {
    throw maintenanceError('contact_merge_recovery_expired', 'expired');
  }
  if (
    primaryData.lifecycleStatus === 'deleted' ||
    duplicateData.lifecycleStatus !== 'deleted' ||
    duplicateData.mergedIntoContactId !== descriptor.primaryContactId ||
    duplicateData.contactMergeOperationId !== descriptor.operationId ||
    !Array.isArray(primaryData.mergedFromContactIds) ||
    !primaryData.mergedFromContactIds.includes(descriptor.duplicateContactId)
  ) {
    throw maintenanceError('contact_merge_contact_state_invalid');
  }
  if (
    !profilesEqual(primaryData, operationData.resolvedProfile) ||
    !profilesEqual(duplicateData, operationData.duplicateBefore)
  ) {
    throw maintenanceError('contact_merge_profile_changed');
  }
  if (
    !operationData.primaryBefore ||
    !operationData.duplicateBefore ||
    !operationData.resolvedProfile
  ) {
    throw maintenanceError('contact_merge_snapshot_missing');
  }

  return Object.freeze({
    descriptor,
    alreadyRecovered: false,
    operationStatus: operationData.status,
    primaryBefore: profileSnapshot(operationData.primaryBefore),
    duplicateBefore: profileSnapshot(operationData.duplicateBefore),
    resolvedProfile: profileSnapshot(operationData.resolvedProfile),
  });
}

function factRestorationPlan({ currentByPredicate, context }) {
  const entries = [];
  for (const [field, predicate] of Object.entries(PROFILE_FACT_FIELDS)) {
    const beforeValue = context.primaryBefore[field];
    const resolvedValue = context.resolvedProfile[field];
    const before = normalizeFactValue(beforeValue);
    const resolved = normalizeFactValue(resolvedValue);
    if (before === resolved) continue;

    const current = currentByPredicate.get(predicate) || [];
    if (current.length > 1) {
      throw maintenanceError('contact_merge_fact_conflict');
    }
    const currentRecord = current[0] || null;
    const currentValue = currentRecord
      ? normalizeFactValue(currentRecord.data?.value)
      : '';

    if (currentRecord && currentValue !== before && currentValue !== resolved) {
      throw maintenanceError('contact_merge_fact_changed');
    }
    if (currentRecord && currentValue === before) continue;
    if (!currentRecord && !before) continue;

    entries.push(
      Object.freeze({
        field,
        predicate,
        beforeValue,
        current: currentRecord,
        correctionId: deterministicId(
          'merge-recovery-fact',
          context.descriptor.uid,
          context.descriptor.operationId,
          predicate,
        ),
      }),
    );
  }
  return Object.freeze(entries);
}

function mergeFactWriteCount(plan) {
  return plan.reduce(
    (count, entry) =>
      count + (entry.current ? 1 : 0) + (entry.correctionId ? 1 : 0),
    0,
  );
}

export function planContactMergeFactRestoration({
  uid,
  operationId,
  primaryBefore,
  resolvedProfile,
  currentFacts = [],
}) {
  const owner = safeSegment(uid);
  const operation = safeSegment(operationId);
  const currentByPredicate = new Map(
    Object.values(PROFILE_FACT_FIELDS).map((predicate) => [predicate, []]),
  );
  for (const fact of currentFacts) {
    const predicate = String(fact?.predicate || fact?.data?.predicate || '');
    if (!currentByPredicate.has(predicate)) continue;
    currentByPredicate.get(predicate).push({
      id: safeSegment(fact.id),
      path:
        typeof fact.path === 'string'
          ? fact.path
          : `users/${owner}/contacts/unknown/facts/${safeSegment(fact.id)}`,
      data:
        fact.data && typeof fact.data === 'object'
          ? fact.data
          : { predicate, value: fact.value },
    });
  }
  const context = {
    descriptor: {
      uid: owner,
      operationId: operation,
    },
    primaryBefore: profileSnapshot(primaryBefore),
    resolvedProfile: profileSnapshot(resolvedProfile),
  };
  return Object.freeze(
    factRestorationPlan({ currentByPredicate, context }).map((entry) =>
      Object.freeze({
        field: entry.field,
        predicate: entry.predicate,
        beforeValue: entry.beforeValue,
        currentFactId: entry.current?.id || null,
        correctionId: entry.correctionId,
      }),
    ),
  );
}

function safeRequestPatch(code, now, extra = {}) {
  return {
    workerProtocolVersion: MAINTENANCE_PROTOCOL_VERSION,
    workerReasonCode: code,
    workerUpdatedAt: now,
    ...extra,
  };
}

async function commitBatch(
  db,
  operations,
  uid = null,
  validateTransaction = null,
) {
  if (operations.length === 0) return;
  if (operations.length > MAX_MAX_MUTATIONS) {
    throw maintenanceError('contact_maintenance_budget_exhausted', 'deferred');
  }
  const applyOperations = (writer) => {
    for (const operation of operations) {
      if (operation.type === 'delete') writer.delete(operation.ref);
      else if (operation.type === 'update') {
        writer.update(operation.ref, operation.data);
      } else {
        writer.set(operation.ref, operation.data, operation.options);
      }
    }
  };
  if (uid) {
    await db.runTransaction(async (transaction) => {
      const security = await transaction.get(
        db.doc(`_accountSecurity/${safeSegment(uid)}`),
      );
      if (
        !security.exists ||
        security.data()?.status !== 'active'
      ) {
        throw maintenanceError(
          'account_unavailable',
          'needs-review',
        );
      }
      if (typeof validateTransaction === 'function') {
        await validateTransaction(transaction);
      }
      applyOperations(transaction);
    });
    return;
  }
  const batch = db.batch();
  applyOperations(batch);
  await batch.commit();
}

/**
 * Firebase Admin repository. Every path is constructed from validated owner
 * and document segments. Request-supplied paths and purge plans are never used.
 */
export function createFirestoreContactMaintenanceRepository(
  db,
  {
    clock = () => new Date(),
    leaseIdFactory = randomUUID,
  } = {},
) {
  if (!db || typeof db.doc !== 'function' || typeof db.collection !== 'function') {
    throw new TypeError('A Firebase Admin Firestore service is required.');
  }
  if (typeof clock !== 'function' || typeof leaseIdFactory !== 'function') {
    throw new TypeError('Valid purge lease dependencies are required.');
  }

  async function read(path) {
    return documentRecord(await db.doc(path).get());
  }

  async function listOwnerRequests(uid, maxRequests) {
    const owner = safeSegment(uid);
    const limit = Math.min(MAX_MAX_REQUESTS, maxRequests) + 1;
    const snapshots = await Promise.all(
      ['purge', 'merge-recovery'].map((kind) =>
        db
          .collection(`users/${owner}/${requestCollection(kind)}`)
          .where('status', '==', 'queued')
          .limit(limit)
          .get(),
      ),
    );
    const requests = [];
    snapshots.forEach((snapshot, index) => {
      const kind = index === 0 ? 'purge' : 'merge-recovery';
      snapshot.docs.forEach((document) => {
        requests.push({
          kind,
          uid: owner,
          id: document.id,
          data: document.data() || {},
        });
      });
    });
    requests.sort(
      (left, right) =>
        requestTime(left.data) - requestTime(right.data) ||
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id),
    );
    return Object.freeze({
      requests: Object.freeze(requests.slice(0, maxRequests)),
      hasMore: requests.length > maxRequests,
    });
  }

  async function listScheduledRequests(maxRequests) {
    const limit = Math.min(MAX_MAX_REQUESTS, maxRequests) + 1;
    const snapshots = await Promise.all(
      ['purge', 'merge-recovery'].map((kind) =>
        db
          .collectionGroup(requestCollection(kind))
          .where('status', '==', 'queued')
          .limit(limit)
          .get(),
      ),
    );
    const requests = [];
    snapshots.forEach((snapshot, index) => {
      const kind = index === 0 ? 'purge' : 'merge-recovery';
      snapshot.docs.forEach((document) => {
        const descriptor = parseScheduledDescriptor(kind, document);
        if (descriptor) requests.push(descriptor);
      });
    });
    requests.sort(
      (left, right) =>
        requestTime(left.data) - requestTime(right.data) ||
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id),
    );
    return Object.freeze({
      requests: Object.freeze(requests.slice(0, maxRequests)),
      hasMore: requests.length > maxRequests,
    });
  }

  async function loadPurgeContext(descriptor) {
    const validated = validateDescriptor(descriptor);
    const [request, contact] = await Promise.all([
      read(requestPath(validated.uid, 'purge', validated.id)),
      read(contactPath(validated.uid, validated.contactId)),
    ]);
    return { request: { ...descriptor, data: request?.data || {} }, contact };
  }

  async function loadMergeContext(descriptor) {
    const validated = validateDescriptor(descriptor);
    const [request, operation, primary, duplicate] = await Promise.all([
      read(requestPath(validated.uid, 'merge-recovery', validated.id)),
      read(mergeOperationPath(validated.uid, validated.operationId)),
      read(contactPath(validated.uid, validated.primaryContactId)),
      read(contactPath(validated.uid, validated.duplicateContactId)),
    ]);
    return {
      request: { ...descriptor, data: request?.data || {} },
      operation,
      primary,
      duplicate,
    };
  }

  async function acquirePurgeFence({ descriptor, now }) {
    const validated = validateDescriptor(descriptor);
    const contextAt = valueDate(now);
    const acquiredAt = valueDate(clock());
    if (!contextAt || !acquiredAt) {
      throw maintenanceError('contact_maintenance_clock_invalid');
    }
    const leaseId = safeSegment(leaseIdFactory());
    const leaseExpiresAt = new Date(
      acquiredAt.getTime() + PURGE_LEASE_DURATION_MS,
    );
    const requestRef = db.doc(
      requestPath(validated.uid, 'purge', validated.id),
    );
    const contactRef = db.doc(
      contactPath(validated.uid, validated.contactId),
    );

    await db.runTransaction(async (transaction) => {
      const [securitySnapshot, requestSnapshot, contactSnapshot] =
        await Promise.all([
          transaction.get(
            db.doc(`_accountSecurity/${validated.uid}`),
          ),
          transaction.get(requestRef),
          transaction.get(contactRef),
        ]);
      if (
        !securitySnapshot.exists ||
        securitySnapshot.data()?.status !== 'active'
      ) {
        throw maintenanceError('account_unavailable', 'needs-review');
      }
      const authoritativeRequest = documentRecord(requestSnapshot);
      const contact = documentRecord(contactSnapshot);
      const context = assertPurgeContext({
        request: {
          ...validated,
          data: authoritativeRequest?.data || {},
        },
        contact,
        now: contextAt,
      });
      const existingFence = contact?.data?.purgeFence;
      if (
        existingFence != null &&
        existingFence.requestId !== context.descriptor.id
      ) {
        throw maintenanceError('contact_purge_fence_conflict');
      }
      // Re-acquiring the same deterministic request deliberately takes over a
      // previous worker lease. Any in-flight stale worker will fail its exact
      // lease check inside the delete transaction before it can write.
      transaction.set(
        contactRef,
        {
          purgeFence: {
            protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
            requestId: context.descriptor.id,
            leaseId,
            acquiredAt,
            leaseExpiresAt,
          },
        },
        { merge: true },
      );
    });

    return Object.freeze({
      requestId: validated.id,
      leaseId,
      leaseExpiresAt,
      writes: PURGE_FENCE_WRITES,
    });
  }

  async function assertPurgeTransaction(
    transaction,
    {
      descriptor,
      lease,
      now,
    },
  ) {
    const validated = validateDescriptor(descriptor);
    const checkedAt = valueDate(now);
    if (!checkedAt) {
      throw maintenanceError('contact_maintenance_clock_invalid');
    }
    const [requestSnapshot, contactSnapshot] = await Promise.all([
      transaction.get(
        db.doc(requestPath(validated.uid, 'purge', validated.id)),
      ),
      transaction.get(
        db.doc(contactPath(validated.uid, validated.contactId)),
      ),
    ]);
    const request = documentRecord(requestSnapshot);
    const contact = documentRecord(contactSnapshot);
    const context = assertPurgeContext({
      request: {
        ...validated,
        data: request?.data || {},
      },
      contact,
      now: checkedAt,
    });
    assertPurgeLease({
      descriptor: context.descriptor,
      contact,
      lease,
      now: valueDate(clock()) || checkedAt,
    });
    return context;
  }

  async function updateRequest(descriptor, patch) {
    await db.runTransaction(async (transaction) => {
      const requestRef = db.doc(
        requestPath(
          descriptor.uid,
          descriptor.kind,
          descriptor.id,
        ),
      );
      const [security, request] = await Promise.all([
        transaction.get(
          db.doc(`_accountSecurity/${safeSegment(descriptor.uid)}`),
        ),
        transaction.get(requestRef),
      ]);
      if (
        !security.exists ||
        security.data()?.status !== 'active'
      ) {
        throw maintenanceError(
          'account_unavailable',
          'needs-review',
        );
      }
      if (
        !request.exists ||
        request.data()?.status !== 'queued' ||
        request.data()?.requiresServerExecution !== true
      ) {
        return;
      }
      transaction.update(requestRef, patch);
    });
  }

  async function purgeContactData({
    descriptor,
    lease,
    now,
    limit,
  }) {
    const validated = validateDescriptor(descriptor);
    const uid = validated.uid;
    const contactId = validated.contactId;
    const owner = safeSegment(uid);
    const contact = safeSegment(contactId);
    let remaining = Math.max(0, Math.min(MAX_MAX_MUTATIONS, limit));
    const operations = new Map();
    const queueOperation = (operation) => {
      const path = operation.ref.path;
      const current = operations.get(path);
      if (current) {
        if (operation.type === 'delete' && current.type !== 'delete') {
          operations.set(path, operation);
        }
        return true;
      }
      if (remaining === 0) return false;
      operations.set(path, operation);
      remaining -= 1;
      return true;
    };

    for (const reference of ROOT_REFERENCES) {
      if (remaining === 0) break;
      if (reference.collectionName === 'commitments') continue;
      const snapshot = await db
        .collection(`users/${owner}/${reference.collectionName}`)
        .where('contactId', '==', contact)
        .limit(remaining)
        .get();
      for (const document of snapshot.docs) {
        if (document.data()?.contactId !== contact) {
          throw maintenanceError('contact_purge_reference_conflict');
        }
        queueOperation({ type: 'delete', ref: document.ref });
      }
    }

    if (remaining > 0) {
      const commitments = await db
        .collection(`users/${owner}/commitments`)
        .where('contactId', '==', contact)
        .limit(remaining)
        .get();
      for (const commitment of commitments.docs) {
        if (remaining === 0) break;
        if (commitment.data()?.contactId !== contact) {
          throw maintenanceError('contact_purge_reference_conflict');
        }
        const feedbackLimit = remaining;
        const feedback = await db
          .collection(`users/${owner}/commitmentFeedbackEvents`)
          .where('commitmentId', '==', commitment.id)
          .limit(feedbackLimit)
          .get();
        for (const event of feedback.docs) {
          if (event.data()?.commitmentId !== commitment.id) {
            throw maintenanceError('contact_purge_reference_conflict');
          }
          queueOperation({ type: 'delete', ref: event.ref });
        }
        // When a page fills the remaining budget, another feedback record may
        // still exist. Keep the parent until a later pass proves the dependent
        // immutable stream is empty.
        if (feedback.size < feedbackLimit && remaining > 0) {
          queueOperation({ type: 'delete', ref: commitment.ref });
        }
      }
    }

    for (const field of CONNECTION_REFERENCE_FIELDS) {
      if (remaining === 0) break;
      const snapshot = await db
        .collection(`users/${owner}/connections`)
        .where(field, '==', contact)
        .limit(remaining)
        .get();
      for (const document of snapshot.docs) {
        const data = document.data() || {};
        if (field !== 'migratedFromContactId') {
          queueOperation({ type: 'delete', ref: document.ref });
          continue;
        }
        if (
          data.mergeHistorical === true ||
          data.mergeSuppressed === true ||
          data.sourceId === contact ||
          data.targetId === contact
        ) {
          queueOperation({ type: 'delete', ref: document.ref });
          continue;
        }
        queueOperation({
          type: 'update',
          ref: document.ref,
          data: {
            ...Object.fromEntries(
              CONNECTION_MERGE_FIELDS.map((key) => [
                key,
                FieldValue.delete(),
              ]),
            ),
            updatedAt: FieldValue.serverTimestamp(),
          },
        });
      }
    }

    for (const field of CONTACT_EVENT_REFERENCE_FIELDS) {
      if (remaining === 0) break;
      const snapshot = await db
        .collection(`users/${owner}/contactEvents`)
        .where(field, '==', contact)
        .limit(remaining)
        .get();
      for (const document of snapshot.docs) {
        queueOperation({ type: 'delete', ref: document.ref });
      }
    }

    if (remaining > 0) {
      const primaryContacts = await db
        .collection(`users/${owner}/contacts`)
        .where('mergedFromContactIds', 'array-contains', contact)
        .limit(remaining)
        .get();
      for (const document of primaryContacts.docs) {
        queueOperation({
          type: 'update',
          ref: document.ref,
          data: {
            mergedFromContactIds: FieldValue.arrayRemove(contact),
            updatedAt: FieldValue.serverTimestamp(),
          },
        });
      }
    }

    if (remaining > 0) {
      const mergeOperations = await db
        .collection(`users/${owner}/contactMergeOperations`)
        .where('duplicateContactId', '==', contact)
        .limit(remaining)
        .get();
      for (const document of mergeOperations.docs) {
        queueOperation({
          type: 'update',
          ref: document.ref,
          data: {
            ...Object.fromEntries(
              MERGE_OPERATION_PRIVATE_FIELDS.map((key) => [
                key,
                FieldValue.delete(),
              ]),
            ),
            recoveryScrubbed: true,
            recoveryScrubbedAt: FieldValue.serverTimestamp(),
          },
        });
      }
    }

    if (remaining > 0) {
      const recoveryRequests = await db
        .collection(`users/${owner}/${MERGE_RECOVERY_REQUESTS}`)
        .where('duplicateContactId', '==', contact)
        .limit(remaining)
        .get();
      for (const document of recoveryRequests.docs) {
        queueOperation({ type: 'delete', ref: document.ref });
      }
    }

    for (const nested of NESTED_REFERENCES) {
      if (remaining === 0) break;
      const snapshot = await db
        .collection(
          `users/${owner}/contacts/${contact}/${nested.collectionName}`,
        )
        .limit(remaining)
        .get();
      for (const document of snapshot.docs) {
        queueOperation({ type: 'delete', ref: document.ref });
      }
    }

    await commitBatch(
      db,
      [...operations.values()],
      owner,
      (transaction) =>
        assertPurgeTransaction(transaction, {
          descriptor: validated,
          lease,
          now,
        }),
    );
    return operations.size;
  }

  async function hasPurgeData({
    descriptor,
    lease,
    now,
  }) {
    const validated = validateDescriptor(descriptor);
    const uid = validated.uid;
    const contactId = validated.contactId;
    const owner = safeSegment(uid);
    const contact = safeSegment(contactId);
    await db.runTransaction((transaction) =>
      assertPurgeTransaction(transaction, {
        descriptor: validated,
        lease,
        now,
      }),
    );
    for (const reference of ROOT_REFERENCES) {
      const snapshot = await db
        .collection(`users/${owner}/${reference.collectionName}`)
        .where('contactId', '==', contact)
        .limit(1)
        .get();
      if (!snapshot.empty) return true;
    }
    for (const field of CONNECTION_REFERENCE_FIELDS) {
      const snapshot = await db
        .collection(`users/${owner}/connections`)
        .where(field, '==', contact)
        .limit(1)
        .get();
      if (!snapshot.empty) return true;
    }
    for (const field of CONTACT_EVENT_REFERENCE_FIELDS) {
      const snapshot = await db
        .collection(`users/${owner}/contactEvents`)
        .where(field, '==', contact)
        .limit(1)
        .get();
      if (!snapshot.empty) return true;
    }
    const primaryContactSnapshot = await db
      .collection(`users/${owner}/contacts`)
      .where('mergedFromContactIds', 'array-contains', contact)
      .limit(1)
      .get();
    if (!primaryContactSnapshot.empty) return true;
    const mergeOperationSnapshot = await db
      .collection(`users/${owner}/contactMergeOperations`)
      .where('duplicateContactId', '==', contact)
      .limit(1)
      .get();
    if (!mergeOperationSnapshot.empty) return true;
    const recoveryRequestSnapshot = await db
      .collection(`users/${owner}/${MERGE_RECOVERY_REQUESTS}`)
      .where('duplicateContactId', '==', contact)
      .limit(1)
      .get();
    if (!recoveryRequestSnapshot.empty) return true;
    for (const nested of NESTED_REFERENCES) {
      const snapshot = await db
        .collection(
          `users/${owner}/contacts/${contact}/${nested.collectionName}`,
        )
        .limit(1)
        .get();
      if (!snapshot.empty) return true;
    }
    return false;
  }

  async function finalizePurge({ descriptor, lease, now }) {
    const requestRef = db.doc(
      requestPath(descriptor.uid, 'purge', descriptor.id),
    );
    const contactRef = db.doc(
      contactPath(descriptor.uid, descriptor.contactId),
    );
    return db.runTransaction(async (transaction) => {
      const [
        securitySnapshot,
        requestSnapshot,
        contactSnapshot,
        ...relatedSnapshots
      ] =
        await Promise.all([
          transaction.get(
            db.doc(`_accountSecurity/${descriptor.uid}`),
          ),
          transaction.get(requestRef),
          transaction.get(contactRef),
          ...ROOT_REFERENCES.map((reference) =>
            transaction.get(
              db
                .collection(
                  `users/${descriptor.uid}/${reference.collectionName}`,
                )
                .where('contactId', '==', descriptor.contactId)
                .limit(1),
            ),
          ),
          ...NESTED_REFERENCES.map((nested) =>
            transaction.get(
              db
                .collection(
                  `users/${descriptor.uid}/contacts/${descriptor.contactId}/${nested.collectionName}`,
                )
                .limit(1),
            ),
          ),
          ...CONNECTION_REFERENCE_FIELDS.map((field) =>
            transaction.get(
              db
                .collection(`users/${descriptor.uid}/connections`)
                .where(field, '==', descriptor.contactId)
                .limit(1),
            ),
          ),
          ...CONTACT_EVENT_REFERENCE_FIELDS.map((field) =>
            transaction.get(
              db
                .collection(`users/${descriptor.uid}/contactEvents`)
                .where(field, '==', descriptor.contactId)
                .limit(1),
            ),
          ),
          transaction.get(
            db
              .collection(`users/${descriptor.uid}/contacts`)
              .where(
                'mergedFromContactIds',
                'array-contains',
                descriptor.contactId,
              )
              .limit(1),
          ),
          transaction.get(
            db
              .collection(
                `users/${descriptor.uid}/contactMergeOperations`,
              )
              .where(
                'duplicateContactId',
                '==',
                descriptor.contactId,
              )
              .limit(1),
          ),
          transaction.get(
            db
              .collection(
                `users/${descriptor.uid}/${MERGE_RECOVERY_REQUESTS}`,
              )
              .where(
                'duplicateContactId',
                '==',
                descriptor.contactId,
              )
              .limit(1),
          ),
        ]);
      if (
        !securitySnapshot.exists ||
        securitySnapshot.data()?.status !== 'active'
      ) {
        throw maintenanceError('account_unavailable', 'needs-review');
      }
      const request = documentRecord(requestSnapshot);
      const contact = documentRecord(contactSnapshot);
      if (!contact && request?.data?.status === 'completed') {
        return Object.freeze({ completed: true, writes: 0 });
      }
      const context = assertPurgeContext({
        request: { ...descriptor, data: request?.data || {} },
        contact,
        now,
      });
      assertPurgeLease({
        descriptor: context.descriptor,
        contact,
        lease,
        now: valueDate(clock()) || now,
      });
      if (relatedSnapshots.some((snapshot) => !snapshot.empty)) {
        throw maintenanceError('contact_purge_references_remaining', 'deferred');
      }
      transaction.delete(contactRef);
      transaction.update(requestRef, {
        status: 'completed',
        completedAt: FieldValue.serverTimestamp(),
        requiresServerExecution: false,
        workerProtocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        workerReasonCode: 'completed',
        verifiedEmptyCollections: [
          ...ROOT_REFERENCES.map((item) => item.kind),
          ...NESTED_REFERENCES.map((item) => item.kind),
          'connection',
          'contact-event',
          'commitment-feedback',
          'merge-recovery',
        ],
      });
      return Object.freeze({
        completed: true,
        writes: PURGE_FINALIZATION_WRITES,
      });
    });
  }

  async function restoreMergeReferences({
    uid,
    operationId,
    primaryContactId,
    duplicateContactId,
    limit,
  }) {
    const owner = safeSegment(uid);
    const operation = safeSegment(operationId);
    const primary = safeSegment(primaryContactId);
    const duplicate = safeSegment(duplicateContactId);
    let remaining = Math.max(0, Math.min(MAX_MAX_MUTATIONS, limit));
    const operations = [];

    for (const reference of ROOT_REFERENCES) {
      if (remaining === 0) break;
      const snapshot = await db
        .collection(`users/${owner}/${reference.collectionName}`)
        .where('contactMergeOperationId', '==', operation)
        .limit(remaining)
        .get();
      for (const document of snapshot.docs) {
        const data = document.data() || {};
        if (
          data.contactId !== primary ||
          data.migratedFromContactId !== duplicate
        ) {
          throw maintenanceError('contact_merge_reference_conflict');
        }
        operations.push({
          type: 'update',
          ref: document.ref,
          data: {
            contactId: duplicate,
            contactName:
              data.migratedFromHadContactName === true
                ? data.migratedFromContactName ?? null
                : FieldValue.delete(),
            contactMergeOperationId: FieldValue.delete(),
            migratedFromContactId: FieldValue.delete(),
            migratedFromContactName: FieldValue.delete(),
            migratedFromHadContactName: FieldValue.delete(),
            migratedAt: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          },
        });
        remaining -= 1;
      }
    }

    if (remaining > 0) {
      const snapshot = await db
        .collection(`users/${owner}/connections`)
        .where('mergeRecoverySourceOperationId', '==', operation)
        .limit(remaining)
        .get();
      const candidates = [];
      for (const document of snapshot.docs) {
        const data = document.data() || {};
        if (
          data.contactMergeOperationId !== operation ||
          data.migratedFromContactId !== duplicate ||
          data.mergeHistorical !== true ||
          (data.sourceId !== duplicate && data.targetId !== duplicate)
        ) {
          throw maintenanceError('contact_merge_connection_conflict');
        }
        const targetPath =
          typeof data.migratedToPath === 'string'
            ? data.migratedToPath
            : null;
        const expectedPrefix = `users/${owner}/connections/`;
        if (
          targetPath &&
          (!targetPath.startsWith(expectedPrefix) ||
            targetPath.slice(expectedPrefix.length).includes('/') ||
            !targetPath.slice(expectedPrefix.length))
        ) {
          throw maintenanceError('contact_merge_connection_conflict');
        }
        const writeCost = targetPath ? 2 : 1;
        if (writeCost > remaining) break;
        candidates.push({
          source: document,
          target: targetPath ? db.doc(targetPath) : null,
        });
        remaining -= writeCost;
      }
      const targetCandidates = candidates.filter(
        (candidate) => candidate.target,
      );
      const targetSnapshots = targetCandidates.length
        ? await db.getAll(
            ...targetCandidates.map((candidate) => candidate.target),
          )
        : [];
      let targetIndex = 0;
      for (const candidate of candidates) {
        if (candidate.target) {
          const targetSnapshot = targetSnapshots[targetIndex];
          targetIndex += 1;
          const targetData = targetSnapshot?.data() || {};
          if (
            !targetSnapshot?.exists ||
            targetData.contactMergeOperationId !== operation ||
            targetData.migratedFromContactId !== duplicate ||
            targetData.migratedFromPath !== candidate.source.ref.path
          ) {
            throw maintenanceError('contact_merge_connection_conflict');
          }
          operations.push({ type: 'delete', ref: candidate.target });
        }
        operations.push({
          type: 'update',
          ref: candidate.source.ref,
          data: {
            ...Object.fromEntries(
              CONNECTION_MERGE_FIELDS.map((key) => [
                key,
                FieldValue.delete(),
              ]),
            ),
            updatedAt: FieldValue.serverTimestamp(),
          },
        });
      }
    }

    for (const nested of NESTED_REFERENCES) {
      if (remaining === 0) break;
      const targetCollectionPath =
        `users/${owner}/contacts/${primary}/${nested.collectionName}`;
      const snapshot = await db
        .collection(targetCollectionPath)
        .where('contactMergeOperationId', '==', operation)
        .limit(remaining)
        .get();
      const candidates = [];
      for (const document of snapshot.docs) {
        const data = document.data() || {};
        const expectedPrefix =
          `users/${owner}/contacts/${duplicate}/${nested.collectionName}/`;
        const sourcePath = String(data.migratedFromPath || '');
        if (
          !sourcePath.startsWith(expectedPrefix) ||
          sourcePath.slice(expectedPrefix.length).includes('/') ||
          !sourcePath.slice(expectedPrefix.length)
        ) {
          throw maintenanceError('contact_merge_nested_reference_conflict');
        }
        candidates.push({ target: document.ref, source: db.doc(sourcePath) });
      }
      if (candidates.length) {
        const sourceSnapshots = await db.getAll(
          ...candidates.map((candidate) => candidate.source),
        );
        if (sourceSnapshots.some((source) => !source.exists)) {
          throw maintenanceError('contact_merge_source_history_missing');
        }
        for (const candidate of candidates) {
          operations.push({ type: 'delete', ref: candidate.target });
          remaining -= 1;
        }
      }
    }

    await commitBatch(db, operations, owner);
    return operations.length;
  }

  async function hasMergeReferences({
    uid,
    operationId,
    primaryContactId,
  }) {
    const owner = safeSegment(uid);
    const operation = safeSegment(operationId);
    const primary = safeSegment(primaryContactId);
    for (const reference of ROOT_REFERENCES) {
      const snapshot = await db
        .collection(`users/${owner}/${reference.collectionName}`)
        .where('contactMergeOperationId', '==', operation)
        .limit(1)
        .get();
      if (!snapshot.empty) return true;
    }
    const connectionSnapshot = await db
      .collection(`users/${owner}/connections`)
      .where('contactMergeOperationId', '==', operation)
      .limit(1)
      .get();
    if (!connectionSnapshot.empty) return true;
    for (const nested of NESTED_REFERENCES) {
      const snapshot = await db
        .collection(
          `users/${owner}/contacts/${primary}/${nested.collectionName}`,
        )
        .where('contactMergeOperationId', '==', operation)
        .limit(1)
        .get();
      if (!snapshot.empty) return true;
    }
    return false;
  }

  async function estimateMergeFinalization({ context }) {
    const currentByPredicate = new Map();
    for (const predicate of Object.values(PROFILE_FACT_FIELDS)) {
      const snapshot = await db
        .collection(
          `users/${context.descriptor.uid}/contacts/${context.descriptor.primaryContactId}/facts`,
        )
        .where('predicate', '==', predicate)
        .where('current', '==', true)
        .limit(2)
        .get();
      currentByPredicate.set(
        predicate,
        snapshot.docs.map((document) => ({
          id: document.id,
          path: document.ref.path,
          data: document.data() || {},
        })),
      );
    }
    const plan = factRestorationPlan({ currentByPredicate, context });
    return MERGE_BASE_FINALIZATION_WRITES + mergeFactWriteCount(plan);
  }

  async function finalizeMergeRecovery({ descriptor, now, mutationBudget }) {
    const owner = safeSegment(descriptor.uid);
    const operationId = safeSegment(descriptor.operationId);
    const primaryId = safeSegment(descriptor.primaryContactId);
    const duplicateId = safeSegment(descriptor.duplicateContactId);
    const requestRef = db.doc(
      requestPath(owner, 'merge-recovery', descriptor.id),
    );
    const operationRef = db.doc(mergeOperationPath(owner, operationId));
    const primaryRef = db.doc(contactPath(owner, primaryId));
    const duplicateRef = db.doc(contactPath(owner, duplicateId));
    const factsRef = db.collection(
      `users/${owner}/contacts/${primaryId}/facts`,
    );
    const primaryEventRef = db.doc(
      `users/${owner}/contactEvents/${deterministicId(
        'merge-recovered-primary',
        owner,
        operationId,
      )}`,
    );
    const duplicateEventRef = db.doc(
      `users/${owner}/contactEvents/${deterministicId(
        'merge-recovered-duplicate',
        owner,
        operationId,
      )}`,
    );

    return db.runTransaction(async (transaction) => {
      const [
        securitySnapshot,
        requestSnapshot,
        operationSnapshot,
        primarySnapshot,
        duplicateSnapshot,
        ...querySnapshots
      ] = await Promise.all([
        transaction.get(db.doc(`_accountSecurity/${owner}`)),
        transaction.get(requestRef),
        transaction.get(operationRef),
        transaction.get(primaryRef),
        transaction.get(duplicateRef),
        ...ROOT_REFERENCES.map((reference) =>
          transaction.get(
            db
              .collection(`users/${owner}/${reference.collectionName}`)
              .where('contactMergeOperationId', '==', operationId)
              .limit(1),
          ),
        ),
        ...NESTED_REFERENCES.map((nested) =>
          transaction.get(
            db
              .collection(
                `users/${owner}/contacts/${primaryId}/${nested.collectionName}`,
              )
              .where('contactMergeOperationId', '==', operationId)
              .limit(1),
          ),
        ),
        transaction.get(
          db
            .collection(`users/${owner}/connections`)
            .where('contactMergeOperationId', '==', operationId)
            .limit(1),
        ),
        ...Object.values(PROFILE_FACT_FIELDS).map((predicate) =>
          transaction.get(
            factsRef
              .where('predicate', '==', predicate)
              .where('current', '==', true)
              .limit(2),
          ),
        ),
      ]);
      if (
        !securitySnapshot.exists ||
        securitySnapshot.data()?.status !== 'active'
      ) {
        throw maintenanceError('account_unavailable', 'needs-review');
      }
      const referenceSnapshotCount =
        ROOT_REFERENCES.length + NESTED_REFERENCES.length + 1;
      const referenceSnapshots = querySnapshots.slice(
        0,
        referenceSnapshotCount,
      );
      const factSnapshots = querySnapshots.slice(referenceSnapshotCount);
      const operation = documentRecord(operationSnapshot);
      if (
        operation?.data?.status === 'recovered' &&
        operation.data.recoveryRequestId === descriptor.id
      ) {
        if (requestSnapshot.data()?.status !== 'completed') {
          transaction.update(requestRef, {
            status: 'completed',
            completedAt: FieldValue.serverTimestamp(),
            requiresServerExecution: false,
            workerProtocolVersion: MAINTENANCE_PROTOCOL_VERSION,
            workerReasonCode: 'completed',
          });
          return Object.freeze({ completed: true, writes: 1 });
        }
        return Object.freeze({ completed: true, writes: 0 });
      }
      if (referenceSnapshots.some((snapshot) => !snapshot.empty)) {
        throw maintenanceError(
          'contact_merge_references_remaining',
          'deferred',
        );
      }

      const context = assertMergeContext({
        request: {
          ...descriptor,
          data: requestSnapshot.exists ? requestSnapshot.data() || {} : {},
        },
        operation,
        primary: documentRecord(primarySnapshot),
        duplicate: documentRecord(duplicateSnapshot),
        now,
      });
      const currentByPredicate = new Map();
      Object.values(PROFILE_FACT_FIELDS).forEach((predicate, index) => {
        currentByPredicate.set(
          predicate,
          factSnapshots[index].docs.map((document) => ({
            id: document.id,
            path: document.ref.path,
            ref: document.ref,
            data: document.data() || {},
          })),
        );
      });
      const factPlan = factRestorationPlan({ currentByPredicate, context });
      const correctionRefs = factPlan
        .filter((entry) => entry.correctionId)
        .map((entry) => factsRef.doc(entry.correctionId));
      const correctionSnapshots = correctionRefs.length
        ? await Promise.all(
            correctionRefs.map((reference) => transaction.get(reference)),
          )
        : [];
      if (correctionSnapshots.some((snapshot) => snapshot.exists)) {
        throw maintenanceError('contact_merge_fact_recovery_conflict');
      }

      const writes =
        MERGE_BASE_FINALIZATION_WRITES + mergeFactWriteCount(factPlan);
      if (writes > mutationBudget || writes > MAX_MAX_MUTATIONS) {
        throw maintenanceError(
          'contact_maintenance_budget_exhausted',
          'deferred',
        );
      }

      let correctionIndex = 0;
      for (const entry of factPlan) {
        if (entry.current) {
          transaction.update(
            entry.current.ref || db.doc(entry.current.path),
            {
              current: false,
              supersededBy: entry.correctionId,
              supersededAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
              mergeRecoveryOperationId: operationId,
            },
          );
        }
        if (entry.correctionId) {
          const correctionRef = correctionRefs[correctionIndex];
          correctionIndex += 1;
          const restoredValue = (
            Array.isArray(entry.beforeValue)
              ? entry.beforeValue.join(', ')
              : String(entry.beforeValue ?? '')
          ).trim();
          const value = restoredValue || '[removed]';
          transaction.set(correctionRef, {
            predicate: entry.predicate,
            value,
            normalizedValue: normalizeFactValue(value),
            sourceType: entry.current ? 'user-correction' : 'profile',
            sourceId: entry.current?.id || `recovery:${operationId}`,
            observedAt: now,
            confidence: 1,
            current: true,
            aiAllowed:
              Boolean(restoredValue) &&
              primarySnapshot.data()?.aiAllowed !== false &&
              entry.current?.data?.aiAllowed !== false,
            correctionOf: entry.current?.id || null,
            supersededBy: null,
            contactMergeRecoveryOperationId: operationId,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }

      const duplicateData = duplicateSnapshot.data() || {};
      const wasArchived = Boolean(valueDate(duplicateData.archivedAt));
      const rememberedAI = duplicateData.aiAllowedBeforeLifecycle !== false;

      transaction.update(primaryRef, {
        ...context.primaryBefore,
        mergedFromContactIds: FieldValue.arrayRemove(duplicateId),
        updatedAt: FieldValue.serverTimestamp(),
        profileRevision: FieldValue.increment(1),
        factSyncPending: null,
        factSyncRecoveredAt: FieldValue.serverTimestamp(),
        lastContactMergeRecoveryOperationId: operationId,
      });
      transaction.update(duplicateRef, {
        ...context.duplicateBefore,
        lifecycleStatus: wasArchived ? 'archived' : 'active',
        archivedAt: wasArchived
          ? duplicateData.archivedAt
          : null,
        deletedAt: null,
        purgeEligibleAt: null,
        restoredAt: now,
        aiAllowed: wasArchived ? false : rememberedAI,
        aiAllowedBeforeLifecycle: wasArchived ? rememberedAI : null,
        mergedIntoContactId: null,
        contactMergeOperationId: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(operationRef, {
        status: 'recovered',
        recoveredFromStatus: context.operationStatus,
        recoveredAt: FieldValue.serverTimestamp(),
        recoveryRequestId: descriptor.id,
        recoveryProtocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      });
      transaction.update(requestRef, {
        status: 'completed',
        completedAt: FieldValue.serverTimestamp(),
        requiresServerExecution: false,
        workerProtocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        workerReasonCode: 'completed',
        restoredFactPredicateCount: factPlan.length,
      });
      const eventPayload = {
        operationId,
        primaryContactId: primaryId,
        duplicateContactId: duplicateId,
        recoveryProtocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      };
      transaction.set(primaryEventRef, {
        contactId: primaryId,
        type: 'merge-recovered',
        actorUid: owner,
        sourceType: 'contact-management-worker',
        sourceId: operationId,
        payload: eventPayload,
        occurredAt: FieldValue.serverTimestamp(),
        immutable: true,
      });
      transaction.set(duplicateEventRef, {
        contactId: duplicateId,
        type: 'merge-recovered',
        actorUid: owner,
        sourceType: 'contact-management-worker',
        sourceId: operationId,
        payload: eventPayload,
        occurredAt: FieldValue.serverTimestamp(),
        immutable: true,
      });
      return Object.freeze({ completed: true, writes });
    });
  }

  return Object.freeze({
    listOwnerRequests,
    listScheduledRequests,
    loadPurgeContext,
    loadMergeContext,
    acquirePurgeFence,
    updateRequest,
    purgeContactData,
    hasPurgeData,
    finalizePurge,
    restoreMergeReferences,
    hasMergeReferences,
    estimateMergeFinalization,
    finalizeMergeRecovery,
  });
}

async function markDisposition(repository, descriptor, error, now) {
  const disposition =
    error instanceof ContactMaintenanceError
      ? error.disposition
      : 'retryable';
  const status =
    disposition === 'needs-review'
      ? 'needs-review'
      : disposition === 'expired'
        ? 'expired'
        : 'queued';
  const reasonCode =
    error instanceof ContactMaintenanceError
      ? error.code
      : 'contact_maintenance_retryable';
  await repository
    .updateRequest(
      descriptor,
      safeRequestPatch(reasonCode, now, {
        status,
        requiresServerExecution: status === 'queued',
        lastAttemptAt: now,
      }),
    )
    .catch(() => undefined);
  return disposition;
}

async function processPurgeRequest({
  descriptor,
  repository,
  now,
  mutationBudget,
}) {
  const loaded = await repository.loadPurgeContext(descriptor);
  const context = assertPurgeContext({ ...loaded, now });
  const lease = await repository.acquirePurgeFence({
    descriptor: context.descriptor,
    now,
  });
  let mutations = Number(lease?.writes) || PURGE_FENCE_WRITES;
  const dataBudget = Math.max(
    0,
    mutationBudget - mutations - PURGE_FINALIZATION_WRITES,
  );
  if (dataBudget > 0) {
    mutations += await repository.purgeContactData({
      descriptor: context.descriptor,
      lease,
      now,
      limit: dataBudget,
    });
  }
  if (
    await repository.hasPurgeData({
      descriptor: context.descriptor,
      lease,
      now,
    })
  ) {
    await repository.updateRequest(
      context.descriptor,
      safeRequestPatch('contact_purge_in_progress', now, {
        status: 'queued',
        requiresServerExecution: true,
        lastAttemptAt: now,
      }),
    );
    return Object.freeze({
      completed: false,
      deferred: true,
      mutations: mutations + 1,
    });
  }
  if (mutationBudget - mutations < PURGE_FINALIZATION_WRITES) {
    await repository.updateRequest(
      context.descriptor,
      safeRequestPatch('contact_maintenance_budget_exhausted', now, {
        status: 'queued',
        requiresServerExecution: true,
        lastAttemptAt: now,
      }),
    );
    return Object.freeze({
      completed: false,
      deferred: true,
      mutations: mutations + 1,
    });
  }
  const finalized = await repository.finalizePurge({
    descriptor: context.descriptor,
    lease,
    now,
  });
  return Object.freeze({
    completed: true,
    deferred: false,
    mutations: mutations + finalized.writes,
  });
}

async function processMergeRecoveryRequest({
  descriptor,
  repository,
  now,
  mutationBudget,
}) {
  const loaded = await repository.loadMergeContext(descriptor);
  const context = assertMergeContext({ ...loaded, now });
  if (context.alreadyRecovered) {
    const finalized = await repository.finalizeMergeRecovery({
      descriptor: context.descriptor,
      now,
      mutationBudget,
    });
    return Object.freeze({
      completed: true,
      deferred: false,
      mutations: finalized.writes,
    });
  }

  let mutations = 0;
  const referenceBudget = Math.max(0, mutationBudget - 1);
  if (referenceBudget > 0) {
    mutations += await repository.restoreMergeReferences({
      uid: context.descriptor.uid,
      operationId: context.descriptor.operationId,
      primaryContactId: context.descriptor.primaryContactId,
      duplicateContactId: context.descriptor.duplicateContactId,
      limit: referenceBudget,
    });
  }
  if (
    await repository.hasMergeReferences({
      uid: context.descriptor.uid,
      operationId: context.descriptor.operationId,
      primaryContactId: context.descriptor.primaryContactId,
    })
  ) {
    await repository.updateRequest(
      context.descriptor,
      safeRequestPatch('contact_merge_recovery_in_progress', now, {
        status: 'queued',
        requiresServerExecution: true,
        lastAttemptAt: now,
      }),
    );
    return Object.freeze({
      completed: false,
      deferred: true,
      mutations: mutations + 1,
    });
  }

  const estimatedWrites = await repository.estimateMergeFinalization({
    context,
  });
  if (
    estimatedWrites > mutationBudget - mutations ||
    estimatedWrites > MAX_MAX_MUTATIONS
  ) {
    await repository.updateRequest(
      context.descriptor,
      safeRequestPatch('contact_maintenance_budget_exhausted', now, {
        status: 'queued',
        requiresServerExecution: true,
        lastAttemptAt: now,
      }),
    );
    return Object.freeze({
      completed: false,
      deferred: true,
      mutations: mutations + 1,
    });
  }
  const finalized = await repository.finalizeMergeRecovery({
    descriptor: context.descriptor,
    now,
    mutationBudget: mutationBudget - mutations,
  });
  return Object.freeze({
    completed: true,
    deferred: false,
    mutations: mutations + finalized.writes,
  });
}

async function executeRequest({
  descriptor,
  repository,
  now,
  mutationBudget,
}) {
  const validated = validateDescriptor(descriptor);
  return validated.kind === 'purge'
    ? processPurgeRequest({
        descriptor: validated,
        repository,
        now,
        mutationBudget,
      })
    : processMergeRecoveryRequest({
        descriptor: validated,
        repository,
        now,
        mutationBudget,
      });
}

async function processListedRequests({
  listed,
  repository,
  now,
  maxMutations,
  logger,
}) {
  const report = {
    schemaVersion: 1,
    requestsExamined: 0,
    completed: 0,
    deferred: 0,
    needsReview: 0,
    expired: 0,
    retryableFailures: 0,
    mutations: 0,
    hasMore: listed.hasMore === true,
  };

  for (const descriptor of listed.requests) {
    if (report.mutations >= maxMutations) {
      report.hasMore = true;
      break;
    }
    report.requestsExamined += 1;
    try {
      const result = await executeRequest({
        descriptor,
        repository,
        now,
        mutationBudget: maxMutations - report.mutations,
      });
      report.mutations += result.mutations;
      if (result.completed) report.completed += 1;
      else if (result.deferred) report.deferred += 1;
    } catch (error) {
      const disposition = await markDisposition(
        repository,
        descriptor,
        error,
        now,
      );
      if (disposition === 'needs-review') report.needsReview += 1;
      else if (disposition === 'expired') report.expired += 1;
      else if (disposition === 'deferred') report.deferred += 1;
      else {
        report.retryableFailures += 1;
        logger?.error?.('[contact-maintenance] request failed', {
          subject: subjectHash(descriptor.uid),
          requestKind:
            descriptor.kind === 'purge' ? 'purge' : 'merge-recovery',
          errorCode: safeErrorCode(error?.code),
        });
      }
      report.mutations += 1;
    }
  }

  return Object.freeze(report);
}

export async function runOwnerContactMaintenance({
  db,
  uid,
  repository = createFirestoreContactMaintenanceRepository(db),
  now = new Date(),
  maxRequests,
  maxMutations,
  logger = console,
}) {
  const owner = safeSegment(uid);
  const runAt = valueDate(now);
  if (!runAt) {
    throw maintenanceError('contact_maintenance_clock_invalid');
  }
  const limits = normalizeContactMaintenanceLimits({
    maxRequests,
    maxMutations,
  });
  const listed = await repository.listOwnerRequests(
    owner,
    limits.maxRequests,
  );
  if (
    listed.requests.some(
      (descriptor) => descriptor.uid !== owner,
    )
  ) {
    throw maintenanceError('contact_maintenance_ownership_invalid');
  }
  return processListedRequests({
    listed,
    repository,
    now: runAt,
    maxMutations: limits.maxMutations,
    logger,
  });
}

/**
 * Undeployed scheduler/admin seam. It discovers bounded queued documents via
 * collection-group queries, derives each owner from the verified Firestore
 * path, and never accepts a caller-provided UID.
 */
export async function runScheduledContactMaintenance({
  db,
  repository = createFirestoreContactMaintenanceRepository(db),
  now = new Date(),
  maxRequests,
  maxMutations,
  logger = console,
}) {
  const runAt = valueDate(now);
  if (!runAt) {
    throw maintenanceError('contact_maintenance_clock_invalid');
  }
  const limits = normalizeContactMaintenanceLimits({
    maxRequests,
    maxMutations,
  });
  const listed = await repository.listScheduledRequests(limits.maxRequests);
  return processListedRequests({
    listed,
    repository,
    now: runAt,
    maxMutations: limits.maxMutations,
    logger,
  });
}

export const CONTACT_MAINTENANCE_SCHEMA = Object.freeze({
  protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
  rootReferenceCollections: ROOT_REFERENCES.map(
    (item) => item.collectionName,
  ),
  nestedReferenceCollections: NESTED_REFERENCES.map(
    (item) => item.collectionName,
  ),
  endpointReferenceCollections: ['connections'],
  dependentReferenceCollections: ['commitmentFeedbackEvents'],
  eventReferenceCollections: ['contactEvents'],
  profileFields: [...PROFILE_FIELDS],
});
