import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../config/firebase';
import { generateText } from './ai';
import { listCommitments, type Commitment } from './commitments';
import { computeHealth, type HealthResult } from './health';

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
  health: HealthResult;
}

export async function loadBriefContext(uid: string, contactId: string, contact: any): Promise<BriefContext> {
  const [notesSnap, outreachSnap, commitments] = await Promise.all([
    getDocs(query(collection(db, `users/${uid}/notes`), where('contactId', '==', contactId))),
    getDocs(query(collection(db, `users/${uid}/outreaches`), where('contactId', '==', contactId))),
    listCommitments(uid, { contactId, status: 'open' }),
  ]);

  const notes = notesSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const outreaches = outreachSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

  return {
    contact,
    notes,
    outreaches,
    commitments,
    health: computeHealth({ contact, notes, outreaches }),
  };
}

function describeDate(value: any): string {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'unknown date';
  return date.toLocaleDateString();
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
        lastOutreach.aiSummary ? ` — ${lastOutreach.aiSummary}` : ''
      }`
    );
  }

  const lastNote = notes[notes.length - 1];
  if (lastNote?.content) lines.push(`Last note: ${String(lastNote.content).slice(0, 200)}`);

  if (commitments.length > 0) {
    const owed = commitments.filter((c) => c.owedBy === 'you');
    if (owed.length > 0) lines.push(`You owe them: ${owed.map((c) => c.text).join('; ')}`);
    const theirs = commitments.filter((c) => c.owedBy === 'them');
    if (theirs.length > 0) lines.push(`They owe you: ${theirs.map((c) => c.text).join('; ')}`);
  }

  lines.push(`Relationship health: ${health.summary}`);

  return lines.join('\n');
}

export async function generateBrief(context: BriefContext, meetingTitle: string): Promise<string> {
  const { contact, notes, outreaches, commitments, health } = context;

  const notesText = notes
    .slice(-5)
    .map((n) => `- ${describeDate(n.createdAt)}: ${String(n.content || n.text || '').slice(0, 400)}`)
    .join('\n');

  const outreachText = outreaches
    .slice(-5)
    .map(
      (o) =>
        `- ${describeDate(o.sentAt)} via ${o.channel || o.type || 'unknown'}, status ${o.status || 'unknown'}${
          o.aiSummary ? `: ${o.aiSummary}` : ''
        }`
    )
    .join('\n');

  const commitmentText =
    commitments.length > 0
      ? commitments.map((c) => `- ${c.owedBy === 'you' ? 'You owe' : 'They owe'}: ${c.text}${c.dueHint ? ` (${c.dueHint})` : ''}`).join('\n')
      : '(none tracked)';

  const prompt = `You are briefing someone who is about to walk into "${meetingTitle}" with ${contact.name}. They have about thirty seconds to read this.

What we know:
- Name: ${contact.name}
- Role: ${contact.role || 'unknown'} at ${contact.company || 'unknown'}
- Relationship tier: ${contact.relationshipTier || 'unknown'}
- Why they matter (written by the user): ${contact.whyTheyMatter || '(not recorded)'}
- Relationship health: ${health.summary}

Recent notes:
${notesText || '(none)'}

Recent outreach:
${outreachText || '(none)'}

Open commitments:
${commitmentText}

Write the brief as 3-4 short bullet points, each one line, starting with "- ".
Rules:
- Lead with whatever is most likely to be raised in the first two minutes.
- If there is an unfulfilled commitment from the user, say so first and plainly.
- Reference specifics from the notes. Do not invent facts that are not above.
- Dry and useful. No pep talk, no "be sure to build rapport", no restating their job title back.
- If the record is genuinely thin, say that in one bullet rather than padding.`;

  return generateText(prompt, { model: 'reasoning', timeoutMs: 25000 });
}
