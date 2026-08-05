export type RelationshipTimelineKind =
  | 'meeting'
  | 'reply'
  | 'sensitive-note'
  | 'note'
  | 'provider-send'
  | 'user-confirmed-send'
  | 'mail-client-opened'
  | 'follow-up'
  | 'draft'
  | 'legacy-outreach'
  | 'outreach';

export interface RelationshipTimelineProvenance {
  label: string;
  sourceId: string;
  provider: string | null;
  threadId: string | null;
  replySourceId: string | null;
}

export interface RelationshipTimelineEvent<T = Record<string, unknown>> {
  id: string;
  kind: RelationshipTimelineKind;
  label: string;
  happenedAt: Date | null;
  dueAt: Date | null;
  provenance: RelationshipTimelineProvenance;
  record: T;
  recordType: 'note' | 'outreach';
}

export function timelineDate(value: unknown): Date | null {
  const candidate =
    typeof (value as { toDate?: unknown })?.toDate === 'function'
      ? (value as { toDate: () => Date }).toDate()
      : value instanceof Date
        ? value
        : value
          ? new Date(value as string | number)
          : null;
  return candidate && !Number.isNaN(candidate.getTime()) ? candidate : null;
}

export function timelineFreshness(
  value: Date | null,
  now: Date = new Date(),
): string {
  if (!value) return 'Date unavailable';
  const day = 86_400_000;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
  ).getTime();
  const days = Math.round((start - target) / day);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1) return `${days} days ago`;
  if (days === -1) return 'Tomorrow';
  return `In ${Math.abs(days)} days`;
}

function noteKind(note: Record<string, any>): {
  kind: RelationshipTimelineKind;
  label: string;
  provenanceLabel: string;
} {
  if (
    note.recordType === 'capture' ||
    note.source === 'public-card-capture'
  ) {
    return {
      kind: 'note',
      label: 'Public card capture',
      provenanceLabel:
        note.captureProvenance?.channelEvidence === 'client-url-marker'
          ? 'Recorded from an issued card URL marker; hardware not verified'
          : 'Recorded from the public card; hardware not verified',
    };
  }
  if (note.recordType === 'meeting' || note.source === 'meeting-log') {
    return {
      kind: 'meeting',
      label: 'Meeting logged',
      provenanceLabel: note.providerEventId
        ? 'Calendar-linked meeting record'
        : 'Meeting entered by you',
    };
  }
  if (note.replyTargetOutreachId || note.replyTargetThreadId) {
    return {
      kind: 'reply',
      label: 'Reply note',
      provenanceLabel: 'Reply pasted and linked by you',
    };
  }
  if (note.sensitive === true || note.source === 'sensitive-note') {
    return {
      kind: 'sensitive-note',
      label: 'Encrypted private note',
      provenanceLabel: 'Encrypted and entered by you',
    };
  }
  if (note.source === 'quick-note') {
    return {
      kind: 'note',
      label: 'Quick note',
      provenanceLabel: 'Entered by you',
    };
  }
  if (note.aiFeature) {
    return {
      kind: 'note',
      label: 'AI-assisted note',
      provenanceLabel: 'Saved from an AI-assisted workflow',
    };
  }
  return {
    kind: 'note',
    label: 'Relationship note',
    provenanceLabel: note.source
      ? `Recorded source: ${String(note.source)}`
      : 'Source not recorded',
  };
}

function outreachKind(outreach: Record<string, any>): {
  kind: RelationshipTimelineKind;
  label: string;
  provenanceLabel: string;
} {
  if (outreach.verification === 'provider-verified') {
    return {
      kind: 'provider-send',
      label: 'Provider-verified send',
      provenanceLabel: `Verified by ${outreach.provider || 'connected provider'}`,
    };
  }
  if (outreach.verification === 'user-confirmed') {
    return {
      kind: 'user-confirmed-send',
      label: 'User-confirmed send',
      provenanceLabel: 'Confirmed sent by you',
    };
  }
  if (outreach.status === 'Opened in Mail Client' || outreach.openedAt) {
    return {
      kind: 'mail-client-opened',
      label: 'Mail client opened',
      provenanceLabel: 'Local mail-client handoff; delivery not confirmed',
    };
  }
  if (outreach.status === 'Pending Follow-Up') {
    return {
      kind: 'follow-up',
      label: 'Follow-up scheduled',
      provenanceLabel: 'Scheduled in Cirqle',
    };
  }
  if (
    outreach.status === 'Drafted' ||
    outreach.verification === 'none' ||
    (!outreach.sentAt && !outreach.verification)
  ) {
    return {
      kind: 'draft',
      label: 'Outreach draft',
      provenanceLabel: 'Draft saved in Cirqle; delivery not confirmed',
    };
  }
  if (outreach.status === 'Sent' && !outreach.verification) {
    return {
      kind: 'legacy-outreach',
      label: 'Legacy sent record',
      provenanceLabel: 'Legacy record; verification source unknown',
    };
  }
  return {
    kind: 'outreach',
    label: 'Outreach activity',
    provenanceLabel: 'Workflow record; delivery proof not available',
  };
}

function outreachHappenedAt(outreach: Record<string, any>): Date | null {
  if (outreach.verification === 'provider-verified') {
    return (
      timelineDate(outreach.providerVerifiedAt) ||
      timelineDate(outreach.sentAt) ||
      timelineDate(outreach.updatedAt)
    );
  }
  if (outreach.verification === 'user-confirmed') {
    return (
      timelineDate(outreach.userConfirmedAt) ||
      timelineDate(outreach.sentAt) ||
      timelineDate(outreach.updatedAt)
    );
  }
  if (outreach.status === 'Opened in Mail Client' || outreach.openedAt) {
    return timelineDate(outreach.openedAt) || timelineDate(outreach.updatedAt);
  }
  return (
    timelineDate(outreach.createdAt) ||
    timelineDate(outreach.updatedAt) ||
    timelineDate(outreach.sentAt)
  );
}

export function buildRelationshipTimeline(params: {
  notes: Array<Record<string, any>>;
  outreaches: Array<Record<string, any>>;
}): RelationshipTimelineEvent[] {
  const noteIds = new Set(params.notes.map((note) => String(note.id)));
  const noteEvents: RelationshipTimelineEvent[] = params.notes.map((note) => {
    const presentation = noteKind(note);
    const happenedAt =
      presentation.kind === 'meeting'
        ? timelineDate(note.occurredAt) ||
          timelineDate(note.meetingAt) ||
          timelineDate(note.observedAt) ||
          timelineDate(note.createdAt)
        : timelineDate(note.observedAt) || timelineDate(note.createdAt);
    return {
      id: `note:${String(note.id)}`,
      kind: presentation.kind,
      label: presentation.label,
      happenedAt,
      dueAt: null,
      provenance: {
        label: presentation.provenanceLabel,
        sourceId: String(note.id),
        provider: note.provider || null,
        threadId: note.replyTargetThreadId || note.threadId || null,
        replySourceId: null,
      },
      record: note,
      recordType: 'note',
    };
  });

  const outreachEvents: RelationshipTimelineEvent[] = params.outreaches.flatMap(
    (outreach) => {
      const presentation = outreachKind(outreach);
      const baseEvent: RelationshipTimelineEvent = {
        id: `outreach:${String(outreach.id)}`,
        kind: presentation.kind,
        label: presentation.label,
        happenedAt: outreachHappenedAt(outreach),
        dueAt: timelineDate(outreach.nextFollowUpDate),
        provenance: {
          label: presentation.provenanceLabel,
          sourceId: String(outreach.id),
          provider: outreach.provider || null,
          threadId: outreach.threadId || null,
          replySourceId: null,
        },
        record: outreach,
        recordType: 'outreach',
      };
      const replyEvidence = outreach.replyEvidence;
      if (
        !replyEvidence ||
        (replyEvidence.sourceRecordId &&
          noteIds.has(String(replyEvidence.sourceRecordId)))
      ) {
        return [baseEvent];
      }
      const replySource = replyEvidence.source;
      const replyEvent: RelationshipTimelineEvent = {
        id: `outreach:${String(outreach.id)}:reply`,
        kind: 'reply',
        label: 'Reply linked to outreach',
        happenedAt:
          timelineDate(replyEvidence.occurredAt) ||
          timelineDate(outreach.dateOfResponse) ||
          timelineDate(outreach.updatedAt),
        dueAt: null,
        provenance: {
          label:
            replySource === 'provider'
              ? `Reply verified by ${replyEvidence.provider || outreach.provider || 'provider'}`
              : replySource === 'user'
                ? 'Reply linked by you'
                : 'Reply evidence source unknown',
          sourceId: String(outreach.id),
          provider: replyEvidence.provider || outreach.provider || null,
          threadId: replyEvidence.threadId || outreach.threadId || null,
          replySourceId: replyEvidence.sourceRecordId || null,
        },
        record: outreach,
        recordType: 'outreach',
      };
      return [baseEvent, replyEvent];
    },
  );

  return [...noteEvents, ...outreachEvents].sort((left, right) => {
    const leftTime = left.happenedAt?.getTime() || 0;
    const rightTime = right.happenedAt?.getTime() || 0;
    return rightTime - leftTime || left.id.localeCompare(right.id);
  });
}
