/**
 * Firestore security rules — executable spec.
 *
 * Run with `npm test`, which wraps this in `firebase emulators:exec` so the
 * emulator is started and torn down for you. No manual setup, and it does not
 * collide with a dev emulator: firebase.test.json pins its own ports.
 *
 * WHY THIS EXISTS AS A COMMITTED SUITE
 *
 * `cards/{cardId}` and `cards/{cardId}/captures/{id}` are the only genuinely
 * public surface in the app, and captures accept writes from *unauthenticated*
 * strangers. That is the sort of thing that is fine the day it ships and
 * quietly stops being fine three refactors later. A rules change that opened
 * capture enumeration, or let a stranger overwrite someone's card, would
 * otherwise be invisible until it mattered.
 *
 * Each test states the property in plain English, so a failure names the thing
 * that broke rather than a line number in a .rules file.
 */
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, setDoc, getDoc, addDoc, collection, getDocs, deleteDoc, updateDoc,
} from 'firebase/firestore';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

const OWNER = 'owner-uid';
const OTHER = 'other-uid';
const CARD = 'abc123xyz9';

let passed = 0;
let failed = 0;
const failures = [];

async function it(name, fn) {
  try {
    await fn();
    console.log(`  [32mPASS[0m  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  [31mFAIL[0m  ${name}`);
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

// Seed with rules disabled — this is fixture setup, not behaviour under test.
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, `cards/${CARD}`), {
    cardId: CARD, ownerUid: OWNER, name: 'Devarshi', published: true,
  });
  await setDoc(doc(db, `users/${OWNER}`), { name: 'Devarshi', apiKey: 'secret-key' });
  await setDoc(doc(db, `users/${OWNER}/contacts/c1`), { name: 'Sarah' });
  await setDoc(doc(db, `users/${OWNER}/integrations/gmail`), { connected: true });
  await setDoc(doc(db, `cards/${CARD}/captures/seeded`), {
    visitorName: 'Seeded Visitor', visitorEmail: null, visitorCompany: null,
    note: null, capturedAt: new Date(), processed: false,
  });
});

const anon = env.unauthenticatedContext().firestore();
const owner = env.authenticatedContext(OWNER).firestore();
const other = env.authenticatedContext(OTHER).firestore();

const validCapture = {
  visitorName: 'Alex Rivera',
  visitorEmail: null,
  visitorCompany: null,
  note: null,
  capturedAt: new Date(),
  processed: false,
};

describe('cards/{cardId} — the public card page');

await it('a stranger with the link can read a published card', async () => {
  await assertSucceeds(getDoc(doc(anon, `cards/${CARD}`)));
});

await it('a stranger cannot overwrite someone’s card', async () => {
  await assertFails(setDoc(doc(anon, `cards/${CARD}`), { name: 'Hacked' }, { merge: true }));
});

await it('a different signed-in user cannot overwrite the card', async () => {
  await assertFails(setDoc(doc(other, `cards/${CARD}`), { name: 'Hacked' }, { merge: true }));
});

await it('a different signed-in user cannot delete the card', async () => {
  await assertFails(deleteDoc(doc(other, `cards/${CARD}`)));
});

await it('the owner can update their own card', async () => {
  await assertSucceeds(setDoc(doc(owner, `cards/${CARD}`), { intro: 'hello' }, { merge: true }));
});

await it('nobody can reassign ownerUid to steal a card', async () => {
  await assertFails(updateDoc(doc(other, `cards/${CARD}`), { ownerUid: OTHER }));
});

await it('creating a card for someone else is rejected', async () => {
  await assertFails(setDoc(doc(other, 'cards/newcard01'), { cardId: 'newcard01', ownerUid: OWNER }));
});

describe('cards/{cardId}/captures — unauthenticated reverse capture');

await it('a stranger can leave a capture (this is the whole feature)', async () => {
  await assertSucceeds(addDoc(collection(anon, `cards/${CARD}/captures`), validCapture));
});

await it('a capture with an empty name is rejected', async () => {
  await assertFails(addDoc(collection(anon, `cards/${CARD}/captures`), { ...validCapture, visitorName: '' }));
});

await it('an over-long name is rejected (120 char cap)', async () => {
  await assertFails(addDoc(collection(anon, `cards/${CARD}/captures`), { ...validCapture, visitorName: 'x'.repeat(200) }));
});

await it('an over-long note is rejected (500 char cap)', async () => {
  await assertFails(addDoc(collection(anon, `cards/${CARD}/captures`), { ...validCapture, note: 'x'.repeat(600) }));
});

await it('an unexpected extra field is rejected', async () => {
  await assertFails(addDoc(collection(anon, `cards/${CARD}/captures`), { ...validCapture, isAdmin: true }));
});

await it('a capture pre-marked processed:true is rejected', async () => {
  await assertFails(addDoc(collection(anon, `cards/${CARD}/captures`), { ...validCapture, processed: true }));
});

await it('a non-string name is rejected', async () => {
  await assertFails(addDoc(collection(anon, `cards/${CARD}/captures`), { ...validCapture, visitorName: 42 }));
});

await it('a stranger cannot enumerate who else tapped', async () => {
  await assertFails(getDocs(collection(anon, `cards/${CARD}/captures`)));
});

await it('a stranger cannot read a single capture by id', async () => {
  await assertFails(getDoc(doc(anon, `cards/${CARD}/captures/seeded`)));
});

await it('a different signed-in user cannot enumerate captures', async () => {
  await assertFails(getDocs(collection(other, `cards/${CARD}/captures`)));
});

await it('a stranger cannot edit a capture after leaving it', async () => {
  await assertFails(updateDoc(doc(anon, `cards/${CARD}/captures/seeded`), { visitorName: 'Changed' }));
});

await it('a stranger cannot delete a capture', async () => {
  await assertFails(deleteDoc(doc(anon, `cards/${CARD}/captures/seeded`)));
});

await it('the owner can read their captures', async () => {
  await assertSucceeds(getDocs(collection(owner, `cards/${CARD}/captures`)));
});

await it('the owner can delete a capture once drained', async () => {
  await assertSucceeds(deleteDoc(doc(owner, `cards/${CARD}/captures/seeded`)));
});

describe('users/{uid} — the public card must not open a door to private data');

await it('a stranger cannot read the owner user document', async () => {
  await assertFails(getDoc(doc(anon, `users/${OWNER}`)));
});

await it('another signed-in user cannot read the owner user document', async () => {
  await assertFails(getDoc(doc(other, `users/${OWNER}`)));
});

await it('another user cannot list the owner’s contacts', async () => {
  await assertFails(getDocs(collection(other, `users/${OWNER}/contacts`)));
});

await it('another user cannot read integration status (connection metadata)', async () => {
  await assertFails(getDoc(doc(other, `users/${OWNER}/integrations/gmail`)));
});

await it('another user cannot write into the owner’s contacts', async () => {
  await assertFails(addDoc(collection(other, `users/${OWNER}/contacts`), { name: 'Injected' }));
});

await it('the owner can read their own contacts', async () => {
  await assertSucceeds(getDocs(collection(owner, `users/${OWNER}/contacts`)));
});

await it('the owner can write their own commitments', async () => {
  await assertSucceeds(addDoc(collection(owner, `users/${OWNER}/commitments`), { text: 'Send the deck' }));
});

describe('oauthTokens/{uid} — refresh tokens are server-only');

await it('the token owner cannot read their own refresh token', async () => {
  await assertFails(getDoc(doc(owner, `oauthTokens/${OWNER}`)));
});

await it('a stranger cannot read a refresh token', async () => {
  await assertFails(getDoc(doc(anon, `oauthTokens/${OWNER}`)));
});

await it('nobody can write a refresh token from a client', async () => {
  await assertFails(setDoc(doc(owner, `oauthTokens/${OWNER}`), { refreshToken: 'stolen' }));
});

await env.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failing: ' + failures.join('; '));
  process.exit(1);
}
