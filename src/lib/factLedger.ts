import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

import { db } from '../config/firebase';
import {
  clampConfidence,
  normalizeFactValue,
  type FactSourceType,
  type NewFact,
  type TemporalFact,
} from './factLedgerCore';

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  const parsed = new Date(value as string | number | Date);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function factFromDocument(document: { id: string; data: () => any }): TemporalFact {
  const data = document.data();
  return {
    id: document.id,
    predicate: String(data.predicate || ''),
    value: String(data.value || ''),
    normalizedValue:
      data.normalizedValue || normalizeFactValue(data.value),
    sourceType: (data.sourceType || 'system') as FactSourceType,
    sourceId: data.sourceId || null,
    observedAt: toDate(data.observedAt),
    confidence: clampConfidence(data.confidence),
    current: data.current !== false,
    aiAllowed: data.aiAllowed !== false,
    correctionOf: data.correctionOf || null,
    supersededBy: data.supersededBy || null,
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
  };
}

export async function listContactFacts(
  uid: string,
  contactId: string,
  { includeHistory = true }: { includeHistory?: boolean } = {},
): Promise<TemporalFact[]> {
  const base = collection(
    db,
    `users/${uid}/contacts/${contactId}/facts`,
  );
  const snapshot = await getDocs(
    includeHistory ? base : query(base, where('current', '==', true)),
  );
  return snapshot.docs
    .map(factFromDocument)
    .sort(
      (a, b) =>
        (b.observedAt?.getTime() || b.createdAt?.getTime() || 0) -
        (a.observedAt?.getTime() || a.createdAt?.getTime() || 0),
    );
}

export async function recordContactFact(
  uid: string,
  contactId: string,
  input: NewFact,
): Promise<string> {
  const predicate = input.predicate.trim();
  const value = input.value.trim().replace(/\s+/g, ' ');
  if (!predicate || !value) throw new Error('A predicate and value are required.');

  const base = collection(
    db,
    `users/${uid}/contacts/${contactId}/facts`,
  );
  const current = await getDocs(
    query(
      base,
      where('predicate', '==', predicate),
      where('current', '==', true),
    ),
  );
  const requestedCorrectionId =
    typeof input.correctionOf === 'string' && input.correctionOf.trim()
      ? input.correctionOf.trim()
      : null;
  const inferredCorrectionId =
    input.sourceType === 'user-correction' &&
    !requestedCorrectionId &&
    current.docs.length === 1
      ? current.docs[0].id
      : null;
  const correctionOf = requestedCorrectionId || inferredCorrectionId;
  const sourceType =
    input.sourceType === 'user-correction' && !correctionOf
      ? 'profile'
      : input.sourceType;
  const sourceId =
    sourceType === 'user-correction'
      ? correctionOf
      : input.sourceId || null;
  const nextRef = doc(base);
  const batch = writeBatch(db);
  for (const previous of current.docs) {
    batch.update(previous.ref, {
      current: false,
      supersededBy: nextRef.id,
      supersededAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
  batch.set(nextRef, {
    predicate,
    value,
    normalizedValue: normalizeFactValue(value),
    sourceType,
    sourceId,
    observedAt: input.observedAt || new Date(),
    confidence: clampConfidence(input.confidence ?? 1),
    current: true,
    aiAllowed: input.aiAllowed !== false,
    correctionOf,
    supersededBy: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  await batch.commit();
  return nextRef.id;
}

export async function correctContactFact(
  uid: string,
  contactId: string,
  factId: string,
  value: string,
): Promise<string> {
  const previousRef = doc(
    db,
    `users/${uid}/contacts/${contactId}/facts/${factId}`,
  );
  const previous = await getDoc(previousRef);
  if (!previous.exists()) throw new Error('Fact not found.');
  const data = previous.data();
  return recordContactFact(uid, contactId, {
    predicate: data.predicate,
    value,
    sourceType: 'user-correction',
    sourceId: factId,
    observedAt: new Date(),
    confidence: 1,
    aiAllowed: data.aiAllowed !== false,
    correctionOf: factId,
  });
}

export async function setFactAIAllowed(
  uid: string,
  contactId: string,
  factId: string,
  aiAllowed: boolean,
): Promise<void> {
  await updateDoc(
    doc(db, `users/${uid}/contacts/${contactId}/facts/${factId}`),
    {
      aiAllowed,
      privacyUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  );
}
