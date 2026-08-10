import { ContactIngestError } from './contact-ingest.js';

/**
 * Agent-written notes, meeting logs, and outreach records.
 *
 * Everything here is additive. There is deliberately no delete, archive, or
 * merge path: an agent that misreads a thread should at worst add something the
 * owner can retire, never remove something they wrote.
 *
 * Notes and meeting logs declare `privacySourceType: 'agent'` so the owner can
 * retire everything an AI added in one action. Outreach records cannot — their
 * field list is closed and has no slot for it — so they are filed under the
 * existing `outreach` category. See the note on logAgentOutreach.
 */

const NOTE_SCHEMA_VERSION = 2;
const AGENT_PRIVACY_SOURCE_TYPE = 'agent';
const MAX_NOTE_CONTENT = 20_000;
const MAX_MEETING_CONTENT = 70_000;
const MAX_SUBJECT = 500;
const MAX_BODY = 20_000;

function ingestError(code, message, status = 400) {
  return new ContactIngestError({ code, message, status });
}

function cleanMultiline(value, limit) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .join('\n')
    .trim()
    .slice(0, limit);
}

function cleanLine(value, limit) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

function safeContactId(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 300 || id.includes('/') || id === '.' || id === '..') {
    throw ingestError('invalid_contact', 'A valid contactId is required.');
  }
  return id;
}

function parseOccurredAt(value, now) {
  if (value == null || value === '') return now;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw ingestError(
      'invalid_date',
      'Use an ISO date such as 2026-08-10 or 2026-08-10T14:30:00Z.',
    );
  }
  // A thread can only describe something that already happened. Accepting a
  // future date would let a misread "let's meet next Tuesday" become a meeting
  // the owner never had.
  if (parsed.getTime() > now.getTime() + 60_000) {
    throw ingestError(
      'date_in_future',
      'That date is in the future. Log what has already happened.',
    );
  }
  return parsed;
}

async function assertContactWritable(db, uid, contactId) {
  const snapshot = await db.doc(`users/${uid}/contacts/${contactId}`).get();
  if (!snapshot.exists) {
    throw ingestError('contact_not_found', 'No contact with that id.', 404);
  }
  const data = snapshot.data() || {};
  if (
    data.lifecycleStatus === 'deleted' ||
    data.mergedIntoContactId ||
    data.purgeFence
  ) {
    throw ingestError(
      'contact_not_writable',
      'That contact is archived, merged, or being removed.',
      409,
    );
  }
  return data;
}

function noteBase({ uid, contactId, noteId, content, observedAt, now }) {
  return {
    noteSchemaVersion: NOTE_SCHEMA_VERSION,
    userId: uid,
    contactId,
    // The note's own id: isValidNoteBase requires sourceId == noteId, which is
    // why per-import revocation is not expressible for notes and why the
    // privacySourceType below carries the agent label instead.
    sourceId: noteId,
    privacySourceType: AGENT_PRIVACY_SOURCE_TYPE,
    content,
    sensitive: false,
    aiAllowed: true,
    observedAt,
    factIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function addAgentNote({ db, uid, contactId, content, now }) {
  const id = safeContactId(contactId);
  await assertContactWritable(db, uid, id);

  const body = cleanMultiline(content, MAX_NOTE_CONTENT);
  if (!body) {
    throw ingestError('empty_note', 'A note needs some content.');
  }

  const ref = db.collection(`users/${uid}/notes`).doc();
  await ref.set({
    ...noteBase({
      uid,
      contactId: id,
      noteId: ref.id,
      content: body,
      observedAt: now,
      now,
    }),
    recordType: 'note',
    source: 'quick-note',
  });

  return { noteId: ref.id, contactId: id, characters: body.length };
}

export async function logAgentMeeting({
  db,
  uid,
  contactId,
  content,
  occurredAt,
  now,
}) {
  const id = safeContactId(contactId);
  await assertContactWritable(db, uid, id);

  const body = cleanMultiline(content, MAX_MEETING_CONTENT);
  if (!body) {
    throw ingestError('empty_meeting', 'A meeting log needs some content.');
  }
  const when = parseOccurredAt(occurredAt, now);

  const ref = db.collection(`users/${uid}/notes`).doc();
  await ref.set({
    ...noteBase({
      uid,
      contactId: id,
      noteId: ref.id,
      content: body,
      // isValidMeetingNoteCreate requires all three to be the same instant.
      observedAt: when,
      now,
    }),
    recordType: 'meeting',
    source: 'meeting-log',
    occurredAt: when,
    meetingAt: when,
  });

  return {
    noteId: ref.id,
    contactId: id,
    occurredAt: when.toISOString(),
    characters: body.length,
  };
}

/**
 * Record an email the owner says they sent.
 *
 * Deliberately capped at `Sent (User Confirmed)` / `verification:
 * 'user-confirmed'`. The stronger `Sent (Provider Verified)` means Gmail
 * confirmed the send, and an agent reading a pasted thread has not observed
 * that — claiming it would inflate the Tracker's evidence counts with things
 * nobody verified. The provider-only fields (providerMessageId, threadId, and
 * friends) are never written here for the same reason.
 *
 * Outreach documents have a closed field list with no slot for a privacy source
 * type, so these are filed under the existing `outreach` category rather than
 * `agent`. Retention and AI rules for outreach still apply; they are just not
 * swept up by the single agent undo.
 */
export async function logAgentOutreach({
  db,
  uid,
  contactId,
  subject,
  body,
  channel,
  sentAt,
  responseReceived,
  notes,
  now,
}) {
  const id = safeContactId(contactId);
  const contact = await assertContactWritable(db, uid, id);
  const when = parseOccurredAt(sentAt, now);

  const cleanSubject = cleanLine(subject, MAX_SUBJECT);
  const cleanBody = cleanMultiline(body, MAX_BODY);
  if (!cleanSubject && !cleanBody) {
    throw ingestError(
      'empty_outreach',
      'Include the subject or the message body.',
    );
  }

  const replied = responseReceived === true;
  const ref = db.collection(`users/${uid}/outreaches`).doc();
  await ref.set({
    userId: uid,
    contactId: id,
    contactName: cleanLine(contact.name, 240) || null,
    type: 'Email',
    channel: cleanLine(channel, 120) || 'email',
    subject: cleanSubject,
    body: cleanBody,
    status: replied ? 'Responded' : 'Sent (User Confirmed)',
    verification: 'user-confirmed',
    deliveryMode: 'manual',
    sentAt: when,
    userConfirmedAt: now,
    responseReceived: replied ? 'Yes' : 'No',
    dateOfResponse: replied ? now : null,
    notes: cleanMultiline(notes, MAX_BODY) || null,
    generatedBy: 'agent',
    createdAt: now,
    updatedAt: now,
  });

  return {
    outreachId: ref.id,
    contactId: id,
    status: replied ? 'Responded' : 'Sent (User Confirmed)',
    verification: 'user-confirmed',
    sentAt: when.toISOString(),
  };
}

export const __testing = Object.freeze({
  AGENT_PRIVACY_SOURCE_TYPE,
  cleanMultiline,
  parseOccurredAt,
});
