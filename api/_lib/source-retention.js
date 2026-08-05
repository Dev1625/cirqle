import { FieldPath } from 'firebase-admin/firestore';

/**
 * Server-side mirror of src/lib/moat/privacyPolicy.ts.
 *
 * This module deliberately does not import the browser Firebase bundle. Keep
 * schema version 1, source types, boundary ids, and the 1..3650 day bounds in
 * lockstep with that client-side module.
 */
export const RETENTION_SOURCE_TYPES = Object.freeze([
  'profile',
  'import',
  'note',
  'voice',
  'meeting',
  'calendar',
  'email',
  'outreach',
  'reply',
  'commitment',
  'public-card-capture',
  'user-input',
  'system',
]);

const SOURCE_TYPE_SET = new Set(RETENTION_SOURCE_TYPES);
const RETENTION_MODES = new Set([
  'forever',
  'days',
  'delete-on-disconnect',
]);
const MAX_SOURCE_ID_LENGTH = 180;
const DAY_MS = 86_400_000;
const MAX_DELETE_BATCH_SIZE = 400;
const DEFAULT_DELETE_BATCH_SIZE = 200;
const MAX_SCANNED_DOCUMENTS = 5_000;
const DEFAULT_SCANNED_DOCUMENTS = 1_000;
const MAX_READ_PAGE_SIZE = 250;
const DEFAULT_READ_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 4_096;

const TOP_LEVEL_COLLECTIONS = Object.freeze([
  Object.freeze({ name: 'notes', defaultSourceType: 'note' }),
  Object.freeze({ name: 'outreaches', defaultSourceType: 'outreach' }),
  Object.freeze({ name: 'threads', defaultSourceType: 'email' }),
  Object.freeze({ name: 'commitments', defaultSourceType: 'commitment' }),
  // These collections are supported as exact, forward-compatible storage
  // seams. The current web app stores meetings/voice/replies in notes and
  // identifies them with metadata instead.
  Object.freeze({ name: 'meetings', defaultSourceType: 'meeting' }),
  Object.freeze({ name: 'voiceMemos', defaultSourceType: 'voice' }),
  Object.freeze({ name: 'emails', defaultSourceType: 'email' }),
  Object.freeze({ name: 'replies', defaultSourceType: 'reply' }),
  Object.freeze({ name: 'calendarEvents', defaultSourceType: 'calendar' }),
]);

const FACTS_SOURCE_INDEX = TOP_LEVEL_COLLECTIONS.length;

const NOTE_SOURCE_MARKERS = Object.freeze({
  'quick-note': 'note',
  'sensitive-note': 'note',
  'voice-memo': 'voice',
  voice: 'voice',
  'meeting-log': 'meeting',
  meeting: 'meeting',
  'calendar-meeting': 'meeting',
  reply: 'reply',
  'pasted-reply': 'reply',
  email: 'email',
  gmail: 'email',
  'gmail-message': 'email',
  'public-card-capture': 'public-card-capture',
  'ai-tag-extraction': 'user-input',
});

const FACT_SOURCE_TYPE_MAP = Object.freeze({
  profile: 'profile',
  import: 'import',
  note: 'note',
  voice: 'voice',
  meeting: 'meeting',
  calendar: 'calendar',
  email: 'email',
  outreach: 'outreach',
  reply: 'reply',
  commitment: 'commitment',
  'public-card-capture': 'public-card-capture',
  'public-card': 'public-card-capture',
  'user-input': 'user-input',
  'user-correction': 'user-input',
  system: 'system',
});

export class SourceRetentionError extends Error {
  constructor({
    code = 'retention_sweep_invalid',
    message = 'The retention sweep request is invalid.',
    status = 400,
  } = {}) {
    super(message);
    this.name = 'SourceRetentionError';
    this.code = code;
    this.status = status;
  }
}

function boundedInteger(
  value,
  {
    fallback,
    minimum = 1,
    maximum,
    field,
  },
) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SourceRetentionError({
      code: 'retention_sweep_invalid',
      message: `${field} must be an integer between ${minimum} and ${maximum}.`,
    });
  }
  return parsed;
}

function normalizedSourceId(value) {
  return String(value || '').trim().slice(0, MAX_SOURCE_ID_LENGTH);
}

function normalizedDocumentId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 1_500 || id.includes('/')) return null;
  return id;
}

function normalizeRetentionDays(mode, value) {
  if (mode !== 'days') return null;
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3_650) {
    throw new SourceRetentionError({
      code: 'retention_policy_invalid',
      message: 'Retention days must be between 1 and 3650.',
    });
  }
  return parsed;
}

function sourceTypeBoundaryId(sourceType) {
  return `type:${sourceType}`;
}

function exactSourceBoundaryId(sourceType, sourceId) {
  return `source:${sourceType}:${normalizedSourceId(sourceId)}`;
}

function normalizeBoundary(candidate) {
  if (
    !candidate ||
    !SOURCE_TYPE_SET.has(candidate.sourceType) ||
    !RETENTION_MODES.has(candidate.retentionMode)
  ) {
    return null;
  }
  const sourceId = normalizedSourceId(candidate.sourceId) || null;
  const scope = sourceId ? 'source' : 'source-type';
  let retentionDays;
  try {
    retentionDays = normalizeRetentionDays(
      candidate.retentionMode,
      candidate.retentionDays,
    );
  } catch {
    return null;
  }
  const aiUse = candidate.aiUse === 'never' ? 'never' : 'allow';
  return Object.freeze({
    id: sourceId
      ? exactSourceBoundaryId(candidate.sourceType, sourceId)
      : sourceTypeBoundaryId(candidate.sourceType),
    scope,
    sourceType: candidate.sourceType,
    sourceId,
    retentionMode: candidate.retentionMode,
    retentionDays,
    aiUse,
  });
}

/**
 * Corrupted finite defaults remain finite with the same conservative 30-day
 * fallback used by the browser policy module. Malformed individual boundaries
 * are ignored instead of weakening otherwise-valid settings.
 */
export function normalizeServerSourcePrivacyPolicy(value) {
  let defaultRetentionMode = RETENTION_MODES.has(
    value?.defaultRetentionMode,
  )
    ? value.defaultRetentionMode
    : 'forever';
  let defaultRetentionDays = null;
  try {
    defaultRetentionDays = normalizeRetentionDays(
      defaultRetentionMode,
      value?.defaultRetentionDays,
    );
  } catch {
    defaultRetentionMode = 'days';
    defaultRetentionDays = 30;
  }

  const byId = new Map();
  for (const candidate of Array.isArray(value?.boundaries)
    ? value.boundaries
    : []) {
    const normalized = normalizeBoundary(candidate);
    if (normalized) byId.set(normalized.id, normalized);
  }

  return Object.freeze({
    schemaVersion: 1,
    defaultRetentionMode,
    defaultRetentionDays,
    defaultAIUse: value?.defaultAIUse === 'never' ? 'never' : 'allow',
    boundaries: Object.freeze(
      [...byId.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    ),
  });
}

function effectiveBoundary(candidate, policy) {
  const exactId = exactSourceBoundaryId(
    candidate.sourceType,
    candidate.sourceId,
  );
  return (
    policy.boundaries.find((boundary) => boundary.id === exactId) ||
    policy.boundaries.find(
      (boundary) =>
        boundary.scope === 'source-type' &&
        boundary.sourceType === candidate.sourceType,
    ) ||
    null
  );
}

function timestampMillis(value) {
  if (!value) return null;
  let candidate = value;
  if (typeof value?.toDate === 'function') {
    try {
      candidate = value.toDate();
    } catch {
      return null;
    }
  }
  const parsed =
    candidate instanceof Date
      ? candidate.getTime()
      : typeof candidate === 'number'
        ? candidate
        : Date.parse(String(candidate));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstTimestamp(data, fields) {
  for (const field of fields) {
    const parsed = timestampMillis(data?.[field]);
    if (parsed != null) return new Date(parsed);
  }
  return null;
}

/**
 * Pure retention evaluation. The sweep never guesses the age of an undated
 * record and never treats an unknown provider state as disconnected.
 */
export function evaluateServerSourceRetention(
  candidate,
  rawPolicy,
  now = new Date(),
) {
  if (
    !candidate ||
    !SOURCE_TYPE_SET.has(candidate.sourceType) ||
    !normalizedSourceId(candidate.sourceId)
  ) {
    throw new SourceRetentionError({
      code: 'retention_candidate_invalid',
      message: 'A valid source id and source type are required.',
    });
  }
  const nowMs = timestampMillis(now);
  if (nowMs == null) {
    throw new SourceRetentionError({
      code: 'retention_sweep_invalid',
      message: 'The sweep time must be a valid date.',
    });
  }

  const policy = normalizeServerSourcePrivacyPolicy(rawPolicy);
  const boundary = effectiveBoundary(candidate, policy);
  const retentionMode =
    boundary?.retentionMode || policy.defaultRetentionMode;
  const retentionDays =
    boundary?.retentionMode === 'days'
      ? boundary.retentionDays
      : policy.defaultRetentionDays;

  if (
    retentionMode === 'delete-on-disconnect' &&
    candidate.disconnected === true
  ) {
    return Object.freeze({
      eligible: true,
      reason: 'provider-disconnected',
      boundaryId: boundary?.id || 'default',
      expiresAt: null,
    });
  }

  if (retentionMode !== 'days') {
    return Object.freeze({
      eligible: false,
      reason: 'retained',
      boundaryId: boundary?.id || 'default',
      expiresAt: null,
    });
  }

  const observedAtMs = timestampMillis(candidate.observedAt);
  if (observedAtMs == null) {
    return Object.freeze({
      eligible: false,
      reason: 'observed-at-missing',
      boundaryId: boundary?.id || 'default',
      expiresAt: null,
    });
  }

  const expiresAtMs = observedAtMs + Number(retentionDays) * DAY_MS;
  return Object.freeze({
    eligible: expiresAtMs <= nowMs,
    reason: expiresAtMs <= nowMs ? 'retention-expired' : 'retained',
    boundaryId: boundary?.id || 'default',
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
}

function explicitSourceType(data) {
  for (const value of [data?.privacySourceType, data?.recordSourceType]) {
    if (SOURCE_TYPE_SET.has(value)) return value;
  }
  return null;
}

function noteSourceType(data) {
  const explicit = explicitSourceType(data);
  if (
    explicit &&
    [
      'note',
      'voice',
      'meeting',
      'email',
      'reply',
      'public-card-capture',
      'user-input',
    ].includes(explicit)
  ) {
    return explicit;
  }
  const marker = String(data?.source || '').trim().toLowerCase();
  if (NOTE_SOURCE_MARKERS[marker]) return NOTE_SOURCE_MARKERS[marker];
  // A deliberately selected reply link is stable metadata. Its presence is
  // enough to distinguish a pasted reply without reading note content.
  if (data?.replyTargetOutreachId || data?.replyTargetThreadId) return 'reply';
  return 'note';
}

function providerForRecord({ collectionName, sourceType, data }) {
  const explicit = String(
    data?.privacyProvider || data?.provider || '',
  ).toLowerCase();
  if (['gmail', 'google-mail'].includes(explicit)) return 'gmail';
  if (['calendar', 'google-calendar'].includes(explicit)) return 'calendar';
  if (collectionName === 'threads') return 'gmail';
  if (collectionName === 'calendarEvents') return 'calendar';
  if (
    sourceType === 'meeting' &&
    String(data?.source || '').toLowerCase() === 'calendar-meeting'
  ) {
    return 'calendar';
  }
  return null;
}

function observedAtForRecord(collectionName, sourceType, data) {
  if (collectionName === 'outreaches') {
    return firstTimestamp(data, ['sentAt', 'createdAt', 'updatedAt']);
  }
  if (collectionName === 'threads') {
    return firstTimestamp(data, ['sentAt', 'createdAt', 'lastCheckedAt']);
  }
  if (collectionName === 'commitments') {
    return firstTimestamp(data, ['createdAt', 'updatedAt']);
  }
  if (sourceType === 'meeting' || collectionName === 'meetings') {
    return firstTimestamp(data, [
      'observedAt',
      'meetingAt',
      'startAt',
      'createdAt',
      'updatedAt',
    ]);
  }
  if (sourceType === 'email' || collectionName === 'emails') {
    return firstTimestamp(data, [
      'receivedAt',
      'sentAt',
      'observedAt',
      'createdAt',
      'updatedAt',
    ]);
  }
  if (sourceType === 'reply' || collectionName === 'replies') {
    return firstTimestamp(data, [
      'receivedAt',
      'observedAt',
      'createdAt',
      'updatedAt',
    ]);
  }
  return firstTimestamp(data, ['observedAt', 'createdAt', 'updatedAt']);
}

/**
 * Converts one allowlisted storage document into a deletion candidate.
 * Contacts are intentionally not in the allowlist. The function never looks
 * at note bodies, subjects, names, emails, or any other source content.
 */
export function classifyStoredRetentionDocument({
  collectionName,
  documentId,
  data = {},
  ref = null,
  connections = {},
}) {
  const id = normalizedDocumentId(documentId);
  if (!id) return null;

  if (collectionName === 'facts') {
    const sourceType =
      FACT_SOURCE_TYPE_MAP[String(data?.sourceType || '').toLowerCase()];
    if (!sourceType) return null;
    const sourceId = normalizedSourceId(data?.sourceId) || id;
    const provider = providerForRecord({
      collectionName,
      sourceType,
      data,
    });
    return Object.freeze({
      sourceType,
      sourceId,
      observedAt: firstTimestamp(data, ['observedAt', 'createdAt']),
      disconnected: provider
        ? connections?.[provider] === false
        : false,
      storageKind: 'fact',
      ref,
    });
  }

  const definition = TOP_LEVEL_COLLECTIONS.find(
    (candidate) => candidate.name === collectionName,
  );
  if (!definition) return null;

  let sourceType = definition.defaultSourceType;
  if (collectionName === 'notes') {
    sourceType = noteSourceType(data);
  } else if (
    collectionName !== 'commitments' &&
    explicitSourceType(data)
  ) {
    // A commitment is always retained as a commitment record. Its origin
    // sourceType is provenance, not the privacy identity of this document.
    sourceType = explicitSourceType(data);
  }

  const provider = providerForRecord({
    collectionName,
    sourceType,
    data,
  });
  return Object.freeze({
    sourceType,
    sourceId: id,
    observedAt: observedAtForRecord(collectionName, sourceType, data),
    disconnected: provider ? connections?.[provider] === false : false,
    storageKind: collectionName,
    ref,
  });
}

function reportBucket() {
  return {
    scanned: 0,
    eligible: 0,
    deleted: 0,
    retained: 0,
    missingObservedAt: 0,
    providerDisconnected: 0,
  };
}

function safeCandidateKey(candidate, index) {
  if (typeof candidate?.ref?.path === 'string') {
    return `path:${candidate.ref.path}`;
  }
  if (typeof candidate?.storageKey === 'string') {
    return `key:${candidate.storageKey}`;
  }
  return `${candidate?.storageKind || 'unknown'}:${candidate?.sourceType || 'unknown'}:${normalizedSourceId(candidate?.sourceId)}:${index}`;
}

/**
 * Applies a policy to already-scoped candidate documents. Delete commits are
 * bounded below Firestore's 500-write limit, candidates are de-duplicated by
 * storage reference, and the returned report contains counts only.
 */
export async function executeSourceRetentionSweep({
  candidates,
  policy,
  dryRun = true,
  now = new Date(),
  batchSize = DEFAULT_DELETE_BATCH_SIZE,
  commitDeleteBatch,
}) {
  const normalizedBatchSize = boundedInteger(batchSize, {
    fallback: DEFAULT_DELETE_BATCH_SIZE,
    maximum: MAX_DELETE_BATCH_SIZE,
    field: 'batchSize',
  });
  if (!dryRun && typeof commitDeleteBatch !== 'function') {
    throw new SourceRetentionError({
      code: 'retention_delete_unavailable',
      message: 'Retention deletion is unavailable.',
      status: 503,
    });
  }

  const normalizedPolicy = normalizeServerSourcePrivacyPolicy(policy);
  const bySourceType = {};
  const eligible = [];
  const seen = new Set();
  let scanned = 0;
  let retained = 0;
  let missingObservedAt = 0;
  let providerDisconnected = 0;

  let index = 0;
  for await (const candidate of candidates || []) {
    const key = safeCandidateKey(candidate, index);
    index += 1;
    if (seen.has(key)) continue;
    seen.add(key);

    const decision = evaluateServerSourceRetention(
      candidate,
      normalizedPolicy,
      now,
    );
    const bucket =
      bySourceType[candidate.sourceType] ||
      (bySourceType[candidate.sourceType] = reportBucket());
    bucket.scanned += 1;
    scanned += 1;

    if (decision.eligible) {
      bucket.eligible += 1;
      if (decision.reason === 'provider-disconnected') {
        bucket.providerDisconnected += 1;
        providerDisconnected += 1;
      }
      eligible.push(candidate);
    } else {
      bucket.retained += 1;
      retained += 1;
      if (decision.reason === 'observed-at-missing') {
        bucket.missingObservedAt += 1;
        missingObservedAt += 1;
      }
    }
  }

  let deleted = 0;
  if (!dryRun) {
    for (
      let offset = 0;
      offset < eligible.length;
      offset += normalizedBatchSize
    ) {
      const batch = eligible.slice(offset, offset + normalizedBatchSize);
      if (batch.some((candidate) => !candidate.ref)) {
        throw new SourceRetentionError({
          code: 'retention_delete_unavailable',
          message: 'Retention deletion is unavailable.',
          status: 503,
        });
      }
      await commitDeleteBatch(batch.map((candidate) => candidate.ref));
      deleted += batch.length;
      for (const candidate of batch) {
        bySourceType[candidate.sourceType].deleted += 1;
      }
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    dryRun: Boolean(dryRun),
    evaluatedAt: new Date(timestampMillis(now)).toISOString(),
    scanned,
    eligible: eligible.length,
    retained,
    deleted,
    missingObservedAt,
    providerDisconnected,
    bySourceType,
  });
}

function encodeCursorState(state) {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export function decodeRetentionSweepCursor(value) {
  if (value == null || value === '') {
    return Object.freeze({ version: 1, sourceIndex: 0 });
  }
  if (typeof value !== 'string' || value.length > MAX_CURSOR_LENGTH) {
    throw new SourceRetentionError({
      code: 'retention_cursor_invalid',
      message: 'The retention sweep cursor is invalid.',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new SourceRetentionError({
      code: 'retention_cursor_invalid',
      message: 'The retention sweep cursor is invalid.',
    });
  }

  if (
    parsed?.version !== 1 ||
    !Number.isInteger(parsed.sourceIndex) ||
    parsed.sourceIndex < 0 ||
    parsed.sourceIndex > FACTS_SOURCE_INDEX
  ) {
    throw new SourceRetentionError({
      code: 'retention_cursor_invalid',
      message: 'The retention sweep cursor is invalid.',
    });
  }

  for (const field of [
    'afterDocumentId',
    'afterContactId',
    'currentContactId',
    'afterFactId',
  ]) {
    if (
      parsed[field] != null &&
      normalizedDocumentId(parsed[field]) !== parsed[field]
    ) {
      throw new SourceRetentionError({
        code: 'retention_cursor_invalid',
        message: 'The retention sweep cursor is invalid.',
      });
    }
  }
  return Object.freeze({
    version: 1,
    sourceIndex: parsed.sourceIndex,
    ...(parsed.afterDocumentId
      ? { afterDocumentId: parsed.afterDocumentId }
      : {}),
    ...(parsed.afterContactId
      ? { afterContactId: parsed.afterContactId }
      : {}),
    ...(parsed.currentContactId
      ? { currentContactId: parsed.currentContactId }
      : {}),
    ...(parsed.afterFactId ? { afterFactId: parsed.afterFactId } : {}),
  });
}

function orderedPage(collectionRef, { afterId = null, limit }) {
  let query = collectionRef
    .orderBy(FieldPath.documentId())
    .limit(limit);
  if (afterId) query = query.startAfter(afterId);
  return query.get();
}

async function scanRegularCollection({
  db,
  uid,
  definition,
  sourceIndex,
  afterDocumentId,
  connections,
  candidates,
  scanBudget,
  pageSize,
}) {
  let afterId = afterDocumentId || null;
  const collectionRef = db.collection(
    `users/${uid}/${definition.name}`,
  );

  while (scanBudget.remaining > 0) {
    const remaining = scanBudget.remaining;
    const readLimit = Math.min(pageSize, remaining + 1);
    const snapshot = await orderedPage(collectionRef, {
      afterId,
      limit: readLimit,
    });
    const documents = snapshot.docs || [];
    if (documents.length === 0) {
      return { complete: true };
    }

    const processCount = Math.min(documents.length, remaining);
    for (let index = 0; index < processCount; index += 1) {
      const document = documents[index];
      scanBudget.remaining -= 1;
      const candidate = classifyStoredRetentionDocument({
        collectionName: definition.name,
        documentId: document.id,
        data: document.data() || {},
        ref: document.ref,
        connections,
      });
      if (candidate) candidates.push(candidate);
      afterId = document.id;
    }

    if (processCount < documents.length || scanBudget.remaining === 0) {
      return {
        complete: false,
        cursor: encodeCursorState({
          version: 1,
          sourceIndex,
          afterDocumentId: afterId,
        }),
      };
    }
    if (documents.length < readLimit) return { complete: true };
  }

  return {
    complete: false,
    cursor: encodeCursorState({
      version: 1,
      sourceIndex,
      afterDocumentId: afterId,
    }),
  };
}

async function scanFactsForContact({
  contactRef,
  contactId,
  afterFactId,
  connections,
  candidates,
  scanBudget,
  pageSize,
}) {
  let afterId = afterFactId || null;
  while (scanBudget.remaining > 0) {
    const remaining = scanBudget.remaining;
    const readLimit = Math.min(pageSize, remaining + 1);
    const snapshot = await orderedPage(contactRef.collection('facts'), {
      afterId,
      limit: readLimit,
    });
    const documents = snapshot.docs || [];
    if (documents.length === 0) return { complete: true };

    const processCount = Math.min(documents.length, remaining);
    for (let index = 0; index < processCount; index += 1) {
      const document = documents[index];
      scanBudget.remaining -= 1;
      const candidate = classifyStoredRetentionDocument({
        collectionName: 'facts',
        documentId: document.id,
        data: document.data() || {},
        ref: document.ref,
        connections,
      });
      if (candidate) candidates.push(candidate);
      afterId = document.id;
    }

    if (processCount < documents.length || scanBudget.remaining === 0) {
      return {
        complete: false,
        cursor: encodeCursorState({
          version: 1,
          sourceIndex: FACTS_SOURCE_INDEX,
          currentContactId: contactId,
          afterFactId: afterId,
        }),
      };
    }
    if (documents.length < readLimit) return { complete: true };
  }
  return {
    complete: false,
    cursor: encodeCursorState({
      version: 1,
      sourceIndex: FACTS_SOURCE_INDEX,
      currentContactId: contactId,
      afterFactId: afterId,
    }),
  };
}

async function scanFactCollections({
  db,
  uid,
  cursor,
  connections,
  candidates,
  maxDocuments,
  scanBudget,
  pageSize,
}) {
  let afterContactId = cursor.afterContactId || null;
  let traversedContacts = 0;
  const maxContactTraversal = Math.max(
    50,
    Math.min(1_000, maxDocuments),
  );

  if (cursor.currentContactId) {
    const contactRef = db.doc(
      `users/${uid}/contacts/${cursor.currentContactId}`,
    );
    const result = await scanFactsForContact({
      contactRef,
      contactId: cursor.currentContactId,
      afterFactId: cursor.afterFactId || null,
      connections,
      candidates,
      scanBudget,
      pageSize,
    });
    if (!result.complete) return result;
    afterContactId = cursor.currentContactId;
  }

  const contactsRef = db.collection(`users/${uid}/contacts`);
  while (
    scanBudget.remaining > 0 &&
    traversedContacts < maxContactTraversal
  ) {
    const remainingContacts = maxContactTraversal - traversedContacts;
    const readLimit = Math.min(pageSize, remainingContacts);
    const snapshot = await orderedPage(contactsRef, {
      afterId: afterContactId,
      limit: readLimit,
    });
    const contacts = snapshot.docs || [];
    if (contacts.length === 0) return { complete: true };

    for (const contact of contacts) {
      traversedContacts += 1;
      const result = await scanFactsForContact({
        contactRef: contact.ref,
        contactId: contact.id,
        afterFactId: null,
        connections,
        candidates,
        scanBudget,
        pageSize,
      });
      if (!result.complete) return result;
      afterContactId = contact.id;

      if (
        scanBudget.remaining === 0 ||
        traversedContacts >= maxContactTraversal
      ) {
        return {
          complete: false,
          cursor: encodeCursorState({
            version: 1,
            sourceIndex: FACTS_SOURCE_INDEX,
            afterContactId,
          }),
        };
      }
    }
    if (contacts.length < readLimit) return { complete: true };
  }

  return {
    complete: false,
    cursor: encodeCursorState({
      version: 1,
      sourceIndex: FACTS_SOURCE_INDEX,
      ...(afterContactId ? { afterContactId } : {}),
    }),
  };
}

/**
 * Reads only allowlisted per-user source collections. Every query is paged
 * and every run has a hard candidate bound. The opaque cursor resumes a later
 * call without ever accepting a user-controlled Firestore path.
 */
export async function scanFirestoreRetentionCandidates({
  db,
  uid,
  connections = {},
  cursor: rawCursor = null,
  maxDocuments = DEFAULT_SCANNED_DOCUMENTS,
  pageSize = DEFAULT_READ_PAGE_SIZE,
}) {
  if (!db || typeof db.collection !== 'function' || typeof db.doc !== 'function') {
    throw new SourceRetentionError({
      code: 'retention_storage_unavailable',
      message: 'Retention storage is unavailable.',
      status: 503,
    });
  }
  if (typeof uid !== 'string' || !uid.trim() || uid.includes('/')) {
    throw new SourceRetentionError({
      code: 'retention_sweep_invalid',
      message: 'A valid account identity is required.',
    });
  }
  const normalizedMaxDocuments = boundedInteger(maxDocuments, {
    fallback: DEFAULT_SCANNED_DOCUMENTS,
    maximum: MAX_SCANNED_DOCUMENTS,
    field: 'maxDocuments',
  });
  const normalizedPageSize = boundedInteger(pageSize, {
    fallback: DEFAULT_READ_PAGE_SIZE,
    maximum: MAX_READ_PAGE_SIZE,
    field: 'pageSize',
  });
  const cursor = decodeRetentionSweepCursor(rawCursor);
  const candidates = [];
  const scanBudget = { remaining: normalizedMaxDocuments };

  for (
    let sourceIndex = cursor.sourceIndex;
    sourceIndex < TOP_LEVEL_COLLECTIONS.length;
    sourceIndex += 1
  ) {
    const result = await scanRegularCollection({
      db,
      uid,
      definition: TOP_LEVEL_COLLECTIONS[sourceIndex],
      sourceIndex,
      afterDocumentId:
        sourceIndex === cursor.sourceIndex
          ? cursor.afterDocumentId
          : null,
      connections,
      candidates,
      scanBudget,
      pageSize: normalizedPageSize,
    });
    if (!result.complete) {
      return Object.freeze({
        candidates: Object.freeze(candidates),
        hasMore: true,
        nextCursor: result.cursor,
      });
    }
  }

  const factCursor =
    cursor.sourceIndex === FACTS_SOURCE_INDEX
      ? cursor
      : { version: 1, sourceIndex: FACTS_SOURCE_INDEX };
  const factResult = await scanFactCollections({
    db,
    uid,
    cursor: factCursor,
    connections,
    candidates,
    maxDocuments: normalizedMaxDocuments,
    scanBudget,
    pageSize: normalizedPageSize,
  });
  return Object.freeze({
    candidates: Object.freeze(candidates),
    hasMore: !factResult.complete,
    nextCursor: factResult.complete ? null : factResult.cursor,
  });
}

async function readConnectionState(db, uid, provider) {
  const snapshot = await db
    .doc(`users/${uid}/integrations/${provider}`)
    .get();
  if (!snapshot.exists) return null;
  const connected = snapshot.data()?.connected;
  return connected === true ? true : connected === false ? false : null;
}

async function loadRetentionPolicy(db, uid) {
  const snapshot = await db
    .doc(`users/${uid}/settings/privacy`)
    .get();
  return normalizeServerSourcePrivacyPolicy(
    snapshot.exists ? snapshot.data() || {} : {},
  );
}

async function commitFirestoreDeleteBatch(db, refs) {
  if (refs.length === 0) return;
  if (refs.length > MAX_DELETE_BATCH_SIZE) {
    throw new SourceRetentionError({
      code: 'retention_delete_batch_too_large',
      message: 'The retention delete batch is too large.',
      status: 500,
    });
  }
  const batch = db.batch();
  for (const ref of refs) batch.delete(ref);
  await batch.commit();
}

/**
 * Reusable admin/scheduler seam. No scheduler is deployed here: a trusted
 * caller may enumerate account UIDs and repeatedly invoke this function until
 * hasMore is false. It never logs and it never returns source ids or content.
 */
export async function runAdminSourceRetentionSweep({
  db,
  uid,
  dryRun = true,
  now = new Date(),
  cursor = null,
  maxDocuments = DEFAULT_SCANNED_DOCUMENTS,
  pageSize = DEFAULT_READ_PAGE_SIZE,
  batchSize = DEFAULT_DELETE_BATCH_SIZE,
  loadPolicy = loadRetentionPolicy,
  loadConnections,
  scanCandidates = scanFirestoreRetentionCandidates,
  commitDeleteBatch = (refs) => commitFirestoreDeleteBatch(db, refs),
}) {
  const [policy, connections] = await Promise.all([
    loadPolicy(db, uid),
    loadConnections
      ? loadConnections(db, uid)
      : Promise.all([
          readConnectionState(db, uid, 'gmail'),
          readConnectionState(db, uid, 'calendar'),
        ]).then(([gmail, calendar]) => ({ gmail, calendar })),
  ]);
  const scan = await scanCandidates({
    db,
    uid,
    connections,
    cursor,
    maxDocuments,
    pageSize,
  });
  const report = await executeSourceRetentionSweep({
    candidates: scan.candidates,
    policy,
    dryRun,
    now,
    batchSize,
    commitDeleteBatch,
  });
  return Object.freeze({
    ...report,
    hasMore: scan.hasMore === true,
    nextCursor:
      scan.hasMore === true && typeof scan.nextCursor === 'string'
        ? scan.nextCursor
        : null,
  });
}
