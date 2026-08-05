import type { GroundingDisplay } from './grounding';

export const VOICE_ENRICHMENT_VERSION = 1;
export const VOICE_ENRICHMENT_LEASE_MS = 60_000;
export const VOICE_ENRICHMENT_HEARTBEAT_MS = 15_000;
export const VOICE_ENRICHMENT_MAX_ACTIVE = 10;
export const VOICE_MEMO_MAX_CHARS = 12_000;

export function normalizeVoiceMemoText(value: unknown): {
  text: string;
  truncated: boolean;
} {
  const normalized =
    typeof value === 'string'
      ? value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
      : '';
  return {
    text: normalized.slice(0, VOICE_MEMO_MAX_CHARS),
    truncated: normalized.length > VOICE_MEMO_MAX_CHARS,
  };
}

export type VoiceEnrichmentState =
  | 'queued'
  | 'running'
  | 'partial'
  | 'complete'
  | 'failed'
  | 'cancelled';

export type VoiceEnrichmentStepStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface VoiceEnrichmentStep {
  status: VoiceEnrichmentStepStatus;
  error: string | null;
  completedAt: string | null;
  grounding: GroundingDisplay | null;
}

export interface VoiceSummaryStep extends VoiceEnrichmentStep {
  text: string | null;
}

export interface VoiceCommitmentStep extends VoiceEnrichmentStep {
  createdCount: number;
}

export interface VoiceEnrichmentJob {
  version: number;
  noteId: string;
  contactId: string;
  contactName: string;
  state: VoiceEnrichmentState;
  visible: boolean;
  cancelRequested: boolean;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAtMs: number | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  summary: VoiceSummaryStep;
  commitments: VoiceCommitmentStep;
}

function emptyStep(): VoiceEnrichmentStep {
  return {
    status: 'pending',
    error: null,
    completedAt: null,
    grounding: null,
  };
}

export function createVoiceEnrichmentJob(input: {
  noteId: string;
  contactId: string;
  contactName: string;
  now?: Date;
}): VoiceEnrichmentJob {
  const now = (input.now || new Date()).toISOString();
  return {
    version: VOICE_ENRICHMENT_VERSION,
    noteId: input.noteId,
    contactId: input.contactId,
    contactName: input.contactName.slice(0, 240),
    state: 'queued',
    visible: true,
    cancelRequested: false,
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAtMs: null,
    queuedAt: now,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
    summary: {
      ...emptyStep(),
      text: null,
    },
    commitments: {
      ...emptyStep(),
      createdCount: 0,
    },
  };
}

export function canClaimVoiceEnrichment(
  job: VoiceEnrichmentJob,
  workerId: string,
  nowMs: number,
): boolean {
  if (job.cancelRequested) return false;
  if (job.state === 'queued') return true;
  if (job.state !== 'running') return false;
  return (
    job.leaseOwner === workerId ||
    job.leaseExpiresAtMs == null ||
    job.leaseExpiresAtMs <= nowMs
  );
}

export function claimVoiceEnrichment(
  job: VoiceEnrichmentJob,
  workerId: string,
  now = new Date(),
): VoiceEnrichmentJob {
  if (!canClaimVoiceEnrichment(job, workerId, now.getTime())) {
    throw new Error('Voice enrichment is already leased by another tab.');
  }

  const timestamp = now.toISOString();
  return {
    ...job,
    state: 'running',
    attempt: job.leaseOwner === workerId ? job.attempt : job.attempt + 1,
    leaseOwner: workerId,
    leaseExpiresAtMs: now.getTime() + VOICE_ENRICHMENT_LEASE_MS,
    startedAt: job.startedAt || timestamp,
    updatedAt: timestamp,
  };
}

export function markVoiceStepRunning(
  job: VoiceEnrichmentJob,
  step: 'summary' | 'commitments',
  now = new Date(),
): VoiceEnrichmentJob {
  const timestamp = now.toISOString();
  return {
    ...job,
    state: 'running',
    updatedAt: timestamp,
    [step]: {
      ...job[step],
      status: 'running',
      error: null,
    },
  };
}

export function completeVoiceSummary(
  job: VoiceEnrichmentJob,
  input: {
    text: string;
    grounding: GroundingDisplay;
    now?: Date;
  },
): VoiceEnrichmentJob {
  const timestamp = (input.now || new Date()).toISOString();
  return {
    ...job,
    state: 'running',
    updatedAt: timestamp,
    summary: {
      status: 'complete',
      error: null,
      completedAt: timestamp,
      grounding: input.grounding,
      text: input.text.slice(0, 160),
    },
  };
}

export function completeVoiceCommitments(
  job: VoiceEnrichmentJob,
  input: {
    createdCount: number;
    grounding: GroundingDisplay;
    now?: Date;
  },
): VoiceEnrichmentJob {
  const timestamp = (input.now || new Date()).toISOString();
  return {
    ...job,
    state: 'complete',
    leaseOwner: null,
    leaseExpiresAtMs: null,
    completedAt: timestamp,
    updatedAt: timestamp,
    commitments: {
      status: 'complete',
      error: null,
      completedAt: timestamp,
      grounding: input.grounding,
      createdCount: Math.max(0, Math.floor(input.createdCount)),
    },
  };
}

export function failVoiceEnrichment(
  job: VoiceEnrichmentJob,
  step: 'summary' | 'commitments',
  message: string,
  now = new Date(),
): VoiceEnrichmentJob {
  const timestamp = now.toISOString();
  const anyComplete =
    job.summary.status === 'complete' || job.commitments.status === 'complete';
  return {
    ...job,
    state: anyComplete ? 'partial' : 'failed',
    leaseOwner: null,
    leaseExpiresAtMs: null,
    updatedAt: timestamp,
    [step]: {
      ...job[step],
      status: 'failed',
      error: message.slice(0, 500),
    },
  };
}

export function cancelVoiceEnrichment(
  job: VoiceEnrichmentJob,
  now = new Date(),
): VoiceEnrichmentJob {
  const timestamp = now.toISOString();
  const cancelStep = <T extends VoiceEnrichmentStep>(step: T): T =>
    step.status === 'complete'
      ? step
      : {
          ...step,
          status: 'cancelled',
          error: null,
        };

  return {
    ...job,
    state: 'cancelled',
    visible: true,
    cancelRequested: true,
    leaseOwner: null,
    leaseExpiresAtMs: null,
    updatedAt: timestamp,
    summary: cancelStep(job.summary),
    commitments: cancelStep(job.commitments),
  };
}

export function retryVoiceEnrichment(
  job: VoiceEnrichmentJob,
  now = new Date(),
): VoiceEnrichmentJob {
  if (!['partial', 'failed', 'cancelled'].includes(job.state)) {
    throw new Error('Only an incomplete voice enrichment can be retried.');
  }
  const timestamp = now.toISOString();
  const resetStep = <T extends VoiceEnrichmentStep>(step: T): T =>
    step.status === 'complete'
      ? step
      : {
          ...step,
          status: 'pending',
          error: null,
          completedAt: null,
          grounding: null,
        };

  return {
    ...job,
    state: 'queued',
    visible: true,
    cancelRequested: false,
    leaseOwner: null,
    leaseExpiresAtMs: null,
    queuedAt: timestamp,
    completedAt: null,
    updatedAt: timestamp,
    summary: resetStep(job.summary),
    commitments: resetStep(job.commitments),
  };
}

export function voiceEnrichmentProgress(job: VoiceEnrichmentJob): {
  completed: number;
  total: 2;
  percent: number;
} {
  const completed = [job.summary, job.commitments].filter(
    (step) => step.status === 'complete',
  ).length;
  return {
    completed,
    total: 2,
    percent: completed * 50,
  };
}
