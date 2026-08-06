import { createHash } from 'node:crypto';

import { FieldValue } from 'firebase-admin/firestore';

const RECOVERY_WINDOW_DAYS = 30;
const MAX_TRANSACTION_WRITES = 450;
const MERGE_PROTOCOL_VERSION = 1;

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

const PROFILE_FIELD_SET = new Set(PROFILE_FIELDS);
const FIELD_LIMITS = Object.freeze({
  name: 160,
  email: 320,
  phone: 80,
  company: 200,
  role: 200,
  location: 200,
  linkedinUrl: 2_048,
  summary: 4_000,
  relationshipTier: 16,
  industry: 160,
  subIndustry: 160,
  school: 200,
  seniority: 120,
  connectionSource: 240,
  whyTheyMatter: 2_000,
});

const PROFILE_DEFAULTS = Object.freeze({
  name: '',
  email: '',
  phone: '',
  company: '',
  role: '',
  location: '',
  linkedinUrl: '',
  summary: '',
  relationshipTier: 'Cold',
  industry: '',
  subIndustry: '',
  school: '',
  seniority: '',
  connectionSource: '',
  whyTheyMatter: '',
  tags: [],
});

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

const REFERENCE_KINDS = Object.freeze([
  ...ROOT_REFERENCES.map((reference) => reference.kind),
  'connection',
  'fact',
  'job-history',
]);

const REQUEST_FIELDS = new Set([
  'operationId',
  'primaryContactId',
  'duplicateContactId',
  'choices',
  'confirmed',
  'expectedPrimary',
  'expectedDuplicate',
]);
const CHOICE_FIELDS = new Set(['field', 'strategy', 'customValue']);
const EXPECTED_CONTACT_FIELDS = new Set([
  'profile',
  'lifecycleStatus',
  'aiAllowed',
  'mergedIntoContactId',
  'contactMergeOperationId',
]);
const STRATEGIES = new Set([
  'primary',
  'duplicate',
  'combine',
  'custom',
]);

export class ContactMergeError extends Error {
  constructor({
    code = 'contact_merge_invalid',
    message = 'The contact merge request is invalid.',
    status = 400,
  } = {}) {
    super(message);
    this.name = 'ContactMergeError';
    this.code = code;
    this.status = status;
  }
}

function mergeError(code, message, status = 400) {
  return new ContactMergeError({ code, message, status });
}

function safeDocumentId(value, field, { operation = false } = {}) {
  const id = typeof value === 'string' ? value.trim() : '';
  const valid =
    id &&
    id.length <= (operation ? 128 : 300) &&
    !id.includes('/') &&
    id !== '.' &&
    id !== '..' &&
    (!operation || /^[A-Za-z0-9_-]{20,128}$/.test(id));
  if (!valid) {
    throw mergeError(
      'contact_merge_invalid',
      `${field} is invalid.`,
    );
  }
  return id;
}

function cleanText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
}

function cleanMultilineText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .join('\n')
    .trim();
}

function normalizeEmail(value) {
  const email = cleanText(value).toLocaleLowerCase();
  if (!email || email.length > FIELD_LIMITS.email) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function normalizeHttpsUrl(value) {
  const candidate = cleanText(value);
  if (!candidate || candidate.length > FIELD_LIMITS.linkedinUrl) return '';
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeIdentityText(value) {
  return cleanText(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeTags(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[;,|]/)
      : [];
  const seen = new Set();
  const tags = [];
  for (const raw of source) {
    const tag = cleanText(raw).slice(0, 80);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === 40) break;
  }
  return tags;
}

function profileValidationErrors(profile) {
  const errors = [];
  if (!profile.name) errors.push('name');
  for (const field of PROFILE_FIELDS) {
    if (field === 'tags') continue;
    if (profile[field].length > FIELD_LIMITS[field]) errors.push(field);
  }
  if (profile.email && !normalizeEmail(profile.email)) errors.push('email');
  if (profile.linkedinUrl) {
    try {
      const url = new URL(profile.linkedinUrl);
      if (url.protocol !== 'https:') errors.push('linkedinUrl');
    } catch {
      errors.push('linkedinUrl');
    }
  }
  if (!['Cold', 'Warm', 'Strong'].includes(profile.relationshipTier)) {
    errors.push('relationshipTier');
  }
  return [...new Set(errors)];
}

function sanitizeProfile(value) {
  const profile = {
    ...PROFILE_DEFAULTS,
    name: cleanText(value?.name),
    email: cleanText(value?.email).toLocaleLowerCase(),
    phone: cleanText(value?.phone),
    company: cleanText(value?.company),
    role: cleanText(value?.role),
    location: cleanText(value?.location),
    linkedinUrl: cleanText(value?.linkedinUrl),
    summary: cleanMultilineText(value?.summary),
    relationshipTier:
      value?.relationshipTier === 'Warm' ||
      value?.relationshipTier === 'Strong'
        ? value.relationshipTier
        : 'Cold',
    industry: cleanText(value?.industry),
    subIndustry: cleanText(value?.subIndustry),
    school: cleanText(value?.school),
    seniority: cleanText(value?.seniority),
    connectionSource: cleanText(value?.connectionSource),
    whyTheyMatter: cleanMultilineText(value?.whyTheyMatter),
    tags: normalizeTags(value?.tags),
  };
  if (profileValidationErrors(profile).length) {
    throw mergeError(
      'contact_merge_profile_invalid',
      'The merged profile contains an invalid field.',
    );
  }
  return profile;
}

function profileFromRecord(value = {}) {
  try {
    return sanitizeProfile(value);
  } catch {
    return {
      ...PROFILE_DEFAULTS,
      ...Object.fromEntries(
        PROFILE_FIELDS.filter((field) => field !== 'tags').map((field) => [
          field,
          field === 'summary' || field === 'whyTheyMatter'
            ? cleanMultilineText(value[field])
            : cleanText(value[field]),
        ]),
      ),
      relationshipTier:
        value.relationshipTier === 'Warm' ||
        value.relationshipTier === 'Strong'
          ? value.relationshipTier
          : 'Cold',
      tags: normalizeTags(value.tags),
      email: normalizeEmail(value.email),
      linkedinUrl: normalizeHttpsUrl(value.linkedinUrl),
    };
  }
}

function comparableProfileValue(field, value) {
  if (field === 'tags') {
    return [...value]
      .map((tag) => tag.toLocaleLowerCase())
      .sort()
      .join('|');
  }
  if (field === 'email') return normalizeEmail(value);
  if (field === 'name' || field === 'company') {
    return normalizeIdentityText(value);
  }
  return cleanText(value).toLocaleLowerCase();
}

function isEmptyProfileValue(value) {
  return Array.isArray(value) ? value.length === 0 : !cleanText(value);
}

function normalizeChoice(choice) {
  if (
    !choice ||
    typeof choice !== 'object' ||
    Array.isArray(choice) ||
    Object.keys(choice).some((field) => !CHOICE_FIELDS.has(field)) ||
    !PROFILE_FIELD_SET.has(choice.field) ||
    !STRATEGIES.has(choice.strategy)
  ) {
    throw mergeError(
      'contact_merge_choice_invalid',
      'A merge-field choice is invalid.',
    );
  }
  if (choice.strategy === 'combine' && choice.field !== 'tags') {
    throw mergeError(
      'contact_merge_choice_invalid',
      'Only tags can be combined.',
    );
  }
  if (choice.strategy === 'custom') {
    if (choice.field === 'tags') {
      if (
        !Array.isArray(choice.customValue) &&
        typeof choice.customValue !== 'string'
      ) {
        throw mergeError(
          'contact_merge_choice_invalid',
          'A custom tag choice is invalid.',
        );
      }
      return Object.freeze({
        field: choice.field,
        strategy: choice.strategy,
        customValue: normalizeTags(choice.customValue),
      });
    }
    if (
      typeof choice.customValue !== 'string' ||
      choice.customValue.length > 20_000
    ) {
      throw mergeError(
        'contact_merge_choice_invalid',
        'A custom merge value is invalid.',
      );
    }
    return Object.freeze({
      field: choice.field,
      strategy: choice.strategy,
      customValue: choice.customValue,
    });
  }
  if (Object.hasOwn(choice, 'customValue')) {
    throw mergeError(
      'contact_merge_choice_invalid',
      'Only a custom choice may include a custom value.',
    );
  }
  return Object.freeze({
    field: choice.field,
    strategy: choice.strategy,
  });
}

function nullableDocumentId(value, field) {
  return value == null ? null : safeDocumentId(value, field);
}

function normalizeExpectedContact(value, field) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (candidate) => !EXPECTED_CONTACT_FIELDS.has(candidate),
    ) ||
    [...EXPECTED_CONTACT_FIELDS].some(
      (candidate) => !Object.hasOwn(value, candidate),
    ) ||
    !value.profile ||
    typeof value.profile !== 'object' ||
    Array.isArray(value.profile) ||
    Object.keys(value.profile).some(
      (candidate) => !PROFILE_FIELD_SET.has(candidate),
    ) ||
    PROFILE_FIELDS.some(
      (candidate) => !Object.hasOwn(value.profile, candidate),
    ) ||
    !['active', 'archived', 'deleted'].includes(value.lifecycleStatus) ||
    typeof value.aiAllowed !== 'boolean'
  ) {
    throw mergeError(
      'contact_merge_expected_state_invalid',
      `${field} is invalid.`,
    );
  }
  return Object.freeze({
    profile: Object.freeze(profileFromRecord(value.profile)),
    lifecycleStatus: value.lifecycleStatus,
    aiAllowed: value.aiAllowed,
    mergedIntoContactId: nullableDocumentId(
      value.mergedIntoContactId,
      `${field}.mergedIntoContactId`,
    ),
    contactMergeOperationId: nullableDocumentId(
      value.contactMergeOperationId,
      `${field}.contactMergeOperationId`,
    ),
  });
}

export function normalizeContactMergeRequest(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((field) => !REQUEST_FIELDS.has(field))
  ) {
    throw mergeError(
      'contact_merge_field_not_allowed',
      'Only contact merge fields may be supplied. The signed-in account is always used.',
    );
  }
  if (input.confirmed !== true) {
    throw mergeError(
      'contact_merge_confirmation_required',
      'Explicit merge confirmation is required.',
    );
  }
  const operationId = safeDocumentId(input.operationId, 'operationId', {
    operation: true,
  });
  const primaryContactId = safeDocumentId(
    input.primaryContactId,
    'primaryContactId',
  );
  const duplicateContactId = safeDocumentId(
    input.duplicateContactId,
    'duplicateContactId',
  );
  if (primaryContactId === duplicateContactId) {
    throw mergeError(
      'contact_merge_same_contact',
      'Choose two different contacts.',
    );
  }
  if (!Array.isArray(input.choices) || input.choices.length > PROFILE_FIELDS.length) {
    throw mergeError(
      'contact_merge_choice_invalid',
      'Merge choices must be a bounded list.',
    );
  }
  const choices = input.choices.map(normalizeChoice);
  if (new Set(choices.map((choice) => choice.field)).size !== choices.length) {
    throw mergeError(
      'contact_merge_choice_invalid',
      'Each merge field may be chosen only once.',
    );
  }
  const expectedPrimary = normalizeExpectedContact(
    input.expectedPrimary,
    'expectedPrimary',
  );
  const expectedDuplicate = normalizeExpectedContact(
    input.expectedDuplicate,
    'expectedDuplicate',
  );
  return Object.freeze({
    operationId,
    primaryContactId,
    duplicateContactId,
    choices: Object.freeze(choices),
    confirmed: true,
    expectedPrimary,
    expectedDuplicate,
  });
}

function resolveProfile(primary, duplicate, choices) {
  const choiceByField = new Map(
    choices.map((choice) => [choice.field, choice]),
  );
  const rawProfile = {};
  const decisions = [];
  for (const field of PROFILE_FIELDS) {
    const primaryValue = primary[field];
    const duplicateValue = duplicate[field];
    const same =
      comparableProfileValue(field, primaryValue) ===
      comparableProfileValue(field, duplicateValue);
    let strategy;
    let finalValue;
    if (same) {
      strategy = 'same';
      finalValue = primaryValue;
    } else if (isEmptyProfileValue(primaryValue)) {
      strategy = 'only-value';
      finalValue = duplicateValue;
    } else if (isEmptyProfileValue(duplicateValue)) {
      strategy = 'only-value';
      finalValue = primaryValue;
    } else {
      const choice = choiceByField.get(field);
      if (!choice) {
        throw mergeError(
          'contact_merge_choice_required',
          `Choose a value for ${field}.`,
        );
      }
      strategy = choice.strategy;
      if (choice.strategy === 'primary') finalValue = primaryValue;
      else if (choice.strategy === 'duplicate') finalValue = duplicateValue;
      else if (choice.strategy === 'combine') {
        if (field !== 'tags') {
          throw mergeError(
            'contact_merge_choice_invalid',
            `The ${field} field cannot be combined.`,
          );
        }
        finalValue = normalizeTags([...primaryValue, ...duplicateValue]);
      } else {
        finalValue =
          field === 'tags'
            ? normalizeTags(choice.customValue)
            : cleanText(choice.customValue);
      }
    }
    rawProfile[field] = finalValue;
    decisions.push({
      field,
      primaryValue,
      duplicateValue,
      finalValue,
      strategy,
    });
  }
  return Object.freeze({
    profile: Object.freeze(sanitizeProfile(rawProfile)),
    decisions: Object.freeze(decisions),
  });
}

function normalizeFactValue(value) {
  const scalar = Array.isArray(value) ? value.join(', ') : value;
  return String(scalar ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function requestFingerprint(uid, request) {
  const choices = [...request.choices].sort(
    (left, right) =>
      PROFILE_FIELDS.indexOf(left.field) - PROFILE_FIELDS.indexOf(right.field),
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        uid,
        operationId: request.operationId,
        primaryContactId: request.primaryContactId,
        duplicateContactId: request.duplicateContactId,
        choices,
        confirmed: true,
        expectedPrimary: request.expectedPrimary,
        expectedDuplicate: request.expectedDuplicate,
      }),
    )
    .digest('hex');
}

function operationEventId(kind, uid, operationId) {
  return createHash('sha256')
    .update(`${kind}\u0000${uid}\u0000${operationId}`)
    .digest('hex')
    .slice(0, 40);
}

function emptyReferenceCounts() {
  return Object.fromEntries(REFERENCE_KINDS.map((kind) => [kind, 0]));
}

function safeReferenceCounts(value) {
  const counts = emptyReferenceCounts();
  for (const kind of REFERENCE_KINDS) {
    const count = Number(value?.[kind]);
    counts[kind] =
      Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }
  return counts;
}

function resultFromOperation(operationId, data) {
  return Object.freeze({
    operationId,
    primaryContactId: String(data.primaryContactId || ''),
    duplicateContactId: String(data.duplicateContactId || ''),
    migratedReferences: Object.freeze(
      safeReferenceCounts(
        data.migratedReferences || data.referenceCounts,
      ),
    ),
    warnings: Object.freeze([]),
  });
}

function collisionSafeId(id, fromContactId, reservedIds) {
  if (!reservedIds.has(id)) {
    reservedIds.add(id);
    return id;
  }
  const suffix = normalizeIdentityText(fromContactId)
    .replace(/\s/g, '')
    .slice(0, 10);
  let candidate = `${id}--merged-${suffix || 'contact'}`;
  let sequence = 2;
  while (reservedIds.has(candidate)) {
    candidate = `${id}--merged-${suffix || 'contact'}-${sequence}`;
    sequence += 1;
  }
  reservedIds.add(candidate);
  return candidate;
}

function nestedCopyPlans({
  operationId,
  duplicateContactId,
  kind,
  sourceSnapshot,
  targetSnapshot,
}) {
  const reservedIds = new Set(
    targetSnapshot.docs.map((document) => document.id),
  );
  const targetIds = new Map();
  for (const source of sourceSnapshot.docs) {
    targetIds.set(
      source.id,
      collisionSafeId(source.id, duplicateContactId, reservedIds),
    );
  }
  return sourceSnapshot.docs.map((source) => {
    const data = source.data() || {};
    const remap = (value) =>
      typeof value === 'string' ? targetIds.get(value) || value : null;
    const sourceId =
      kind === 'fact' &&
      data.sourceType === 'user-correction' &&
      typeof data.sourceId === 'string'
        ? targetIds.get(data.sourceId) || data.sourceId
        : data.sourceId ?? null;
    return Object.freeze({
      kind,
      sourcePath: source.ref.path,
      targetId: targetIds.get(source.id),
      data: {
        ...data,
        correctionOf: remap(data.correctionOf),
        supersededBy: remap(data.supersededBy),
        sourceId,
        contactMergeOperationId: operationId,
        migratedFromContactId: duplicateContactId,
        migratedFromContactName:
          typeof data.contactName === 'string' ? data.contactName : null,
        migratedFromHadContactName: Object.hasOwn(data, 'contactName'),
        migratedFromPath: source.ref.path,
        originalHistoryLinks: {
          correctionOf: data.correctionOf ?? null,
          supersededBy: data.supersededBy ?? null,
          sourceId: data.sourceId ?? null,
        },
        originalCurrent:
          kind === 'fact' ? data.current !== false : data.current === true,
        current: false,
        ...(kind === 'fact' ? { aiAllowed: false } : {}),
        mergeHistorical: true,
        migrationRecordedAt: FieldValue.serverTimestamp(),
      },
    });
  });
}

function connectionCopyPlans({
  operationId,
  duplicateContactId,
  primaryContactId,
  documents,
}) {
  const unique = new Map();
  for (const document of documents) unique.set(document.ref.path, document);
  return [...unique.values()].map((source) => {
    const data = source.data() || {};
    const originalSourceId = String(data.sourceId || '');
    const originalTargetId = String(data.targetId || '');
    if (
      !originalSourceId ||
      !originalTargetId ||
      (originalSourceId !== duplicateContactId &&
        originalTargetId !== duplicateContactId) ||
      data.contactMergeOperationId
    ) {
      throw mergeError(
        'contact_merge_connection_conflict',
        'A relationship edge changed while the merge was open.',
        409,
      );
    }
    const sourceId =
      originalSourceId === duplicateContactId
        ? primaryContactId
        : originalSourceId;
    const targetId =
      originalTargetId === duplicateContactId
        ? primaryContactId
        : originalTargetId;
    const collapsed = sourceId === targetId;
    const targetIdPart = createHash('sha256')
      .update(`${operationId}\u0000${source.ref.path}`)
      .digest('hex')
      .slice(0, 32);
    const targetDocumentId = collapsed
      ? null
      : `merge-connection-${targetIdPart}`;
    const targetPath = targetDocumentId
      ? `${source.ref.parent.path}/${targetDocumentId}`
      : null;
    return Object.freeze({
      source,
      targetDocumentId,
      sourcePatch: {
        contactMergeOperationId: operationId,
        migratedFromContactId: duplicateContactId,
        migratedToPath: targetPath,
        mergeHistorical: true,
        mergeSuppressed: collapsed,
        mergeRecoverySourceOperationId: operationId,
        migrationRecordedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      targetData: targetDocumentId
        ? {
            ...data,
            sourceId,
            targetId,
            contactMergeOperationId: operationId,
            migratedFromContactId: duplicateContactId,
            migratedFromPath: source.ref.path,
            originalConnectionEndpoints: {
              sourceId: originalSourceId,
              targetId: originalTargetId,
            },
            mergeHistorical: false,
            migrationRecordedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          }
        : null,
    });
  });
}

function profileFactPlans({
  operationId,
  primaryBefore,
  resolvedProfile,
  targetFactSnapshot,
  primaryAIAllowed,
  now,
}) {
  const currentByPredicate = new Map();
  for (const document of targetFactSnapshot.docs) {
    const data = document.data() || {};
    if (data.current !== true) continue;
    const list = currentByPredicate.get(data.predicate) || [];
    list.push(document);
    currentByPredicate.set(data.predicate, list);
  }
  const reservedIds = new Set(
    targetFactSnapshot.docs.map((document) => document.id),
  );
  const plans = [];
  for (const [field, predicate] of Object.entries(PROFILE_FACT_FIELDS)) {
    const before = normalizeFactValue(primaryBefore[field]);
    const afterValue = (
      Array.isArray(resolvedProfile[field])
        ? resolvedProfile[field].join(', ')
        : String(resolvedProfile[field] ?? '')
    ).trim();
    const after = normalizeFactValue(afterValue);
    if (after === before) continue;
    const current = [...(currentByPredicate.get(predicate) || [])].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    if (!after && current.length === 0) continue;
    const baseId = `merge-fact-${createHash('sha256')
      .update(`${operationId}\u0000${predicate}`)
      .digest('hex')
      .slice(0, 24)}`;
    const id = collisionSafeId(baseId, operationId, reservedIds);
    const value = afterValue || '[removed]';
    const predecessor = current[0] || null;
    const predecessorsAllowAI = current.every(
      (document) => document.data()?.aiAllowed !== false,
    );
    plans.push(
      Object.freeze({
        id,
        predicate,
        value,
        current,
        data: {
          predicate,
          value,
          normalizedValue: normalizeFactValue(value),
          sourceType: predecessor ? 'user-correction' : 'profile',
          sourceId: predecessor?.id || `merge:${operationId}`,
          observedAt: now,
          confidence: 1,
          current: true,
          aiAllowed:
            Boolean(after) &&
            primaryAIAllowed &&
            predecessorsAllowAI,
          correctionOf: predecessor?.id || null,
          supersededBy: null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
      }),
    );
  }
  return plans;
}

function assertAccountUnlocked(snapshot, authTime) {
  const data = snapshot.exists ? snapshot.data() || {} : null;
  const authenticatedAt = Number(authTime);
  const revokedAfter = Number(data?.revokedAfterSeconds) || 0;
  if (
    !data ||
    data.status !== 'active' ||
    !Number.isFinite(authenticatedAt) ||
    authenticatedAt <= revokedAfter
  ) {
    throw mergeError(
      'contact_merge_account_locked',
      'This account is not available for contact changes.',
      410,
    );
  }
}

function contactExpectation(data = {}) {
  return {
    profile: profileFromRecord(data),
    lifecycleStatus: ['archived', 'deleted'].includes(data.lifecycleStatus)
      ? data.lifecycleStatus
      : 'active',
    aiAllowed: data.aiAllowed !== false,
    mergedIntoContactId:
      typeof data.mergedIntoContactId === 'string'
        ? data.mergedIntoContactId
        : null,
    contactMergeOperationId:
      typeof data.contactMergeOperationId === 'string'
        ? data.contactMergeOperationId
        : null,
  };
}

function assertMergeableContacts(
  primarySnapshot,
  duplicateSnapshot,
  request,
) {
  if (!primarySnapshot.exists || !duplicateSnapshot.exists) {
    throw mergeError(
      'contact_merge_contact_not_found',
      'One of the contacts no longer exists.',
      404,
    );
  }
  const primary = primarySnapshot.data() || {};
  const duplicate = duplicateSnapshot.data() || {};
  const primaryStatus = primary.lifecycleStatus || 'active';
  const duplicateStatus = duplicate.lifecycleStatus || 'active';
  if (
    primaryStatus === 'deleted' ||
    duplicateStatus === 'deleted' ||
    primary.mergedIntoContactId ||
    duplicate.mergedIntoContactId ||
    primary.contactMergeOperationId ||
    duplicate.contactMergeOperationId
  ) {
    throw mergeError(
      'contact_merge_state_changed',
      'A contact changed while the merge was open. Review the merge again.',
      409,
    );
  }
  if (
    JSON.stringify(contactExpectation(primary)) !==
      JSON.stringify(request.expectedPrimary) ||
    JSON.stringify(contactExpectation(duplicate)) !==
      JSON.stringify(request.expectedDuplicate)
  ) {
    throw mergeError(
      'contact_merge_state_changed',
      'A contact changed while the merge was open. Review the merge again.',
      409,
    );
  }
}

function boundedMutationCount(count) {
  if (count > MAX_TRANSACTION_WRITES) {
    throw mergeError(
      'contact_merge_too_large',
      'This merge has too much linked history for one safe operation.',
      409,
    );
  }
}

/**
 * Executes the entire contact merge through the Admin SDK. Every data read and
 * write participates in one Firestore transaction, including the account
 * security marker. A transaction retry therefore sees a concurrent account
 * lock or contact edit before any merge mutation can commit.
 */
export async function executeAdminContactMerge({
  db,
  uid,
  authTime,
  input,
  now = new Date(),
  beforeCommit,
}) {
  if (!db || typeof db.runTransaction !== 'function') {
    throw mergeError(
      'contact_merge_unavailable',
      'Contact merge is temporarily unavailable.',
      503,
    );
  }
  const owner = safeDocumentId(uid, 'uid');
  const request = normalizeContactMergeRequest(input);
  const mergedAt =
    now instanceof Date ? new Date(now.getTime()) : new Date(Number(now));
  if (Number.isNaN(mergedAt.getTime())) {
    throw mergeError(
      'contact_merge_invalid',
      'The merge clock is invalid.',
    );
  }
  const purgeEligibleAt = new Date(mergedAt.getTime());
  purgeEligibleAt.setUTCDate(
    purgeEligibleAt.getUTCDate() + RECOVERY_WINDOW_DAYS,
  );
  const fingerprint = requestFingerprint(owner, request);

  const securityRef = db.doc(`_accountSecurity/${owner}`);
  const operationRef = db.doc(
    `users/${owner}/contactMergeOperations/${request.operationId}`,
  );
  const primaryRef = db.doc(
    `users/${owner}/contacts/${request.primaryContactId}`,
  );
  const duplicateRef = db.doc(
    `users/${owner}/contacts/${request.duplicateContactId}`,
  );
  const primaryFacts = db.collection(
    `users/${owner}/contacts/${request.primaryContactId}/facts`,
  );
  const duplicateFacts = db.collection(
    `users/${owner}/contacts/${request.duplicateContactId}/facts`,
  );
  const primaryJobs = db.collection(
    `users/${owner}/contacts/${request.primaryContactId}/jobHistory`,
  );
  const duplicateJobs = db.collection(
    `users/${owner}/contacts/${request.duplicateContactId}/jobHistory`,
  );
  const primaryEventRef = db.doc(
    `users/${owner}/contactEvents/${operationEventId(
      'merge-primary',
      owner,
      request.operationId,
    )}`,
  );
  const duplicateEventRef = db.doc(
    `users/${owner}/contactEvents/${operationEventId(
      'merge-duplicate',
      owner,
      request.operationId,
    )}`,
  );

  return db.runTransaction(async (transaction) => {
    const [
      securitySnapshot,
      operationSnapshot,
      primarySnapshot,
      duplicateSnapshot,
    ] = await Promise.all([
      transaction.get(securityRef),
      transaction.get(operationRef),
      transaction.get(primaryRef),
      transaction.get(duplicateRef),
    ]);
    assertAccountUnlocked(securitySnapshot, authTime);

    if (operationSnapshot.exists) {
      const operation = operationSnapshot.data() || {};
      if (
        operation.status === 'completed' &&
        operation.actorUid === owner &&
        operation.primaryContactId === request.primaryContactId &&
        operation.duplicateContactId === request.duplicateContactId &&
        operation.requestFingerprint === fingerprint
      ) {
        return resultFromOperation(request.operationId, operation);
      }
      throw mergeError(
        'contact_merge_operation_reused',
        'That merge operation ID has already been used.',
        409,
      );
    }
    assertMergeableContacts(
      primarySnapshot,
      duplicateSnapshot,
      request,
    );

    const referenceSnapshots = await Promise.all([
      ...ROOT_REFERENCES.map((reference) =>
        transaction.get(
          db
            .collection(`users/${owner}/${reference.collectionName}`)
            .where('contactId', '==', request.duplicateContactId),
        ),
      ),
      transaction.get(
        db
          .collection(`users/${owner}/connections`)
          .where('sourceId', '==', request.duplicateContactId),
      ),
      transaction.get(
        db
          .collection(`users/${owner}/connections`)
          .where('targetId', '==', request.duplicateContactId),
      ),
      transaction.get(duplicateFacts),
      transaction.get(primaryFacts),
      transaction.get(duplicateJobs),
      transaction.get(primaryJobs),
    ]);
    const rootSnapshots = referenceSnapshots.slice(
      0,
      ROOT_REFERENCES.length,
    );
    const [
      sourceConnectionSnapshot,
      targetConnectionSnapshot,
    ] = referenceSnapshots.slice(
      ROOT_REFERENCES.length,
      ROOT_REFERENCES.length + 2,
    );
    const [
      duplicateFactSnapshot,
      primaryFactSnapshot,
      duplicateJobSnapshot,
      primaryJobSnapshot,
    ] = referenceSnapshots.slice(ROOT_REFERENCES.length + 2);

    const primaryData = primarySnapshot.data() || {};
    const duplicateData = duplicateSnapshot.data() || {};
    const primaryBefore = profileFromRecord(primaryData);
    const duplicateBefore = profileFromRecord(duplicateData);
    const resolved = resolveProfile(
      primaryBefore,
      duplicateBefore,
      request.choices,
    );
    const migratedReferences = emptyReferenceCounts();
    rootSnapshots.forEach((snapshot, index) => {
      migratedReferences[ROOT_REFERENCES[index].kind] = snapshot.size;
    });
    const connectionCopies = connectionCopyPlans({
      operationId: request.operationId,
      duplicateContactId: request.duplicateContactId,
      primaryContactId: request.primaryContactId,
      documents: [
        ...sourceConnectionSnapshot.docs,
        ...targetConnectionSnapshot.docs,
      ],
    });
    migratedReferences.connection = connectionCopies.length;
    migratedReferences.fact = duplicateFactSnapshot.size;
    migratedReferences['job-history'] = duplicateJobSnapshot.size;

    const factCopies = nestedCopyPlans({
      operationId: request.operationId,
      duplicateContactId: request.duplicateContactId,
      kind: 'fact',
      sourceSnapshot: duplicateFactSnapshot,
      targetSnapshot: primaryFactSnapshot,
    });
    const jobCopies = nestedCopyPlans({
      operationId: request.operationId,
      duplicateContactId: request.duplicateContactId,
      kind: 'job-history',
      sourceSnapshot: duplicateJobSnapshot,
      targetSnapshot: primaryJobSnapshot,
    });
    const factChanges = profileFactPlans({
      operationId: request.operationId,
      primaryBefore,
      resolvedProfile: resolved.profile,
      targetFactSnapshot: primaryFactSnapshot,
      primaryAIAllowed: primaryData.aiAllowed !== false,
      now: mergedAt,
    });
    const rootWrites = rootSnapshots.reduce(
      (count, snapshot) => count + snapshot.size,
      0,
    );
    const connectionWrites = connectionCopies.reduce(
      (count, plan) => count + 1 + (plan.targetDocumentId ? 1 : 0),
      0,
    );
    const factHistoryWrites = factChanges.reduce(
      (count, plan) => count + plan.current.length + 1,
      0,
    );
    const mutationCount =
      5 +
      rootWrites +
      connectionWrites +
      factCopies.length +
      jobCopies.length +
      factHistoryWrites;
    boundedMutationCount(mutationCount);

    rootSnapshots.forEach((snapshot) => {
      for (const document of snapshot.docs) {
        const data = document.data() || {};
        transaction.update(document.ref, {
          contactId: request.primaryContactId,
          contactName: resolved.profile.name,
          contactMergeOperationId: request.operationId,
          migratedFromContactId: request.duplicateContactId,
          migratedFromContactName:
            typeof data.contactName === 'string' ? data.contactName : null,
          migratedFromHadContactName: Object.hasOwn(data, 'contactName'),
          migratedAt: mergedAt,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });
    for (const plan of connectionCopies) {
      transaction.update(plan.source.ref, plan.sourcePatch);
      if (plan.targetDocumentId && plan.targetData) {
        transaction.create(
          db
            .collection(`users/${owner}/connections`)
            .doc(plan.targetDocumentId),
          plan.targetData,
        );
      }
    }
    for (const copy of factCopies) {
      transaction.create(primaryFacts.doc(copy.targetId), copy.data);
    }
    for (const copy of jobCopies) {
      transaction.create(primaryJobs.doc(copy.targetId), copy.data);
    }
    for (const plan of factChanges) {
      for (const current of plan.current) {
        transaction.update(current.ref, {
          current: false,
          supersededBy: plan.id,
          supersededAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      transaction.create(primaryFacts.doc(plan.id), plan.data);
    }

    const rememberedDuplicateAI =
      typeof duplicateData.aiAllowedBeforeLifecycle === 'boolean'
        ? duplicateData.aiAllowedBeforeLifecycle
        : duplicateData.aiAllowed !== false;
    transaction.update(primaryRef, {
      ...resolved.profile,
      normalizedEmail: resolved.profile.email,
      mergedFromContactIds: FieldValue.arrayUnion(
        request.duplicateContactId,
      ),
      updatedAt: FieldValue.serverTimestamp(),
      profileRevision: FieldValue.increment(1),
      factSyncPending: null,
      factSyncAt: FieldValue.serverTimestamp(),
    });
    transaction.update(duplicateRef, {
      lifecycleStatus: 'deleted',
      deletedAt: mergedAt,
      purgeEligibleAt,
      aiAllowed: false,
      aiAllowedBeforeLifecycle: rememberedDuplicateAI,
      mergedIntoContactId: request.primaryContactId,
      contactMergeOperationId: request.operationId,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const operationRecord = {
      operationId: request.operationId,
      primaryContactId: request.primaryContactId,
      duplicateContactId: request.duplicateContactId,
      actorUid: owner,
      status: 'completed',
      requestFingerprint: fingerprint,
      choices: resolved.decisions,
      referenceCounts: migratedReferences,
      migratedReferences,
      migratedReferenceCount: Object.values(migratedReferences).reduce(
        (count, value) => count + value,
        0,
      ),
      primaryBefore,
      duplicateBefore,
      resolvedProfile: resolved.profile,
      startedAt: FieldValue.serverTimestamp(),
      completedAt: FieldValue.serverTimestamp(),
      immutable: true,
      recoveryProtocolVersion: MERGE_PROTOCOL_VERSION,
    };
    transaction.create(operationRef, operationRecord);
    transaction.create(primaryEventRef, {
      contactId: request.primaryContactId,
      type: 'merge-completed',
      actorUid: owner,
      sourceType: 'contact-management-worker',
      sourceId: request.operationId,
      payload: {
        operationId: request.operationId,
        primaryContactId: request.primaryContactId,
        duplicateContactId: request.duplicateContactId,
        referenceCounts: migratedReferences,
        recoveryProtocolVersion: MERGE_PROTOCOL_VERSION,
      },
      occurredAt: FieldValue.serverTimestamp(),
      immutable: true,
    });
    transaction.create(duplicateEventRef, {
      contactId: request.duplicateContactId,
      type: 'soft-deleted',
      actorUid: owner,
      sourceType: 'contact-management-worker',
      sourceId: request.operationId,
      payload: {
        reason: 'merged',
        mergedIntoContactId: request.primaryContactId,
        purgeEligibleAt: purgeEligibleAt.toISOString(),
        recoveryProtocolVersion: MERGE_PROTOCOL_VERSION,
      },
      occurredAt: FieldValue.serverTimestamp(),
      immutable: true,
    });

    if (beforeCommit) {
      await beforeCommit({
        uid: owner,
        operationId: request.operationId,
        mutationCount,
      });
    }
    return Object.freeze({
      operationId: request.operationId,
      primaryContactId: request.primaryContactId,
      duplicateContactId: request.duplicateContactId,
      migratedReferences: Object.freeze({ ...migratedReferences }),
      warnings: Object.freeze([]),
    });
  });
}

export const CONTACT_MERGE_SCHEMA = Object.freeze({
  protocolVersion: MERGE_PROTOCOL_VERSION,
  maxTransactionWrites: MAX_TRANSACTION_WRITES,
  profileFields: [...PROFILE_FIELDS],
  rootReferenceCollections: ROOT_REFERENCES.map(
    (reference) => reference.collectionName,
  ),
  endpointReferenceCollections: ['connections'],
  nestedReferenceCollections: ['facts', 'jobHistory'],
});
