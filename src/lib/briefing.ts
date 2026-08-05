import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../config/firebase';
import { listCommitments, type Commitment } from './commitments';
import { computeHealth, type HealthResult } from './health';
import {
  generateGroundedText,
  groundingDisplay,
  type GroundedSource,
  type GroundingDisplay,
} from './grounding';
import { isContactAIEligible } from './contactManagementCore';
import { listContactFacts } from './factLedger';
import {
  factsToGroundedSources,
  type TemporalFact,
} from './factLedgerCore';

/**
 * Pre-meeting briefing.
 *
 * The narrow, real problem: you are walking into a coffee at 3pm with someone
 * you last spoke to in March, and everything you need is in the app but
 * spread across four screens. The brief is worth having only if it arrives
 * *before* the meeting and fits on a phone screen — length is a feature.
 */

export interface BriefContext {
  contact: any;
  notes: any[];
  outreaches: any[];
  commitments: Commitment[];
  facts: TemporalFact[];
  health: HealthResult;
}

export async function loadBriefContext(uid: string, contactId: string, contact: any): Promise<BriefContext> {
  const [notesSnap, outreachSnap, commitments, facts] = await Promise.all([
    getDocs(query(collection(db, `users/${uid}/notes`), where('contactId', '==', contactId))),
    getDocs(query(collection(db, `users/${uid}/outreaches`), where('contactId', '==', contactId))),
    listCommitments(uid, { contactId, status: 'open' }),
    listContactFacts(uid, contactId),
  ]);

  const notes = notesSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const outreaches = outreachSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

  return {
    contact,
    notes,
    outreaches,
    commitments,
    facts,
    health: computeHealth({ contact, notes, outreaches }),
  };
}

function describeDate(value: any): string {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'unknown date';
  return date.toLocaleDateString();
}

function dateIso(value: any): string | null {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  return !date || Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function recordTime(value: any): number {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  return !date || Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function noteMayEnterBriefing(note: any): boolean {
  return (
    note?.sensitive !== true &&
    note?.aiAllowed !== false &&
    typeof note?.content === 'string' &&
    note.content.trim().length > 0
  );
}

export function buildBriefSources(
  context: BriefContext,
  meetingTitle: string
): GroundedSource[] {
  const { contact, notes, outreaches, commitments, facts, health } = context;
  if (!isContactAIEligible(contact)) return [];
  const contactId = contact.id || 'meeting-contact';
  const sources: GroundedSource[] = [
    {
      id: `contact-${contactId}`,
      kind: 'contact',
      label: `Contact · ${contact.name || 'Unnamed'}`,
      text: JSON.stringify({
        name: contact.name || null,
        role: contact.role || null,
        company: contact.company || null,
        relationshipTier: contact.relationshipTier || null,
        whyTheyMatter: contact.whyTheyMatter || null,
      }),
    },
    {
      id: 'meeting-title',
      kind: 'meeting',
      label: 'Upcoming calendar event',
      text: JSON.stringify({ title: meetingTitle }),
    },
    {
      id: `network-health-${contactId}`,
      kind: 'system',
      label: 'Deterministic network health',
      text: JSON.stringify({
        score: health.score,
        trend: health.trend,
        summary: health.summary,
        lastTouchDays: health.neverContacted ? null : health.lastTouchDays,
        neverContacted: health.neverContacted,
      }),
    },
  ];
  sources.push(...factsToGroundedSources(contactId, facts));

  [...notes]
    .filter(noteMayEnterBriefing)
    .sort((a, b) => recordTime(b.createdAt) - recordTime(a.createdAt))
    .slice(0, 5)
    .forEach((note) => {
      if (!note.id) return;
      sources.push({
        id: `note-${note.id}`,
        kind: 'note',
        label: `Note · ${describeDate(note.createdAt)}`,
        observedAt: dateIso(note.createdAt),
        text: note.content.trim().slice(0, 1_200),
      });
    });

  [...outreaches]
    .sort(
      (a, b) =>
        recordTime(b.sentAt || b.createdAt) - recordTime(a.sentAt || a.createdAt)
    )
    .slice(0, 5)
    .forEach((outreach) => {
      if (!outreach.id) return;
      sources.push({
        id: `outreach-${outreach.id}`,
        kind: outreach.responseReceived === 'Yes' ? 'reply' : 'outreach',
        label: `Outreach · ${describeDate(outreach.sentAt || outreach.createdAt)}`,
        observedAt: dateIso(outreach.sentAt || outreach.createdAt),
        text: JSON.stringify({
          channel: outreach.channel || outreach.type || null,
          subject: outreach.subject || null,
          body: outreach.body ? String(outreach.body).slice(0, 1_200) : null,
          trackerStatus: outreach.status || null,
          nextAction: outreach.nextAction || null,
          responseReceived: outreach.responseReceived || null,
          responseSnippet: outreach.responseSnippet || null,
          deliveryVerification: outreach.deliveryVerification || null,
        }),
      });
    });

  commitments.slice(0, 6).forEach((commitment) => {
    sources.push({
      id: `commitment-${commitment.id}`,
      kind: 'commitment',
      label: `Open commitment · ${commitment.contactName}`,
      text: JSON.stringify({
        text: commitment.text,
        dueHint: commitment.dueHint,
        owedBy: commitment.owedBy,
        status: commitment.status,
      }),
    });
  });

  return sources;
}

/**
 * Composes the brief without the model.
 *
 * Not a silent fallback — the caller offers it explicitly when the gateway is
 * unreachable. It is genuinely useful on its own: the facts are all local,
 * and only the prose is missing.
 */
export function composeFallbackBrief(context: BriefContext): string {
  const lines: string[] = [];
  const { contact, notes, outreaches, commitments, health } = context;

  if (contact.whyTheyMatter) lines.push(`Why they matter: ${contact.whyTheyMatter}`);

  const lastOutreach = [...outreaches].sort(
    (a, b) => (b.sentAt?.toDate?.()?.getTime() || 0) - (a.sentAt?.toDate?.()?.getTime() || 0)
  )[0];
  if (lastOutreach) {
    lines.push(
      `Last touch: ${lastOutreach.channel || lastOutreach.type || 'outreach'} on ${describeDate(lastOutreach.sentAt)}${
        lastOutreach.subject ? ` — ${String(lastOutreach.subject).slice(0, 120)}` : ''
      }`
    );
  }

  const lastNote = [...notes]
    .filter(noteMayEnterBriefing)
    .sort((a, b) => recordTime(b.createdAt) - recordTime(a.createdAt))[0];
  if (lastNote) {
    lines.push(`Last note: ${lastNote.content.trim().slice(0, 200)}`);
  }

  if (commitments.length > 0) {
    const owed = commitments.filter((c) => c.owedBy === 'you');
    if (owed.length > 0) lines.push(`You owe them: ${owed.map((c) => c.text).join('; ')}`);
    const theirs = commitments.filter((c) => c.owedBy === 'them');
    if (theirs.length > 0) lines.push(`They owe you: ${theirs.map((c) => c.text).join('; ')}`);
  }

  lines.push(`Relationship health: ${health.summary}`);

  return lines.join('\n');
}

export async function generateBrief(
  context: BriefContext,
  meetingTitle: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ text: string; grounding: GroundingDisplay }> {
  const sources = buildBriefSources(context, meetingTitle);
  if (sources.length === 0) {
    throw new Error(
      'This contact is archived or excluded from AI in their privacy settings.',
    );
  }
  const grounded = await generateGroundedText({
    task: 'Write a pre-meeting brief that takes about thirty seconds to read: three or four short one-line bullets.',
    sources,
    rules: [
      'Lead with an open commitment owed by the user when one is explicitly recorded.',
      'Prioritize concrete details likely to matter in the upcoming meeting; do not predict what someone will raise.',
      'Treat a tracker status as a workflow label, not proof of sending, delivery, opening, or a reply.',
      'Do not treat an older AI summary as evidence; only the raw source records in this packet count.',
      'Use dry, useful wording with no pep talk or generic rapport advice.',
      'If the record is thin, say so in one bullet instead of padding.',
    ],
    options: {
      tier: 'reasoning',
      timeoutMs: 25_000,
      maxTokens: 700,
      feature: 'pre-meeting-brief',
      signal: options.signal,
    },
  });
  const requiredSourceIds = [`contact-${context.contact.id || 'meeting-contact'}`];
  context.commitments
    .filter((commitment) => commitment.owedBy === 'you')
    .forEach((commitment) => requiredSourceIds.push(`commitment-${commitment.id}`));
  if (requiredSourceIds.some((id) => !grounded.usedSourceIds.includes(id))) {
    throw new Error('The meeting brief did not cite its required contact or commitment records.');
  }
  return {
    text: grounded.result.trim(),
    grounding: groundingDisplay(grounded, sources),
  };
}
