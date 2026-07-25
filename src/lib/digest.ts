import { collection, getDocs } from 'firebase/firestore';
import { db } from '../config/firebase';
import { generateText } from './ai';
import { computeHealth, isDormant, type HealthResult } from './health';
import { emailMode } from './integrations/config';

/**
 * Dormant-contact digest — "worth reviving this week".
 *
 * The content generation and the in-app surface are fully real: they need no
 * external dependency and are not mocked. Only *email delivery* is scaffolded,
 * because that needs a transactional provider credential the owner has not
 * supplied. The in-app surface is deliberately not blocked on it.
 */

export interface DigestItem {
  contactId: string;
  name: string;
  company: string | null;
  role: string | null;
  health: HealthResult;
  /** Why this one, in the user's language rather than the scorer's. */
  reason: string;
}

export interface Digest {
  items: DigestItem[];
  generatedAt: Date;
  /** Total dormant, which may exceed the number shown. */
  dormantCount: number;
}

/**
 * Ranks dormant contacts by what is worth reviving, not just by who is
 * stalest.
 *
 * A Strong tie you have not spoken to in 90 days is a much better use of
 * attention than a Cold contact you emailed once and never heard back from —
 * so tier weight pushes up and a total absence of prior response pushes down.
 * Sorting purely by days-since would surface exactly the contacts least
 * likely to reply.
 */
export async function buildDigest(uid: string, limit = 5): Promise<Digest> {
  const [contactsSnap, notesSnap, outreachSnap] = await Promise.all([
    getDocs(collection(db, `users/${uid}/contacts`)),
    getDocs(collection(db, `users/${uid}/notes`)),
    getDocs(collection(db, `users/${uid}/outreaches`)),
  ]);

  const contacts = contactsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

  const notesByContact: Record<string, any[]> = {};
  notesSnap.docs.forEach((d) => {
    const data = d.data() as any;
    const key = data.contactId || '';
    (notesByContact[key] ||= []).push(data);
  });

  const outreachByContact: Record<string, any[]> = {};
  outreachSnap.docs.forEach((d) => {
    const data = d.data() as any;
    const key = data.contactId || '';
    (outreachByContact[key] ||= []).push(data);
  });

  const dormant: { item: DigestItem; weight: number }[] = [];

  for (const contact of contacts) {
    const notes = notesByContact[contact.id] || [];
    const outreaches = outreachByContact[contact.id] || [];
    const health = computeHealth({ contact, notes, outreaches });

    if (!isDormant(health)) continue;

    const tier = contact.relationshipTier || 'Cold';
    const tierWeight = tier === 'Strong' ? 3 : tier === 'Warm' ? 2.2 : tier === 'Dormant' ? 1.4 : 1;
    const everReplied = outreaches.some((o) => String(o.responseReceived).toLowerCase() === 'yes');
    const replyWeight = everReplied ? 1.6 : 0.7;
    // Staleness matters, but with diminishing returns — 400 days and 200 days
    // are not meaningfully different decisions.
    const staleWeight = Math.log10(Math.min(health.lastTouchDays, 400) + 10);

    dormant.push({
      weight: tierWeight * replyWeight * staleWeight,
      item: {
        contactId: contact.id,
        name: contact.name || 'Unknown',
        company: contact.company || null,
        role: contact.role || null,
        health,
        reason: buildReason(tier, health, everReplied, contact.whyTheyMatter),
      },
    });
  }

  dormant.sort((a, b) => b.weight - a.weight);

  return {
    items: dormant.slice(0, limit).map((entry) => entry.item),
    generatedAt: new Date(),
    dormantCount: dormant.length,
  };
}

function buildReason(
  tier: string,
  health: HealthResult,
  everReplied: boolean,
  whyTheyMatter?: string | null
): string {
  if (whyTheyMatter) {
    return `${health.lastTouchDays} days quiet. You wrote: "${String(whyTheyMatter).slice(0, 80)}"`;
  }
  if (tier === 'Strong') {
    return `A strong tie gone quiet for ${health.lastTouchDays} days. Those are the expensive ones to lose.`;
  }
  if (everReplied) {
    return `They replied before — ${health.lastTouchDays} days ago. Warm enough to restart.`;
  }
  return `${health.lastTouchDays} days with no contact. Worth one more try, or let it go.`;
}

/** One-tap AI-drafted opener for a specific dormant contact. */
export async function draftRevivalNote(params: {
  contactName: string;
  company: string | null;
  role: string | null;
  reason: string;
  whyTheyMatter?: string | null;
  lastTouchDays: number;
  senderName: string;
}): Promise<string> {
  const prompt = `Write a short re-engagement message to ${params.contactName}${
    params.role ? `, ${params.role}` : ''
  }${params.company ? ` at ${params.company}` : ''}.

Context:
- It has been about ${params.lastTouchDays} days since last contact.
- Why they matter to the sender: ${params.whyTheyMatter || '(not recorded)'}
- Sender's name: ${params.senderName}

Rules:
- 3-4 sentences, maximum 80 words.
- Acknowledge the gap once, lightly, without apologising twice or grovelling.
- Give one concrete reason for reaching out now. If you have nothing specific, ask a genuine question rather than inventing a pretext.
- No "hope this finds you well", no "just circling back", no "touching base".
- Sound like a person who has been busy, not like a CRM.

Return only the message body. No subject line, no signature block.`;

  return generateText(prompt, { model: 'reasoning' });
}

/**
 * Email delivery of the digest.
 *
 * Scaffolded behind the same mock/live gate as the OAuth integrations. In
 * mock mode this resolves without sending anything and the caller says so
 * plainly in the UI — it does not pretend an email went out.
 *
 * Going live needs a transactional provider (Postmark, Resend, SendGrid) and
 * a verified sending domain; steps are in MANUAL_SETUP.md.
 */
export async function sendDigestEmail(params: {
  to: string;
  digest: Digest;
  senderName: string;
}): Promise<{ delivered: boolean; mode: 'mock' | 'live' }> {
  if (emailMode() === 'mock') {
    return { delivered: false, mode: 'mock' };
  }

  const response = await fetch('/api/digest/send', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: params.to,
      subject: `Worth reviving this week — ${params.digest.items.length} from your network`,
      items: params.digest.items.map((item) => ({
        name: item.name,
        company: item.company,
        reason: item.reason,
        score: item.health.score,
      })),
    }),
  });

  if (!response.ok) throw new Error(`Digest send failed (${response.status})`);
  return { delivered: true, mode: 'live' };
}
