import { integrationsApiBase, isMock } from './config';

/**
 * Google Calendar, read-only.
 *
 * Live architecture is scheduled polling, not push. Watch channels need a
 * public HTTPS webhook, renewal bookkeeping and replay handling, and they buy
 * nothing until the integration is past testing-mode token limits. Polling
 * upcoming events every few minutes is correct for this stage; the seam for
 * swapping it is fetchUpcomingEvents() and nothing above it needs to change.
 *
 * Mock mode synthesises events from the owner's *real* contacts, which is what
 * makes pre-meeting briefing and Event Mode genuinely demoable — a brief about
 * "Sarah Chen" is only interesting if Sarah Chen is actually in the Directory
 * with notes and outreach history attached.
 */

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location: string | null;
  /** Attendee emails/names as Calendar reports them. */
  attendees: string[];
  /** Resolved Cirqle contact id, when an attendee matched one. */
  contactId?: string | null;
  contactName?: string | null;
  /** True when this looks like a multi-hour conference rather than a meeting. */
  isEventLike: boolean;
}

export interface CalendarSyncState {
  events: CalendarEvent[];
  syncedAt: Date;
  mode: 'mock' | 'live';
}

/** Deterministic PRNG so mock events are stable across reloads within a day. */
function seededRandom(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return () => {
    hash = (hash * 1664525 + 1013904223) >>> 0;
    return hash / 4294967296;
  };
}

function atTime(base: Date, dayOffset: number, hour: number, minute = 0): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const MOCK_LOCATIONS = [
  'Blue Bottle, 315 Linden St',
  'Zoom',
  'Google Meet',
  'Their office — 55 Hudson Yards',
  'Sightglass Coffee, SoMa',
];

const MOCK_TITLES = [
  (name: string) => `Coffee with ${name}`,
  (name: string) => `${name} <> intro call`,
  (name: string) => `Catch-up: ${name}`,
  (name: string) => `${name} — portfolio chat`,
];

/**
 * A conference-shaped event, so Event Mode has something to auto-suggest
 * against. Deliberately long and location-bearing — that shape is exactly
 * what distinguishes "I am at an event, batch-tag my captures" from "I have a
 * 30-minute call".
 */
const MOCK_CONFERENCE = {
  title: 'SaaStr Annual 2026',
  location: 'San Mateo County Event Center',
};

export function buildMockEvents(
  seedKey: string,
  contacts: { id: string; name?: string | null; email?: string | null }[]
): CalendarEvent[] {
  const random = seededRandom(seedKey + new Date().toDateString());
  const now = new Date();
  const events: CalendarEvent[] = [];

  const named = contacts.filter((c) => (c.name || '').trim().length > 0);

  // Two to three contact meetings across today and tomorrow.
  const pickCount = Math.min(named.length, 2 + Math.floor(random() * 2));
  const used = new Set<number>();

  for (let i = 0; i < pickCount; i++) {
    let index = Math.floor(random() * named.length);
    let guard = 0;
    while (used.has(index) && guard++ < named.length) {
      index = (index + 1) % named.length;
    }
    used.add(index);

    const contact = named[index];
    const name = contact.name as string;
    const dayOffset = i === 0 ? 0 : Math.floor(random() * 2);
    // First meeting is always still ahead of now today, so the Dashboard
    // "today's meetings" card is never empty on a fresh demo.
    const hour = i === 0
      ? Math.min(now.getHours() + 1 + Math.floor(random() * 2), 20)
      : 9 + Math.floor(random() * 8);

    const start = atTime(now, dayOffset, hour, random() > 0.5 ? 30 : 0);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    events.push({
      id: `mock-evt-${contact.id}-${i}`,
      title: MOCK_TITLES[Math.floor(random() * MOCK_TITLES.length)](name),
      start,
      end,
      location: MOCK_LOCATIONS[Math.floor(random() * MOCK_LOCATIONS.length)],
      attendees: [contact.email || `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`],
      contactId: contact.id,
      contactName: name,
      isEventLike: false,
    });
  }

  // One conference-shaped event, for Event Mode auto-suggestion.
  //
  // Deliberately anchored around *now* rather than a fixed 09:00–18:00. A
  // hardcoded working-day window means anyone opening the app in the evening
  // sees no suggestion at all, and Event Mode's auto-detect — one of the more
  // convincing things to demo — silently looks broken. The whole point of the
  // mock is to be demoable at any hour, so the window straddles the current
  // time and only the *displayed* hours vary.
  const confStart = new Date(now.getTime() - 3 * 3600 * 1000);
  const confEnd = new Date(now.getTime() + 5 * 3600 * 1000);
  events.push({
    id: 'mock-evt-conference',
    title: MOCK_CONFERENCE.title,
    start: confStart,
    end: confEnd,
    location: MOCK_CONFERENCE.location,
    attendees: [],
    contactId: null,
    contactName: null,
    isEventLike: true,
  });

  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Heuristic used by both modes: a multi-hour event with a physical location
 * and few or no individual attendees is a conference, not a meeting.
 */
export function looksLikeEvent(title: string, start: Date, end: Date, attendees: string[]): boolean {
  const hours = (end.getTime() - start.getTime()) / 3600000;
  if (hours < 3) return false;
  if (attendees.length > 6) return false;
  return /summit|conference|annual|expo|demo day|meetup|forum|festival|hackathon/i.test(title) || hours >= 5;
}

export async function fetchUpcomingEvents(params: {
  uid: string;
  contacts: { id: string; name?: string | null; email?: string | null }[];
}): Promise<CalendarSyncState> {
  if (isMock()) {
    return {
      events: buildMockEvents(params.uid, params.contacts),
      syncedAt: new Date(),
      mode: 'mock',
    };
  }

  // Live: the Cloud Function holds the refresh token and calls Google. The
  // browser never sees a Google credential.
  const response = await fetch(`${integrationsApiBase()}/calendar/upcoming`, {
    method: 'GET',
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`Calendar sync failed (${response.status})`);
  }
  const payload = await response.json();
  const events: CalendarEvent[] = (payload.events || []).map((raw: any) => {
    const start = new Date(raw.start);
    const end = new Date(raw.end);
    const attendees: string[] = raw.attendees || [];
    return {
      id: raw.id,
      title: raw.title || '(no title)',
      start,
      end,
      location: raw.location || null,
      attendees,
      contactId: raw.contactId ?? null,
      contactName: raw.contactName ?? null,
      isEventLike: looksLikeEvent(raw.title || '', start, end, attendees),
    };
  });

  return { events, syncedAt: new Date(payload.syncedAt || Date.now()), mode: 'live' };
}

/** The event most likely to be "where you are right now". */
export function currentEvent(events: CalendarEvent[], at: Date = new Date()): CalendarEvent | null {
  const live = events.filter((e) => e.start <= at && e.end >= at);
  if (live.length === 0) return null;
  return live.find((e) => e.isEventLike) || live[0];
}

/** Meetings starting within the given window, soonest first. */
export function upcomingMeetings(events: CalendarEvent[], withinMinutes = 24 * 60, at: Date = new Date()): CalendarEvent[] {
  const cutoff = new Date(at.getTime() + withinMinutes * 60000);
  return events
    .filter((e) => !e.isEventLike && e.start >= at && e.start <= cutoff)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Meetings that ended recently — the trigger for the voice-memo prompt. */
export function justEndedMeetings(events: CalendarEvent[], withinMinutes = 180, at: Date = new Date()): CalendarEvent[] {
  const floor = new Date(at.getTime() - withinMinutes * 60000);
  return events
    .filter((e) => !e.isEventLike && e.end <= at && e.end >= floor && e.contactId)
    .sort((a, b) => b.end.getTime() - a.end.getTime());
}
