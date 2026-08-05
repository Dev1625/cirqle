import React, { useEffect, useMemo, useState } from 'react';
import {
  doc,
  getDoc,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';

import { db } from '../../config/firebase';
import { AICancelledError } from '../../lib/ai';
import { extractAndStoreDetailed } from '../../lib/commitments';
import {
  generateGroundedText,
  groundingDisplay,
  type GroundedSource,
} from '../../lib/grounding';
import {
  completeVoiceCommitments,
  completeVoiceSummary,
  failVoiceEnrichment,
  markVoiceStepRunning,
  VOICE_ENRICHMENT_HEARTBEAT_MS,
  VOICE_ENRICHMENT_MAX_ACTIVE,
  voiceEnrichmentProgress,
  type VoiceEnrichmentJob,
} from '../../lib/voiceEnrichmentCore';
import {
  claimVoiceEnrichmentJob,
  dismissVoiceEnrichmentJob,
  finalizeVoiceEnrichmentCancellation,
  heartbeatVoiceEnrichmentJob,
  mutateClaimedVoiceEnrichmentJob,
  readVoiceEnrichmentJob,
  requestVoiceEnrichmentCancellation,
  retryVoiceEnrichmentJob,
  subscribeVoiceEnrichmentJobs,
} from '../../lib/voiceEnrichment';
import { Button } from '../ui/Button';

const LOCAL_CONCURRENCY = 2;
const activeControllers = new Map<string, AbortController>();

function recordDate(value: unknown): Date | null {
  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  const parsed = value ? new Date(value as string | number | Date) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

async function processVoiceEnrichment(
  uid: string,
  candidate: VoiceEnrichmentJob,
  workerId: string,
): Promise<void> {
  const key = `${uid}:${candidate.noteId}`;
  if (activeControllers.has(key)) return;

  const claimed = await claimVoiceEnrichmentJob(
    uid,
    candidate.noteId,
    workerId,
  );
  if (!claimed) return;

  const controller = new AbortController();
  activeControllers.set(key, controller);
  const heartbeat = window.setInterval(() => {
    void heartbeatVoiceEnrichmentJob(
      uid,
      candidate.noteId,
      workerId,
    ).catch(() => undefined);
  }, VOICE_ENRICHMENT_HEARTBEAT_MS);

  let activeStep: 'summary' | 'commitments' =
    claimed.summary.status === 'complete' ? 'commitments' : 'summary';

  try {
    const noteSnapshot = await getDoc(
      doc(db, `users/${uid}/notes/${candidate.noteId}`),
    );
    if (!noteSnapshot.exists()) {
      throw new Error('The saved voice memo could not be found.');
    }
    const note = noteSnapshot.data() as Record<string, unknown>;
    const text = typeof note.content === 'string' ? note.content.trim() : '';
    if (!text) throw new Error('The saved voice memo has no transcript.');
    const observedAt =
      recordDate(note.createdAt)?.toISOString() || claimed.queuedAt;
    const sources: GroundedSource[] = [
      {
        id: `contact-${claimed.contactId}`,
        kind: 'contact',
        label: `Contact · ${claimed.contactName}`,
        text: JSON.stringify({ name: claimed.contactName }),
      },
      {
        id: `note-${claimed.noteId}`,
        kind: 'note',
        label: 'Voice memo',
        text: text.slice(0, 3_000),
        observedAt,
      },
    ];

    let latest = (await readVoiceEnrichmentJob(uid, claimed.noteId)) || claimed;
    if (latest.cancelRequested) {
      await finalizeVoiceEnrichmentCancellation(
        uid,
        claimed.noteId,
        workerId,
      );
      return;
    }

    if (latest.summary.status !== 'complete') {
      activeStep = 'summary';
      latest =
        (await mutateClaimedVoiceEnrichmentJob(
          uid,
          claimed.noteId,
          workerId,
          (current) => markVoiceStepRunning(current, 'summary'),
        )) || latest;
      const grounded = await generateGroundedText({
        task: 'Summarize the saved post-meeting voice memo in one dry sentence of at most 140 characters.',
        sources,
        rules: [
          'Summarize only what the memo explicitly says.',
          'Do not imply a meeting, promise, attachment, or outcome unless the memo records it.',
          'Return no preamble.',
        ],
        options: {
          tier: 'fast',
          maxTokens: 120,
          feature: 'voice-memo-summary',
          signal: controller.signal,
        },
      });
      if (!grounded.usedSourceIds.includes(`note-${claimed.noteId}`)) {
        throw new Error('The summary did not cite the saved memo.');
      }
      const display = groundingDisplay(grounded, sources);
      await updateDoc(doc(db, `users/${uid}/notes/${claimed.noteId}`), {
        aiSummary: grounded.result.trim().slice(0, 160),
        aiSummaryGrounding: display,
        updatedAt: serverTimestamp(),
      });
      latest =
        (await mutateClaimedVoiceEnrichmentJob(
          uid,
          claimed.noteId,
          workerId,
          (current) =>
            completeVoiceSummary(current, {
              text: grounded.result,
              grounding: display,
            }),
        )) || latest;
    }

    latest = (await readVoiceEnrichmentJob(uid, claimed.noteId)) || latest;
    if (latest.cancelRequested) {
      await finalizeVoiceEnrichmentCancellation(
        uid,
        claimed.noteId,
        workerId,
      );
      return;
    }

    if (latest.commitments.status !== 'complete') {
      activeStep = 'commitments';
      await mutateClaimedVoiceEnrichmentJob(
        uid,
        claimed.noteId,
        workerId,
        (current) => markVoiceStepRunning(current, 'commitments'),
      );
      const extracted = await extractAndStoreDetailed({
        uid,
        contactId: claimed.contactId,
        contactName: claimed.contactName,
        text,
        sourceType: 'voice',
        sourceId: claimed.noteId,
        signal: controller.signal,
      });
      await mutateClaimedVoiceEnrichmentJob(
        uid,
        claimed.noteId,
        workerId,
        (current) =>
          completeVoiceCommitments(current, {
            createdCount: extracted.created.length,
            grounding: extracted.grounding,
          }),
      );
    }
  } catch (error) {
    const latest = await readVoiceEnrichmentJob(uid, candidate.noteId).catch(
      () => null,
    );
    if (
      error instanceof AICancelledError ||
      controller.signal.aborted ||
      latest?.cancelRequested
    ) {
      await finalizeVoiceEnrichmentCancellation(
        uid,
        candidate.noteId,
        workerId,
      ).catch(() => undefined);
    } else {
      await mutateClaimedVoiceEnrichmentJob(
        uid,
        candidate.noteId,
        workerId,
        (current) =>
          failVoiceEnrichment(
            current,
            activeStep,
            activeStep === 'summary'
              ? 'Summary enrichment could not finish. The raw memo is safe.'
              : 'Commitment enrichment could not finish. The raw memo and summary are safe.',
          ),
      ).catch(() => undefined);
    }
  } finally {
    window.clearInterval(heartbeat);
    activeControllers.delete(key);
  }
}

function jobStatus(job: VoiceEnrichmentJob): string {
  const progress = voiceEnrichmentProgress(job);
  if (job.cancelRequested && job.state === 'running') {
    return 'Stopping after the current safe checkpoint…';
  }
  if (job.state === 'queued') return 'Queued for private enrichment';
  if (job.state === 'running') {
    return job.summary.status !== 'complete'
      ? 'Grounding a concise summary…'
      : 'Reviewing explicit commitments…';
  }
  if (job.state === 'complete') {
    return `Complete · ${job.commitments.createdCount} commitment${
      job.commitments.createdCount === 1 ? '' : 's'
    } added`;
  }
  if (job.state === 'partial') {
    return `${progress.completed} of ${progress.total} steps complete`;
  }
  if (job.state === 'cancelled') return 'Canceled · raw memo preserved';
  return 'Enrichment needs attention · raw memo preserved';
}

export function VoiceEnrichmentCenter({ uid }: { uid: string }) {
  const [jobs, setJobs] = useState<VoiceEnrichmentJob[]>([]);
  const [readError, setReadError] = useState(false);
  const workerId = useMemo(
    () => `voice-${crypto.randomUUID()}`,
    [],
  );

  useEffect(
    () =>
      subscribeVoiceEnrichmentJobs(
        uid,
        (next) => {
          setReadError(false);
          setJobs(next);
        },
        () => setReadError(true),
      ),
    [uid],
  );

  useEffect(() => {
    const localActive = [...activeControllers.keys()].filter((key) =>
      key.startsWith(`${uid}:`),
    ).length;
    const ownerActive = jobs.filter(
      (job) =>
        job.state === 'running' &&
        job.leaseExpiresAtMs != null &&
        job.leaseExpiresAtMs > Date.now(),
    ).length;
    const available = Math.max(
      0,
      Math.min(
        LOCAL_CONCURRENCY - localActive,
        VOICE_ENRICHMENT_MAX_ACTIVE - ownerActive,
      ),
    );
    if (available === 0) return;

    jobs
      .filter(
        (job) =>
          !job.cancelRequested &&
          (job.state === 'queued' ||
            (job.state === 'running' &&
              (job.leaseExpiresAtMs == null ||
                job.leaseExpiresAtMs <= Date.now()))),
      )
      .slice(0, available)
      .forEach((job) => {
        void processVoiceEnrichment(uid, job, workerId);
      });
  }, [jobs, uid, workerId]);

  useEffect(
    () => () => {
      for (const [key, controller] of activeControllers) {
        if (key.startsWith(`${uid}:`)) controller.abort();
      }
    },
    [uid],
  );

  const visible = jobs.filter((job) => job.visible).slice(0, 3);
  if (!readError && visible.length === 0) return null;

  return (
    <aside
      className="fixed bottom-4 right-4 z-[85] w-[min(24rem,calc(100vw-2rem))] space-y-2"
      aria-label="Voice memo enrichment"
      aria-live="polite"
    >
      {readError && (
        <div className="rounded-card border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 shadow-float">
          Voice enrichment status is temporarily unavailable. Saved memos are
          unaffected.
        </div>
      )}
      {visible.map((job) => {
        const running = ['queued', 'running'].includes(job.state);
        const failed = ['partial', 'failed', 'cancelled'].includes(job.state);
        const progress = voiceEnrichmentProgress(job);
        return (
          <section
            key={job.noteId}
            className="rounded-card border border-ink/15 bg-white p-4 shadow-float"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-muted">
                  {running ? (
                    <LoaderCircle
                      size={12}
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : failed ? (
                    <AlertTriangle
                      size={12}
                      className="text-amber-700"
                      aria-hidden="true"
                    />
                  ) : (
                    <CheckCircle2
                      size={12}
                      className="text-emerald-700"
                      aria-hidden="true"
                    />
                  )}
                  Voice memo · {job.contactName}
                </p>
                <p className="mt-1 text-xs text-subtle">{jobStatus(job)}</p>
              </div>
              {!running && (
                <button
                  type="button"
                  onClick={() =>
                    void dismissVoiceEnrichmentJob(uid, job.noteId)
                  }
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-card text-muted hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                  aria-label={`Dismiss voice enrichment for ${job.contactName}`}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            <div
              className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/10"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
            >
              <div
                className="h-full bg-brand transition-[width] motion-reduce:transition-none"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {running && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    activeControllers
                      .get(`${uid}:${job.noteId}`)
                      ?.abort();
                    void requestVoiceEnrichmentCancellation(uid, job.noteId);
                  }}
                >
                  Cancel
                </Button>
              )}
              {failed && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void retryVoiceEnrichmentJob(uid, job.noteId)
                  }
                >
                  <RotateCcw size={12} aria-hidden="true" />
                  Retry remaining
                </Button>
              )}
              {job.state === 'complete' && (
                <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-muted">
                  <Sparkles size={11} aria-hidden="true" />
                  Raw note saved first
                </span>
              )}
            </div>
          </section>
        );
      })}
    </aside>
  );
}
