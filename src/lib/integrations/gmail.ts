import {
  doc,
  setDoc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../../config/firebase';
import { integrationsApiBase, isMock } from './config';

/**
 * Gmail, scoped to sending and to reading back only the threads Cirqle
 * itself created.
 *
 * Scope choice — gmail.send + gmail.metadata rather than gmail.readonly:
 *   - Privacy: "Cirqle only ever looks at threads it started" is a claim the
 *     scope actually enforces, not a promise in a policy document.
 *   - Verification: restricted scopes like gmail.readonly require a security
 *     assessment. gmail.metadata is sensitive but not restricted, which is a
 *     materially cheaper and faster path when the owner pursues verification.
 *
 * Token handling is a hard requirement, not a style preference: the refresh
 * token is held by the Cloud Function and never written anywhere the client
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
  threadId: string;
  mode: 'mock' | 'live';
}

/**
 * Sends outreach and immediately begins tracking the resulting thread.
 *
 * In mock mode this fabricates a Gmail-shaped thread id and records it for
 * real, so Draft Outreach visibly starts tracking the moment you hit send —
 * the payoff moment works identically in both modes.
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
  let threadId: string;
  let mode: 'mock' | 'live';

  if (isMock()) {
    // Gmail thread ids are 16 hex chars; matching the shape keeps the mock
    // honest against any code that later parses or displays them.
    threadId = Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    mode = 'mock';
  } else {
    const response = await fetch(`${integrationsApiBase()}/gmail/send`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: params.to, subject: params.subject, body: params.body }),
    });
    if (!response.ok) throw new Error(`Gmail send failed (${response.status})`);
    const payload = await response.json();
    threadId = payload.threadId;
    mode = 'live';
  }

  await trackThread({
    uid: params.uid,
    threadId,
    contactId: params.contactId,
    contactName: params.contactName,
    subject: params.subject,
    outreachId: params.outreachId,
  });

  return { threadId, mode };
}

/**
 * Per-user incremental sync cursor.
 *
 * Gmail's historyId lets a poll ask "what changed since last time" instead of
 * re-reading every tracked thread. Stored per user; the Cloud Function is the
 * only thing that advances it in live mode.
 */
export async function readSyncCursor(uid: string): Promise<string | null> {
  const snap = await getDoc(doc(db, `users/${uid}/integrations/gmail`));
  return snap.exists() ? (snap.data() as any).historyId || null : null;
}

export async function writeSyncCursor(uid: string, historyId: string): Promise<void> {
  await setDoc(
    doc(db, `users/${uid}/integrations/gmail`),
    { historyId, lastSyncedAt: serverTimestamp() },
    { merge: true }
  );
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

  const cursor = await readSyncCursor(uid);
  const response = await fetch(`${integrationsApiBase()}/gmail/poll`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ historyId: cursor, threadIds: threads.map((t) => t.threadId) }),
  });
  if (!response.ok) throw new Error(`Gmail poll failed (${response.status})`);
  const payload = await response.json();

  if (payload.historyId) await writeSyncCursor(uid, payload.historyId);

  const statusByThread: Record<string, TrackedThread['status']> = payload.statuses || {};
  for (const thread of threads) {
    const next = statusByThread[thread.threadId];
    if (next && next !== thread.status) {
      await setDoc(
        doc(db, `users/${uid}/threads/${thread.threadId}`),
        { status: next, lastCheckedAt: new Date() },
        { merge: true }
      );
    }
  }

  return listTrackedThreads(uid);
}
