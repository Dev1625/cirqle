import {
  addDoc,
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../config/firebase';
import { generateJSON } from './ai';

/**
 * Commitment tracking.
 *
 * "I'll send the deck" is the most commonly broken promise in professional
 * networking, and it is broken by forgetting rather than by intent. The note
 * already contains the promise; nothing was ever reading it back out.
 *
 * Deliberately dismissible. An extraction model will produce false positives
 * ("I'll think about it" is not a commitment), and a tracker you cannot
 * silence becomes a tracker you stop reading.
 */

export type CommitmentStatus = 'open' | 'done' | 'dismissed';

export interface Commitment {
  id: string;
  contactId: string;
  contactName: string;
  text: string;
  /** Free-text timing as the source expressed it — "next week", "by Friday". */
  dueHint: string | null;
  /** Which side owes: the owner, or the contact. */
  owedBy: 'you' | 'them';
  status: CommitmentStatus;
  sourceType: 'note' | 'outreach' | 'voice';
  sourceId: string | null;
  createdAt: Date | null;
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value?.toDate) return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function listCommitments(
  uid: string,
  options: { contactId?: string; status?: CommitmentStatus } = {}
): Promise<Commitment[]> {
  const base = collection(db, `users/${uid}/commitments`);

  // Only ONE equality filter goes to Firestore; the other is applied in
  // memory. Two equality filters on different fields require a composite
  // index, which the emulator creates on demand but production Firestore
  // rejects outright with "The query requires an index" — a failure that
  // would only ever show up after deploy. The collection is per-user and
  // small, so filtering the remainder client-side costs nothing.
  const snap = await getDocs(
    options.contactId ? query(base, where('contactId', '==', options.contactId)) : base
  );

  return snap.docs
    .filter((d) => {
      const data = d.data() as any;
      if (options.status && (data.status || 'open') !== options.status) return false;
      return true;
    })
    .map((d) => {
      const data = d.data() as any;
      return {
        id: d.id,
        contactId: data.contactId,
        contactName: data.contactName || '',
        text: data.text || '',
        dueHint: data.dueHint || null,
        owedBy: data.owedBy === 'them' ? 'them' : 'you',
        status: (data.status || 'open') as CommitmentStatus,
        sourceType: (data.sourceType || 'note') as Commitment['sourceType'],
        sourceId: data.sourceId || null,
        createdAt: toDate(data.createdAt),
      } as Commitment;
    })
    .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
}

export async function setCommitmentStatus(
  uid: string,
  commitmentId: string,
  status: CommitmentStatus
): Promise<void> {
  await updateDoc(doc(db, `users/${uid}/commitments/${commitmentId}`), {
    status,
    resolvedAt: status === 'open' ? null : serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function createCommitment(
  uid: string,
  input: Omit<Commitment, 'id' | 'createdAt' | 'status'> & { status?: CommitmentStatus }
): Promise<string> {
  const ref = await addDoc(collection(db, `users/${uid}/commitments`), {
    contactId: input.contactId,
    contactName: input.contactName,
    text: input.text,
    dueHint: input.dueHint || null,
    owedBy: input.owedBy,
    status: input.status || 'open',
    sourceType: input.sourceType,
    sourceId: input.sourceId || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

interface ExtractedCommitment {
  text?: string;
  dueHint?: string | null;
  owedBy?: string;
}

/**
 * Pulls commitments out of free text.
 *
 * The prompt is strict about what does *not* count, because the failure mode
 * here is a queue full of "great to connect!" noise that trains the user to
 * ignore it. Better to miss a soft commitment than to surface five false ones.
 */
export async function extractCommitments(params: {
  text: string;
  contactName: string;
}): Promise<{ text: string; dueHint: string | null; owedBy: 'you' | 'them' }[]> {
  const prompt = `Read this note about a conversation with ${params.contactName} and extract only concrete commitments — specific things someone said they would DO.

Note:
"""
${params.text.slice(0, 4000)}
"""

Counts as a commitment: "I'll send the deck", "I'll intro you to Priya", "she'll review the memo and get back to me", "follow up next week".

Does NOT count, and must be excluded:
- Pleasantries: "great to connect", "let's stay in touch", "we should grab coffee sometime"
- Vague intentions with no action: "I'll think about it", "we'll see"
- Things already completed
- Facts, opinions, or background about the person

For each real commitment give: the action as a short imperative phrase (max 60 chars), any timing the note mentions (or null), and whether it is owed by "you" (the note's author) or "them" (${params.contactName}).

Return JSON: {"commitments": [{"text": "...", "dueHint": "..." or null, "owedBy": "you" or "them"}]}
If there are none, return {"commitments": []}. Returning an empty list is a correct and expected answer.`;

  const result = await generateJSON<{ commitments?: ExtractedCommitment[] }>(prompt, {
    model: 'reasoning',
  });

  return (result.commitments || [])
    .filter((item) => (item.text || '').trim().length > 0)
    .slice(0, 6)
    .map((item) => ({
      text: (item.text as string).trim().slice(0, 120),
      dueHint: item.dueHint ? String(item.dueHint).slice(0, 60) : null,
      owedBy: item.owedBy === 'them' ? ('them' as const) : ('you' as const),
    }));
}

/**
 * Extracts and persists in one step, skipping anything already tracked for
 * this contact so re-running over the same note does not duplicate the queue.
 */
export async function extractAndStore(params: {
  uid: string;
  contactId: string;
  contactName: string;
  text: string;
  sourceType: Commitment['sourceType'];
  sourceId?: string | null;
}): Promise<Commitment[]> {
  const [found, existing] = await Promise.all([
    extractCommitments({ text: params.text, contactName: params.contactName }),
    listCommitments(params.uid, { contactId: params.contactId }),
  ]);

  const seen = new Set(existing.map((c) => c.text.trim().toLowerCase()));
  const created: Commitment[] = [];

  for (const item of found) {
    if (seen.has(item.text.trim().toLowerCase())) continue;
    const id = await createCommitment(params.uid, {
      contactId: params.contactId,
      contactName: params.contactName,
      text: item.text,
      dueHint: item.dueHint,
      owedBy: item.owedBy,
      sourceType: params.sourceType,
      sourceId: params.sourceId || null,
    });
    created.push({
      id,
      contactId: params.contactId,
      contactName: params.contactName,
      text: item.text,
      dueHint: item.dueHint,
      owedBy: item.owedBy,
      status: 'open',
      sourceType: params.sourceType,
      sourceId: params.sourceId || null,
      createdAt: new Date(),
    });
  }

  return created;
}
