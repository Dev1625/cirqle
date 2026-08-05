import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRelationshipTimeline,
  timelineFreshness,
} from '../src/lib/relationshipTimeline';

test('relationship timeline uses the actual meeting date and preserves note provenance', () => {
  const [event] = buildRelationshipTimeline({
    notes: [{
      id: 'meeting-1',
      recordType: 'meeting',
      source: 'meeting-log',
      occurredAt: '2026-06-10T12:00:00.000Z',
      createdAt: '2026-07-01T12:00:00.000Z',
    }],
    outreaches: [],
  });
  assert.equal(event.kind, 'meeting');
  assert.equal(event.label, 'Meeting logged');
  assert.equal(event.happenedAt?.toISOString(), '2026-06-10T12:00:00.000Z');
  assert.equal(event.provenance.sourceId, 'meeting-1');
  assert.equal(event.provenance.label, 'Meeting entered by you');
});

test('capture evidence is labeled as an unverified public-card capture', () => {
  const [event] = buildRelationshipTimeline({
    notes: [{
      id: 'capture-record-1',
      recordType: 'capture',
      source: 'public-card-capture',
      observedAt: '2026-07-29T12:00:00.000Z',
      captureProvenance: {
        channel: 'nfc',
        channelEvidence: 'client-url-marker',
        channelVerified: false,
      },
    }],
    outreaches: [],
  });
  assert.equal(event.label, 'Public card capture');
  assert.match(event.provenance.label, /hardware not verified/i);
});

test('opened mail client is never mislabeled as sent', () => {
  const [event] = buildRelationshipTimeline({
    notes: [],
    outreaches: [{
      id: 'outreach-opened',
      status: 'Opened in Mail Client',
      verification: 'none',
      openedAt: '2026-07-28T12:00:00.000Z',
    }],
  });
  assert.equal(event.kind, 'mail-client-opened');
  assert.equal(event.label, 'Mail client opened');
  assert.match(event.provenance.label, /delivery not confirmed/i);
});

test('provider and user send evidence remain distinct', () => {
  const events = buildRelationshipTimeline({
    notes: [],
    outreaches: [
      {
        id: 'provider',
        verification: 'provider-verified',
        provider: 'gmail',
        threadId: 'thread-1',
        sentAt: '2026-07-20T12:00:00.000Z',
      },
      {
        id: 'user',
        verification: 'user-confirmed',
        sentAt: '2026-07-21T12:00:00.000Z',
      },
    ],
  });
  assert.equal(events[0].kind, 'user-confirmed-send');
  assert.equal(events[1].kind, 'provider-send');
  assert.equal(events[1].provenance.provider, 'gmail');
  assert.equal(events[1].provenance.threadId, 'thread-1');
});

test('reply evidence controls label and time without erasing the underlying outreach', () => {
  const events = buildRelationshipTimeline({
    notes: [],
    outreaches: [{
      id: 'outreach-1',
      verification: 'provider-verified',
      provider: 'gmail',
      sentAt: '2026-07-01T12:00:00.000Z',
      updatedAt: '2026-07-01T12:00:00.000Z',
      replyEvidence: {
        occurredAt: '2026-07-25T15:00:00.000Z',
        source: 'user',
        sourceRecordId: 'reply-note-1',
        threadId: 'thread-1',
      },
    }],
  });
  const [event, sendEvent] = events;
  assert.equal(events.length, 2);
  assert.equal(event.kind, 'reply');
  assert.equal(event.happenedAt?.toISOString(), '2026-07-25T15:00:00.000Z');
  assert.equal(event.provenance.replySourceId, 'reply-note-1');
  assert.equal(event.provenance.label, 'Reply linked by you');
  assert.equal(sendEvent.kind, 'provider-send');
});

test('a linked reply note is shown once while its original outreach remains visible', () => {
  const events = buildRelationshipTimeline({
    notes: [{
      id: 'reply-note-1',
      replyTargetOutreachId: 'outreach-1',
      createdAt: '2026-07-25T15:00:00.000Z',
      content: 'Reply saved',
    }],
    outreaches: [{
      id: 'outreach-1',
      verification: 'user-confirmed',
      sentAt: '2026-07-20T15:00:00.000Z',
      replyEvidence: {
        occurredAt: '2026-07-25T15:00:00.000Z',
        source: 'user',
        sourceRecordId: 'reply-note-1',
      },
    }],
  });
  assert.equal(events.length, 2);
  assert.equal(events.filter((event) => event.kind === 'reply').length, 1);
  assert.equal(events.find((event) => event.kind === 'reply')?.recordType, 'note');
  assert.equal(events.find((event) => event.kind === 'user-confirmed-send')?.recordType, 'outreach');
});

test('undated events sort last and freshness never invents a date', () => {
  const events = buildRelationshipTimeline({
    notes: [
      { id: 'undated', content: 'No timestamp' },
      { id: 'dated', content: 'Dated', createdAt: '2026-07-20T12:00:00.000Z' },
    ],
    outreaches: [],
  });
  assert.equal(events[0].provenance.sourceId, 'dated');
  assert.equal(events[1].provenance.sourceId, 'undated');
  assert.equal(events[1].happenedAt, null);
  assert.equal(timelineFreshness(null), 'Date unavailable');
  assert.equal(
    timelineFreshness(
      new Date('2026-07-28T23:00:00.000Z'),
      new Date('2026-07-29T12:00:00.000Z'),
    ),
    'Yesterday',
  );
});
