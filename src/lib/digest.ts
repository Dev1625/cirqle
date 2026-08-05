import { collection, getDocs } from 'firebase/firestore';
import { db } from '../config/firebase';
import { computeHealth, isDormant, type HealthResult } from './health';
import { emailMode } from './integrations/config';
import {
  generateGroundedText,
  groundingDisplay,
  type GroundedSource,
  type GroundingDisplay,
} from './grounding';
import { isContactAIEligible } from './contactManagementCore';

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
  whyTheyMatter: string | null;
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
    if (!isContactAIEligible(contact)) continue;
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
        whyTheyMatter: contact.whyTheyMatter || null,
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
  // Never-contacted is a genuinely different situation from "quiet for a
  // while", and it must be handled before any day count is formatted —
  // lastTouchDays is a sentinel here, not a real measurement.
  if (health.neverContacted) {
    if (whyTheyMatter) {
      return `Never actually contacted. You wrote: "${String(whyTheyMatter).slice(0, 80)}"`;
    }
    if (tier === 'Strong') {
      return 'Marked a strong tie, but there is no contact on record at all. Worth an opener.';
    }
    return 'In your network, never contacted. Worth an opener, or let it go.';
  }

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
  contactId: string;
  contactName: string;
  company: string | null;
  role: string | null;
  reason: string;
  whyTheyMatter?: string | null;
  lastTouchDays: number;
  neverContacted?: boolean;
  senderName: string;
  signal?: AbortSignal;
}): Promise<{ text: string; grounding: GroundingDisplay }> {
  const sources = revivalDraftSources(params);
  const grounded = await generateGroundedText({
    task: `Write a short ${
      params.neverContacted ? 'first-approach' : 're-engagement'
    } message of three or four sentences and at most 80 words.`,
    sources,
    rules: [
      params.neverContacted
        ? 'This is a first approach. Do not reference a past conversation, shared history, or a gap.'
        : 'Acknowledge the recorded gap once, lightly, without grovelling.',
      'Give a concrete reason for reaching out only when the saved contact record supplies one.',
      'When no reason is recorded, ask a genuine, modest question instead of inventing a pretext.',
      'Never mention an attachment, recent news, a company event, a mutual contact, or a personal milestone unless a source explicitly contains it.',
      'Do not use "hope this finds you well", "just circling back", or "touching base".',
      'Return only the message body, with no subject or signature block.',
    ],
    options: {
      tier: 'reasoning',
      maxTokens: 450,
      feature: 'dormant-revival-draft',
      signal: params.signal,
    },
  });
  const requiredSourceIds = [
    `contact-${params.contactId}`,
    `network-health-${params.contactId}`,
  ];
  if (requiredSourceIds.some((id) => !grounded.usedSourceIds.includes(id))) {
    throw new Error('The revival draft did not cite the contact and network-health records.');
  }
  return {
    text: grounded.result.trim(),
    grounding: groundingDisplay(grounded, sources),
  };
}

export function revivalDraftSources(params: {
  contactId: string;
  contactName: string;
  company: string | null;
  role: string | null;
  reason: string;
  whyTheyMatter?: string | null;
  lastTouchDays: number;
  neverContacted?: boolean;
  senderName: string;
}): GroundedSource[] {
  return [
    {
      id: `contact-${params.contactId}`,
      kind: 'contact',
      label: `Contact · ${params.contactName}`,
      text: JSON.stringify({
        name: params.contactName,
        company: params.company,
        role: params.role,
        whyTheyMatter: params.whyTheyMatter || null,
      }),
    },
    {
      id: `network-health-${params.contactId}`,
      kind: 'system',
      label: 'Deterministic network health',
      text: JSON.stringify({
        neverContacted: Boolean(params.neverContacted),
        lastTouchDays: params.neverContacted ? null : params.lastTouchDays,
        rankingReason: params.reason,
      }),
    },
    {
      id: 'sender-profile',
      kind: 'profile',
      label: 'Sender profile',
      text: JSON.stringify({ name: params.senderName }),
    },
  ];
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
