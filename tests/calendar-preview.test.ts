import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMockEvents,
  upcomingMeetings,
} from '../src/lib/integrations/calendar.ts';

const contacts = [
  { id: 'maya', name: 'Maya Chen', email: 'maya@example.com' },
  { id: 'jon', name: 'Jon Bell', email: 'jon@example.com' },
  { id: 'priya', name: 'Priya Rao', email: 'priya@example.com' },
];

function contactMeetings(at: Date) {
  return buildMockEvents('calendar-test-user', contacts, at)
    .filter((event) => !event.isEventLike);
}

test('all mock contact meetings stay in the future after 20:00', () => {
  const at = new Date(2026, 6, 28, 20, 45, 0, 0);
  const meetings = contactMeetings(at);

  assert.ok(meetings.length >= 2);
  assert.ok(meetings.every((meeting) => meeting.start > at));
  assert.deepEqual(upcomingMeetings(buildMockEvents('calendar-test-user', contacts, at), 24 * 60, at), meetings);
});

test('the first meeting rolls into tomorrow when its lead time crosses midnight', () => {
  const at = new Date(2026, 6, 28, 23, 30, 0, 0);
  const first = contactMeetings(at)[0];

  assert.ok(first.start > at);
  assert.equal(first.start.getFullYear(), 2026);
  assert.equal(first.start.getMonth(), 6);
  assert.equal(first.start.getDate(), 29);
});

test('late-day fixed-hour draws roll forward instead of becoming just-ended meetings', () => {
  const at = new Date(2026, 6, 28, 22, 15, 0, 0);
  const meetings = contactMeetings(at);

  assert.ok(meetings.every((meeting) => meeting.start > at));
  assert.ok(meetings.every((meeting) => meeting.end > at));
});

test('generation is deterministic for an injected reference time', () => {
  const at = new Date(2026, 6, 28, 21, 5, 0, 0);
  const first = buildMockEvents('calendar-test-user', contacts, at);
  const second = buildMockEvents('calendar-test-user', contacts, new Date(at));

  assert.deepEqual(second, first);
});

test('the caller reference date is never mutated', () => {
  const at = new Date(2026, 6, 28, 23, 50, 12, 345);
  const original = at.getTime();

  buildMockEvents('calendar-test-user', contacts, at);

  assert.equal(at.getTime(), original);
});

test('empty contact directories still produce only the current conference fixture', () => {
  const at = new Date(2026, 6, 28, 23, 0, 0, 0);
  const events = buildMockEvents('calendar-test-user', [], at);

  assert.equal(events.length, 1);
  assert.equal(events[0].isEventLike, true);
  assert.ok(events[0].start < at);
  assert.ok(events[0].end > at);
});
