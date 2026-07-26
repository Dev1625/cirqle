/**
 * onCardCapture — the Cloud Function that files an NFC tap into the owner's
 * Directory the instant it happens, rather than on their next app load.
 *
 * Driven entirely through the Firestore emulator's REST API, so the test needs
 * no admin SDK at the repo root and no service-account credential.
 *
 * Run with `npm run test:functions` (wraps this in `firebase emulators:exec`).
 */
const PORT = process.env.FIRESTORE_EMULATOR_PORT || 8591;
const PROJECT = 'cirqle-trigger-test';
const BASE = `http://127.0.0.1:${PORT}/v1/projects/${PROJECT}/databases/(default)/documents`;

const OWNER = 'owner-uid-trigger';
const CARD = 'triggercard1';

let passed = 0, failed = 0;
const failures = [];

async function it(name, fn) {
  try {
    await fn();
    console.log(`  [32mPASS[0m  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [31mFAIL[0m  ${name}\n        ${e?.message || e}`);
    failed++; failures.push(name);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const H = { 'Authorization': 'Bearer owner', 'Content-Type': 'application/json' };

async function put(path, fields) {
  const r = await fetch(`${BASE}/${path}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`PATCH ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}
async function post(collectionPath, fields) {
  const r = await fetch(`${BASE}/${collectionPath}`, { method: 'POST', headers: H, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`POST ${collectionPath} -> ${r.status} ${await r.text()}`);
  return r.json();
}
async function list(collectionPath) {
  const r = await fetch(`${BASE}/${collectionPath}`, { headers: H });
  if (!r.ok) return [];
  return (await r.json()).documents || [];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until predicate holds or we run out of patience. */
async function waitFor(label, fn, timeoutMs = 25000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(700);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

console.log('\nonCardCapture — server-side capture draining');

// Fixtures: a published card, and an owner who is NOT in Event Mode yet.
await put(`cards/${CARD}`, {
  cardId: { stringValue: CARD },
  ownerUid: { stringValue: OWNER },
  name: { stringValue: 'Devarshi' },
  published: { booleanValue: true },
});
await put(`users/${OWNER}`, { name: { stringValue: 'Devarshi' } });

await it('a tap becomes a contact without the owner opening the app', async () => {
  await post(`cards/${CARD}/captures`, {
    visitorName: { stringValue: 'Marcus Webb' },
    visitorEmail: { nullValue: null },
    visitorCompany: { stringValue: 'Bridgewater' },
    note: { nullValue: null },
    capturedAt: { timestampValue: new Date().toISOString() },
    processed: { booleanValue: false },
  });

  const contacts = await waitFor('the contact to be filed', async () => {
    const docs = await list(`users/${OWNER}/contacts`);
    return docs.length > 0 ? docs : null;
  });

  const f = contacts[0].fields;
  assert(f.name?.stringValue === 'Marcus Webb', `name was ${JSON.stringify(f.name)}`);
  assert(f.capturedVia?.stringValue === 'nfc-card', 'capturedVia not set');
  assert(f.connectionSource?.stringValue === 'NFC card', 'connectionSource not set');
  assert(f.company?.stringValue === 'Bridgewater', 'company not carried across');
  assert(/Tapped your card/.test(f.summary?.stringValue || ''), `summary was "${f.summary?.stringValue}"`);
});

await it('the capture is consumed, so the client drain cannot file it twice', async () => {
  const remaining = await waitFor('captures to drain to zero', async () => {
    const docs = await list(`cards/${CARD}/captures`);
    return docs.length === 0 ? [] : null;
  });
  assert(remaining.length === 0, 'capture still present after the trigger ran');
});

await it('Event Mode tags the contact with the event name', async () => {
  await put(`users/${OWNER}`, {
    name: { stringValue: 'Devarshi' },
    eventMode: {
      mapValue: {
        fields: {
          active: { booleanValue: true },
          eventName: { stringValue: 'SaaStr Annual 2026' },
        },
      },
    },
  });

  await post(`cards/${CARD}/captures`, {
    visitorName: { stringValue: 'Priya Raman' },
    visitorEmail: { nullValue: null },
    visitorCompany: { nullValue: null },
    note: { nullValue: null },
    capturedAt: { timestampValue: new Date().toISOString() },
    processed: { booleanValue: false },
  });

  const priya = await waitFor('Priya to be filed with the event tag', async () => {
    const docs = await list(`users/${OWNER}/contacts`);
    const hit = docs.find((d) => d.fields?.name?.stringValue === 'Priya Raman');
    return hit || null;
  });

  const f = priya.fields;
  assert(f.capturedEventName?.stringValue === 'SaaStr Annual 2026', `event was ${JSON.stringify(f.capturedEventName)}`);
  const tags = f.tags?.arrayValue?.values || [];
  assert(tags.some((t) => t.stringValue === 'SaaStr Annual 2026'), 'event tag missing from tags[]');
  assert(/at SaaStr Annual 2026/.test(f.summary?.stringValue || ''), `summary was "${f.summary?.stringValue}"`);
});

await it('a capture on an unknown card is left in place rather than lost', async () => {
  await post(`cards/no-such-card/captures`, {
    visitorName: { stringValue: 'Orphan Capture' },
    visitorEmail: { nullValue: null },
    visitorCompany: { nullValue: null },
    note: { nullValue: null },
    capturedAt: { timestampValue: new Date().toISOString() },
    processed: { booleanValue: false },
  });
  // Give the trigger time to run and decline.
  await sleep(6000);
  const docs = await list(`cards/no-such-card/captures`);
  assert(docs.length === 1, `expected the capture to survive for the client drain, found ${docs.length}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('Failing: ' + failures.join('; '));
  process.exit(1);
}
