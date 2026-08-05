import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';

import { db } from '../config/firebase';
import {
  canClaimVoiceEnrichment,
  cancelVoiceEnrichment,
  claimVoiceEnrichment,
  createVoiceEnrichmentJob,
  retryVoiceEnrichment,
  VOICE_ENRICHMENT_LEASE_MS,
  type VoiceEnrichmentJob,
} from './voiceEnrichmentCore';

function jobRef(uid: string, noteId: string) {
  return doc(db, `users/${uid}/voiceEnrichmentJobs/${noteId}`);
}

function normalizeJob(
  noteId: string,
  value: Partial<VoiceEnrichmentJob>,
): VoiceEnrichmentJob | null {
  if (
    !value ||
    value.noteId !== noteId ||
    typeof value.contactId !== 'string' ||
    typeof value.contactName !== 'string' ||
    typeof value.state !== 'string' ||
    !value.summary ||
    !value.commitments
  ) {
    return null;
  }
  return value as VoiceEnrichmentJob;
}

export async function enqueueVoiceEnrichment(input: {
  uid: string;
  noteId: string;
  contactId: string;
  contactName: string;
}): Promise<void> {
  const job = createVoiceEnrichmentJob(input);
  await setDoc(jobRef(input.uid, input.noteId), job);
}

export function subscribeVoiceEnrichmentJobs(
  uid: string,
  onJobs: (jobs: VoiceEnrichmentJob[]) => void,
  onError: () => void,
): Unsubscribe {
  return onSnapshot(
    collection(db, `users/${uid}/voiceEnrichmentJobs`),
    (snapshot) => {
      const jobs = snapshot.docs
        .map((document) =>
          normalizeJob(
            document.id,
            document.data() as Partial<VoiceEnrichmentJob>,
          ),
        )
        .filter((job): job is VoiceEnrichmentJob => Boolean(job))
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        );
      onJobs(jobs);
    },
    onError,
  );
}

export async function readVoiceEnrichmentJob(
  uid: string,
  noteId: string,
): Promise<VoiceEnrichmentJob | null> {
  const snapshot = await getDoc(jobRef(uid, noteId));
  return snapshot.exists()
    ? normalizeJob(
        snapshot.id,
        snapshot.data() as Partial<VoiceEnrichmentJob>,
      )
    : null;
}

export async function claimVoiceEnrichmentJob(
  uid: string,
  noteId: string,
  workerId: string,
  now = new Date(),
): Promise<VoiceEnrichmentJob | null> {
  return runTransaction(db, async (transaction) => {
    const reference = jobRef(uid, noteId);
    const snapshot = await transaction.get(reference);
    const current = snapshot.exists()
      ? normalizeJob(
          snapshot.id,
          snapshot.data() as Partial<VoiceEnrichmentJob>,
        )
      : null;
    if (
      !current ||
      !canClaimVoiceEnrichment(current, workerId, now.getTime())
    ) {
      return null;
    }
    const claimed = claimVoiceEnrichment(current, workerId, now);
    transaction.set(reference, claimed);
    return claimed;
  });
}

export async function mutateClaimedVoiceEnrichmentJob(
  uid: string,
  noteId: string,
  workerId: string,
  mutate: (current: VoiceEnrichmentJob) => VoiceEnrichmentJob,
): Promise<VoiceEnrichmentJob | null> {
  return runTransaction(db, async (transaction) => {
    const reference = jobRef(uid, noteId);
    const snapshot = await transaction.get(reference);
    const current = snapshot.exists()
      ? normalizeJob(
          snapshot.id,
          snapshot.data() as Partial<VoiceEnrichmentJob>,
        )
      : null;
    if (!current || current.leaseOwner !== workerId) return null;
    const next = mutate(current);
    transaction.set(reference, next);
    return next;
  });
}

export async function heartbeatVoiceEnrichmentJob(
  uid: string,
  noteId: string,
  workerId: string,
  now = new Date(),
): Promise<void> {
  await mutateClaimedVoiceEnrichmentJob(
    uid,
    noteId,
    workerId,
    (current) => ({
      ...current,
      leaseExpiresAtMs: now.getTime() + VOICE_ENRICHMENT_LEASE_MS,
      updatedAt: now.toISOString(),
    }),
  );
}

export async function requestVoiceEnrichmentCancellation(
  uid: string,
  noteId: string,
): Promise<void> {
  await runTransaction(db, async (transaction) => {
    const reference = jobRef(uid, noteId);
    const snapshot = await transaction.get(reference);
    const current = snapshot.exists()
      ? normalizeJob(
          snapshot.id,
          snapshot.data() as Partial<VoiceEnrichmentJob>,
        )
      : null;
    if (!current || ['complete', 'cancelled'].includes(current.state)) return;
    transaction.set(
      reference,
      current.state === 'queued'
        ? cancelVoiceEnrichment(current)
        : {
            ...current,
            cancelRequested: true,
            updatedAt: new Date().toISOString(),
          },
    );
  });
}

export async function finalizeVoiceEnrichmentCancellation(
  uid: string,
  noteId: string,
  workerId: string,
): Promise<void> {
  await mutateClaimedVoiceEnrichmentJob(
    uid,
    noteId,
    workerId,
    (current) => cancelVoiceEnrichment(current),
  );
}

export async function retryVoiceEnrichmentJob(
  uid: string,
  noteId: string,
): Promise<void> {
  await runTransaction(db, async (transaction) => {
    const reference = jobRef(uid, noteId);
    const snapshot = await transaction.get(reference);
    const current = snapshot.exists()
      ? normalizeJob(
          snapshot.id,
          snapshot.data() as Partial<VoiceEnrichmentJob>,
        )
      : null;
    if (!current) return;
    transaction.set(reference, retryVoiceEnrichment(current));
  });
}

export async function dismissVoiceEnrichmentJob(
  uid: string,
  noteId: string,
): Promise<void> {
  await updateDoc(jobRef(uid, noteId), {
    visible: false,
    updatedAt: new Date().toISOString(),
  });
}
