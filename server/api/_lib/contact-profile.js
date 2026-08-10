import { createHash } from 'node:crypto';

import { FieldValue } from 'firebase-admin/firestore';

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

// Exported for contact-ingest.js, which creates contacts (this module only
// updates them) and must stamp the same identity facts on the new record.
export const PROFILE_FACT_FIELDS = Object.freeze({
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

export class ContactProfileError extends Error {
  constructor({
    code = 'contact_profile_invalid',
    message = 'The contact profile request is invalid.',
    status = 400,
  } = {}) {
    super(message);
    this.name = 'ContactProfileError';
    this.code = code;
    this.status = status;
  }
}

function profileError(code, message, status = 400) {
  return new ContactProfileError({ code, message, status });
}

function safeDocumentId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (
    !id ||
    id.length > 300 ||
    id.includes('/') ||
    id === '.' ||
    id === '..'
  ) {
    throw profileError(
      'contact_profile_invalid',
      'The contact identifier is invalid.',
    );
  }
  return id;
}

function cleanText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\u0000/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function cleanMultilineText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .join('\n')
    .trim();
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

function safeHttpsUrl(value) {
  const candidate = cleanText(value);
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password
    ) {
      return '';
    }
    return candidate;
  } catch {
    return '';
  }
}

function profileFromRecord(value = {}) {
  const relationshipTier = ['Cold', 'Warm', 'Strong'].includes(
    value.relationshipTier,
  )
    ? value.relationshipTier
    : 'Cold';
  return {
    ...PROFILE_DEFAULTS,
    name: cleanText(value.name),
    email: cleanText(value.email).toLocaleLowerCase(),
    phone: cleanText(value.phone),
    company: cleanText(value.company),
    role: cleanText(value.role),
    location: cleanText(value.location),
    linkedinUrl: cleanText(value.linkedinUrl),
    summary: cleanMultilineText(value.summary),
    relationshipTier,
    industry: cleanText(value.industry),
    subIndustry: cleanText(value.subIndustry),
    school: cleanText(value.school),
    seniority: cleanText(value.seniority),
    connectionSource: cleanText(value.connectionSource),
    whyTheyMatter: cleanMultilineText(value.whyTheyMatter),
    tags: normalizeTags(value.tags),
  };
}

/**
 * Normalises and validates a profile, or throws ContactProfileError.
 *
 * Exported so contact-ingest.js can hold agent-supplied contacts to exactly the
 * same field limits and formats as a profile edit from the app. A second
 * normaliser would be a second thing to keep in sync.
 */
export function validateProfile(value) {
  const profile = profileFromRecord(value);
  if (!profile.name) {
    throw profileError(
      'contact_profile_invalid',
      'A contact name is required.',
    );
  }
  for (const [field, maxLength] of Object.entries(FIELD_LIMITS)) {
    if (profile[field].length > maxLength) {
      throw profileError(
        'contact_profile_invalid',
        `${field} is too long.`,
      );
    }
  }
  if (
    profile.email &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)
  ) {
    throw profileError(
      'contact_profile_invalid',
      'Enter a complete email address.',
    );
  }
  if (
    profile.linkedinUrl &&
    safeHttpsUrl(profile.linkedinUrl) !== profile.linkedinUrl
  ) {
    throw profileError(
      'contact_profile_invalid',
      'LinkedIn URL must be a complete secure URL without credentials.',
    );
  }
  return Object.freeze(profile);
}

function hasOnlyKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function normalizeContactProfileRequest(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !hasOnlyKeys(value, [
      'contactId',
      'expectedProfileRevision',
      'profile',
    ])
  ) {
    throw profileError(
      'contact_profile_invalid',
      'Only contact profile fields may be supplied.',
    );
  }
  if (
    !Number.isSafeInteger(value.expectedProfileRevision) ||
    value.expectedProfileRevision < 0
  ) {
    throw profileError(
      'contact_profile_invalid',
      'The expected profile revision is invalid.',
    );
  }
  if (!hasOnlyKeys(value.profile, PROFILE_FIELDS)) {
    throw profileError(
      'contact_profile_invalid',
      'A complete contact profile is required.',
    );
  }
  return Object.freeze({
    contactId: safeDocumentId(value.contactId),
    expectedProfileRevision: value.expectedProfileRevision,
    profile: validateProfile(value.profile),
  });
}

function normalizeFactValue(value) {
  const scalar = Array.isArray(value) ? value.join(', ') : value;
  return String(scalar ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function factValue(value) {
  return (
    Array.isArray(value)
      ? value.join(', ')
      : String(value ?? '')
  ).trim();
}

function profileRevision(data) {
  return Number.isSafeInteger(data?.profileRevision) &&
    data.profileRevision >= 0
    ? data.profileRevision
    : 0;
}

function responseContact(contactId, profile, revision, data) {
  return {
    id: contactId,
    ...profile,
    profileRevision: revision,
    lifecycleStatus:
      data.lifecycleStatus === 'archived'
        ? 'archived'
        : 'active',
    aiAllowed: data.aiAllowed !== false,
    aiAllowedBeforeLifecycle:
      typeof data.aiAllowedBeforeLifecycle === 'boolean'
        ? data.aiAllowedBeforeLifecycle
        : null,
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

function assertAccountUnlocked(snapshot, authTime) {
  const data = snapshot.exists ? snapshot.data() || {} : null;
  if (
    !data ||
    data.status !== 'active' ||
    !Number.isFinite(Number(authTime)) ||
    Number(authTime) <= (Number(data.revokedAfterSeconds) || 0)
  ) {
    throw profileError(
      'contact_profile_account_locked',
      'This account is not available for contact changes.',
      410,
    );
  }
}

function changedProfileFields(previous, next) {
  return PROFILE_FIELDS.filter(
    (field) =>
      JSON.stringify(previous[field]) !== JSON.stringify(next[field]),
  );
}

/**
 * Exported so contact-ingest.js stamps creation facts (revision 0) with ids
 * from this same formula. Two implementations would drift, and a later edit
 * would then write a duplicate fact instead of superseding the original.
 */
export function deterministicFactId({
  uid,
  contactId,
  revision,
  predicate,
}) {
  const digest = createHash('sha256')
    .update(`${uid}\u001f${contactId}\u001f${revision}\u001f${predicate}`)
    .digest('hex')
    .slice(0, 32);
  return `profile-fact-${digest}`;
}

function jobKey(profile) {
  return `${cleanText(profile.company).toLocaleLowerCase()}|${cleanText(
    profile.role,
  ).toLocaleLowerCase()}`;
}

function hasJob(profile) {
  return Boolean(cleanText(profile.company) || cleanText(profile.role));
}

function jobHistoryPlan({
  contactId,
  previous,
  next,
  currentEntries,
  now,
}) {
  if (jobKey(previous) === jobKey(next)) {
    return { changed: false, close: [], additions: [] };
  }
  const additions = [];
  if (currentEntries.length === 0 && hasJob(previous)) {
    additions.push({
      role: previous.role,
      company: previous.company,
      location: previous.location,
      startedAt: null,
      endedAt: now,
      current: false,
      sourceType: 'profile-backfill',
      sourceId: contactId,
      correctionOf: null,
      supersededBy: null,
      recordedAt: now,
    });
  }
  if (hasJob(next)) {
    additions.push({
      role: next.role,
      company: next.company,
      location: next.location,
      startedAt: now,
      endedAt: null,
      current: true,
      sourceType: 'user-correction',
      sourceId: contactId,
      correctionOf: currentEntries[0]?.id || null,
      supersededBy: null,
      recordedAt: now,
    });
  }
  return {
    changed: true,
    close: currentEntries,
    additions,
  };
}

export async function executeAdminContactProfileSave({
  db,
  uid,
  authTime,
  input,
  now = new Date(),
}) {
  const request = normalizeContactProfileRequest(input);
  const owner = safeDocumentId(uid);
  const contactRef = db.doc(
    `users/${owner}/contacts/${request.contactId}`,
  );
  const securityRef = db.doc(`_accountSecurity/${owner}`);
  const factsRef = contactRef.collection('facts');
  const jobsRef = contactRef.collection('jobHistory');
  const eventsRef = db.collection(`users/${owner}/contactEvents`);

  return db.runTransaction(async (transaction) => {
    const [securitySnapshot, contactSnapshot] = await Promise.all([
      transaction.get(securityRef),
      transaction.get(contactRef),
    ]);
    assertAccountUnlocked(securitySnapshot, authTime);
    if (!contactSnapshot.exists) {
      throw profileError(
        'contact_profile_not_found',
        'Contact not found.',
        404,
      );
    }
    const contactData = contactSnapshot.data() || {};
    if (contactData.lifecycleStatus === 'deleted') {
      throw profileError(
        'contact_profile_deleted',
        'Restore this contact before editing it.',
        409,
      );
    }
    if (contactData.mergedIntoContactId) {
      throw profileError(
        'contact_profile_merged',
        'This contact was merged into another record and cannot be edited.',
        409,
      );
    }
    if (contactData.factSyncPending) {
      throw profileError(
        'contact_profile_fact_recovery_required',
        'This contact needs fact-history recovery before it can be edited.',
        409,
      );
    }
    const revision = profileRevision(contactData);
    if (revision !== request.expectedProfileRevision) {
      throw profileError(
        'contact_profile_conflict',
        'This contact changed in another tab. Refresh it and review the newer profile.',
        409,
      );
    }

    const previous = profileFromRecord(contactData);
    const changedFields = changedProfileFields(previous, request.profile);
    if (changedFields.length === 0) {
      return {
        contactId: request.contactId,
        contact: responseContact(
          request.contactId,
          previous,
          revision,
          contactData,
        ),
        profile: previous,
        profileRevision: revision,
        changedFields: [],
        profileFactIds: [],
        jobHistoryChanged: false,
      };
    }

    const changedPredicates = [
      ...new Set(
        changedFields.map((field) => PROFILE_FACT_FIELDS[field]),
      ),
    ];
    const factQueries = changedPredicates.map((predicate) =>
      factsRef
        .where('predicate', '==', predicate)
        .where('current', '==', true)
        .limit(11),
    );
    const currentJobsQuery = jobsRef.where('current', '==', true).limit(21);
    const [...snapshots] = await Promise.all([
      ...factQueries.map((query) => transaction.get(query)),
      transaction.get(currentJobsQuery),
    ]);
    const currentJobsSnapshot = snapshots.pop();
    if (
      snapshots.some((snapshot) => snapshot.size > 10) ||
      currentJobsSnapshot.size > 20
    ) {
      throw profileError(
        'contact_profile_history_conflict',
        'This contact has conflicting history that must be reviewed first.',
        409,
      );
    }

    const currentByPredicate = new Map();
    snapshots.forEach((snapshot, index) => {
      currentByPredicate.set(changedPredicates[index], snapshot.docs);
    });
    const nextRevision = revision + 1;
    const profileFactIds = [];
    let factWriteCount = 0;
    for (const field of changedFields) {
      const predicate = PROFILE_FACT_FIELDS[field];
      const before = normalizeFactValue(previous[field]);
      const afterValue = factValue(request.profile[field]);
      const after = normalizeFactValue(afterValue);
      if (before === after) continue;
      const current = [...(currentByPredicate.get(predicate) || [])].sort(
        (left, right) => left.id.localeCompare(right.id),
      );
      if (!after && current.length === 0) continue;
      const factId = deterministicFactId({
        uid: owner,
        contactId: request.contactId,
        revision: nextRevision,
        predicate,
      });
      const factRef = factsRef.doc(factId);
      const predecessor = current[0] || null;
      const predecessorsAllowAI = current.every(
        (document) => document.data()?.aiAllowed !== false,
      );
      for (const prior of current) {
        transaction.update(prior.ref, {
          current: false,
          supersededBy: factId,
          supersededAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        factWriteCount += 1;
      }
      const value = afterValue || '[removed]';
      transaction.create(factRef, {
        predicate,
        value,
        normalizedValue: normalizeFactValue(value).slice(0, 20_000),
        sourceType: predecessor ? 'user-correction' : 'profile',
        sourceId: predecessor?.id || `profile:${request.contactId}`,
        observedAt: now,
        confidence: 1,
        current: true,
        aiAllowed:
          Boolean(after) &&
          contactData.aiAllowed !== false &&
          predecessorsAllowAI,
        correctionOf: predecessor?.id || null,
        supersededBy: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      factWriteCount += 1;
      profileFactIds.push(factId);
    }

    const currentJobs = currentJobsSnapshot.docs;
    const jobs = jobHistoryPlan({
      contactId: request.contactId,
      previous,
      next: request.profile,
      currentEntries: currentJobs,
      now,
    });
    const additionRefs = jobs.additions.map(() => jobsRef.doc());
    const nextCurrentRef = additionRefs.find(
      (_, index) => jobs.additions[index]?.current,
    );
    for (const entry of jobs.close) {
      transaction.update(entry.ref, {
        current: false,
        endedAt: now,
        supersededBy: nextCurrentRef?.id || null,
        closedAt: FieldValue.serverTimestamp(),
      });
    }
    jobs.additions.forEach((entry, index) => {
      transaction.create(additionRefs[index], {
        ...entry,
        createdAt: FieldValue.serverTimestamp(),
        immutableProvenance: {
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          recordedByUid: owner,
        },
      });
    });

    const writeCount =
      2 +
      factWriteCount +
      jobs.close.length +
      jobs.additions.length;
    if (writeCount > 450) {
      throw profileError(
        'contact_profile_history_conflict',
        'This contact has too much conflicting history to update safely.',
        409,
      );
    }

    transaction.update(contactRef, {
      ...request.profile,
      normalizedEmail: request.profile.email,
      updatedAt: FieldValue.serverTimestamp(),
      profileRevision: nextRevision,
      factSyncAt: FieldValue.serverTimestamp(),
    });
    const eventRef = eventsRef.doc();
    transaction.create(eventRef, {
      contactId: request.contactId,
      type: 'profile-updated',
      actorUid: owner,
      sourceType: 'contact-management-server',
      sourceId: request.contactId,
      payload: {
        changedFields,
        profileFactIds,
        jobHistoryEntryIds: additionRefs.map((reference) => reference.id),
        previousRevision: revision,
        nextRevision,
      },
      occurredAt: FieldValue.serverTimestamp(),
      immutable: true,
    });

    return {
      contactId: request.contactId,
      contact: responseContact(
        request.contactId,
        request.profile,
        nextRevision,
        contactData,
      ),
      profile: request.profile,
      profileRevision: nextRevision,
      changedFields,
      profileFactIds,
      jobHistoryChanged: jobs.changed,
    };
  });
}
