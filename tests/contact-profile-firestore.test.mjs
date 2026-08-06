import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import {
  ContactProfileError,
  executeAdminContactProfileSave,
} from '../server/api/_lib/contact-profile.js';

const EMULATOR_AVAILABLE = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const PROJECT_ID = 'cirqle-contact-profile-test';
const NOW = new Date('2026-07-29T18:00:00.000Z');
const AUTH_TIME = Math.floor(NOW.getTime() / 1_000);
const app = EMULATOR_AVAILABLE
  ? initializeApp({ projectId: PROJECT_ID }, 'contact-profile-emulator-test')
  : null;
const db = app ? getFirestore(app) : null;

const PREDICATES = Object.freeze({
  name: 'identity.name',
  email: 'identity.email',
  phone: 'identity.phone',
  company: 'identity.company',
  role: 'identity.role',
  location: 'identity.location',
  linkedinUrl: 'identity.linkedinUrl',
  summary: 'identity.summary',
  relationshipTier: 'relationship.tier',
  industry: 'identity.industry',
  subIndustry: 'identity.subIndustry',
  school: 'identity.school',
  seniority: 'identity.seniority',
  connectionSource: 'relationship.connectionSource',
  whyTheyMatter: 'relationship.whyTheyMatter',
  tags: 'relationship.tags',
});

before(async () => {
  if (!EMULATOR_AVAILABLE) return;
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.equal(response.ok, true);
});

after(async () => {
  if (app) await deleteApp(app);
});

function profile(overrides = {}) {
  return {
    name: 'Before Name',
    email: 'before@example.com',
    phone: '+1 212 555 0100',
    company: 'Before Co',
    role: 'Engineer',
    location: 'New York',
    linkedinUrl: 'https://example.com/before',
    summary: 'Before summary',
    relationshipTier: 'Warm',
    industry: 'Software',
    subIndustry: 'CRM',
    school: 'Before University',
    seniority: 'Senior',
    connectionSource: 'Before Event',
    whyTheyMatter: 'Before context',
    tags: ['Before', 'Trusted'],
    ...overrides,
  };
}

function nextProfile(overrides = {}) {
  return profile({
    name: 'After Name',
    email: 'after@example.com',
    phone: '+1 646 555 0199',
    company: 'After Co',
    role: 'Founder',
    location: 'Brooklyn',
    linkedinUrl: 'https://example.com/after',
    summary: 'After summary',
    relationshipTier: 'Strong',
    industry: 'Technology',
    subIndustry: 'Relationship intelligence',
    school: 'After University',
    seniority: 'Founder',
    connectionSource: 'After Event',
    whyTheyMatter: 'After context',
    tags: ['After', 'Investor'],
    ...overrides,
  });
}

function fact(field, value, { aiAllowed = true } = {}) {
  const factValue = Array.isArray(value) ? value.join(', ') : String(value);
  return {
    predicate: PREDICATES[field],
    value: factValue,
    normalizedValue: factValue.toLocaleLowerCase(),
    sourceType: 'profile',
    sourceId: 'profile:contact',
    observedAt: Timestamp.fromDate(new Date('2026-07-01T00:00:00.000Z')),
    confidence: 1,
    current: true,
    aiAllowed,
    correctionOf: null,
    supersededBy: null,
    createdAt: Timestamp.fromDate(new Date('2026-07-01T00:00:00.000Z')),
    updatedAt: Timestamp.fromDate(new Date('2026-07-01T00:00:00.000Z')),
  };
}

async function seedOwner(uid) {
  await db.doc(`_accountSecurity/${uid}`).set({
    status: 'active',
    revokedAfterSeconds: 0,
  });
}

test(
  'Admin profile transaction atomically saves all fields beyond browser rule-call limits',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'all-fields-owner';
    const contactId = 'contact';
    const before = profile();
    await seedOwner(uid);
    await db.doc(`users/${uid}/contacts/${contactId}`).set({
      ...before,
      normalizedEmail: before.email,
      profileRevision: 3,
      lifecycleStatus: 'active',
      aiAllowed: true,
    });
    await Promise.all(
      Object.keys(PREDICATES).map((field) =>
        db
          .doc(
            `users/${uid}/contacts/${contactId}/facts/before-${field}`,
          )
          .set(
            fact(field, before[field], {
              aiAllowed: field !== 'company',
            }),
          ),
      ),
    );

    const result = await executeAdminContactProfileSave({
      db,
      uid,
      authTime: AUTH_TIME,
      input: {
        contactId,
        expectedProfileRevision: 3,
        profile: nextProfile(),
      },
      now: NOW,
    });
    assert.equal(result.profileRevision, 4);
    assert.equal(result.changedFields.length, 16);
    assert.equal(result.profileFactIds.length, 16);

    const [contact, currentFacts, eventSnapshot] = await Promise.all([
      db.doc(`users/${uid}/contacts/${contactId}`).get(),
      db
        .collection(`users/${uid}/contacts/${contactId}/facts`)
        .where('current', '==', true)
        .get(),
      db
        .collection(`users/${uid}/contactEvents`)
        .where('contactId', '==', contactId)
        .get(),
    ]);
    assert.equal(contact.data().profileRevision, 4);
    assert.equal(contact.data().company, 'After Co');
    assert.equal(currentFacts.size, 16);
    const company = currentFacts.docs.find(
      (document) => document.data().predicate === 'identity.company',
    );
    assert.equal(company.data().value, 'After Co');
    assert.equal(company.data().aiAllowed, false);
    assert.equal(company.data().correctionOf, 'before-company');
    assert.equal(eventSnapshot.size, 1);
    assert.deepEqual(
      Object.keys(eventSnapshot.docs[0].data().payload).sort(),
      [
        'changedFields',
        'jobHistoryEntryIds',
        'nextRevision',
        'previousRevision',
        'profileFactIds',
      ],
    );
  },
);
test(
  'concurrent edits produce one winner, one conflict, and one current fact',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'concurrent-owner';
    const contactId = 'contact';
    const before = profile({ company: '' });
    await seedOwner(uid);
    await db.doc(`users/${uid}/contacts/${contactId}`).set({
      ...before,
      normalizedEmail: before.email,
      profileRevision: 0,
      lifecycleStatus: 'active',
      aiAllowed: true,
    });
    const edit = (company) =>
      executeAdminContactProfileSave({
        db,
        uid,
        authTime: AUTH_TIME,
        input: {
          contactId,
          expectedProfileRevision: 0,
          profile: profile({ company }),
        },
        now: NOW,
      });
    const outcomes = await Promise.allSettled([
      edit('First Co'),
      edit('Second Co'),
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
    );
    const rejected = outcomes.find(
      (outcome) => outcome.status === 'rejected',
    );
    assert.ok(rejected.reason instanceof ContactProfileError);
    assert.equal(rejected.reason.code, 'contact_profile_conflict');

    const current = await db
      .collection(`users/${uid}/contacts/${contactId}/facts`)
      .where('predicate', '==', 'identity.company')
      .where('current', '==', true)
      .get();
    assert.equal(current.size, 1);
  },
);

test(
  'unrelated current facts do not block a targeted profile edit',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'many-notes-owner';
    const contactId = 'contact';
    const before = profile();
    await seedOwner(uid);
    await db.doc(`users/${uid}/contacts/${contactId}`).set({
      ...before,
      normalizedEmail: before.email,
      profileRevision: 0,
      lifecycleStatus: 'active',
      aiAllowed: true,
    });
    const writes = [];
    for (let index = 0; index < 120; index += 1) {
      writes.push(
        db
          .doc(
            `users/${uid}/contacts/${contactId}/facts/note-${index}`,
          )
          .set({
            ...fact('company', `Note ${index}`),
            predicate: 'relationship.note',
            sourceType: 'note',
            sourceId: `note-${index}`,
          }),
      );
    }
    await Promise.all(writes);

    const result = await executeAdminContactProfileSave({
      db,
      uid,
      authTime: AUTH_TIME,
      input: {
        contactId,
        expectedProfileRevision: 0,
        profile: profile({ whyTheyMatter: 'Updated context' }),
      },
      now: NOW,
    });
    assert.deepEqual(result.changedFields, ['whyTheyMatter']);
  },
);

test(
  'pending legacy fact sync fails closed without mutating the contact',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'pending-owner';
    const contactId = 'contact';
    const before = profile();
    await seedOwner(uid);
    await db.doc(`users/${uid}/contacts/${contactId}`).set({
      ...before,
      normalizedEmail: before.email,
      profileRevision: 2,
      lifecycleStatus: 'active',
      factSyncPending: { before: {}, after: {} },
    });
    await assert.rejects(
      executeAdminContactProfileSave({
        db,
        uid,
        authTime: AUTH_TIME,
        input: {
          contactId,
          expectedProfileRevision: 2,
          profile: nextProfile(),
        },
        now: NOW,
      }),
      (error) =>
        error instanceof ContactProfileError &&
        error.code === 'contact_profile_fact_recovery_required',
    );
    const contact = await db
      .doc(`users/${uid}/contacts/${contactId}`)
      .get();
    assert.equal(contact.data().profileRevision, 2);
    assert.equal(contact.data().name, 'Before Name');
  },
);
