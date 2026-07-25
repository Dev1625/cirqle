import { useCallback, useEffect, useState } from 'react';
import { collection, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from '../config/firebase';
import { fetchUpcomingEvents, type CalendarEvent } from '../lib/integrations/calendar';
import { integrationMode } from '../lib/integrations/config';

/**
 * Loads the owner's profile, contacts, and upcoming calendar events together.
 *
 * They travel as a unit because mock mode synthesises events *from* the
 * contacts — a brief about a stranger is useless, so the mock only ever
 * schedules meetings with people who are really in the Directory, with real
 * notes and outreach history behind them.
 */
export interface CalendarData {
  profile: any | null;
  contacts: any[];
  events: CalendarEvent[];
  syncedAt: Date | null;
  mode: 'mock' | 'live';
  state: 'loading' | 'error' | 'ready';
  error: string | null;
  refresh: () => void;
}

export function useCalendarEvents(uid: string | undefined): CalendarData {
  const [profile, setProfile] = useState<any | null>(null);
  const [contacts, setContacts] = useState<any[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;

    (async () => {
      setState('loading');
      setError(null);
      try {
        const [profileSnap, contactsSnap] = await Promise.all([
          getDoc(doc(db, `users/${uid}`)),
          getDocs(collection(db, `users/${uid}/contacts`)),
        ]);
        if (cancelled) return;

        const loadedProfile = profileSnap.exists() ? profileSnap.data() : null;
        const loadedContacts = contactsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

        setProfile(loadedProfile);
        setContacts(loadedContacts);

        const sync = await fetchUpcomingEvents({ uid, contacts: loadedContacts });
        if (cancelled) return;

        setEvents(sync.events);
        setSyncedAt(sync.syncedAt);
        setState('ready');
      } catch (err: any) {
        if (cancelled) return;
        setError(err?.message || 'Could not reach the calendar.');
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uid, nonce]);

  return {
    profile,
    contacts,
    events,
    syncedAt,
    mode: integrationMode(),
    state,
    error,
    refresh,
  };
}
