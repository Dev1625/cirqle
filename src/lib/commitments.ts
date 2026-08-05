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
import {
  generateGroundedJSON,
  groundingDisplay,
  type GroundedSource,
  type GroundingDisplay,
} from './grounding';
import type { CommitmentFeedbackState } from './moat/commitmentFeedbackCore';

/**
 * Commitment tracking.
 *
 * The original note remains the source of truth. Extraction records retain
 * the exact source IDs the model cited so a false positive can be reviewed
 * and dismissed without turning generated text into an unexplained fact.
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
  aiGrounding: GroundingDisplay | null;
  feedback?: CommitmentFeedbackState | null;
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

  // Only one equality filter goes to Firestore; the other is applied in
  // memory so production does not unexpectedly require a composite index.
  const snap = await getDocs(
    options.contactId ? query(base, where('contactId', '==', options.contactId)) : base
  );

  return snap.docs
    .filter((document) => {
      const data = document.data() as any;
      return !options.status || (data.status || 'open') === options.status;
    })
    .map((document) => {
      const data = document.data() as any;
      return {
        id: document.id,
        contactId: data.contactId,
        contactName: data.contactName || '',
        text: data.text || '',
        dueHint: data.dueHint || null,
        owedBy: data.owedBy === 'them' ? 'them' : 'you',
        status: (data.status || 'open') as CommitmentStatus,
        sourceType: (data.sourceType || 'note') as Commitment['sourceType'],
        sourceId: data.sourceId || null,
        createdAt: toDate(data.createdAt),
        aiGrounding: data.aiGrounding || null,
        feedback: data.feedback || null,
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
  input: Omit<
    Commitment,
    'id' | 'createdAt' | 'status' | 'aiGrounding' | 'feedback'
  > & {
    status?: CommitmentStatus;
    aiGrounding?: GroundingDisplay | null;
  }
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
    aiGrounding: input.aiGrounding || null,
    feedback: null,
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

export interface CommitmentExtraction {
  commitments: { text: string; dueHint: string | null; owedBy: 'you' | 'them' }[];
  grounding: GroundingDisplay;
}

export function commitmentExtractionSources(params: {
  text: string;
  contactName: string;
  contactId?: string;
  sourceType?: Commitment['sourceType'];
  sourceId?: string | null;
}): GroundedSource[] {
  const kind =
    params.sourceType === 'outreach'
      ? 'outreach'
      : params.sourceType === 'note' || params.sourceType === 'voice'
        ? 'note'
        : 'user-input';
  const evidenceId = params.sourceId
    ? `${kind === 'outreach' ? 'outreach' : 'note'}-${params.sourceId}`
    : 'user-commitment-text';
  const evidenceLabel =
    params.sourceType === 'voice'
      ? 'Voice memo'
      : params.sourceType === 'outreach'
        ? 'Outreach record'
        : params.sourceType === 'note'
          ? 'Saved note'
          : 'Supplied text';
  const sources: GroundedSource[] = [
    {
      id: evidenceId,
      kind,
      label: evidenceLabel,
      text: params.text.slice(0, 4_000),
    },
  ];

  if (params.contactId) {
    sources.unshift({
      id: `contact-${params.contactId}`,
      kind: 'contact',
      label: `Contact · ${params.contactName}`,
      text: JSON.stringify({ name: params.contactName }),
    });
  }
  return sources;
}

/**
 * Pulls only explicit promises out of free text. The model receives the note
 * as untrusted evidence, never interpolated into its instructions.
 */
export async function extractCommitments(params: {
  text: string;
  contactName: string;
  contactId?: string;
  sourceType?: Commitment['sourceType'];
  sourceId?: string | null;
  signal?: AbortSignal;
}): Promise<CommitmentExtraction> {
  const sources = commitmentExtractionSources(params);
  const grounded = await generateGroundedJSON<{ commitments?: ExtractedCommitment[] }>({
    task: 'Extract only concrete commitments: specific actions the note author or the named contact explicitly said they would do.',
    resultSchema: `{
      "commitments": [{
        "text": "short imperative action, maximum 60 characters",
        "dueHint": "timing exactly as expressed, or null",
        "owedBy": "you | them"
      }]
    }`,
    sources,
    rules: [
      'Pleasantries such as "great to connect" and "stay in touch" are not commitments.',
      'Vague intentions such as "think about it" and "we will see" are not commitments.',
      'Exclude completed actions, facts, opinions, background, and suggestions with no promise.',
      'Do not infer a due date or owner. If ownership is not explicit, omit the item.',
      'An empty commitments list is correct when the evidence contains no concrete promise.',
    ],
    options: {
      tier: 'reasoning',
      maxTokens: 900,
      feature: 'commitment-extraction',
      signal: params.signal,
    },
  });
  const evidenceId = sources.find((source) => source.kind !== 'contact')?.id;
  if (
    (grounded.result?.commitments || []).length > 0 &&
    evidenceId &&
    !grounded.usedSourceIds.includes(evidenceId)
  ) {
    throw new Error('Commitment suggestions were withheld because they did not cite the source record.');
  }

  const commitments = (grounded.result?.commitments || [])
    .filter((item) => (item.text || '').trim().length > 0)
    .slice(0, 6)
    .map((item) => ({
      text: (item.text as string).trim().slice(0, 120),
      dueHint: item.dueHint ? String(item.dueHint).slice(0, 60) : null,
      owedBy: item.owedBy === 'them' ? ('them' as const) : ('you' as const),
    }));

  return {
    commitments,
    grounding: groundingDisplay(grounded, sources),
  };
}

/**
 * Extracts and persists in one step, skipping anything already tracked for
 * this contact so re-running over the same source does not duplicate the
 * queue.
 */
export async function extractAndStore(params: {
  uid: string;
  contactId: string;
  contactName: string;
  text: string;
  sourceType: Commitment['sourceType'];
  sourceId?: string | null;
  signal?: AbortSignal;
}): Promise<Commitment[]> {
  return (await extractAndStoreDetailed(params)).created;
}

export async function extractAndStoreDetailed(params: {
  uid: string;
  contactId: string;
  contactName: string;
  text: string;
  sourceType: Commitment['sourceType'];
  sourceId?: string | null;
  signal?: AbortSignal;
}): Promise<{ created: Commitment[]; grounding: GroundingDisplay }> {
  const [found, existing] = await Promise.all([
    extractCommitments({
      text: params.text,
      contactName: params.contactName,
      contactId: params.contactId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      signal: params.signal,
    }),
    listCommitments(params.uid, { contactId: params.contactId }),
  ]);

  const seen = new Set(existing.map((commitment) => commitment.text.trim().toLowerCase()));
  const created: Commitment[] = [];

  for (const item of found.commitments) {
    if (seen.has(item.text.trim().toLowerCase())) continue;
    const id = await createCommitment(params.uid, {
      contactId: params.contactId,
      contactName: params.contactName,
      text: item.text,
      dueHint: item.dueHint,
      owedBy: item.owedBy,
      sourceType: params.sourceType,
      sourceId: params.sourceId || null,
      aiGrounding: found.grounding,
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
      aiGrounding: found.grounding,
      feedback: null,
    });
  }

  return { created, grounding: found.grounding };
}
