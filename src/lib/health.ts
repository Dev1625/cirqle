import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase';

/**
 * Relationship health — explainable, and pinnable.
 *
 * AUDIT NOTE (this feature overlaps work the owner has in progress):
 * scoring already existed before this pass, inside src/pages/NetworkGraph.tsx
 * (`buildAnalysis`). That version is graph-local: computed at render, never
 * persisted, used only for node radius and signal colour, and it has no
 * explanation and no way to stop the decay. The weights below are carried
 * over from it deliberately so a contact does not read as 72 on one screen
 * and 58 on another.
 *
 * What is added here: the *why* ("72 and falling — last contact 47 days ago"
 * rather than a bare number), and pinning, so a genuinely quarterly
 * relationship stops being nagged about.
 *
 * What is deliberately NOT done: NetworkGraph has not been refactored to call
 * this. It is heavily modified on the concurrent polish branch, and rewriting
 * it here would produce a large merge conflict for no user-visible gain. The
 * two should be unified once that branch lands — flagged in the report.
 *
 * This is a first pass, not a mature system.
 */

export type Trend = 'rising' | 'steady' | 'falling' | 'pinned';

export interface HealthReason {
  /** Signed contribution, for ordering by what actually moved the number. */
  delta: number;
  label: string;
}

export interface HealthResult {
  score: number;
  trend: Trend;
  pinned: boolean;
  lastTouchDays: number;
  reasons: HealthReason[];
  /** One dry sentence, ready to render. */
  summary: string;
}

const NEVER = 999;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value?.toDate) return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysSince(date: Date | null): number {
  if (!date) return NEVER;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

export function lastTouchDate(params: {
  contact: any;
  notes?: any[];
  outreaches?: any[];
}): Date | null {
  const candidates = [
    toDate(params.contact?.lastContactedAt),
    toDate(params.contact?.capturedAt),
    ...(params.notes || []).map((n) => toDate(n.createdAt)),
    ...(params.outreaches || []).map((o) => toDate(o.sentAt) || toDate(o.updatedAt)),
  ].filter(Boolean) as Date[];

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.getTime() - a.getTime())[0];
}

export function computeHealth(params: {
  contact: any;
  notes?: any[];
  outreaches?: any[];
}): HealthResult {
  const { contact } = params;
  const notes = params.notes || [];
  const outreaches = params.outreaches || [];

  const pinned = Boolean(contact?.healthPinned);
  const tier = contact?.relationshipTier || 'Cold';

  const responseCount = outreaches.filter((o) => String(o.responseReceived).toLowerCase() === 'yes').length;
  const meetingCount = outreaches.filter((o) => o.meetingHeld).length;
  const referralCount = outreaches.filter((o) => o.referralGenerated).length;
  const interactionCount = notes.length + outreaches.length;

  const touch = lastTouchDate({ contact, notes, outreaches });
  const lastTouchDays = daysSince(touch);

  const tierPoints = tier === 'Strong' ? 34 : tier === 'Warm' ? 25 : tier === 'Dormant' ? 10 : 16;
  const decay = lastTouchDays > 120 ? -18 : lastTouchDays > 60 ? -9 : 0;

  const reasons: HealthReason[] = [];
  reasons.push({ delta: tierPoints, label: `${tier} tier` });
  if (interactionCount > 0) {
    reasons.push({
      delta: interactionCount * 4.5,
      label: `${interactionCount} interaction${interactionCount === 1 ? '' : 's'} logged`,
    });
  }
  if (responseCount > 0) reasons.push({ delta: responseCount * 4, label: `${responseCount} replied` });
  if (meetingCount > 0) reasons.push({ delta: meetingCount * 5, label: `${meetingCount} met in person` });
  if (referralCount > 0) reasons.push({ delta: referralCount * 8, label: `${referralCount} referral${referralCount === 1 ? '' : 's'}` });
  if (decay < 0) {
    reasons.push({
      delta: decay,
      label: lastTouchDays >= NEVER ? 'never contacted' : `${lastTouchDays} days since last contact`,
    });
  }

  const raw =
    18 +
    tierPoints +
    interactionCount * 4.5 +
    responseCount * 4 +
    meetingCount * 5 +
    referralCount * 8 +
    decay;

  const score = Math.round(clamp(raw, 10, 100));

  let trend: Trend;
  if (pinned) trend = 'pinned';
  else if (decay < 0) trend = 'falling';
  else if (lastTouchDays <= 14 && interactionCount > 1) trend = 'rising';
  else trend = 'steady';

  reasons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    score,
    trend,
    pinned,
    lastTouchDays,
    reasons,
    summary: buildSummary(score, trend, lastTouchDays),
  };
}

/**
 * The explanation the owner actually asked for: a number plus the single
 * fact that most explains it. Dry, not encouraging — this is a diagnostic,
 * not a fitness app.
 */
export function buildSummary(score: number, trend: Trend, lastTouchDays: number): string {
  if (trend === 'pinned') {
    return `${score} and held. Pinned, so it won't decay.`;
  }
  if (lastTouchDays >= NEVER) {
    return `${score} — no contact on record yet.`;
  }
  if (trend === 'falling') {
    return `${score} and falling — last contact ${lastTouchDays} day${lastTouchDays === 1 ? '' : 's'} ago.`;
  }
  if (trend === 'rising') {
    return `${score} and rising — last contact ${lastTouchDays === 0 ? 'today' : `${lastTouchDays} day${lastTouchDays === 1 ? '' : 's'} ago`}.`;
  }
  return `${score} and steady — last contact ${lastTouchDays === 0 ? 'today' : `${lastTouchDays} day${lastTouchDays === 1 ? '' : 's'} ago`}.`;
}

/**
 * Pinning freezes the decay term for relationships that are genuinely
 * low-frequency by design — a mentor you see quarterly is not "going cold",
 * and a score that insists otherwise is just wrong.
 */
export async function setPinned(uid: string, contactId: string, pinned: boolean): Promise<void> {
  await updateDoc(doc(db, `users/${uid}/contacts/${contactId}`), {
    healthPinned: pinned,
    healthPinnedAt: pinned ? new Date() : null,
    updatedAt: serverTimestamp(),
  });
}

/** Dormant = decaying, not pinned, and not touched in a good while. */
export function isDormant(health: HealthResult, thresholdDays = 60): boolean {
  if (health.pinned) return false;
  return health.lastTouchDays >= thresholdDays;
}
