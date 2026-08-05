import {
  doc,
  setDoc,
  getDocs,
  collection,
  query,
  where,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../../config/firebase';
import { integrationsApiBase, isMock } from './config';
import { authenticatedFetch } from '../authenticatedFetch';

/**
 * Gmail, scoped to sending and to reading back only the threads Cirqle
 * itself created.
 *
 * Scope choice — gmail.send + gmail.metadata rather than gmail.readonly:
 *   - Privacy: Gmail's metadata scope is mailbox-wide, so the server keeps an
 *     Admin-only registry of thread IDs returned by successful Cirqle sends.
 *     Poll requests are rejected unless every ID is present in that registry.
 *   - Verification: restricted scopes like gmail.readonly require a security
 *     assessment. gmail.metadata is sensitive but not restricted, which is a
 *     materially cheaper and faster path when the owner pursues verification.
 *
 * Token handling is a hard requirement, not a style preference: the refresh
 * token is held by the server API and never written anywhere the client
 * can read. Everything below either runs against mock data or calls the
 * function; nothing here ever sees a Google credential.
 *
 * Polling, not push. Gmail watch() needs a Pub/Sub topic and renewal every
 * 7 days, and buys nothing until the app is past testing-mode limits.
 */

export interface TrackedThread {
  id: string;
  threadId: string;
  contactId: string;
  contactName: string;
  subject: string;
  sentAt: Date;
  /** Where the thread is, as of the last poll. */
  status: 'sent' | 'delivered' | 'replied';
  lastCheckedAt: Date | null;
  mode: 'mock' | 'live';
}

function toDate(value: any): Date {
  if (value?.toDate) return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Records the outreach → Gmail thread → contact mapping.
 *
 * Keyed by threadId so a repeated poll is idempotent, and stored under the
 * user so the existing owner-only Firestore rules already cover it.
 */
export async function trackThread(params: {
  uid: string;
  threadId: string;
  contactId: string;
  contactName: string;
  subject: string;
  outreachId?: string | null;
}): Promise<void> {
  await setDoc(
    doc(db, `users/${params.uid}/threads/${params.threadId}`),
    {
      threadId: params.threadId,
      contactId: params.contactId,
      contactName: params.contactName,
      subject: params.subject,
      outreachId: params.outreachId || null,
      status: 'sent',
      sentAt: new Date(),
      lastCheckedAt: new Date(),
      mode: isMock() ? 'mock' : 'live',
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function listTrackedThreads(uid: string, contactId?: string): Promise<TrackedThread[]> {
  const base = collection(db, `users/${uid}/threads`);
  const snap = await getDocs(contactId ? query(base, where('contactId', '==', contactId)) : base);
  return snap.docs
    .map((d) => {
      const data = d.data() as any;
      return {
        id: d.id,
        threadId: data.threadId,
        contactId: data.contactId,
        contactName: data.contactName || '',
        subject: data.subject || '(no subject)',
        sentAt: toDate(data.sentAt),
        status: (data.status || 'sent') as TrackedThread['status'],
        lastCheckedAt: data.lastCheckedAt ? toDate(data.lastCheckedAt) : null,
        mode: (data.mode === 'live' ? 'live' : 'mock') as TrackedThread['mode'],
      };
    })
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
}

export interface SendResult {
  threadId: string | null;
  mode: 'mock' | 'live';
  verified: boolean;
}

/**
 * Sends through a connected provider and begins tracking only after the
 * provider returns a real message/thread id.
 *
 * Preview mode deliberately does not fabricate a successful send or thread.
 * The caller may open a mailto draft and record an unverified handoff.
 */
export async function sendOutreach(params: {
  uid: string;
  contactId: string;
  contactName: string;
  to: string;
  subject: string;
  body: string;
  outreachId?: string | null;
}): Promise<SendResult> {
  if (isMock()) {
    return { threadId: null, mode: 'mock', verified: false };
  }
  if (!params.outreachId) {
    throw new Error('A saved outreach attempt is required before Gmail send.');
  }

  const response = await authenticatedFetch(`${integrationsApiBase()}/gmail/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: params.to,
      subject: params.subject,
      body: params.body,
      idempotencyKey: params.outreachId,
    }),
  });
  if (!response.ok) throw new Error(`Gmail send failed (${response.status})`);
  const payload = await response.json();
  const threadId = payload.threadId;
  if (
    typeof threadId !== 'string' ||
    !threadId ||
    payload.recorded !== true
  ) {
    throw new Error('Gmail send did not return an atomically recorded receipt.');
  }

  return { threadId, mode: 'live', verified: true };
}

/**
 * Polls tracked threads for replies.
 *
 * The mock advances a thread's state on a plausible clock rather than at
 * random — delivered after a few minutes, some replied after a few hours — so
 * the tracking UI has something to actually show during a demo instead of
 * sitting on "sent" forever.
 */
export async function pollThreads(uid: string): Promise<TrackedThread[]> {
  const threads = await listTrackedThreads(uid);

  if (isMock()) {
    const now = Date.now();
    const updated: TrackedThread[] = [];
    for (const thread of threads) {
      const ageMinutes = (now - thread.sentAt.getTime()) / 60000;
      let status: TrackedThread['status'] = 'sent';
      if (ageMinutes > 180) {
        // Deterministic per thread, so a thread does not flip between polls.
        const hash = thread.threadId.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 0);
        status = hash % 3 === 0 ? 'replied' : 'delivered';
      } else if (ageMinutes > 5) {
        status = 'delivered';
      }

      if (status !== thread.status) {
        await setDoc(
          doc(db, `users/${uid}/threads/${thread.threadId}`),
          { status, lastCheckedAt: new Date() },
          { merge: true }
        );
      }
      updated.push({ ...thread, status, lastCheckedAt: new Date() });
    }
    return updated;
  }

  const response = await authenticatedFetch(`${integrationsApiBase()}/gmail/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadIds: threads.map((t) => t.threadId) }),
  });
  if (!response.ok) throw new Error(`Gmail poll failed (${response.status})`);
  await response.json();
  return listTrackedThreads(uid);
}
