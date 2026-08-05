import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  getDocs,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from 'react-router';

import { AccentRule } from '../components/ui/AccentRule';
import { Button } from '../components/ui/Button';
import { db } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';

function asDate(value: unknown): Date | null {
  if (!value) return null;
  const candidate =
    typeof (value as { toDate?: unknown }).toDate === 'function'
      ? (value as { toDate: () => Date }).toDate()
      : value instanceof Date
        ? value
        : new Date(String(value));
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

export default function OutreachCalendar() {
  const { user } = useAuth();
  const [outreaches, setOutreaches] = useState<any[]>([]);
  const [contactsMap, setContactsMap] = useState<Record<string, any>>({});
  const [currentDate, setCurrentDate] = useState(new Date());
  const [readState, setReadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [nameWarning, setNameWarning] = useState(false);

  useEffect(() => {
    if (!user) return;

    let active = true;
    const contactQuery = query(
      collection(db, `users/${user.uid}/contacts`),
      where('userId', '==', user.uid),
    );
    getDocs(contactQuery)
      .then((snapshot) => {
        if (!active) return;
        const map: Record<string, any> = {};
        snapshot.docs.forEach((contact) => {
          map[contact.id] = contact.data();
        });
        setContactsMap(map);
      })
      .catch(() => {
        if (active) setNameWarning(true);
        console.warn('[calendar] contact names temporarily unavailable');
      });

    const outreachQuery = query(
      collection(db, `users/${user.uid}/outreaches`),
      where('userId', '==', user.uid),
    );
    const unsubscribe = onSnapshot(
      outreachQuery,
      (snapshot) => {
        if (!active) return;
        const planned = snapshot.docs
          .map((outreach) => ({
            id: outreach.id,
            ...(outreach.data() as any),
          }))
          .filter((outreach) => asDate(outreach.nextFollowUpDate));
        setOutreaches(planned);
        setReadState('ready');
      },
      () => {
        if (!active) return;
        setReadState('error');
        console.warn('[calendar] follow-ups temporarily unavailable');
      },
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [user]);

  const weeks = useMemo(() => {
    const monthStart = startOfMonth(currentDate);
    const firstDay = startOfWeek(monthStart);
    const lastDay = endOfWeek(endOfMonth(monthStart));
    const result: Date[][] = [];
    let cursor = firstDay;

    while (cursor <= lastDay) {
      const week: Date[] = [];
      for (let index = 0; index < 7; index += 1) {
        week.push(cursor);
        cursor = addDays(cursor, 1);
      }
      result.push(week);
    }
    return result;
  }, [currentDate]);

  const monthLabel = format(currentDate, 'MMMM yyyy');
  const monthFollowUpCount = outreaches.filter((outreach) => {
    const date = asDate(outreach.nextFollowUpDate);
    return date ? isSameMonth(date, currentDate) : false;
  }).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-5 border-b border-ink/20 pb-6">
        <div>
          <AccentRule className="mb-4" />
          <h1 className="mb-2 font-serif text-4xl font-black italic sm:text-5xl">
            Outreach Calendar.
          </h1>
          <p className="font-mono text-xs uppercase tracking-widest text-muted">
            Pace yourself. Review upcoming planned follow-ups.
          </p>
        </div>

        <div
          className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
          aria-label="Calendar navigation"
        >
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setCurrentDate((date) => subMonths(date, 1))}
            aria-label={`Previous month, ${format(subMonths(currentDate, 1), 'MMMM yyyy')}`}
          >
            <ChevronLeft size={17} aria-hidden="true" />
          </Button>
          <p
            className="flex min-h-11 min-w-[12rem] flex-1 items-center justify-center rounded-card border border-ink/20 bg-white px-4 font-serif text-lg font-bold sm:flex-none"
            aria-live="polite"
            aria-atomic="true"
          >
            {monthLabel}
          </p>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setCurrentDate((date) => addMonths(date, 1))}
            aria-label={`Next month, ${format(addMonths(currentDate, 1), 'MMMM yyyy')}`}
          >
            <ChevronRight size={17} aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCurrentDate(new Date())}
          >
            Today
          </Button>
        </div>
      </div>

      {readState === 'loading' && (
        <p role="status" aria-live="polite" className="font-mono text-xs text-muted">
          Loading planned follow-ups…
        </p>
      )}

      {readState === 'error' && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border border-red-200 bg-red-50 p-4"
        >
          <p className="font-mono text-xs leading-relaxed text-red-800">
            Follow-ups could not be loaded. Nothing was changed; check your connection and reopen this view.
          </p>
          <Button type="button" variant="outline" onClick={() => window.location.reload()}>
            Reload calendar
          </Button>
        </div>
      )}

      {nameWarning && readState === 'ready' && (
        <p role="status" className="font-mono text-xs leading-relaxed text-muted">
          Follow-up dates loaded, but some contact names are temporarily unavailable.
        </p>
      )}

      {readState === 'ready' && monthFollowUpCount === 0 && (
        <div
          className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-dashed border-ink/25 bg-paper/55 p-4"
          role="status"
        >
          <p className="font-mono text-xs leading-relaxed text-muted">
            No follow-ups are planned for {monthLabel}. Add a follow-up from a contact record when the timing is right.
          </p>
          <Link
            to="/app/directory"
            className="inline-flex min-h-11 items-center justify-center rounded-card border border-ink/20 px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Open Directory
          </Link>
        </div>
      )}

      <p className="font-mono text-[10px] leading-relaxed text-muted sm:hidden">
        Swipe horizontally to review the full week.
      </p>

      <div
        className="overflow-x-auto rounded-card border border-ink/20 bg-white"
        tabIndex={0}
        aria-label={`${monthLabel} follow-up calendar. Scroll horizontally on narrow screens.`}
      >
        <table className="w-full min-w-[47rem] table-fixed border-collapse">
          <caption className="sr-only">
            Planned outreach follow-ups for {monthLabel}
          </caption>
          <thead className="bg-paper/70">
            <tr>
              {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
                (weekday) => (
                  <th
                    key={weekday}
                    scope="col"
                    className="border-b border-r border-ink/20 p-3 text-center font-mono text-[10px] font-bold uppercase tracking-widest last:border-r-0"
                  >
                    <span aria-hidden="true">{weekday.slice(0, 3)}</span>
                    <span className="sr-only">{weekday}</span>
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0].toISOString()}>
                {week.map((day) => {
                  const followUps = outreaches.filter((outreach) => {
                    const date = asDate(outreach.nextFollowUpDate);
                    return date ? isSameDay(date, day) : false;
                  });
                  const dateLabel = format(day, 'EEEE, MMMM d, yyyy');

                  return (
                    <td
                      key={day.toISOString()}
                      className={`h-32 border-b border-r border-ink/20 p-2 align-top last:border-r-0 ${
                        isSameMonth(day, currentDate)
                          ? 'bg-white'
                          : 'bg-paper/55 text-muted'
                      }`}
                    >
                      <time
                        dateTime={format(day, 'yyyy-MM-dd')}
                        aria-current={isToday(day) ? 'date' : undefined}
                        aria-label={dateLabel}
                        className={`mb-2 inline-flex h-7 min-w-7 items-center justify-center font-mono text-xs ${
                          isToday(day)
                            ? 'rounded-full bg-ink px-1 text-paper'
                            : ''
                        }`}
                      >
                        {format(day, 'd')}
                      </time>

                      <ul className="space-y-1">
                        {followUps.map((outreach) => {
                          const contact = contactsMap[outreach.contactId];
                          const name = contact?.name || 'Contact name unavailable';
                          return (
                            <li key={outreach.id}>
                              <Link
                                to={`/app/directory/${outreach.contactId}`}
                                aria-label={`Follow up with ${name} on ${dateLabel}`}
                                className={`flex min-h-11 items-center border px-2 py-1 font-mono text-[10px] font-bold uppercase leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                                  outreach.status === 'Pending Follow-Up'
                                    ? 'border-ink/40 bg-accent/60 hover:bg-accent'
                                    : 'border-ink/20 bg-paper hover:bg-accent/35'
                                }`}
                              >
                                <span className="line-clamp-2">{name}</span>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
