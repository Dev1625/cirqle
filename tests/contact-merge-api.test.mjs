import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContactMergeError,
} from '../api/_lib/contact-merge.js';
import {
  createContactMergeHandler,
} from '../api/contacts/merge.js';

const UID = 'owner-uid';
const AUTH_TIME = 1_785_340_800;
const OPERATION_ID = '00000000-0000-4000-8000-000000000001';

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function request(body, method = 'POST') {
  return {
    method,
    headers: {
      authorization: 'Bearer valid',
      'x-request-id': 'merge-api-test',
    },
    body,
  };
}

function validBody(overrides = {}) {
  const expectedContact = (name, company) => ({
    profile: {
      name,
      email: '',
      phone: '',
      company,
      role: '',
      location: '',
      linkedinUrl: '',
      summary: '',
      relationshipTier: 'Cold',
      industry: '',
      subIndustry: '',
      school: '',
      seniority: '',
      connectionSource: '',
      whyTheyMatter: '',
      tags: [],
    },
    lifecycleStatus: 'active',
    aiAllowed: true,
    mergedIntoContactId: null,
    contactMergeOperationId: null,
  });
  return {
    operationId: OPERATION_ID,
    primaryContactId: 'primary-contact',
    duplicateContactId: 'duplicate-contact',
    choices: [{ field: 'name', strategy: 'primary' }],
    confirmed: true,
    expectedPrimary: expectedContact('Primary Person', 'Primary Co'),
    expectedDuplicate: expectedContact(
      'Duplicate Person',
      'Duplicate Co',
    ),
    ...overrides,
  };
}

const identity = {
  uid: UID,
  email: 'owner@example.com',
  emailVerified: true,
  authTime: AUTH_TIME,
};

test('merge endpoint derives its owner from Firebase and passes only normalized input', async () => {
  let received = null;
  const handler = createContactMergeHandler({
    verifyIdentity: async () => identity,
    now: () => new Date('2026-07-29T16:00:00.000Z'),
    mergeContact: async (arguments_) => {
      received = arguments_;
      return {
        operationId: OPERATION_ID,
        primaryContactId: 'primary-contact',
        duplicateContactId: 'duplicate-contact',
        migratedReferences: {
          note: 1,
          outreach: 0,
          commitment: 0,
          thread: 0,
          'voice-enrichment': 0,
          connection: 0,
          fact: 1,
          'job-history': 1,
        },
        warnings: [],
      };
    },
  });
  const res = response();

  await handler(request(validBody()), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.operationId, OPERATION_ID);
  assert.equal(res.body.requestId, 'merge-api-test');
  assert.equal(received.uid, UID);
  assert.equal(received.authTime, AUTH_TIME);
  assert.equal(received.input.primaryContactId, 'primary-contact');
  assert.equal(Object.hasOwn(received.input, 'uid'), false);
});

test('merge endpoint rejects caller-supplied ownership and malformed confirmation', async () => {
  let called = false;
  const handler = createContactMergeHandler({
    verifyIdentity: async () => identity,
    mergeContact: async () => {
      called = true;
    },
  });

  const forged = response();
  await handler(request(validBody({ uid: 'other-owner' })), forged);
  assert.equal(forged.statusCode, 400);
  assert.equal(
    forged.body.error.code,
    'contact_merge_field_not_allowed',
  );

  const unconfirmed = response();
  await handler(request(validBody({ confirmed: false })), unconfirmed);
  assert.equal(unconfirmed.statusCode, 400);
  assert.equal(
    unconfirmed.body.error.code,
    'contact_merge_confirmation_required',
  );
  assert.equal(called, false);
});

test('merge endpoint requires a verified Firebase email', async () => {
  let called = false;
  const handler = createContactMergeHandler({
    verifyIdentity: async () => ({
      ...identity,
      emailVerified: false,
    }),
    mergeContact: async () => {
      called = true;
    },
  });
  const res = response();

  await handler(request(validBody()), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'email_verification_required');
  assert.equal(called, false);
});

test('merge endpoint rejects wrong methods and unauthenticated callers before mutation', async () => {
  let authCalls = 0;
  let mergeCalls = 0;
  const wrongMethodHandler = createContactMergeHandler({
    verifyIdentity: async () => {
      authCalls += 1;
      return identity;
    },
    mergeContact: async () => {
      mergeCalls += 1;
    },
  });
  const wrongMethod = response();
  await wrongMethodHandler(request(validBody(), 'GET'), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.Allow, 'POST');
  assert.equal(authCalls, 0);

  const unauthenticatedHandler = createContactMergeHandler({
    verifyIdentity: async () => {
      const error = new Error('no token');
      error.code = 'unauthorized';
      throw error;
    },
    mergeContact: async () => {
      mergeCalls += 1;
    },
  });
  const unauthenticated = response();
  await unauthenticatedHandler(request(validBody()), unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.body.error.code, 'unauthorized');
  assert.equal(mergeCalls, 0);
});

test('merge endpoint preserves safe domain errors and sanitizes unexpected failures', async () => {
  const lockedHandler = createContactMergeHandler({
    verifyIdentity: async () => identity,
    mergeContact: async () => {
      throw new ContactMergeError({
        code: 'contact_merge_account_locked',
        message: 'This account is not available for contact changes.',
        status: 410,
      });
    },
  });
  const locked = response();
  await lockedHandler(request(validBody()), locked);
  assert.equal(locked.statusCode, 410);
  assert.equal(locked.body.error.code, 'contact_merge_account_locked');

  const logs = [];
  const failedHandler = createContactMergeHandler({
    verifyIdentity: async () => identity,
    mergeContact: async () => {
      const error = new Error(
        'Firestore failed for alice@example.com / Secret Contact',
      );
      error.code = 'internal alice@example.com';
      throw error;
    },
    logger: { error: (...items) => logs.push(items) },
  });
  const failed = response();
  await failedHandler(request(validBody()), failed);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.error.code, 'contact_merge_unavailable');
  const serialized = JSON.stringify({ body: failed.body, logs });
  assert.doesNotMatch(
    serialized,
    /alice@example\.com|Secret Contact|owner-uid/,
  );
  assert.match(serialized, /unknown/);
});
