import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, ChevronRight, Mic, UserPlus } from 'lucide-react';
import { Button } from '../ui/Button';
import { AILabel, AISurface } from '../ui/AISurface';
import { EmptyState } from '../ui/EmptyState';
import { PreviewBadge } from '../ui/PreviewBadge';
import { LastSynced } from '../ui/LastSynced';
import { Avatar } from '../ui/Avatar';
import {
  justEndedMeetings,
  upcomingMeetings,
  type CalendarEvent,
} from '../../lib/integrations/calendar';
import { composeFallbackBrief, generateBrief, loadBriefContext } from '../../lib/briefing';
import { isMock } from '../../lib/integrations/config';

/**
 * "Today's meetings" — the natural home for the pre-meeting brief, because
 * it is the one place the user is already looking before a meeting.
 *
 * Also surfaces the post-meeting voice-memo prompt for anything that just
 * ended, since that is the moment the memory is still fresh and the prompt is
 * worth the interruption.
 */

function timeLabel(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function whenLabel(event: CalendarEvent): string {
  const today = new Date();
  const sameDay = event.start.toDateString() === today.toDateString();
  return sameDay ? timeLabel(event.start) : `${event.start.toLocaleDateString([], { weekday: 'short' })} ${timeLabel(event.start)}`;
}

export function TodaysMeetings({
  uid,
  events,
  contacts,
  syncedAt,
  state,
  error,
  onRefresh,
  onRecordMemo,
}: {
  uid: string;
  events: CalendarEvent[];
  contacts: any[];
  syncedAt: Date | null;
  state: 'loading' | 'error' | 'ready';
  error: string | null;
  onRefresh: () => void;
  onRecordMemo: (event: CalendarEvent) => void;
}) {
  const meetings = useMemo(() => upcomingMeetings(events).slice(0, 4), [events]);
  const justEnded = useMemo(() => justEndedMeetings(events).slice(0, 1), [events]);

  return (
    <section className="rounded-card border border-ink/25 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/15 px-6 py-4">
        <div className="flex items-center gap-2">
          <CalendarClock size={15} className="text-brand" />
          <h2 className="font-serif text-xl font-bold italic">Next up.</h2>
          {isMock() && <PreviewBadge />}
        </div>
        <div className="flex items-center gap-3">
          <LastSynced at={syncedAt} />
          <button
            onClick={onRefresh}
            className="font-mono text-[10px] uppercase tracking-widest text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="p-6">
        <AISurface
          state={state === 'ready' ? (meetings.length === 0 && justEnded.length === 0 ? 'empty' : 'ready') : state}
          error={error}
          onRetry={onRefresh}
          loadingLine="Checking your calendar…"
          emptyIcon={CalendarClock}
          emptyLine="Nothing on the calendar with anyone in your network. Briefs show up here when there is."
          emptyAction={
            <Link to="/app/settings">
              <Button variant="outline" size="sm">Connect a calendar</Button>
            </Link>
          }
        >
          <div className="space-y-3">
            {justEnded.map((event) => (
              <JustEndedRow key={event.id} event={event} onRecordMemo={onRecordMemo} />
            ))}
            {meetings.map((event, index) => (
              <MeetingRow
                key={event.id}
                uid={uid}
                event={event}
                contacts={contacts}
                index={index}
              />
            ))}
          </div>
        </AISurface>
      </div>
    </section>
  );
}

function JustEndedRow({
  event,
  onRecordMemo,
}: {
  event: CalendarEvent;
  onRecordMemo: (event: CalendarEvent) => void;
}) {
  return (
    <div className="animate-fade-slide-up flex flex-wrap items-center justify-between gap-3 rounded-card border border-ink/15 bg-paper/60 px-4 py-3">
      <div className="min-w-0">
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
          Just ended
        </span>
        <p className="mt-1 truncate font-mono text-xs">{event.title}</p>
      </div>
      <Button variant="brand" size="sm" onClick={() => onRecordMemo(event)}>
        <Mic size={11} className="mr-1.5" />
        Log it while it's fresh
      </Button>
    </div>
  );
}

function MeetingRow({
  uid,
  event,
  contacts,
  index,
}: {
  uid: string;
  event: CalendarEvent;
  contacts: any[];
  index: number;
}) {
  const [open, setOpen] = useState(index === 0);
  const [brief, setBrief] = useState<string | null>(null);
  const [briefState, setBriefState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const [briefError, setBriefError] = useState<string | null>(null);

  const contact = useMemo(
    () => contacts.find((c) => c.id === event.contactId) || null,
    [contacts, event.contactId]
  );

  const runBrief = useCallback(async () => {
    if (!contact) return;
    setBriefState('loading');
    setBriefError(null);
    try {
      const context = await loadBriefContext(uid, contact.id, contact);
      const text = await generateBrief(context, event.title);
      setBrief(text);
      setBriefState('ready');
    } catch (err: any) {
      setBriefError(err?.message || 'Could not write the brief.');
      setBriefState('error');
    }
  }, [uid, contact, event.title]);

  const useFallback = async () => {
    if (!contact) return;
    const context = await loadBriefContext(uid, contact.id, contact);
    setBrief(composeFallbackBrief(context));
    setBriefState('ready');
  };

  useEffect(() => {
    if (open && briefState === 'idle' && contact) runBrief();
  }, [open, briefState, contact, runBrief]);

  return (
    <div
      className="animate-fade-slide-up rounded-card border border-ink/15"
      style={{ animationDelay: `${Math.min(index * 35, 140)}ms` }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-paper/50"
        aria-expanded={open}
      >
        <Avatar name={event.contactName || event.title} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs font-bold">{event.title}</span>
          <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
            {whenLabel(event)}
            {event.location ? ` · ${event.location}` : ''}
          </span>
        </span>
        <ChevronRight
          size={14}
          className={`shrink-0 text-muted transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
      </button>

      {open && (
        <div className="animate-fade-in border-t border-ink/15 px-4 py-4">
          {!contact ? (
            <EmptyState
              icon={UserPlus}
              line={`${event.attendees[0] || 'This attendee'} isn't in your Directory yet, so there's nothing to brief from.`}
              action={
                <Link to="/app/directory">
                  <Button variant="outline" size="sm">Add them</Button>
                </Link>
              }
            />
          ) : (
            <>
              <AILabel className="mb-2.5">Before you walk in</AILabel>
              <AISurface
                state={briefState === 'idle' ? 'loading' : briefState}
                error={briefError}
                onRetry={runBrief}
                loadingLine="Reading the file on them…"
                emptyLine="Nothing on record for them yet."
              >
                <div className="space-y-1.5">
                  {(brief || '')
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line, i) => (
                      <p key={i} className="font-mono text-xs leading-relaxed text-subtle">
                        {line.replace(/^[-•]\s*/, '— ')}
                      </p>
                    ))}
                </div>
              </AISurface>

              {briefState === 'error' && (
                <Button variant="ghost" size="sm" className="mt-3" onClick={useFallback}>
                  Show what we know anyway
                </Button>
              )}

              {briefState === 'ready' && (
                <Link
                  to={`/app/directory/${contact.id}`}
                  className="mt-3 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted underline-offset-4 transition-colors hover:text-brand hover:underline"
                >
                  Open full record
                  <ChevronRight size={11} />
                </Link>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
