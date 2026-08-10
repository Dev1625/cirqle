/**
 * Firestore security rules - executable specification.
 *
 * The public card and its anonymous capture form are the only deliberately
 * public Firestore surface. These tests make that narrow exception explicit
 * and ensure it cannot quietly expand during a later refactor.
 */
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

const OWNER = 'owner-uid';
const OTHER = 'other-uid';
const STALE = 'stale-owner-uid';
const DELETING = 'deleting-owner-uid';
const CARD = 'abc234xyz9';
const UNPUBLISHED_CARD = 'def567rst8';
const STALE_CARD = 'stf234xyz9';
const DELETING_CARD = 'dlt567rst8';

let passed = 0;
let failed = 0;
const failures = [];

async function it(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message || error}`);
    failed++;
    failures.push(name);
  }
}

function describe(title) {
  console.log(`\n${title}`);
}

const env = await initializeTestEnvironment({
  projectId: 'cirqle-rules-test',
  firestore: {
    host: '127.0.0.1',
    port: Number(process.env.FIRESTORE_EMULATOR_PORT || 8590),
    rules: RULES,
  },
});

await env.clearFirestore();

// Seed fixtures with rules disabled. Fixture setup is not behavior under test.
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, `cards/${CARD}`), {
    cardId: CARD,
    ownerUid: OWNER,
    name: 'Devarshi',
    published: true,
  });
  await setDoc(doc(db, `cards/${UNPUBLISHED_CARD}`), {
    cardId: UNPUBLISHED_CARD,
    ownerUid: OWNER,
    name: 'Retired',
    published: false,
  });
  await setDoc(doc(db, `cards/${STALE_CARD}`), {
    cardId: STALE_CARD,
    ownerUid: STALE,
    name: 'Stale owner',
    published: true,
  });
  await setDoc(doc(db, `cards/${DELETING_CARD}`), {
    cardId: DELETING_CARD,
    ownerUid: DELETING,
    name: 'Deleting owner',
    published: true,
  });
  await setDoc(
    doc(db, `users/${OWNER}`),
    {
      userId: OWNER,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      name: 'Devarshi',
      role: null,
      company: null,
      bio: null,
      resumeText: null,
      targetIndustries: [],
    },
  );
  await Promise.all([
    setDoc(doc(db, `_accountSecurity/${OWNER}`), {
      status: 'active',
      revokedAfterSeconds: 0,
    }),
    setDoc(doc(db, `_accountSecurity/${OTHER}`), {
      status: 'active',
      revokedAfterSeconds: 0,
    }),
    setDoc(doc(db, `_accountSecurity/${STALE}`), {
      status: 'active',
      revokedAfterSeconds: 100,
    }),
    setDoc(doc(db, `users/${STALE}`), { name: 'Stale' }),
    setDoc(doc(db, `_accountSecurity/${DELETING}`), {
      status: 'deleting',
      revokedAfterSeconds: 0,
    }),
    setDoc(doc(db, `users/${DELETING}`), { name: 'Deleting' }),
  ]);
  await setDoc(
    doc(db, `users/${OWNER}/contacts/c1`),
    { name: 'Sarah' },
  );
  await setDoc(
    doc(db, `users/${OWNER}/contacts/c2`),
    { name: 'Jordan' },
  );
  await setDoc(
    doc(db, `users/${OWNER}/contacts/c-purging`),
    {
      name: 'Purging contact',
      lifecycleStatus: 'deleted',
      purgeEligibleAt: new Date(Date.now() - 1_000),
      purgeFence: {
        protocolVersion: 1,
        requestId: 'c-purging',
        leaseId: 'server-lease',
        acquiredAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1_000),
      },
    },
  );
  await setDoc(
    doc(db, `users/${OWNER}/notes/purging-contact-note`),
    {
      contactId: 'c-purging',
      content: 'worker-owned while purge is fenced',
    },
  );
  await setDoc(
    doc(db, `users/${OWNER}/integrations/gmail`),
    { connected: true },
  );
  await setDoc(
    doc(db, `users/${OWNER}/commitments/feedback-target`),
    {
      contactId: 'c1',
      text: 'Send the deck',
    },
  );
  await setDoc(
    doc(db, `users/${OWNER}/commitments/feedback-purge-target`),
    {
      contactId: 'c-purging',
      text: 'Must not accept feedback during purge',
    },
  );
  await setDoc(
    doc(db, `users/${OWNER}/connections/purging-connection`),
    {
      sourceId: 'c-purging',
      targetId: 'c1',
      type: 'fixture',
    },
  );
  await setDoc(
    doc(db, `users/${OWNER}/connections/migrated-connection`),
    {
      sourceId: 'c1',
      targetId: 'c2',
      type: 'fixture',
      contactMergeOperationId: 'merge-operation',
      migratedFromContactId: 'legacy-contact',
      migratedFromPath:
        `users/${OWNER}/connections/legacy-contact--c2`,
      originalConnectionEndpoints: {
        sourceId: 'legacy-contact',
        targetId: 'c2',
      },
      mergeHistorical: false,
    },
  );
  await setDoc(
    doc(db, `users/${OWNER}/contactEvents/immutable-event`),
    {
      actorUid: OWNER,
      contactId: 'c1',
      type: 'profile-updated',
      immutable: true,
      occurredAt: new Date(),
    },
  );
  await setDoc(
    doc(db, `users/${OWNER}/contactMergeOperations/server-merge-operation`),
    {
      operationId: 'server-merge-operation',
      actorUid: OWNER,
      primaryContactId: 'c1',
      duplicateContactId: 'c2',
      status: 'completed',
      immutable: true,
    },
  );
  await setDoc(
    doc(db, `users/${OWNER}/privacyPolicyEvents/privacy-event`),
    {
      actorUid: OWNER,
      kind: 'privacy-policy-replaced',
      recordedAt: new Date(),
    },
  );
  await setDoc(
    doc(db, `users/${OWNER}/commitmentFeedbackEvents/feedback-event`),
    {
      actorUid: OWNER,
      commitmentId: 'commitment-1',
      kind: 'completed',
      recordedAt: new Date(),
    },
  );
  await setDoc(doc(db, `cards/${CARD}/captures/seeded`), {
    visitorName: 'Seeded Visitor',
    visitorEmail: null,
    visitorCompany: null,
    note: null,
    capturedAt: new Date(),
    processed: false,
  });
  await setDoc(doc(db, `cards/${STALE_CARD}/captures/seeded`), {
    visitorName: 'Stale visitor',
    visitorEmail: 'stale-visitor@example.com',
    visitorCompany: null,
    note: 'private',
    capturedAt: new Date(),
    processed: false,
  });
  await setDoc(doc(db, `cards/${DELETING_CARD}/captures/seeded`), {
    visitorName: 'Deleting visitor',
    visitorEmail: 'deleting-visitor@example.com',
    visitorCompany: null,
    note: 'private',
    capturedAt: new Date(),
    processed: false,
  });
});

const anon = env.unauthenticatedContext().firestore();
const owner = env.authenticatedContext(OWNER, {
  email: 'owner@example.com',
  email_verified: true,
  auth_time: 1,
}).firestore();
const unverifiedOwner = env.authenticatedContext(OWNER, {
  email: 'owner@example.com',
  email_verified: false,
  auth_time: 1,
}).firestore();
const other = env.authenticatedContext(OTHER, {
  email: 'other@example.com',
  email_verified: true,
  auth_time: 1,
}).firestore();
const staleOwner = env.authenticatedContext(STALE, {
  email: 'stale@example.com',
  email_verified: true,
  auth_time: 100,
}).firestore();
const deletingOwner = env.authenticatedContext(DELETING, {
  email: 'deleting@example.com',
  email_verified: true,
  auth_time: 10,
}).firestore();

const validCapture = {
  visitorName: 'Alex Rivera',
  visitorEmail: null,
  visitorCompany: null,
  note: null,
  capturedAt: serverTimestamp(),
  processed: false,
};

function encryptedEnvelopeV1() {
  return {
    schemaVersion: 1,
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: 310_000,
    salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
    iv: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAA=',
  };
}

function encryptedEnvelopeV2(noteId, userId = OWNER) {
  return {
    ...encryptedEnvelopeV1(),
    schemaVersion: 2,
    aad: {
      version: 1,
      scope: 'user-note',
      userId,
      noteId,
    },
  };
}

function validNoteProvenance(feature) {
  return {
    feature,
    sourceIds: ['user-input'],
    sourceLabels: { 'user-input': 'User input' },
    unsupportedAssumptions: [],
    privacyExclusions: [],
    generatedAt: '2026-07-29T12:00:00.000Z',
  };
}

function canonicalNote(noteId, overrides = {}) {
  return {
    noteSchemaVersion: 2,
    userId: OWNER,
    contactId: 'c1',
    recordType: 'note',
    source: 'quick-note',
    privacySourceType: 'note',
    sourceId: noteId,
    content: 'Exact relationship note',
    sensitive: false,
    aiAllowed: true,
    observedAt: new Date('2026-07-29T12:00:00.000Z'),
    factIds: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function canonicalContact(overrides = {}) {
  return {
    userId: OWNER,
    name: 'Canonical Contact',
    email: '',
    normalizedEmail: '',
    phone: '',
    company: '',
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
    profileRevision: 0,
    lifecycleStatus: 'active',
    aiAllowed: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function validCard(cardId, ownerUid = OWNER) {
  return {
    cardId,
    ownerUid,
    mode: 'custom',
    accent: 'oxblood',
    layout: 'expanded',
    name: 'Devarshi Dalal',
    role: 'Founder',
    company: 'Cirqle',
    intro: 'A concise, deliberately public introduction.',
    portedUrl: null,
    links: [],
    email: null,
    published: true,
    updatedAt: serverTimestamp(),
  };
}

describe('cards/{cardId} - published public card');

await it('a stranger with the link can read a published card', async () => {
  await assertSucceeds(getDoc(doc(anon, `cards/${CARD}`)));
});

await it('a stranger cannot read a retired card', async () => {
  await assertFails(getDoc(doc(anon, `cards/${UNPUBLISHED_CARD}`)));
});

await it('the owner can still read their retired card', async () => {
  await assertSucceeds(getDoc(doc(owner, `cards/${UNPUBLISHED_CARD}`)));
});

await it('an unverified owner cannot publish a public card', async () => {
  const cardId = 'hjk234mnp5';
  await assertFails(setDoc(
    doc(unverifiedOwner, `cards/${cardId}`),
    validCard(cardId),
  ));
});

await it('another signed-in user cannot read a retired card', async () => {
  await assertFails(getDoc(doc(other, `cards/${UNPUBLISHED_CARD}`)));
});

await it('a stranger cannot enumerate public cards', async () => {
  await assertFails(getDocs(collection(anon, 'cards')));
});

await it('even the owner cannot list the global public-card collection', async () => {
  await assertFails(getDocs(collection(owner, 'cards')));
});

await it('a stranger cannot overwrite someone\'s card', async () => {
  await assertFails(setDoc(
    doc(anon, `cards/${CARD}`),
    { name: 'Hacked' },
    { merge: true },
  ));
});

await it('a different signed-in user cannot overwrite the card', async () => {
  await assertFails(setDoc(
    doc(other, `cards/${CARD}`),
    { name: 'Hacked' },
    { merge: true },
  ));
});

await it('a different signed-in user cannot delete the card', async () => {
  await assertFails(deleteDoc(doc(other, `cards/${CARD}`)));
});

await it('the owner can update their own card', async () => {
  await assertSucceeds(setDoc(
    doc(owner, `cards/${CARD}`),
    { ...validCard(CARD), intro: 'hello' },
    { merge: true },
  ));
});

await it('nobody can reassign ownerUid to steal a card', async () => {
  await assertFails(updateDoc(
    doc(other, `cards/${CARD}`),
    { ownerUid: OTHER },
  ));
});

await it('creating a card for someone else is rejected', async () => {
  const cardId = 'ghi678uvw7';
  await assertFails(setDoc(
    doc(other, `cards/${cardId}`),
    validCard(cardId, OWNER),
  ));
});

await it('the owner can create a shape-valid public card', async () => {
  const cardId = 'jkm789pqr6';
  await assertSucceeds(setDoc(
    doc(owner, `cards/${cardId}`),
    validCard(cardId),
  ));
});

await it('a public card cannot contain an unexpected secret field', async () => {
  const cardId = 'mnp234stu5';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    { ...validCard(cardId), apiKey: 'must-never-be-public' },
  ));
});

await it('the payload cardId must match the document path', async () => {
  const cardId = 'qrs345vwx4';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    validCard('tuv456xyz3'),
  ));
});

await it('a malformed card id is rejected', async () => {
  const cardId = 'bad-id';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    validCard(cardId),
  ));
});

await it('an unsupported card mode is rejected', async () => {
  const cardId = 'wxy567abc2';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    { ...validCard(cardId), mode: 'admin' },
  ));
});

await it('an unsupported accent is rejected', async () => {
  const cardId = 'zab678def3';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    { ...validCard(cardId), accent: '#ffffff' },
  ));
});

await it('a card may publish a shape-valid HTTPS link', async () => {
  const cardId = 'bcd789fgh4';
  await assertSucceeds(setDoc(
    doc(owner, `cards/${cardId}`),
    {
      ...validCard(cardId),
      links: [{ label: 'Cirqle', url: 'https://cirqle.example/about' }],
    },
  ));
});

await it('a javascript public-card link is rejected', async () => {
  const cardId = 'efg234jkm5';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    {
      ...validCard(cardId),
      links: [{ label: 'Unsafe', url: 'javascript:alert(1)' }],
    },
  ));
});

await it('an unexpected field inside a public-card link is rejected', async () => {
  const cardId = 'hjk345mnp6';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    {
      ...validCard(cardId),
      links: [{
        label: 'Unsafe',
        url: 'https://example.com',
        html: '<script>',
      }],
    },
  ));
});

await it('an insecure ported profile URL is rejected', async () => {
  const cardId = 'kmn456qrs7';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    { ...validCard(cardId), portedUrl: 'http://example.com' },
  ));
});

await it('a credential-bearing public URL is rejected', async () => {
  const cardId = 'qrs456tuv7';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    {
      ...validCard(cardId),
      links: [{
        label: 'Deceptive',
        url: 'https://trusted.example@attacker.example/profile',
      }],
    },
  ));
});

await it('public card text cannot inject extra vCard lines', async () => {
  const cardId = 'rst567uvw8';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    {
      ...validCard(cardId),
      name: 'Ada\r\nTEL;TYPE=CELL:+15551234567',
    },
  ));
});

await it('public card email must be a normalized email-shaped value', async () => {
  const cardId = 'stu678vwx9';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    {
      ...validCard(cardId),
      email: 'ada@example.com\r\nBcc:attacker@example.com',
    },
  ));
});

await it('an over-long public intro is rejected', async () => {
  const cardId = 'cde789ghi4';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    { ...validCard(cardId), intro: 'x'.repeat(241) },
  ));
});

await it('a client-forged updatedAt timestamp is rejected', async () => {
  const cardId = 'fgh234jkm5';
  await assertFails(setDoc(
    doc(owner, `cards/${cardId}`),
    { ...validCard(cardId), updatedAt: new Date(0) },
  ));
});

describe('cards/{cardId}/captures - anonymous reverse capture');

await it('a stranger cannot bypass the protected capture API', async () => {
  await assertFails(addDoc(
    collection(anon, `cards/${CARD}/captures`),
    validCapture,
  ));
});

await it('even the owner cannot create a capture through the browser SDK', async () => {
  await assertFails(addDoc(
    collection(owner, `cards/${CARD}/captures`),
    validCapture,
  ));
});

await it('a capture with an empty name is rejected', async () => {
  await assertFails(addDoc(
    collection(anon, `cards/${CARD}/captures`),
    { ...validCapture, visitorName: '' },
  ));
});

await it('an over-long name is rejected', async () => {
  await assertFails(addDoc(
    collection(anon, `cards/${CARD}/captures`),
    { ...validCapture, visitorName: 'x'.repeat(121) },
  ));
});

await it('an over-long email is rejected', async () => {
  await assertFails(addDoc(
    collection(anon, `cards/${CARD}/captures`),
    { ...validCapture, visitorEmail: 'x'.repeat(201) },
  ));
});

await it('an over-long company is rejected', async () => {
  await assertFails(addDoc(
    collection(anon, `cards/${CARD}/captures`),
    { ...validCapture, visitorCompany: 'x'.repeat(201) },
  ));
});

await it('an over-long note is rejected', async () => {
  await assertFails(addDoc(
    collection(anon, `cards/${CARD}/captures`),
    { ...validCapture, note: 'x'.repeat(501) },
  ));
});

await it('an unexpected extra field is rejected', async () => {
  await assertFails(addDoc(
    collection(anon, `cards/${CARD}/captures`),
    { ...validCapture, isAdmin: true },
  ));
});

await it('a capture pre-marked processed:true is rejected', async () => {
  await assertFails(addDoc(
    collection(anon, `cards/${CARD}/captures`),
    { ...validCapture, processed: true },
  ));
});

await it('a capture with a forged timestamp is rejected', async () => {
  await assertFails(addDoc(
    collection(anon, `cards/${CARD}/captures`),
    { ...validCapture, capturedAt: new Date(0) },
  ));
});

await it('a capture missing a required nullable field is rejected', async () => {
  const { note: _note, ...missingNote } = validCapture;
  await assertFails(addDoc(
    collection(anon, `cards/${CARD}/captures`),
    missingNote,
  ));
});

await it('a non-string name is rejected', async () => {
  await assertFails(addDoc(
    collection(anon, `cards/${CARD}/captures`),
    { ...validCapture, visitorName: 42 },
  ));
});

await it('a capture cannot be left on a retired card', async () => {
  await assertFails(addDoc(
    collection(anon, `cards/${UNPUBLISHED_CARD}/captures`),
    validCapture,
  ));
});

await it('a capture cannot be left under a missing card', async () => {
  await assertFails(addDoc(
    collection(anon, 'cards/mnp345qrs6/captures'),
    validCapture,
  ));
});

await it('a stranger cannot enumerate who else tapped', async () => {
  await assertFails(getDocs(
    collection(anon, `cards/${CARD}/captures`),
  ));
});

await it('a stranger cannot read a single capture by id', async () => {
  await assertFails(getDoc(
    doc(anon, `cards/${CARD}/captures/seeded`),
  ));
});

await it('a different signed-in user cannot enumerate captures', async () => {
  await assertFails(getDocs(
    collection(other, `cards/${CARD}/captures`),
  ));
});

await it('a stranger cannot edit a capture after leaving it', async () => {
  await assertFails(updateDoc(
    doc(anon, `cards/${CARD}/captures/seeded`),
    { visitorName: 'Changed' },
  ));
});

await it('a stranger cannot delete a capture', async () => {
  await assertFails(deleteDoc(
    doc(anon, `cards/${CARD}/captures/seeded`),
  ));
});

await it('the owner can read their captures', async () => {
  await assertSucceeds(getDocs(
    collection(owner, `cards/${CARD}/captures`),
  ));
});

await it('even the owner cannot mutate a capture in place', async () => {
  await assertFails(updateDoc(
    doc(owner, `cards/${CARD}/captures/seeded`),
    { visitorName: 'Changed' },
  ));
});

await it('the owner can delete a capture once drained', async () => {
  await assertSucceeds(deleteDoc(
    doc(owner, `cards/${CARD}/captures/seeded`),
  ));
});

await it('stale and deleting owners cannot read or delete visitor captures', async () => {
  const staleCapture = doc(
    staleOwner,
    `cards/${STALE_CARD}/captures/seeded`,
  );
  const deletingCapture = doc(
    deletingOwner,
    `cards/${DELETING_CARD}/captures/seeded`,
  );
  await assertFails(getDoc(staleCapture));
  await assertFails(deleteDoc(staleCapture));
  await assertFails(getDoc(deletingCapture));
  await assertFails(deleteDoc(deletingCapture));
});

describe('users/{uid} - private CRM data');

await it('browser note writes are limited to the exact canonical union', async () => {
  const quickId = 'canonical-quick';
  await assertSucceeds(setDoc(
    doc(owner, `users/${OWNER}/notes/${quickId}`),
    canonicalNote(quickId),
  ));

  const meetingId = 'canonical-meeting';
  const meetingAt = new Date('2026-07-28T12:00:00.000Z');
  await assertSucceeds(setDoc(
    doc(owner, `users/${OWNER}/notes/${meetingId}`),
    canonicalNote(meetingId, {
      recordType: 'meeting',
      source: 'meeting-log',
      privacySourceType: 'meeting',
      content: 'Discussed the deck and agreed on a review date.',
      observedAt: meetingAt,
      occurredAt: meetingAt,
      meetingAt,
    }),
  ));

  const replyId = 'canonical-reply';
  await assertSucceeds(setDoc(
    doc(owner, `users/${OWNER}/notes/${replyId}`),
    canonicalNote(replyId, {
      recordType: 'reply',
      source: 'pasted-reply',
      privacySourceType: 'reply',
      content: 'Reply received: please send the deck.',
      replyTargetOutreachId: 'outreach-1',
      replyTargetThreadId: null,
      aiFeature: 'contact.reply.process',
      aiProvenance: validNoteProvenance(
        'contact.reply.process',
      ),
    }),
  ));

  const tagId = 'canonical-ai-tag';
  await assertSucceeds(setDoc(
    doc(owner, `users/${OWNER}/notes/${tagId}`),
    canonicalNote(tagId, {
      recordType: 'ai-tag',
      source: 'ai-tag-extraction',
      privacySourceType: 'user-input',
      content: 'AI extracted tags from conversation: fundraising',
      aiAllowed: false,
      aiFeature: 'contact.tags.extract',
      aiProvenance: validNoteProvenance(
        'contact.tags.extract',
      ),
    }),
  ));
  await assertSucceeds(deleteDoc(
    doc(owner, `users/${OWNER}/notes/${tagId}`),
  ));

  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/notes/note-with-provider-payload`),
    canonicalNote('note-with-provider-payload', {
      rawProviderPayload: 'must never enter the note root',
    }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/notes/browser-capture`),
    canonicalNote('browser-capture', {
      recordType: 'capture',
      source: 'public-card-capture',
      privacySourceType: 'public-card-capture',
      content: 'A public card visitor',
    }),
  ));
});

await it('sensitive notes require a v2 envelope bound to owner and note path', async () => {
  const sensitiveId = 'canonical-sensitive';
  await assertSucceeds(setDoc(
    doc(owner, `users/${OWNER}/notes/${sensitiveId}`),
    canonicalNote(sensitiveId, {
      source: 'sensitive-note',
      content: null,
      sensitive: true,
      aiAllowed: false,
      encryptedContent: encryptedEnvelopeV2(sensitiveId),
    }),
  ));

  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/notes/sensitive-with-plaintext`),
    canonicalNote('sensitive-with-plaintext', {
      source: 'sensitive-note',
      content: 'plaintext must never be accepted',
      sensitive: true,
      aiAllowed: false,
      encryptedContent: encryptedEnvelopeV2(
        'sensitive-with-plaintext',
      ),
    }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/notes/copied-sensitive-envelope`),
    canonicalNote('copied-sensitive-envelope', {
      source: 'sensitive-note',
      content: null,
      sensitive: true,
      aiAllowed: false,
      encryptedContent: encryptedEnvelopeV2(sensitiveId),
    }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/notes/legacy-sensitive-create`),
    canonicalNote('legacy-sensitive-create', {
      source: 'sensitive-note',
      content: null,
      sensitive: true,
      aiAllowed: false,
      encryptedContent: encryptedEnvelopeV1(),
    }),
  ));
});

await it('legacy sensitive notes can only migrate once to their bound v2 envelope', async () => {
  const noteId = 'legacy-sensitive-migration';
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), `users/${OWNER}/notes/${noteId}`),
      {
        userId: OWNER,
        contactId: 'c1',
        source: 'sensitive-note',
        content: null,
        sensitive: true,
        aiAllowed: false,
        encryptedContent: encryptedEnvelopeV1(),
        createdAt: new Date('2026-07-01T12:00:00.000Z'),
        updatedAt: new Date('2026-07-01T12:00:00.000Z'),
      },
    );
  });
  const noteRef = doc(owner, `users/${OWNER}/notes/${noteId}`);

  await assertFails(updateDoc(noteRef, {
    content: 'migration must not add plaintext',
    encryptedContent: encryptedEnvelopeV2(noteId),
    encryptionMigratedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(noteRef, {
    encryptedContent: encryptedEnvelopeV2(
      noteId,
      OTHER,
    ),
    encryptionMigratedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(noteRef, {
    encryptedContent: encryptedEnvelopeV2(noteId),
    encryptionMigratedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(noteRef, {
    encryptedContent: encryptedEnvelopeV1(),
    updatedAt: serverTimestamp(),
  }));
});

await it('voice memo enrichment can add only a grounded summary', async () => {
  const noteId = 'canonical-voice';
  const noteRef = doc(owner, `users/${OWNER}/notes/${noteId}`);
  await assertSucceeds(setDoc(
    noteRef,
    canonicalNote(noteId, {
      recordType: 'voice',
      source: 'voice-memo',
      privacySourceType: 'voice',
      content: 'Maya asked for the deck and a Friday follow-up.',
      meetingTitle: null,
    }),
  ));

  await assertSucceeds(updateDoc(noteRef, {
    aiSummary: 'Maya asked for the deck and a Friday follow-up.',
    aiSummaryGrounding: {
      usedSourceIds: [`note-${noteId}`],
      unsupportedAssumptions: [],
      privacyExclusions: [],
      sourceLabels: {
        [`note-${noteId}`]: 'Voice memo',
      },
      generatedAt: '2026-07-29T12:00:00.000Z',
    },
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(noteRef, {
    content: 'A browser must not rewrite the saved transcript.',
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(noteRef, {
    aiSummary: 'Ungrounded rewrite',
    aiSummaryGrounding: {
      usedSourceIds: [],
      unsupportedAssumptions: [],
      sourceLabels: {},
      generatedAt: '2026-07-29T12:00:00.000Z',
      hiddenProviderPayload: 'must be rejected',
    },
    updatedAt: serverTimestamp(),
  }));
});

await it('an expired session marker denies both private reads and writes', async () => {
  await assertFails(getDoc(doc(staleOwner, `users/${STALE}`)));
  await assertFails(setDoc(
    doc(staleOwner, `users/${STALE}/notes/n1`),
    { content: 'must not persist' },
  ));
});

await it('a deleting account cannot read or recreate private data', async () => {
  await assertFails(getDoc(doc(deletingOwner, `users/${DELETING}`)));
  await assertFails(setDoc(
    doc(deletingOwner, `users/${DELETING}/notes/n1`),
    { content: 'must not persist' },
  ));
});

await it('the browser cannot create a user root or alter its security lock', async () => {
  await assertFails(setDoc(doc(other, `users/${OTHER}`), {
    userId: OTHER,
    name: null,
    role: null,
    company: null,
    bio: null,
    resumeText: null,
    targetIndustries: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertFails(getDoc(doc(owner, `_accountSecurity/${OWNER}`)));
  await assertFails(updateDoc(
    doc(owner, `_accountSecurity/${OWNER}`),
    { revokedAfterSeconds: 0 },
  ));
});

await it('user-root chronology is server-timestamped and createdAt is immutable', async () => {
  const userRef = doc(owner, `users/${OWNER}`);
  await assertSucceeds(updateDoc(userRef, {
    name: 'Devarshi Dalal',
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(userRef, {
    createdAt: new Date('2026-07-02T00:00:00.000Z'),
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(userRef, {
    name: 'Forged chronology',
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  }));
  await assertFails(updateDoc(userRef, {
    name: 'Missing timestamp refresh',
  }));
});

await it('a stranger cannot read the owner user document', async () => {
  await assertFails(getDoc(doc(anon, `users/${OWNER}`)));
});

await it('another signed-in user cannot read the owner user document', async () => {
  await assertFails(getDoc(doc(other, `users/${OWNER}`)));
});

await it('another user cannot list the owner\'s contacts', async () => {
  await assertFails(getDocs(
    collection(other, `users/${OWNER}/contacts`),
  ));
});

await it('another user cannot read integration status', async () => {
  await assertFails(getDoc(
    doc(other, `users/${OWNER}/integrations/gmail`),
  ));
});

await it('another user cannot write into the owner\'s contacts', async () => {
  await assertFails(addDoc(
    collection(other, `users/${OWNER}/contacts`),
    { name: 'Injected' },
  ));
});

await it('the owner can read their own contacts', async () => {
  await assertSucceeds(getDocs(
    collection(owner, `users/${OWNER}/contacts`),
  ));
});

await it('contact normalized email must exactly match the stored email', async () => {
  await assertSucceeds(setDoc(
    doc(owner, `users/${OWNER}/contacts/canonical-email`),
    canonicalContact({
      name: 'Canonical Email',
      email: 'person@example.com',
      normalizedEmail: 'person@example.com',
    }),
  ));
  await assertSucceeds(setDoc(
    doc(owner, `users/${OWNER}/contacts/blank-email`),
    canonicalContact({
      name: 'No Email',
    }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/contacts/mismatched-email`),
    canonicalContact({
      name: 'Mismatched Email',
      email: 'person@example.com',
      normalizedEmail: 'other@example.com',
    }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/contacts/null-email`),
    canonicalContact({
      name: 'Null Canonical Email',
      normalizedEmail: null,
    }),
  ));
});

await it('profile revisions and profile fields are Admin-API-only after creation', async () => {
  const contactRef = doc(
    owner,
    `users/${OWNER}/contacts/revision-contact`,
  );
  await assertSucceeds(setDoc(
    contactRef,
    canonicalContact({
      name: 'Canonical Email',
    }),
  ));
  await assertFails(updateDoc(contactRef, {
    company: 'Unversioned Company',
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(contactRef, {
    company: 'Versioned Company',
    profileRevision: 1,
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(contactRef, {
    role: 'Stale Writer',
    profileRevision: 1,
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(contactRef, {
    aiAllowed: false,
    privacyUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
});

await it('the owner can write their own commitments', async () => {
  await assertSucceeds(addDoc(
    collection(owner, `users/${OWNER}/commitments`),
    {
      contactId: 'c1',
      contactName: 'Sarah',
      text: 'Send the deck',
      dueHint: null,
      owedBy: 'you',
      status: 'open',
      sourceType: 'note',
      sourceId: null,
      aiGrounding: null,
      feedback: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  ));
});

await it('a server purge fence blocks contact restore and every linked browser write', async () => {
  const purgingContact = doc(
    owner,
    `users/${OWNER}/contacts/c-purging`,
  );
  await assertFails(updateDoc(purgingContact, {
    lifecycleStatus: 'active',
    purgeEligibleAt: null,
  }));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/contacts/forged-fence`),
    {
      name: 'Forged fence',
      purgeFence: {
        requestId: 'forged-fence',
        leaseId: 'browser-lease',
      },
    },
  ));

  for (const collectionName of [
    'notes',
    'outreaches',
    'commitments',
    'threads',
    'voiceEnrichmentJobs',
  ]) {
    await assertFails(setDoc(
      doc(
        owner,
        `users/${OWNER}/${collectionName}/blocked-${collectionName}`,
      ),
      {
        contactId: 'c-purging',
        content: 'must not race the purge worker',
      },
    ));
  }

  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/connections/blocked-source-edge`),
    {
      sourceId: 'c-purging',
      targetId: 'c1',
      type: 'must not race the purge worker',
    },
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/connections/blocked-target-edge`),
    {
      sourceId: 'c1',
      targetId: 'c-purging',
      type: 'must not race the purge worker',
    },
  ));
  const purgingConnection = doc(
    owner,
    `users/${OWNER}/connections/purging-connection`,
  );
  await assertFails(updateDoc(purgingConnection, {
    type: 'must not change during purge',
  }));
  await assertFails(deleteDoc(purgingConnection));

  await assertFails(setDoc(
    doc(
      owner,
      `users/${OWNER}/commitmentFeedbackEvents/feedback-during-purge`,
    ),
    {
      id: 'feedback-during-purge',
      commitmentId: 'feedback-purge-target',
      actorUid: OWNER,
      occurredAt: '2026-07-29T12:00:00.000Z',
      source: 'user-explicit',
      kind: 'completed',
      recordedAt: serverTimestamp(),
    },
  ));

  const existingNote = doc(
    owner,
    `users/${OWNER}/notes/purging-contact-note`,
  );
  await assertFails(updateDoc(existingNote, {
    content: 'must not change during purge',
  }));
  await assertFails(deleteDoc(existingNote));

  await assertFails(addDoc(
    collection(owner, `users/${OWNER}/contacts/c-purging/facts`),
    {
      predicate: 'identity.company',
      value: 'Too late',
      normalizedValue: 'too late',
      sourceType: 'profile',
      sourceId: 'c-purging',
      observedAt: serverTimestamp(),
      confidence: 1,
      current: true,
      aiAllowed: true,
      correctionOf: null,
      supersededBy: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  ));
  await assertFails(addDoc(
    collection(owner, `users/${OWNER}/contacts/c-purging/jobHistory`),
    {
      role: 'Engineer',
      company: 'Too Late Co',
      location: '',
      startedAt: null,
      endedAt: null,
      current: true,
      sourceType: 'profile',
      sourceId: 'c-purging',
      correctionOf: null,
      supersededBy: null,
      recordedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      immutableProvenance: {
        sourceType: 'profile',
        sourceId: 'c-purging',
        recordedByUid: OWNER,
      },
    },
  ));
  await assertFails(addDoc(
    collection(owner, `users/${OWNER}/contactEvents`),
    {
      actorUid: OWNER,
      contactId: 'c-purging',
      type: 'restored',
      sourceType: 'contact-management',
      sourceId: null,
      payload: {},
      immutable: true,
      occurredAt: serverTimestamp(),
    },
  ));
});

await it('browser writes cannot forge or break merge recovery metadata', async () => {
  const observedAt = new Date('2026-07-20T12:00:00.000Z');
  await assertSucceeds(setDoc(
    doc(owner, `users/${OWNER}/connections/c1--c2`),
    {
      userId: OWNER,
      sourceId: 'c1',
      targetId: 'c2',
      type: 'user-recorded introduction path',
      inferred: false,
      direction: 'mutual',
      strength: 0.6,
      weight: 3,
      willingness: 'unknown',
      lastInteractionAt: observedAt,
      activeIntroductionRequests: null,
      introductionCapacity: null,
      introductionRequestsLast90Days: null,
      lastIntroductionRequestAt: null,
      conflicts: [],
      mutualContext: null,
      provenance: {
        sourceType: 'user-correction',
        sourceId: 'connection:c1--c2',
        observedAt,
      },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/connections/forged-merge-edge`),
    {
      userId: OWNER,
      sourceId: 'c1',
      targetId: 'c2',
      type: 'user-recorded introduction path',
      inferred: false,
      direction: 'mutual',
      strength: 0.6,
      weight: 3,
      willingness: 'unknown',
      lastInteractionAt: observedAt,
      activeIntroductionRequests: null,
      introductionCapacity: null,
      introductionRequestsLast90Days: null,
      lastIntroductionRequestAt: null,
      conflicts: [],
      mutualContext: null,
      provenance: {
        sourceType: 'user-correction',
        sourceId: 'connection:forged-merge-edge',
        observedAt,
      },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      contactMergeOperationId: 'forged-operation',
      migratedFromContactId: 'forged-contact',
    },
  ));
  const migrated = doc(
    owner,
    `users/${OWNER}/connections/migrated-connection`,
  );
  await assertFails(updateDoc(migrated, {
    sourceId: 'c2',
    targetId: 'c1',
  }));
  await assertFails(updateDoc(migrated, {
    contactMergeOperationId: null,
  }));
  await assertFails(deleteDoc(migrated));
  await assertFails(updateDoc(migrated, {
    type: 'edited without breaking recovery',
  }));
});

await it('an unverified owner can read private data but cannot write it', async () => {
  await assertSucceeds(getDoc(
    doc(unverifiedOwner, `users/${OWNER}/contacts/c1`),
  ));
  await assertFails(addDoc(
    collection(unverifiedOwner, `users/${OWNER}/notes`),
    { content: 'should not persist' },
  ));
});

await it('the browser cannot delete the account root document', async () => {
  await assertFails(deleteDoc(doc(owner, `users/${OWNER}`)));
});

await it('the owner can append a shape-valid contact event', async () => {
  await assertSucceeds(addDoc(
    collection(owner, `users/${OWNER}/contactEvents`),
    {
      actorUid: OWNER,
      contactId: 'c1',
      type: 'archived',
      sourceType: 'contact-management',
      sourceId: null,
      payload: {},
      immutable: true,
      occurredAt: serverTimestamp(),
    },
  ));
});

await it('browser contact events cannot smuggle merge-linked contact ids', async () => {
  await assertFails(addDoc(
    collection(owner, `users/${OWNER}/contactEvents`),
    {
      actorUid: OWNER,
      contactId: 'c1',
      type: 'archived',
      sourceType: 'contact-management',
      sourceId: null,
      payload: {
        duplicateContactId: 'c-purging',
      },
      immutable: true,
      occurredAt: serverTimestamp(),
    },
  ));
});

await it('a browser cannot forge a worker-authored contact event', async () => {
  await assertFails(addDoc(
    collection(owner, `users/${OWNER}/contactEvents`),
    {
      actorUid: OWNER,
      contactId: 'c1',
      type: 'merge-recovered',
      sourceType: 'contact-management-worker',
      sourceId: 'forged-operation',
      payload: { protocolVersion: 1 },
      immutable: true,
      occurredAt: serverTimestamp(),
    },
  ));
});

await it('merge completion remains Admin-authored even with browser-shaped provenance', async () => {
  await assertFails(addDoc(
    collection(owner, `users/${OWNER}/contactEvents`),
    {
      actorUid: OWNER,
      contactId: 'c1',
      type: 'merge-completed',
      sourceType: 'contact-management',
      sourceId: 'forged-merge',
      payload: {},
      immutable: true,
      occurredAt: serverTimestamp(),
    },
  ));
});

await it('a contact event cannot impersonate another actor', async () => {
  await assertFails(addDoc(
    collection(owner, `users/${OWNER}/contactEvents`),
    {
      actorUid: OTHER,
      contactId: 'c1',
      type: 'archived',
      immutable: true,
      occurredAt: serverTimestamp(),
    },
  ));
});

await it('contact events are append-only even for their owner', async () => {
  const eventRef = doc(
    owner,
    `users/${OWNER}/contactEvents/immutable-event`,
  );
  await assertFails(updateDoc(eventRef, { type: 'rewritten' }));
  await assertFails(deleteDoc(eventRef));
});

await it('privacy policy events are append-only', async () => {
  const eventRef = doc(
    owner,
    `users/${OWNER}/privacyPolicyEvents/privacy-event`,
  );
  await assertFails(updateDoc(eventRef, { kind: 'rewritten' }));
  await assertFails(deleteDoc(eventRef));
});

await it('privacy policy audit events accept only the current bounded schema', async () => {
  const validEvent = {
    schemaVersion: 1,
    kind: 'privacy-policy-replaced',
    policy: {
      schemaVersion: 1,
      defaultRetentionMode: 'days',
      defaultRetentionDays: 30,
      defaultAIUse: 'never',
      boundaries: [],
    },
    actorUid: OWNER,
    recordedAt: serverTimestamp(),
  };
  await assertSucceeds(setDoc(
    doc(owner, `users/${OWNER}/privacyPolicyEvents/valid-policy-event`),
    validEvent,
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/privacyPolicyEvents/extra-policy-field`),
    {
      ...validEvent,
      rawSourceContent: 'must never enter an audit event',
    },
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/privacyPolicyEvents/unbounded-policy`),
    {
      ...validEvent,
      policy: {
        ...validEvent.policy,
        defaultRetentionDays: 0,
      },
    },
  ));
});

await it('commitment feedback events are append-only', async () => {
  const eventRef = doc(
    owner,
    `users/${OWNER}/commitmentFeedbackEvents/feedback-event`,
  );
  await assertFails(updateDoc(eventRef, { kind: 'rewritten' }));
  await assertFails(deleteDoc(eventRef));
});

await it('commitment feedback audit events are path-bound and variant-exact', async () => {
  const validEvent = {
    id: 'feedback-completed',
    commitmentId: 'feedback-target',
    actorUid: OWNER,
    occurredAt: '2026-07-29T12:00:00.000Z',
    source: 'user-explicit',
    kind: 'completed',
    recordedAt: serverTimestamp(),
  };
  await assertSucceeds(setDoc(
    doc(
      owner,
      `users/${OWNER}/commitmentFeedbackEvents/feedback-completed`,
    ),
    validEvent,
  ));
  await assertFails(setDoc(
    doc(
      owner,
      `users/${OWNER}/commitmentFeedbackEvents/different-event-id`,
    ),
    validEvent,
  ));
  await assertFails(setDoc(
    doc(
      owner,
      `users/${OWNER}/commitmentFeedbackEvents/feedback-extra-field`,
    ),
    {
      ...validEvent,
      id: 'feedback-extra-field',
      providerPayload: 'must not persist',
    },
  ));
  await assertFails(setDoc(
    doc(
      owner,
      `users/${OWNER}/commitmentFeedbackEvents/feedback-bad-source`,
    ),
    {
      ...validEvent,
      id: 'feedback-bad-source',
      source: 'system-inferred',
    },
  ));
});

await it('the owner can enqueue but cannot rewrite a purge request', async () => {
  const requestRef = doc(
    owner,
    `users/${OWNER}/contactPurgeRequests/c1`,
  );
  await assertSucceeds(setDoc(requestRef, {
    actorUid: OWNER,
    contactId: 'c1',
    status: 'queued',
    plan: {
      contactId: 'c1',
      eligible: true,
      eligibleAt: new Date(Date.now() - 1_000),
      collectionPaths: [
        `users/${OWNER}/contacts/c1/facts`,
        `users/${OWNER}/contacts/c1/jobHistory`,
        `users/${OWNER}/contacts/c1`,
      ],
      relatedCollections: [
        'note',
        'outreach',
        'commitment',
        'commitment-feedback',
        'thread',
        'voice-enrichment',
        'connection',
        'contact-event',
      ],
      requiresServerExecution: true,
    },
    requiresServerExecution: true,
    requestedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(requestRef, { status: 'completed' }));
  await assertFails(deleteDoc(requestRef));
});

await it('a purge request cannot target a different contact id', async () => {
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/contactPurgeRequests/c2`),
    {
      actorUid: OWNER,
      contactId: 'c1',
      status: 'queued',
      requiresServerExecution: true,
      requestedAt: serverTimestamp(),
    },
  ));
});

await it('the owner can enqueue but cannot rewrite merge recovery', async () => {
  const requestRef = doc(
    owner,
    `users/${OWNER}/contactMergeRecoveryRequests/merge-1`,
  );
  await assertSucceeds(setDoc(requestRef, {
    actorUid: OWNER,
    operationId: 'merge-1',
    primaryContactId: 'c1',
      duplicateContactId: 'c2',
      status: 'queued',
      requiresServerExecution: true,
      recoveryProtocolVersion: 1,
      requestedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(requestRef, { status: 'completed' }));
  await assertFails(deleteDoc(requestRef));
});

await it('merge operation receipts are readable by their owner but Admin-only to write', async () => {
  const existingRef = doc(
    owner,
    `users/${OWNER}/contactMergeOperations/server-merge-operation`,
  );
  const forgedRef = doc(
    owner,
    `users/${OWNER}/contactMergeOperations/browser-merge-operation`,
  );
  await assertSucceeds(getDoc(existingRef));
  await assertFails(getDoc(doc(
    other,
    `users/${OWNER}/contactMergeOperations/server-merge-operation`,
  )));
  await assertFails(setDoc(forgedRef, {
    operationId: 'browser-merge-operation',
    actorUid: OWNER,
    primaryContactId: 'c1',
    duplicateContactId: 'c2',
    status: 'completed',
    immutable: true,
  }));
  await assertFails(updateDoc(existingRef, { status: 'recovered' }));
  await assertFails(deleteDoc(existingRef));
});

await it('contacts and immutable history cannot be hard-deleted by a browser', async () => {
  const factRef = await addDoc(
    collection(owner, `users/${OWNER}/contacts/c1/facts`),
    {
      predicate: 'identity.role',
      value: 'Founder',
      normalizedValue: 'founder',
      sourceType: 'profile',
      sourceId: 'c1',
      observedAt: serverTimestamp(),
      confidence: 1,
      current: true,
      aiAllowed: true,
      correctionOf: null,
      supersededBy: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  );
  await assertFails(deleteDoc(doc(owner, `users/${OWNER}/contacts/c1`)));
  await assertFails(deleteDoc(factRef));
});

await it('the owner can write nested temporal facts for their own contact', async () => {
  await assertSucceeds(addDoc(
    collection(owner, `users/${OWNER}/contacts/c1/facts`),
    {
      predicate: 'identity.company',
      value: 'Cirqle',
      normalizedValue: 'cirqle',
      sourceType: 'profile',
      sourceId: 'c1',
      observedAt: serverTimestamp(),
      confidence: 1,
      current: true,
      aiAllowed: true,
      correctionOf: null,
      supersededBy: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  ));
});

await it('note, meeting, import, and voice facts accept only their exact browser provenance shapes', async () => {
  const allowedPredicates = {
    note: ['relationship.note'],
    meeting: [
      'meeting.date',
      'meeting.discussed',
      'meeting.promised',
      'meeting.nextSteps',
    ],
    import: [
      'identity.name',
      'identity.email',
      'identity.phone',
      'identity.company',
      'identity.role',
      'identity.location',
      'identity.linkedinUrl',
      'relationship.tier',
      'relationship.whyTheyMatter',
      'identity.summary',
      'identity.industry',
      'identity.subIndustry',
      'identity.school',
      'identity.seniority',
      'relationship.connectionSource',
      'relationship.tags',
    ],
    voice: ['relationship.voiceMemo', 'meeting.title'],
  };

  for (const [sourceType, predicates] of Object.entries(allowedPredicates)) {
    const sourceId = `${sourceType}-source-record`;
    for (const [index, predicate] of predicates.entries()) {
      await assertSucceeds(setDoc(
        doc(
          owner,
          `users/${OWNER}/contacts/c1/facts/${sourceType}-valid-${index}`,
        ),
        {
          predicate,
          value: `Explicit ${sourceType} value ${index}`,
          normalizedValue: `explicit ${sourceType} value ${index}`,
          sourceType,
          sourceId,
          observedAt: new Date('2026-07-29T14:30:00.000Z'),
          confidence: 1,
          current: true,
          // Privacy can be disabled at creation without corrupting provenance.
          aiAllowed: false,
          correctionOf: null,
          supersededBy: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
      ));
    }
  }
});

await it('temporal facts reject empty sources and predicates from a different provenance type', async () => {
  const fact = (sourceType, sourceId, predicate) => ({
    predicate,
    value: 'Explicit user-provided evidence',
    normalizedValue: 'explicit user-provided evidence',
    sourceType,
    sourceId,
    observedAt: new Date('2026-07-29T14:30:00.000Z'),
    confidence: 1,
    current: true,
    aiAllowed: true,
    correctionOf: null,
    supersededBy: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  const corruptions = [
    fact('note', null, 'relationship.note'),
    fact('meeting', '', 'meeting.discussed'),
    fact('import', null, 'identity.company'),
    fact('voice', '', 'relationship.voiceMemo'),
    fact('note', 'note-source', 'meeting.discussed'),
    fact('meeting', 'meeting-source', 'identity.email'),
    fact('import', 'import-source', 'relationship.voiceMemo'),
    fact('voice', 'voice-source', 'identity.company'),
  ];

  for (const [index, payload] of corruptions.entries()) {
    await assertFails(setDoc(
      doc(owner, `users/${OWNER}/contacts/c1/facts/corrupt-source-${index}`),
      payload,
    ));
  }
});

await it('foreign users cannot inject a correctly shaped source fact', async () => {
  await assertFails(setDoc(
    doc(other, `users/${OWNER}/contacts/c1/facts/foreign-note-fact`),
    {
      predicate: 'relationship.note',
      value: 'Foreign note',
      normalizedValue: 'foreign note',
      sourceType: 'note',
      sourceId: 'foreign-note-source',
      observedAt: new Date('2026-07-29T14:30:00.000Z'),
      confidence: 1,
      current: true,
      aiAllowed: false,
      correctionOf: null,
      supersededBy: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  ));
});

await it('source fact timestamps and immutable shape cannot be forged', async () => {
  const valid = {
    predicate: 'relationship.note',
    value: 'Owner note',
    normalizedValue: 'owner note',
    sourceType: 'note',
    sourceId: 'owner-note-source',
    observedAt: new Date('2026-07-29T14:30:00.000Z'),
    confidence: 1,
    current: true,
    aiAllowed: true,
    correctionOf: null,
    supersededBy: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/contacts/c1/facts/forged-created-at`),
    {
      ...valid,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    },
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/contacts/c1/facts/extra-fact-field`),
    {
      ...valid,
      claimedOwnerUid: OTHER,
    },
  ));
});

await it('a browser cannot claim system provenance for a temporal fact', async () => {
  await assertFails(addDoc(
    collection(owner, `users/${OWNER}/contacts/c1/facts`),
    {
      predicate: 'identity.company',
      value: 'Forged system fact',
      normalizedValue: 'forged system fact',
      sourceType: 'system',
      sourceId: null,
      observedAt: serverTimestamp(),
      confidence: 1,
      current: true,
      aiAllowed: true,
      correctionOf: null,
      supersededBy: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  ));
});

await it('user-correction provenance must identify a prior fact', async () => {
  await assertFails(addDoc(
    collection(owner, `users/${OWNER}/contacts/c1/facts`),
    {
      predicate: 'identity.company',
      value: 'Unbound correction',
      normalizedValue: 'unbound correction',
      sourceType: 'user-correction',
      sourceId: 'c1',
      observedAt: serverTimestamp(),
      confidence: 1,
      current: true,
      aiAllowed: true,
      correctionOf: null,
      supersededBy: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  ));
});

await it('a correction must atomically supersede its exact prior fact', async () => {
  const targetRef = doc(
    owner,
    `users/${OWNER}/contacts/c1/facts/correction-target`,
  );
  const correctionRef = doc(
    owner,
    `users/${OWNER}/contacts/c1/facts/correction-successor`,
  );
  const target = {
    predicate: 'identity.role',
    value: 'Engineer',
    normalizedValue: 'engineer',
    sourceType: 'profile',
    sourceId: 'c1',
    observedAt: serverTimestamp(),
    confidence: 1,
    current: true,
    aiAllowed: true,
    correctionOf: null,
    supersededBy: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  const correction = {
    predicate: 'identity.role',
    value: 'Founder',
    normalizedValue: 'founder',
    sourceType: 'user-correction',
    sourceId: targetRef.id,
    observedAt: serverTimestamp(),
    confidence: 1,
    current: true,
    aiAllowed: true,
    correctionOf: targetRef.id,
    supersededBy: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await assertSucceeds(setDoc(targetRef, target));
  await assertFails(setDoc(correctionRef, correction));

  const batch = writeBatch(owner);
  batch.update(targetRef, {
    current: false,
    supersededBy: correctionRef.id,
    supersededAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.set(correctionRef, correction);
  await assertSucceeds(batch.commit());
});

await it('server-authored fact metadata remains immutable but does not block a correction', async () => {
  const targetRef = doc(
    owner,
    `users/${OWNER}/contacts/c1/facts/recovery-metadata-target`,
  );
  const correctionRef = doc(
    owner,
    `users/${OWNER}/contacts/c1/facts/recovery-metadata-successor`,
  );
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(
      doc(
        context.firestore(),
        `users/${OWNER}/contacts/c1/facts/recovery-metadata-target`,
      ),
      {
        predicate: 'identity.summary',
        value: 'Recovered summary',
        normalizedValue: 'recovered summary',
        sourceType: 'profile',
        sourceId: 'recovery:merge-operation',
        observedAt: new Date('2026-07-29T14:30:00.000Z'),
        confidence: 1,
        current: true,
        aiAllowed: false,
        correctionOf: null,
        supersededBy: null,
        contactMergeRecoveryOperationId: 'merge-operation',
        createdAt: new Date('2026-07-29T14:30:00.000Z'),
        updatedAt: new Date('2026-07-29T14:30:00.000Z'),
      },
    );
  });

  await assertFails(updateDoc(targetRef, {
    contactMergeRecoveryOperationId: 'forged-operation',
    updatedAt: serverTimestamp(),
  }));

  const batch = writeBatch(owner);
  batch.update(targetRef, {
    current: false,
    supersededBy: correctionRef.id,
    supersededAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.set(correctionRef, {
    predicate: 'identity.summary',
    value: 'Reviewed summary',
    normalizedValue: 'reviewed summary',
    sourceType: 'user-correction',
    sourceId: targetRef.id,
    observedAt: serverTimestamp(),
    confidence: 1,
    current: true,
    aiAllowed: false,
    correctionOf: targetRef.id,
    supersededBy: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  await assertSucceeds(batch.commit());
});

await it('a superseded fact cannot be reactivated or redirected', async () => {
  const factRef = doc(
    owner,
    `users/${OWNER}/contacts/c1/facts/monotonic-fact`,
  );
  await assertSucceeds(setDoc(factRef, {
    predicate: 'identity.company',
    value: 'Cirqle',
    normalizedValue: 'cirqle',
    sourceType: 'profile',
    sourceId: 'c1',
    observedAt: serverTimestamp(),
    confidence: 1,
    current: true,
    aiAllowed: true,
    correctionOf: null,
    supersededBy: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(factRef, {
    current: false,
    supersededBy: 'successor-fact',
    supersededAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(factRef, {
    current: true,
    supersededBy: null,
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(factRef, {
    supersededBy: 'different-successor',
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(factRef, {
    aiAllowed: false,
    privacyUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
});

await it('a verified owner can register and refresh a privacy-safe browser session', async () => {
  const sessionId = '0123456789abcdef0123456789abcdef';
  const sessionRef = doc(
    owner,
    `users/${OWNER}/sessions/${sessionId}`,
  );
  await assertSucceeds(setDoc(sessionRef, {
    userId: OWNER,
    sessionId,
    deviceLabel: 'Chrome · Windows',
    browser: 'Chrome',
    platform: 'Windows',
    createdAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  }));
  await assertSucceeds(updateDoc(sessionRef, {
    lastSeenAt: serverTimestamp(),
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  }));
  await assertSucceeds(deleteDoc(sessionRef));
});

await it('session records cannot contain fingerprints or cross-user identities', async () => {
  const sessionId = 'abcdef0123456789abcdef0123456789';
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/sessions/${sessionId}`),
    {
      userId: OTHER,
      sessionId,
      deviceLabel: 'Chrome · Windows',
      browser: 'Chrome',
      platform: 'Windows',
      fullUserAgent: 'must not be stored',
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  ));
});

await it('unverified and other users cannot write or read owner sessions', async () => {
  const sessionId = 'fedcba9876543210fedcba9876543210';
  const shape = {
    userId: OWNER,
    sessionId,
    deviceLabel: 'Firefox · Linux',
    browser: 'Firefox',
    platform: 'Linux',
    createdAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  };
  await assertFails(setDoc(
    doc(
      unverifiedOwner,
      `users/${OWNER}/sessions/${sessionId}`,
    ),
    shape,
  ));
  await assertFails(getDocs(
    collection(other, `users/${OWNER}/sessions`),
  ));
});

describe('oauthTokens/{uid} - server-only refresh tokens');

await it('the token owner cannot read their own refresh token', async () => {
  await assertFails(getDoc(doc(owner, `oauthTokens/${OWNER}`)));
});

await it('a stranger cannot read a refresh token', async () => {
  await assertFails(getDoc(doc(anon, `oauthTokens/${OWNER}`)));
});

await it('nobody can write a refresh token from a client', async () => {
  await assertFails(setDoc(
    doc(owner, `oauthTokens/${OWNER}`),
    { refreshToken: 'stolen' },
  ));
});

await env.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failing: ${failures.join('; ')}`);
  process.exit(1);
}

// Adding a contact writes the contact and its derived profile facts in ONE
// atomic batch (src/pages/Directory.tsx). Rules evaluate each write in a batch
// against committed state, so an `exists()` check on the parent could not see
// the contact being created beside the fact and denied the entire batch —
// production could not add a contact at all. Every fact test above seeds its
// contact first, so nothing covered the real client path.
await it('a contact and its derived facts commit in one batch', async () => {
  const batch = writeBatch(owner);
  const contactRef = doc(owner, `users/${OWNER}/contacts/batched-create`);
  batch.set(contactRef, canonicalContact({ name: 'Batched Create' }));
  batch.set(
    doc(owner, `users/${OWNER}/contacts/batched-create/facts/profile-company`),
    {
      predicate: 'identity.company',
      value: 'Northwind Analytics',
      normalizedValue: 'northwind analytics',
      sourceType: 'profile',
      sourceId: 'profile:batched-create',
      observedAt: serverTimestamp(),
      confidence: 1,
      current: true,
      aiAllowed: true,
      correctionOf: null,
      supersededBy: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  );
  await assertSucceeds(batch.commit());
});

// The batched-create allowance must not become a way to orphan a fact under a
// contact that is never created.
await it('a fact whose contact is never created is still denied', async () => {
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/contacts/no-such-contact/facts/orphan`),
    {
      predicate: 'identity.company',
      value: 'Nowhere',
      normalizedValue: 'nowhere',
      sourceType: 'profile',
      sourceId: 'profile:no-such-contact',
      observedAt: serverTimestamp(),
      confidence: 1,
      current: true,
      aiAllowed: true,
      correctionOf: null,
      supersededBy: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  ));
});

// A batch may not smuggle a linked write past the purge fence by writing the
// fence and the fact together: post-batch state is what is checked.
await it('a fact denied when the same batch fences its contact for purging', async () => {
  const batch = writeBatch(owner);
  const contactRef = doc(owner, `users/${OWNER}/contacts/fenced-in-batch`);
  batch.set(contactRef, canonicalContact({
    name: 'Fenced In Batch',
    purgeFence: {
      protocolVersion: 1,
      requestId: 'fenced-in-batch',
      leaseId: 'server-lease',
      acquiredAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1_000),
    },
  }));
  batch.set(
    doc(owner, `users/${OWNER}/contacts/fenced-in-batch/facts/sneaky`),
    {
      predicate: 'identity.company',
      value: 'Sneaky',
      normalizedValue: 'sneaky',
      sourceType: 'profile',
      sourceId: 'profile:fenced-in-batch',
      observedAt: serverTimestamp(),
      confidence: 1,
      current: true,
      aiAllowed: true,
      correctionOf: null,
      supersededBy: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  );
  await assertFails(batch.commit());
});
