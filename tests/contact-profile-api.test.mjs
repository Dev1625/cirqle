import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContactProfileError,
  normalizeContactProfileRequest,
} from '../api/_lib/contact-profile.js';
import {
  createContactProfileHandler,
} from '../api/contacts/profile.js';

const UID = 'profile-owner';
const NOW = new Date('2026-07-29T18:00:00.000Z');

function profile(overrides = {}) {
  return {
    name: 'Maya Chen',
    email: 'maya@example.com',
    phone: '',
    company: 'Cirqle',
    role: 'Founder',
    location: 'New York',
    linkedinUrl: 'https://www.linkedin.com/in/maya',
    summary: '',
    relationshipTier: 'Strong',
    industry: 'Software',
    subIndustry: '',
    school: '',
    seniority: 'Founder',
    connectionSource: 'Demo Day',
    whyTheyMatter: 'Trusted collaborator',
    tags: ['Founder', 'Investor'],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    contactId: 'contact-1',
    expectedProfileRevision: 4,
    profile: profile(),
    ...overrides,
  };
}

function response() {
  return {
    headers: new Map(),
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers.set(name, value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test('profile requests require an exact complete bounded schema', () => {
  const normalized = normalizeContactProfileRequest(request());
  assert.equal(normalized.profile.email, 'maya@example.com');
  assert.deepEqual(normalized.profile.tags, ['Founder', 'Investor']);

  assert.throws(
    () =>
      normalizeContactProfileRequest({
        ...request(),
        uid: 'forged-owner',
      }),
    ContactProfileError,
  );
  const incomplete = profile();
  delete incomplete.school;
  assert.throws(
    () =>
      normalizeContactProfileRequest(
        request({ profile: incomplete }),
      ),
    ContactProfileError,
  );
  assert.throws(
    () =>
      normalizeContactProfileRequest(
        request({
          profile: profile({
            linkedinUrl: 'https://user:secret@example.com/profile',
          }),
        }),
      ),
    /without credentials/i,
  );
});

test('authenticated handler derives the owner and returns a bounded acknowledgement', async () => {
  let observed = null;
  const handler = createContactProfileHandler({
    verifyIdentity: async () => ({
      uid: UID,
      email: 'owner@example.com',
      emailVerified: true,
      authTime: 1_785_348_000,
    }),
    saveProfile: async (arguments_) => {
      observed = arguments_;
      return {
        contactId: arguments_.input.contactId,
        contact: {
          id: arguments_.input.contactId,
          ...arguments_.input.profile,
          profileRevision: 5,
        },
        profileRevision: 5,
        changedFields: ['company'],
        profileFactIds: ['fact-1'],
        jobHistoryChanged: true,
      };
    },
    now: () => NOW,
  });
  const res = response();
  await handler(
    {
      method: 'POST',
      headers: { authorization: 'Bearer valid' },
      body: request(),
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(observed.uid, UID);
  assert.equal(observed.input.expectedProfileRevision, 4);
  assert.equal(observed.now, NOW);
  assert.equal(res.body.contact.profileRevision, 5);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store, max-age=0');
});

test('handler rejects unverified accounts before parsing profile data', async () => {
  let called = false;
  const handler = createContactProfileHandler({
    verifyIdentity: async () => ({
      uid: UID,
      email: 'owner@example.com',
      emailVerified: false,
      authTime: 1,
    }),
    saveProfile: async () => {
      called = true;
    },
  });
  const res = response();
  await handler({ method: 'POST', body: request() }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'email_verification_required');
  assert.equal(called, false);
});

test('conflicts are stable 409 responses without internal detail', async () => {
  const handler = createContactProfileHandler({
    verifyIdentity: async () => ({
      uid: UID,
      email: 'owner@example.com',
      emailVerified: true,
      authTime: 1,
    }),
    saveProfile: async () => {
      throw new ContactProfileError({
        code: 'contact_profile_conflict',
        message: 'This contact changed in another tab.',
        status: 409,
      });
    },
  });
  const res = response();
  await handler({ method: 'POST', body: request() }, res);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body.error, {
    code: 'contact_profile_conflict',
    message: 'This contact changed in another tab.',
  });
});

test('unexpected failures log only a hashed subject and safe code', async () => {
  const logs = [];
  const handler = createContactProfileHandler({
    verifyIdentity: async () => ({
      uid: UID,
      email: 'owner@example.com',
      emailVerified: true,
      authTime: 1,
    }),
    saveProfile: async () => {
      const error = new Error(
        'Firestore failed for maya@example.com / Maya Chen',
      );
      error.code = 'internal maya@example.com';
      throw error;
    },
    logger: { error: (...items) => logs.push(items) },
  });
  const res = response();
  await handler({ method: 'POST', body: request() }, res);
  assert.equal(res.statusCode, 503);
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /maya@example\.com|Maya Chen|profile-owner/);
  assert.match(serialized, /unknown/);
});

test('profile endpoint is POST-only', async () => {
  const handler = createContactProfileHandler();
  const res = response();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.get('Allow'), 'POST');
});
