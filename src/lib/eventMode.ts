import { doc, updateDoc, collection, getDocs, query, where, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase';
import type { CalendarEvent } from './integrations/calendar';
import {
  buildDeterministicEventRecap,
  createEventSessionIdentity,
  type DeterministicEventRecap,
  type EventContactInput,
  type EventSessionSource,
} from './eventModeCore';

export type EventRecap = DeterministicEventRecap;

/**
 * Event Mode — a window during which every contact captured via the card is
 * batch-tagged with the event name.
 *
 * The problem it solves is specific: after a conference you have eleven new
 * contacts and no memory of which room any of them was in. Tagging at capture
 * time costs nothing; reconstructing it a week later is impossible.
 *
 * Stored on the user document rather than as its own collection because
 * exactly one window can be open at a time, and it is read on nearly every
 * capture drain — a field on a document already in memory beats a query.
 */

export interface EventModeState {
  active: boolean;
  sessionId: string | null;
  eventName: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  /** 'manual' when the owner flipped it, 'calendar' when auto-suggested. */
  source: 'manual' | 'calendar' | null;
}

export const EVENT_MODE_OFF: EventModeState = {
  active: false,
  sessionId: null,
  eventName: null,
  startedAt: null,
  endedAt: null,
  source: null,
};

export function readEventMode(profile: any): EventModeState {
  const raw = profile?.eventMode;
  if (!raw) return EVENT_MODE_OFF;
  return {
    active: raw.active === true,
    sessionId: raw.sessionId || null,
    eventName: raw.eventName || null,
    startedAt: raw.startedAt?.toDate ? raw.startedAt.toDate() : raw.startedAt ? new Date(raw.startedAt) : null,
    endedAt: raw.endedAt?.toDate ? raw.endedAt.toDate() : raw.endedAt ? new Date(raw.endedAt) : null,
    source: raw.source || 'manual',
  };
}

export async function startEventMode(
  uid: string,
  eventName: string,
  source: 'manual' | 'calendar' = 'manual'
): Promise<string> {
  const cleanedName = eventName.trim().replace(/\s+/g, ' ').slice(0, 160);
  if (!cleanedName) throw new Error('An event name is required.');
  const sessionId = crypto.randomUUID();
  await updateDoc(doc(db, `users/${uid}`), {
    eventMode: {
      active: true,
      sessionId,
      eventName: cleanedName,
      startedAt: new Date(),
      endedAt: null,
      source,
    },
    updatedAt: serverTimestamp(),
  });
  return sessionId;
}

export async function stopEventMode(uid: string): Promise<void> {
  await updateDoc(doc(db, `users/${uid}`), {
    'eventMode.active': false,
    'eventMode.endedAt': new Date(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * The calendar event worth offering Event Mode for: happening now, conference-
 * shaped. Returns null rather than guessing when nothing fits — an unprompted
 * "are you at X?" for a 30-minute call would be noise.
 */
export function suggestedEvent(events: CalendarEvent[], at: Date = new Date()): CalendarEvent | null {
  return events.find((e) => e.isEventLike && e.start <= at && e.end >= at) || null;
}

/**
 * Builds the post-event recap from durable capture evidence, with legacy
 * contact fields as a compatibility fallback.
 *
 * Deliberately reads filed evidence rather than trusting a counter
 * incremented during the window — if a capture failed to drain, the recap
 * should say six when six landed, not eight because eight were attempted.
 * Evidence is separate from the profile so a repeat encounter can be included
 * without overwriting owner-curated contact fields.
 */
export async function buildEventRecap(
  uid: string,
  eventName: string,
  eventSessionId: string | null = null,
  sessionState?: Partial<EventModeState>,
): Promise<EventRecap> {
  const eventField = eventSessionId ? 'eventSessionId' : 'eventName';
  const eventValue = eventSessionId || eventName;
  const [contactSnapshot, evidenceSnapshot] = await Promise.all([
    getDocs(
      query(
        collection(db, `users/${uid}/contacts`),
        where(
          eventSessionId ? 'capturedEventSessionId' : 'capturedEventName',
          '==',
          eventValue,
        ),
      ),
    ),
    getDocs(
      query(
        collection(db, `users/${uid}/notes`),
        where(eventField, '==', eventValue),
      ),
    ),
  ]);

  const evidenceContacts = evidenceSnapshot.docs
    .map((document) => ({ id: document.id, ...document.data() }) as any)
    .filter(
      (record) =>
        record.source === 'public-card-capture' &&
        record.recordType === 'capture' &&
        typeof record.contactId === 'string' &&
        record.contactId,
    )
    .sort(
      (left, right) =>
        (left.capturedAt?.toMillis?.() || 0) -
          (right.capturedAt?.toMillis?.() || 0) ||
        String(left.id).localeCompare(String(right.id)),
    );
  const contactsById = new Map<string, EventContactInput>();
  for (const record of evidenceContacts) {
    if (contactsById.has(record.contactId)) continue;
    contactsById.set(record.contactId, {
      id: record.contactId,
      name: record.visitorName,
      company: record.visitorCompany,
      email: record.visitorEmail,
      consentToFollowUp: record.consentToFollowUp,
      capturedAt: record.capturedAt,
      captureChannel: record.captureChannel,
      captureProvenance: record.captureProvenance,
    });
  }

  for (const document of contactSnapshot.docs) {
    if (contactsById.has(document.id)) continue;
    const data = document.data() as any;
    contactsById.set(document.id, {
      id: document.id,
      name: data.name,
      company: data.company,
      email: data.email,
      consentToFollowUp: data.consentToFollowUp,
      capturedAt: data.capturedAt,
      capturedVia: data.capturedVia,
      captureChannel: data.captureChannel,
      captureProvenance: data.captureProvenance,
    });
  }
  const contacts = [...contactsById.values()];

  const safeSessionId =
    eventSessionId ||
    `legacy-${eventName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) ||
      'event'}`;
  const source: EventSessionSource =
    sessionState?.source === 'calendar' ? 'calendar' : 'manual';
  const session = createEventSessionIdentity({
    sessionId: safeSessionId,
    eventName,
    source,
    active: sessionState?.active === true,
    startedAt: sessionState?.startedAt,
    endedAt: sessionState?.endedAt,
  });

  return buildDeterministicEventRecap({
    session,
    contacts,
  });
}
