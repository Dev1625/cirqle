import {
  collection,
  doc,
  serverTimestamp,
  type Firestore,
  type WriteBatch,
} from 'firebase/firestore';

import { db } from '../config/firebase';
import { normalizeFactValue, type FactSourceType } from './factLedgerCore';
import {
  MAX_SOURCE_FACTS_PER_RECORD,
  sourceFactDocumentId,
  type SourceFactDraft,
} from './sourceFactsCore';

type BrowserSourceFactType = Exclude<
  FactSourceType,
  'system' | 'user-correction'
>;

export function queueSourceFacts(
  batch: WriteBatch,
  input: {
    uid: string;
    contactId: string;
    sourceType: BrowserSourceFactType;
    sourceId: string;
    observedAt: Date;
    facts: SourceFactDraft[];
    aiAllowed?: boolean;
    firestore?: Firestore;
  },
): string[] {
  const sourceId = input.sourceId.trim().slice(0, 300);
  if (!input.uid || !input.contactId || !sourceId) {
    throw new Error('A fact owner, contact, and source are required.');
  }
  if (
    !(input.observedAt instanceof Date) ||
    Number.isNaN(input.observedAt.getTime())
  ) {
    throw new Error('A valid fact observation time is required.');
  }

  const firestore = input.firestore || db;
  const factCollection = collection(
    firestore,
    `users/${input.uid}/contacts/${input.contactId}/facts`,
  );
  const facts = input.facts.slice(0, MAX_SOURCE_FACTS_PER_RECORD);
  const factIds: string[] = [];

  for (const candidate of facts) {
    const predicate = candidate.predicate.trim().slice(0, 200);
    const value = candidate.value
      .replace(/\u0000/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 20_000);
    if (!predicate || !value) continue;
    const reference = doc(
      factCollection,
      sourceFactDocumentId({
        sourceType: input.sourceType,
        sourceId,
        predicate,
      }),
    );
    factIds.push(reference.id);
    batch.set(reference, {
      predicate,
      value,
      normalizedValue: normalizeFactValue(value).slice(0, 20_000),
      sourceType: input.sourceType,
      sourceId,
      observedAt: input.observedAt,
      confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0)),
      current: true,
      aiAllowed: input.aiAllowed !== false,
      correctionOf: null,
      supersededBy: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
  return factIds;
}
