import { doc, updateDoc, collection, getDocs, query, where, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase';
import type { CalendarEvent } from './integrations/calendar';

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
  eventName: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  /** 'manual' when the owner flipped it, 'calendar' when auto-suggested. */
  source: 'manual' | 'calendar' | null;
}

export const EVENT_MODE_OFF: EventModeState = {
  active: false,
  eventName: null,
  startedAt: null,
  endedAt: null,
  source: null,
};

export function readEventMode(profile: any): EventModeState {
  const raw = profile?.eventMode;
  if (!raw || !raw.active) return EVENT_MODE_OFF;
  return {
    active: true,
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
): Promise<void> {
  await updateDoc(doc(db, `users/${uid}`), {
    eventMode: {
      active: true,
      eventName,
      startedAt: new Date(),
      endedAt: null,
      source,
    },
    updatedAt: serverTimestamp(),
  });
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

export interface EventRecap {
  eventName: string;
  contactCount: number;
  suggestedFollowUps: number;
  contacts: { id: string; name: string; company: string | null }[];
  headline: string;
}

/**
 * Builds the post-event recap from contacts actually tagged with the event.
 *
 * Deliberately reads back from the contacts rather than trusting a counter
 * incremented during the window — if a capture failed to drain, the recap
 * should say six when six landed, not eight because eight were attempted.
 */
export async function buildEventRecap(uid: string, eventName: string): Promise<EventRecap> {
  const snap = await getDocs(
    query(collection(db, `users/${uid}/contacts`), where('capturedEventName', '==', eventName))
  );

  const contacts = snap.docs.map((d) => {
    const data = d.data() as any;
    return { id: d.id, name: data.name || 'Unknown', company: data.company || null };
  });

  // "Worth a follow-up" at this stage means we know enough to write one:
  // a company gives an opener, a bare name does not.
  const suggestedFollowUps = contacts.filter((c) => c.company).length;

  const headline =
    contacts.length === 0
      ? `No captures at ${eventName} yet.`
      : `Your ${eventName} recap: ${contacts.length} new contact${contacts.length === 1 ? '' : 's'}, ${suggestedFollowUps} suggested follow-up${suggestedFollowUps === 1 ? '' : 's'}.`;

  return { eventName, contactCount: contacts.length, suggestedFollowUps, contacts, headline };
}
