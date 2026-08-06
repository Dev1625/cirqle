import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContactSourceDeleteError,
  isDeletableContactNoteSource,
  normalizeContactSourceDeleteRequest,
} from '../server/api/_lib/contact-source-delete.js';
import { createContactSourceDeleteHandler } from '../server/api/contacts/source-delete.js';

function response() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

const identity = Object.freeze({
  uid: 'owner-uid',
  email: 'owner@example.com',
  emailVerified: true,
  authTime: 1,
});

test('source delete input is exact and path safe', () => {
  assert.deepEqual(
    normalizeContactSourceDeleteRequest({
      contactId: 'contact_123',
      noteId: 'note-456',
    }),
    { contactId: 'contact_123', noteId: 'note-456' },
  );
  for (const value of [
    null,
    {},
    { contactId: '../contact', noteId: 'note' },
    { contactId: 'contact', noteId: 'note', uid: 'attacker' },
  ]) {
    assert.throws(
      () => normalizeContactSourceDeleteRequest(value),
      ContactSourceDeleteError,
    );
  }
});

test('note undo accepts only matching quick or sensitive note sources', () => {
  const canonical = {
    noteSchemaVersion: 2,
    userId: identity.uid,
    contactId: 'contact-1',
    recordType: 'note',
    source: 'quick-note',
    privacySourceType: 'note',
    sourceId: 'note-1',
  };
  assert.equal(
    isDeletableContactNoteSource({
      data: canonical,
      uid: identity.uid,
      contactId: 'contact-1',
      noteId: 'note-1',
    }),
    true,
  );
  assert.equal(
    isDeletableContactNoteSource({
      data: {
        ...canonical,
        source: 'sensitive-note',
      },
      uid: identity.uid,
      contactId: 'contact-1',
      noteId: 'note-1',
    }),
    true,
  );
  assert.equal(
    isDeletableContactNoteSource({
      data: {
        userId: identity.uid,
        contactId: 'contact-1',
        source: 'quick-note',
      },
      uid: identity.uid,
      contactId: 'contact-1',
      noteId: 'legacy-note',
    }),
    true,
  );

  for (const data of [
    { ...canonical, sourceId: 'copied-note-id' },
    { ...canonical, recordType: 'reply', source: 'pasted-reply' },
    {
      ...canonical,
      recordType: 'capture',
      source: 'public-card-capture',
      privacySourceType: 'public-card-capture',
    },
    { ...canonical, userId: 'another-user' },
    { ...canonical, contactId: 'another-contact' },
  ]) {
    assert.equal(
      isDeletableContactNoteSource({
        data,
        uid: identity.uid,
        contactId: 'contact-1',
        noteId: 'note-1',
      }),
      false,
    );
  }
});

test('source delete requires auth and POST before touching data', async () => {
  let removals = 0;
  const handler = createContactSourceDeleteHandler({
    verifyIdentity: async () => {
      const error = new Error('unauthorized');
      error.code = 'unauthorized';
      throw error;
    },
    removeSource: async () => {
      removals += 1;
    },
    limiter: { check: async () => ({ remaining: 1 }) },
    logger: { error() {} },
  });
  const res = response();
  await handler({ method: 'POST', body: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.error.code, 'unauthorized');
  assert.equal(removals, 0);

  const method = response();
  await handler({ method: 'DELETE' }, method);
  assert.equal(method.statusCode, 405);
  assert.equal(removals, 0);
});

test('source delete derives owner identity and returns only bounded counts', async () => {
  let received;
  const handler = createContactSourceDeleteHandler({
    verifyIdentity: async () => identity,
    removeSource: async (input) => {
      received = input;
      return { deleted: true, factsDeleted: 1 };
    },
    limiter: { check: async () => ({ remaining: 29 }) },
    logger: { error() {} },
  });
  const res = response();
  await handler(
    {
      method: 'POST',
      body: { contactId: 'contact-1', noteId: 'note-1' },
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(received, {
    uid: identity.uid,
    contactId: 'contact-1',
    noteId: 'note-1',
  });
  assert.equal(res.payload.deleted, true);
  assert.equal(res.payload.factsDeleted, 1);
  assert.equal(typeof res.payload.requestId, 'string');
});

test('source delete sanitizes operational failures', async () => {
  const secret = 'private note content must never leak';
  const handler = createContactSourceDeleteHandler({
    verifyIdentity: async () => identity,
    removeSource: async () => {
      throw new Error(secret);
    },
    limiter: { check: async () => ({ remaining: 29 }) },
    logger: { error() {} },
  });
  const res = response();
  await handler(
    {
      method: 'POST',
      body: { contactId: 'contact-1', noteId: 'note-1' },
    },
    res,
  );
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.stringify(res.payload).includes(secret), false);
});
