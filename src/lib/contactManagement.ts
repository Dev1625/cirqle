import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type DocumentReference,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

import { db } from '../config/firebase';
import {
  buildPermanentPurgePlan,
  detectDuplicate,
  findDuplicateCandidates,
  isContactPurgeEligible,
  managedContactFromRecord,
  nextContactLifecycle,
  sanitizeContactProfile,
  type ContactLifecycleAction,
  type ContactMergeChoice,
  type ContactProfile,
  type ContactProfileField,
  type ContactReferenceKind,
  type ContactReferenceRecord,
  type DuplicateDetection,
  type JobHistoryEntry,
  type ManagedContact,
} from './contactManagementCore';
import { authenticatedFetch } from './authenticatedFetch';

function toDate(value: unknown): Date | null {
  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  if (!value) return null;
  const parsed = new Date(value as string | number | Date);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function managedContactFromSnapshot(
  snapshot: QueryDocumentSnapshot<DocumentData> | {
    id: string;
    data: () => DocumentData;
  },
): ManagedContact {
  return managedContactFromRecord(snapshot.id, snapshot.data());
}

function jobHistoryFromSnapshot(
  snapshot: QueryDocumentSnapshot<DocumentData>,
): JobHistoryEntry {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    role: String(data.role || ''),
    company: String(data.company || ''),
    location: String(data.location || ''),
    startedAt: toDate(data.startedAt),
    endedAt: toDate(data.endedAt),
    current: data.current === true,
    sourceType: data.sourceType || 'profile',
    sourceId: data.sourceId || null,
    correctionOf: data.correctionOf || null,
    supersededBy: data.supersededBy || null,
    recordedAt: toDate(data.recordedAt) || new Date(0),
  };
}

function profileRecord(profile: ContactProfile): Record<ContactProfileField, unknown> {
  return {
    name: profile.name,
    email: profile.email,
    phone: profile.phone,
    company: profile.company,
    role: profile.role,
    location: profile.location,
    linkedinUrl: profile.linkedinUrl,
    summary: profile.summary,
    relationshipTier: profile.relationshipTier,
    industry: profile.industry,
    subIndustry: profile.subIndustry,
    school: profile.school,
    seniority: profile.seniority,
    connectionSource: profile.connectionSource,
    whyTheyMatter: profile.whyTheyMatter,
    tags: profile.tags,
  };
}

function contactEventRef(uid: string): DocumentReference<DocumentData> {
  return doc(collection(db, `users/${uid}/contactEvents`));
}

function eventRecord(params: {
  uid: string;
  contactId: string;
  type: string;
  sourceId?: string | null;
  payload?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    contactId: params.contactId,
    type: params.type,
    actorUid: params.uid,
    sourceType: 'contact-management',
    sourceId: params.sourceId || null,
    payload: params.payload || {},
    occurredAt: serverTimestamp(),
    immutable: true,
  };
}

export async function loadManagedContact(
  uid: string,
  contactId: string,
): Promise<ManagedContact | null> {
  const snapshot = await getDoc(
    doc(db, `users/${uid}/contacts/${contactId}`),
  );
  return snapshot.exists()
    ? managedContactFromSnapshot({
        id: snapshot.id,
        data: () => snapshot.data(),
      })
    : null;
}

export async function listManagedContacts(
  uid: string,
  options: {
    includeArchived?: boolean;
    includeDeleted?: boolean;
  } = {},
): Promise<ManagedContact[]> {
  const snapshot = await getDocs(collection(db, `users/${uid}/contacts`));
  return snapshot.docs
    .map(managedContactFromSnapshot)
    .filter((contact) => {
      if (contact.lifecycleStatus === 'deleted') return options.includeDeleted;
      if (contact.lifecycleStatus === 'archived') return options.includeArchived;
      return true;
    });
}

export async function listContactJobHistory(
  uid: string,
  contactId: string,
): Promise<JobHistoryEntry[]> {
  const snapshot = await getDocs(
    collection(db, `users/${uid}/contacts/${contactId}/jobHistory`),
  );
  return snapshot.docs
    .map(jobHistoryFromSnapshot)
    .sort(
      (left, right) =>
        (right.startedAt?.getTime() || right.recordedAt.getTime()) -
        (left.startedAt?.getTime() || left.recordedAt.getTime()),
    );
}

export class ContactProfileConflictError extends Error {
  constructor() {
    super(
      'This contact changed in another tab. Refresh it, review the newer profile, and then save again.',
    );
    this.name = 'ContactProfileConflictError';
  }
}

export interface SaveContactProfileResult {
  contact: ManagedContact;
  jobHistoryChanged: boolean;
  changedFields: ContactProfileField[];
}

export async function saveContactProfile(params: {
  uid: string;
  contactId: string;
  profile: Partial<Record<ContactProfileField, unknown>>;
  expectedProfileRevision: number;
}): Promise<SaveContactProfileResult> {
  const profile = sanitizeContactProfile(params.profile);
  if (
    !Number.isSafeInteger(params.expectedProfileRevision) ||
    params.expectedProfileRevision < 0
  ) {
    throw new ContactProfileConflictError();
  }
  const response = await authenticatedFetch('/api/contacts/profile', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contactId: params.contactId,
      expectedProfileRevision: params.expectedProfileRevision,
      profile: profileRecord(profile),
    }),
  });
  const payload = (await response.json().catch(() => null)) as
    | {
        contact?: unknown;
        contactId?: unknown;
        changedFields?: unknown;
        jobHistoryChanged?: unknown;
        error?: { code?: unknown; message?: unknown };
      }
    | null;
  if (!response.ok) {
    if (payload?.error?.code === 'contact_profile_conflict') {
      throw new ContactProfileConflictError();
    }
    throw new Error(
      typeof payload?.error?.message === 'string'
        ? payload.error.message
        : 'The contact profile could not be saved. It is safe to retry.',
    );
  }
  if (
    !payload ||
    payload.contactId !== params.contactId ||
    !payload.contact ||
    typeof payload.contact !== 'object' ||
    !Array.isArray(payload.changedFields) ||
    typeof payload.jobHistoryChanged !== 'boolean'
  ) {
    throw new Error(
      'The profile was saved without a valid acknowledgement. Refresh this contact before editing again.',
    );
  }
  const contactRecord = payload.contact as Record<string, unknown>;
  const contact = managedContactFromRecord(params.contactId, contactRecord);
  const expectedResultRevision =
    params.expectedProfileRevision +
    (payload.changedFields.length > 0 ? 1 : 0);
  if (
    contact.profileRevision !== expectedResultRevision ||
    payload.changedFields.some(
      (field) =>
        typeof field !== 'string' ||
        !Object.hasOwn(profileRecord(profile), field),
    )
  ) {
    throw new Error(
      'The profile was saved without a valid revision acknowledgement. Refresh this contact before editing again.',
    );
  }
  return {
    contact,
    jobHistoryChanged: payload.jobHistoryChanged,
    changedFields: payload.changedFields as ContactProfileField[],
  };
}

export async function transitionContactLifecycle(params: {
  uid: string;
  contactId: string;
  action: ContactLifecycleAction;
}): Promise<ManagedContact> {
  const contact = await loadManagedContact(params.uid, params.contactId);
  if (!contact) throw new Error('Contact not found.');
  if (params.action === 'restore' && contact.mergedIntoContactId) {
    throw new Error(
      'This contact was merged. Undo the merge operation before restoring it.',
    );
  }
  const changedAt = new Date();
  const next = nextContactLifecycle(contact, params.action, changedAt);
  const contactRef = doc(
    db,
    `users/${params.uid}/contacts/${params.contactId}`,
  );
  const batch = writeBatch(db);
  batch.update(contactRef, {
    lifecycleStatus: next.lifecycleStatus,
    archivedAt: next.archivedAt || null,
    deletedAt: next.deletedAt || null,
    purgeEligibleAt: next.purgeEligibleAt || null,
    restoredAt: next.restoredAt || null,
    aiAllowed: next.aiAllowed !== false,
    aiAllowedBeforeLifecycle: next.aiAllowedBeforeLifecycle ?? null,
    updatedAt: serverTimestamp(),
  });
  const eventType =
    params.action === 'archive'
      ? 'archived'
      : params.action === 'delete'
        ? 'soft-deleted'
        : 'restored';
  batch.set(
    contactEventRef(params.uid),
    eventRecord({
      uid: params.uid,
      contactId: params.contactId,
      type: eventType,
      payload: {
        previousStatus: contact.lifecycleStatus || 'active',
        nextStatus: next.lifecycleStatus,
        purgeEligibleAt: next.purgeEligibleAt?.toISOString() || null,
      },
    }),
  );
  await batch.commit();
  return { ...contact, ...next };
}

export function archiveContact(uid: string, contactId: string) {
  return transitionContactLifecycle({ uid, contactId, action: 'archive' });
}

export function restoreContact(uid: string, contactId: string) {
  return transitionContactLifecycle({ uid, contactId, action: 'restore' });
}

export function softDeleteContact(uid: string, contactId: string) {
  return transitionContactLifecycle({ uid, contactId, action: 'delete' });
}

export async function softDeleteContacts(
  uid: string,
  contactIds: string[],
): Promise<{ operationId: string; deletedCount: number }> {
  const uniqueIds = [...new Set(contactIds.filter(Boolean))];
  if (uniqueIds.length === 0) return { operationId: '', deletedCount: 0 };
  if (uniqueIds.length > 5_000) {
    throw new Error('Delete contacts in groups of 5,000 or fewer.');
  }
  const operationRef = doc(
    collection(db, `users/${uid}/contactBulkOperations`),
  );
  const contacts = (
    await Promise.all(uniqueIds.map((contactId) => loadManagedContact(uid, contactId)))
  ).filter(
    (contact): contact is ManagedContact =>
      Boolean(contact) && contact?.lifecycleStatus !== 'deleted',
  );
  await setDoc(operationRef, {
    type: 'soft-delete',
    actorUid: uid,
    requestedCount: uniqueIds.length,
    eligibleCount: contacts.length,
    status: 'running',
    startedAt: serverTimestamp(),
    immutable: true,
  });

  const changedAt = new Date();
  let completed = 0;
  try {
    // Each contact consumes one profile write plus one immutable event write.
    // Two hundred contacts keeps every batch below Firestore's 500-write cap.
    for (let index = 0; index < contacts.length; index += 200) {
      const batch = writeBatch(db);
      for (const contact of contacts.slice(index, index + 200)) {
        const next = nextContactLifecycle(contact, 'delete', changedAt);
        batch.update(
          doc(db, `users/${uid}/contacts/${contact.id}`),
          {
            lifecycleStatus: 'deleted',
            deletedAt: next.deletedAt,
            purgeEligibleAt: next.purgeEligibleAt,
            aiAllowed: false,
            aiAllowedBeforeLifecycle:
              next.aiAllowedBeforeLifecycle ?? null,
            updatedAt: serverTimestamp(),
            bulkOperationId: operationRef.id,
          },
        );
        batch.set(
          contactEventRef(uid),
          eventRecord({
            uid,
            contactId: contact.id,
            type: 'soft-deleted',
            sourceId: operationRef.id,
            payload: {
              reason: 'bulk-soft-delete',
              purgeEligibleAt: next.purgeEligibleAt?.toISOString() || null,
            },
          }),
        );
      }
      await batch.commit();
      completed += Math.min(200, contacts.length - index);
      await updateDoc(operationRef, {
        completedCount: completed,
        updatedAt: serverTimestamp(),
      });
    }
    await updateDoc(operationRef, {
      status: 'completed',
      completedCount: completed,
      completedAt: serverTimestamp(),
    });
  } catch (error) {
    await updateDoc(operationRef, {
      status: 'partially-completed',
      completedCount: completed,
      failedAt: serverTimestamp(),
      recoveryReason: 'bulk-write-failed',
    }).catch(() => undefined);
    throw error;
  }
  return { operationId: operationRef.id, deletedCount: completed };
}

export async function setContactAIAllowed(params: {
  uid: string;
  contactId: string;
  aiAllowed: boolean;
}): Promise<void> {
  const contact = await loadManagedContact(params.uid, params.contactId);
  if (!contact) throw new Error('Contact not found.');
  if (contact.lifecycleStatus !== 'active') {
    throw new Error('Restore this contact before changing its AI setting.');
  }
  const batch = writeBatch(db);
  batch.update(
    doc(db, `users/${params.uid}/contacts/${params.contactId}`),
    {
      aiAllowed: params.aiAllowed,
      privacyUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  );
  batch.set(
    contactEventRef(params.uid),
    eventRecord({
      uid: params.uid,
      contactId: params.contactId,
      type: 'profile-updated',
      payload: {
        privacyField: 'aiAllowed',
        previousValue: contact.aiAllowed !== false,
        nextValue: params.aiAllowed,
      },
    }),
  );
  await batch.commit();
}

export async function findContactDuplicates(
  uid: string,
  incoming: Pick<ManagedContact, 'id' | 'name' | 'company' | 'email'>,
): Promise<Array<DuplicateDetection & { contact: ManagedContact }>> {
  const contacts = await listManagedContacts(uid, { includeArchived: true });
  const matches = findDuplicateCandidates(incoming, contacts);
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  return matches
    .map((match) => ({
      ...match,
      contact: byId.get(match.contactId) as ManagedContact,
    }))
    .filter((match) => Boolean(match.contact));
}

const ROOT_REFERENCE_COLLECTIONS: Array<{
  collectionName: string;
  kind: Exclude<ContactReferenceKind, 'fact' | 'job-history'>;
}> = [
  { collectionName: 'notes', kind: 'note' },
  { collectionName: 'outreaches', kind: 'outreach' },
  { collectionName: 'commitments', kind: 'commitment' },
  { collectionName: 'threads', kind: 'thread' },
  {
    collectionName: 'voiceEnrichmentJobs',
    kind: 'voice-enrichment',
  },
];

async function readReferenceRecords(
  uid: string,
  contactId: string,
): Promise<{
  records: ContactReferenceRecord[];
  reservedFactIds: string[];
  reservedJobHistoryIds: string[];
}> {
  const [
    rootSnapshots,
    sourceConnections,
    targetConnections,
    sourceFacts,
    sourceJobs,
  ] = await Promise.all([
    Promise.all(
      ROOT_REFERENCE_COLLECTIONS.map(({ collectionName }) =>
        getDocs(
          query(
            collection(db, `users/${uid}/${collectionName}`),
            where('contactId', '==', contactId),
          ),
        ),
      ),
    ),
    getDocs(
      query(
        collection(db, `users/${uid}/connections`),
        where('sourceId', '==', contactId),
      ),
    ),
    getDocs(
      query(
        collection(db, `users/${uid}/connections`),
        where('targetId', '==', contactId),
      ),
    ),
    getDocs(
      collection(db, `users/${uid}/contacts/${contactId}/facts`),
    ),
    getDocs(
      collection(db, `users/${uid}/contacts/${contactId}/jobHistory`),
    ),
  ]);
  const records: ContactReferenceRecord[] = [];
  rootSnapshots.forEach((snapshot, index) => {
    const descriptor = ROOT_REFERENCE_COLLECTIONS[index];
    snapshot.docs.forEach((document) => {
      records.push({
        kind: descriptor.kind,
        id: document.id,
        sourcePath: document.ref.path,
        contactId,
        data: document.data(),
      });
    });
  });
  sourceFacts.docs.forEach((document) => {
    records.push({
      kind: 'fact',
      id: document.id,
      sourcePath: document.ref.path,
      contactId,
      data: document.data(),
    });
  });
  const connections = new Map(
    [...sourceConnections.docs, ...targetConnections.docs].map((document) => [
      document.ref.path,
      document,
    ]),
  );
  connections.forEach((document) => {
    records.push({
      kind: 'connection',
      id: document.id,
      sourcePath: document.ref.path,
      contactId,
      data: document.data(),
    });
  });
  sourceJobs.docs.forEach((document) => {
    records.push({
      kind: 'job-history',
      id: document.id,
      sourcePath: document.ref.path,
      contactId,
      data: document.data(),
    });
  });
  return { records, reservedFactIds: [], reservedJobHistoryIds: [] };
}

export interface ContactMergePreview {
  primary: ManagedContact;
  duplicate: ManagedContact;
  duplicateEvidence: DuplicateDetection;
  referenceCounts: Record<ContactReferenceKind, number>;
}

export async function loadContactMergePreview(params: {
  uid: string;
  primaryContactId: string;
  duplicateContactId: string;
}): Promise<ContactMergePreview> {
  if (params.primaryContactId === params.duplicateContactId) {
    throw new Error('Choose two different contacts.');
  }
  const [primary, duplicate, referenceData] = await Promise.all([
    loadManagedContact(params.uid, params.primaryContactId),
    loadManagedContact(params.uid, params.duplicateContactId),
    readReferenceRecords(params.uid, params.duplicateContactId),
  ]);
  if (!primary || !duplicate) throw new Error('One of the contacts no longer exists.');
  const referenceCounts: Record<ContactReferenceKind, number> = {
    note: 0,
    outreach: 0,
    commitment: 0,
    thread: 0,
    'voice-enrichment': 0,
    connection: 0,
    fact: 0,
    'job-history': 0,
  };
  referenceData.records.forEach((record) => {
    referenceCounts[record.kind] += 1;
  });
  return {
    primary,
    duplicate,
    duplicateEvidence: detectDuplicate(duplicate, primary),
    referenceCounts,
  };
}

export interface ExecuteContactMergeResult {
  operationId: string;
  primaryContactId: string;
  duplicateContactId: string;
  migratedReferences: Record<ContactReferenceKind, number>;
  warnings: string[];
}

interface ContactMergeAPIError {
  error?: {
    code?: string;
    message?: string;
  };
  requestId?: string;
}

function contactMergeOperationId(value?: string): string {
  const operationId = value?.trim() || crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(operationId)) {
    throw new Error('The merge operation ID is invalid.');
  }
  return operationId;
}

function contactMergeExpectation(contact: ManagedContact) {
  return {
    profile: profileRecord(contact),
    lifecycleStatus: contact.lifecycleStatus || 'active',
    aiAllowed: contact.aiAllowed !== false,
    mergedIntoContactId: contact.mergedIntoContactId || null,
    contactMergeOperationId: contact.contactMergeOperationId || null,
  };
}

export async function executeContactMerge(params: {
  uid: string;
  primaryContactId: string;
  duplicateContactId: string;
  expectedPrimary: ManagedContact;
  expectedDuplicate: ManagedContact;
  choices: ContactMergeChoice[];
  confirmed: boolean;
  operationId?: string;
}): Promise<ExecuteContactMergeResult> {
  if (!params.confirmed) {
    throw new Error('Explicit merge confirmation is required.');
  }
  if (params.primaryContactId === params.duplicateContactId) {
    throw new Error('Choose two different contacts.');
  }

  const operationId = contactMergeOperationId(params.operationId);
  const response = await authenticatedFetch('/api/contacts/merge', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operationId,
      primaryContactId: params.primaryContactId,
      duplicateContactId: params.duplicateContactId,
      choices: params.choices,
      confirmed: true,
      expectedPrimary: contactMergeExpectation(params.expectedPrimary),
      expectedDuplicate: contactMergeExpectation(params.expectedDuplicate),
    }),
  });
  const payload = (await response.json().catch(() => null)) as
    | (Partial<ExecuteContactMergeResult> & ContactMergeAPIError)
    | null;
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        'The contacts could not be merged. It is safe to retry.',
    );
  }
  if (
    !payload ||
    payload.operationId !== operationId ||
    payload.primaryContactId !== params.primaryContactId ||
    payload.duplicateContactId !== params.duplicateContactId ||
    !payload.migratedReferences ||
    !Array.isArray(payload.warnings)
  ) {
    throw new Error(
      'The merge completed without a valid acknowledgement. It is safe to retry.',
    );
  }
  return {
    operationId,
    primaryContactId: params.primaryContactId,
    duplicateContactId: params.duplicateContactId,
    migratedReferences: payload.migratedReferences,
    warnings: payload.warnings,
  };
}

export interface PermanentPurgeRequest {
  requestId: string;
  contactId: string;
  status: 'queued';
}

export interface ContactMergeRecoveryRequest {
  requestId: string;
  operationId: string;
  status: 'queued';
}

export async function requestContactMergeRecovery(
  uid: string,
  operationId: string,
): Promise<ContactMergeRecoveryRequest> {
  const operationRef = doc(
    db,
    `users/${uid}/contactMergeOperations/${operationId}`,
  );
  const operation = await getDoc(operationRef);
  if (!operation.exists()) throw new Error('Merge operation not found.');
  const operationData = operation.data();
  const duplicateContactId = String(operationData.duplicateContactId || '');
  if (!duplicateContactId) throw new Error('Merge recovery metadata is incomplete.');
  const duplicate = await loadManagedContact(uid, duplicateContactId);
  if (
    !duplicate ||
    duplicate.mergedIntoContactId !== operationData.primaryContactId ||
    duplicate.contactMergeOperationId !== operationId
  ) {
    throw new Error('The merged duplicate no longer matches this operation.');
  }
  if (isContactPurgeEligible(duplicate, new Date())) {
    throw new Error('The merge recovery window has expired.');
  }
  const requestRef = doc(
    db,
    `users/${uid}/contactMergeRecoveryRequests/${operationId}`,
  );
  const existingRequest = await getDoc(requestRef);
  if (existingRequest.exists()) {
    return {
      requestId: requestRef.id,
      operationId,
      status: 'queued',
    };
  }
  try {
    await setDoc(
      requestRef,
      {
        operationId,
        primaryContactId: operationData.primaryContactId,
        duplicateContactId,
        actorUid: uid,
        status: 'queued',
        requestedAt: serverTimestamp(),
        requiresServerExecution: true,
        // The worker uses contactMergeOperationId on root references and
        // migratedFromPath on nested copies, then verifies the saved before/
        // after profile snapshots before restoring either profile.
        recoveryProtocolVersion: 1,
      },
      { merge: false },
    );
  } catch (error) {
    // Two tabs can request the same deterministic recovery simultaneously.
    // The immutable queue rule lets one create win and rejects the rewrite;
    // re-read before surfacing an error so that race remains idempotent.
    if (!(await getDoc(requestRef)).exists()) throw error;
  }
  return { requestId: requestRef.id, operationId, status: 'queued' };
}

export async function requestPermanentContactPurge(
  uid: string,
  contactId: string,
): Promise<PermanentPurgeRequest> {
  const contact = await loadManagedContact(uid, contactId);
  if (!contact) throw new Error('Contact not found.');
  const plan = buildPermanentPurgePlan(uid, contact, new Date());
  if (!plan.eligible) {
    throw new Error(
      plan.eligibleAt
        ? `Permanent deletion is available after ${plan.eligibleAt.toLocaleDateString()}.`
        : 'Soft-delete the contact before requesting permanent deletion.',
    );
  }
  const requestRef = doc(
    db,
    `users/${uid}/contactPurgeRequests/${contactId}`,
  );
  const existingRequest = await getDoc(requestRef);
  if (existingRequest.exists()) {
    return { requestId: requestRef.id, contactId, status: 'queued' };
  }
  const batch = writeBatch(db);
  batch.set(
    requestRef,
    {
      contactId,
      actorUid: uid,
      status: 'queued',
      plan,
      requestedAt: serverTimestamp(),
      // A privileged server worker must recursively delete nested data and
      // verify all root references before it marks this request complete.
      requiresServerExecution: true,
    },
    { merge: false },
  );
  batch.set(
    contactEventRef(uid),
    eventRecord({
      uid,
      contactId,
      type: 'purge-requested',
      sourceId: requestRef.id,
      payload: {
        eligibleAt: plan.eligibleAt?.toISOString() || null,
        paths: plan.collectionPaths,
      },
    }),
  );
  try {
    await batch.commit();
  } catch (error) {
    if (!(await getDoc(requestRef)).exists()) throw error;
  }
  return { requestId: requestRef.id, contactId, status: 'queued' };
}
