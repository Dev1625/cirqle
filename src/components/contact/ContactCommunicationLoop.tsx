import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { GitBranch, ShieldCheck } from 'lucide-react';

import { db } from '../../config/firebase';
import {
  buildCommunicationGraph,
  analyzeWordingOutcomes,
  summarizeCommunicationGraph,
  type CommunicationStage,
} from '../../lib/moat/communicationGraph';

const STAGE_LABELS: Record<CommunicationStage, string> = {
  draft: 'Drafted',
  opened: 'Opened mail client',
  'sent-confirmed': 'Sent · confirmed by you',
  'sent-provider': 'Sent · provider verified',
  delivered: 'Delivered · provider verified',
  replied: 'Reply linked',
  meeting: 'Meeting recorded',
  commitment: 'Commitment confirmed',
  outcome: 'Relationship outcome',
};

function iso(value: any): string {
  const date =
    typeof value?.toDate === 'function'
      ? value.toDate()
      : value instanceof Date
        ? value
        : value
          ? new Date(value)
          : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

export function ContactCommunicationLoop({
  uid,
  contactId,
  notes,
  outreaches,
}: {
  uid: string;
  contactId: string;
  notes: any[];
  outreaches: any[];
}) {
  const [commitments, setCommitments] = useState<any[]>([]);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    setLoadError(false);
    return onSnapshot(
      query(
        collection(db, `users/${uid}/commitments`),
        where('contactId', '==', contactId),
      ),
      (snapshot) =>
        setCommitments(
          snapshot.docs.map((document) => ({
            id: document.id,
            ...document.data(),
          })),
        ),
      () => setLoadError(true),
    );
  }, [uid, contactId]);

  const graph = useMemo(
    () =>
      buildCommunicationGraph({
        outreaches: outreaches.map((outreach) => ({
          id: outreach.id,
          contactId,
          channel: 'email',
          status: outreach.status || null,
          verification: outreach.verification || null,
          createdAt: iso(outreach.createdAt),
          draftedAt: iso(outreach.draftedAt),
          openedAt: iso(outreach.openedAt),
          sentAt: iso(outreach.sentAt),
          provider: outreach.provider || null,
          threadId: outreach.threadId || null,
          providerMessageId: outreach.providerMessageId || null,
          deliveryEvidence: outreach.deliveryEvidence
            ? {
                ...outreach.deliveryEvidence,
                occurredAt: iso(outreach.deliveryEvidence.occurredAt),
              }
            : null,
          replyEvidence: outreach.replyEvidence
            ? {
                ...outreach.replyEvidence,
                occurredAt: iso(outreach.replyEvidence.occurredAt),
              }
            : null,
          responseReceived: outreach.responseReceived || null,
          subject: outreach.subject || null,
          body: outreach.body || null,
        })),
        meetings: notes
          .filter((note) => note.recordType === 'meeting')
          .map((meeting) => ({
            id: meeting.id,
            contactId,
            occurredAt: iso(meeting.occurredAt || meeting.createdAt),
            source: meeting.providerEventId ? 'calendar' : 'user',
            outreachId: meeting.outreachId || null,
            threadId: meeting.threadId || null,
            provider: meeting.provider || null,
            providerEventId: meeting.providerEventId || null,
          })),
        commitments: commitments.map((commitment) => ({
          id: commitment.id,
          contactId,
          occurredAt: iso(commitment.createdAt),
          sourceRecordId: commitment.sourceId || commitment.id,
          outreachId: commitment.outreachId || null,
          meetingId: commitment.meetingId || null,
          reality: commitment.feedback?.reality || 'unreviewed',
        })),
        outcomes: commitments
          .filter((commitment) =>
            ['improved', 'unchanged', 'worsened'].includes(
              commitment.feedback?.relationshipOutcome,
            ),
          )
          .map((commitment) => ({
            id: `${commitment.id}-relationship-outcome`,
            contactId,
            occurredAt: iso(
              commitment.feedback?.lastEventAt ||
                commitment.feedbackUpdatedAt ||
                commitment.updatedAt,
            ),
            outcome: commitment.feedback.relationshipOutcome,
            commitmentId: commitment.id,
            meetingId: commitment.meetingId || null,
            outreachId: commitment.outreachId || null,
          })),
      }),
    [contactId, commitments, notes, outreaches],
  );
  const summary = useMemo(() => summarizeCommunicationGraph(graph), [graph]);
  const wording = useMemo(
    () =>
      analyzeWordingOutcomes(
        outreaches.map((outreach) => ({
          ...outreach,
          id: outreach.id,
          contactId,
          createdAt: iso(outreach.createdAt),
          draftedAt: iso(outreach.draftedAt),
          openedAt: iso(outreach.openedAt),
          sentAt: iso(outreach.sentAt),
        })),
        graph,
      ),
    [contactId, graph, outreaches],
  );
  const events = [...graph.events].reverse();

  return (
    <section
      className="rounded-card border border-ink/15 bg-white p-4"
      aria-labelledby="contact-loop-title"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2
            id="contact-loop-title"
            className="flex items-center gap-2 font-serif text-lg font-bold italic"
          >
            <GitBranch size={15} className="text-brand" aria-hidden="true" />
            Communication loop
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-subtle">
            Only linked, timestamped evidence advances this relationship.
          </p>
        </div>
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
          {events.length} proven
        </span>
      </div>

      {loadError ? (
        <p role="alert" className="mt-3 text-xs text-red-700">
          Commitment evidence could not be loaded. Reload before relying on
          this loop.
        </p>
      ) : events.length === 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          No evidence-backed chain yet. Drafts and user-entered notes remain
          visible elsewhere without being mistaken for delivery or replies.
        </p>
      ) : (
        <ol className="mt-4 space-y-3 border-l border-ink/15 pl-4">
          {events.slice(0, 9).map((event) => (
            <li key={event.id} className="relative">
              <span
                className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brand"
                aria-hidden="true"
              />
              <p className="text-xs font-bold">{STAGE_LABELS[event.stage]}</p>
              <p className="mt-0.5 font-mono text-[9px] uppercase tracking-widest text-subtle">
                {new Date(event.occurredAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
                {' · '}
                {event.provenance.verification.replace('-', ' ')}
              </p>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-ink/10 pt-3 text-center">
        <div>
          <p className="font-serif text-lg font-black">
            {summary.stageCounts.replied}
          </p>
          <p className="font-mono text-[8px] uppercase tracking-widest text-muted">
            Replies
          </p>
        </div>
        <div>
          <p className="font-serif text-lg font-black">
            {summary.stageCounts.meeting}
          </p>
          <p className="font-mono text-[8px] uppercase tracking-widest text-muted">
            Meetings
          </p>
        </div>
        <div>
          <p className="font-serif text-lg font-black">
            {summary.stageCounts.outcome}
          </p>
          <p className="font-mono text-[8px] uppercase tracking-widest text-muted">
            Outcomes
          </p>
        </div>
      </div>

      <div className="mt-4 border-t border-ink/10 pt-3">
        <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-muted">
          Private wording learning
        </p>
        <p className="mt-1 text-xs leading-relaxed text-subtle">
          {wording.recommendation ||
            `Cirqle will show a personal pattern after at least ${wording.minimumSampleSize} evidenced sends share one wording signal.`}
        </p>
        <p className="mt-1 font-mono text-[9px] leading-relaxed text-muted">
          {wording.privacyNote}
        </p>
      </div>

      {graph.issues.length > 0 && (
        <details className="mt-3 border-t border-ink/10 pt-3">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-mono text-[9px] font-bold uppercase tracking-widest text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
            <ShieldCheck size={12} aria-hidden="true" />
            {graph.issues.length} unproven or unlinked record
            {graph.issues.length === 1 ? '' : 's'}
          </summary>
          <ul className="space-y-1 pb-2 text-[11px] leading-relaxed text-subtle">
            {graph.issues.slice(0, 6).map((issue) => (
              <li key={`${issue.recordType}-${issue.recordId}-${issue.code}`}>
                {issue.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
