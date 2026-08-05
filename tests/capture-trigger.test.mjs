/**
 * onCardCapture — the Cloud Function that files an NFC, QR, shared-link, or
 * direct public-card capture into the owner's Directory immediately.
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
await put(`_accountSecurity/${OWNER}`, {
  status: { stringValue: 'active' },
  revokedAfterSeconds: { integerValue: '0' },
});

await it('a tap becomes a contact without the owner opening the app', async () => {
  await post(`cards/${CARD}/captures`, {
    visitorName: { stringValue: 'Marcus Webb' },
    visitorEmail: { nullValue: null },
    visitorCompany: { stringValue: 'Bridgewater' },
    note: { nullValue: null },
    captureChannel: { stringValue: 'nfc' },
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
  assert(f.captureChannel?.stringValue === 'nfc', 'NFC channel not preserved');
  assert(f.connectionSource?.stringValue === 'NFC card', 'connectionSource not set');
  assert(
    f.captureProvenance?.mapValue?.fields?.channel?.stringValue === 'nfc',
    'NFC provenance channel missing',
  );
  assert(
    f.captureProvenance?.mapValue?.fields?.channelVerified?.booleanValue === false,
    'URL marker must not claim verified hardware',
  );
  assert(f.company?.stringValue === 'Bridgewater', 'company not carried across');
  assert(/Tapped your NFC card/.test(f.summary?.stringValue || ''), `summary was "${f.summary?.stringValue}"`);
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
          sessionId: { stringValue: 'saastr-session-2026' },
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
    captureChannel: { stringValue: 'qr' },
    capturedAt: { timestampValue: new Date().toISOString() },
    processed: { booleanValue: false },
  });

  const priya = await waitFor('Priya to be filed with the event tag', async () => {
    const docs = await list(`users/${OWNER}/contacts`);
    const hit = docs.find((d) => d.fields?.name?.stringValue === 'Priya Raman');
    return hit || null;
  });

  const f = priya.fields;
  assert(f.capturedVia?.stringValue === 'qr-code', 'QR capturedVia not preserved');
  assert(f.captureChannel?.stringValue === 'qr', 'QR channel not preserved');
  assert(f.connectionSource?.stringValue === 'QR code', 'QR source not preserved');
  assert(f.capturedEventName?.stringValue === 'SaaStr Annual 2026', `event was ${JSON.stringify(f.capturedEventName)}`);
  assert(
    f.capturedEventSessionId?.stringValue === 'saastr-session-2026',
    'event session identity missing',
  );
  const tags = f.tags?.arrayValue?.values || [];
  assert(tags.some((t) => t.stringValue === 'SaaStr Annual 2026'), 'event tag missing from tags[]');
  assert(/at SaaStr Annual 2026/.test(f.summary?.stringValue || ''), `summary was "${f.summary?.stringValue}"`);
});

await it('a normalized email match preserves the existing profile and appends capture evidence', async () => {
  const existingContactId = 'existing-email-contact';
  await put(`users/${OWNER}/contacts/${existingContactId}`, {
    userId: { stringValue: OWNER },
    name: { stringValue: 'Owner Curated Name' },
    company: { stringValue: 'Owner Curated Company' },
    email: { stringValue: 'repeat@example.com' },
    summary: { stringValue: 'This profile must not be overwritten.' },
    lifecycleStatus: { stringValue: 'active' },
    aiAllowed: { booleanValue: true },
    createdAt: { timestampValue: '2026-07-01T12:00:00.000Z' },
    updatedAt: { timestampValue: '2026-07-01T12:00:00.000Z' },
  });
  const before = await list(`users/${OWNER}/contacts`);
  const submitted = await post(`cards/${CARD}/captures`, {
    visitorName: { stringValue: 'Visitor Submitted Name' },
    visitorEmail: { stringValue: 'REPEAT@EXAMPLE.COM' },
    visitorCompany: { stringValue: 'Visitor Submitted Company' },
    note: { stringValue: 'Met after the keynote' },
    consentToFollowUp: { booleanValue: true },
    privacyNoticeVersion: { stringValue: '2026-07-29' },
    eventSessionId: { stringValue: 'saastr-session-2026' },
    eventName: { stringValue: 'SaaStr Annual 2026' },
    eventSource: { stringValue: 'manual' },
    captureChannel: { stringValue: 'nfc' },
    capturedAt: { timestampValue: new Date().toISOString() },
    processed: { booleanValue: false },
  });
  const captureId = String(submitted.name || '').split('/').at(-1);

  const evidenceNote = await waitFor('deduplicated capture evidence', async () => {
    const notes = await list(`users/${OWNER}/notes`);
    return notes.find(
      (document) => document.fields?.sourceId?.stringValue === captureId,
    ) || null;
  });
  const after = await list(`users/${OWNER}/contacts`);
  assert(after.length === before.length, 'email match created another contact');
  const existing = after.find((document) =>
    document.name.endsWith(`/${existingContactId}`),
  );
  assert(existing, 'existing contact disappeared');
  assert(
    existing.fields.name?.stringValue === 'Owner Curated Name',
    'capture overwrote the existing name',
  );
  assert(
    existing.fields.company?.stringValue === 'Owner Curated Company',
    'capture overwrote the existing company',
  );
  assert(
    existing.fields.summary?.stringValue ===
      'This profile must not be overwritten.',
    'capture overwrote the existing summary',
  );
  assert(
    evidenceNote.fields.contactId?.stringValue === existingContactId,
    'evidence was not linked to the existing contact',
  );
  assert(
    evidenceNote.fields.noteSchemaVersion?.integerValue === '2',
    'capture evidence did not use the canonical note schema',
  );
  assert(
    evidenceNote.fields.recordType?.stringValue === 'capture' &&
      evidenceNote.fields.source?.stringValue ===
        'public-card-capture' &&
      evidenceNote.fields.privacySourceType?.stringValue ===
        'public-card-capture',
    'capture evidence provenance shape was not canonical',
  );
  assert(
    evidenceNote.fields.sensitive?.booleanValue === false &&
      evidenceNote.fields.aiAllowed?.booleanValue === true &&
      evidenceNote.fields.factIds?.arrayValue &&
      (evidenceNote.fields.factIds.arrayValue.values || []).length === 0,
    'capture evidence privacy fields were not explicit',
  );
  assert(
    evidenceNote.fields.observedAt?.timestampValue &&
      evidenceNote.fields.content?.stringValue,
    'capture evidence was missing its bounded chronology or summary',
  );
  assert(
    evidenceNote.fields.deduplicatedIntoExistingContact?.booleanValue === true,
    'dedupe decision was not preserved',
  );
  assert(
    evidenceNote.fields.consentToFollowUp?.booleanValue === true,
    'follow-up consent was not preserved',
  );
  assert(
    evidenceNote.fields.privacyNoticeVersion?.stringValue === '2026-07-29',
    'privacy notice version was not preserved',
  );
  assert(
    evidenceNote.fields.eventSessionId?.stringValue === 'saastr-session-2026',
    'event session was not preserved',
  );
  assert(
    evidenceNote.fields.captureProvenance?.mapValue?.fields
      ?.channelVerified?.booleanValue === false,
    'URL attribution claimed verified hardware',
  );

  const facts = await list(
    `users/${OWNER}/contacts/${existingContactId}/facts`,
  );
  const evidenceFact = facts.find(
    (document) =>
      document.fields?.predicate?.stringValue ===
        'relationship.captureEvidence' &&
      document.fields?.sourceId?.stringValue === captureId,
  );
  assert(evidenceFact, 'immutable capture evidence fact was not written');
  assert(
    /follow-up consent granted/.test(
      evidenceFact.fields.value?.stringValue || '',
    ),
    'consent proof is missing from the immutable fact',
  );
});

await it('distinct concurrent captures with one email create only one new contact', async () => {
  const results = await Promise.all([
    post(`cards/${CARD}/captures`, {
      visitorName: { stringValue: 'Concurrent Visitor' },
      visitorEmail: { stringValue: 'CONCURRENT@EXAMPLE.COM' },
      visitorCompany: { stringValue: 'First claim' },
      note: { stringValue: 'First encounter' },
      consentToFollowUp: { booleanValue: true },
      privacyNoticeVersion: { stringValue: '2026-07-29' },
      eventSessionId: { stringValue: 'saastr-session-2026' },
      eventName: { stringValue: 'SaaStr Annual 2026' },
      eventSource: { stringValue: 'manual' },
      captureChannel: { stringValue: 'qr' },
      capturedAt: { timestampValue: new Date().toISOString() },
      processed: { booleanValue: false },
    }),
    post(`cards/${CARD}/captures`, {
      visitorName: { stringValue: 'Concurrent Visitor' },
      visitorEmail: { stringValue: 'concurrent@example.com' },
      visitorCompany: { stringValue: 'Second claim' },
      note: { stringValue: 'Second encounter' },
      consentToFollowUp: { booleanValue: true },
      privacyNoticeVersion: { stringValue: '2026-07-29' },
      eventSessionId: { stringValue: 'saastr-session-2026' },
      eventName: { stringValue: 'SaaStr Annual 2026' },
      eventSource: { stringValue: 'manual' },
      captureChannel: { stringValue: 'link' },
      capturedAt: { timestampValue: new Date().toISOString() },
      processed: { booleanValue: false },
    }),
  ]);
  const captureIds = new Set(
    results.map((result) => String(result.name || '').split('/').at(-1)),
  );

  const contact = await waitFor('one concurrent-email contact', async () => {
    const contacts = await list(`users/${OWNER}/contacts`);
    const matching = contacts.filter(
      (document) =>
        document.fields?.email?.stringValue === 'concurrent@example.com',
    );
    return matching.length === 1 ? matching[0] : null;
  });
  const facts = await waitFor('both concurrent capture facts', async () => {
    const documents = await list(`${contact.name.split('/documents/')[1]}/facts`);
    const matching = documents.filter(
      (document) =>
        document.fields?.predicate?.stringValue ===
          'relationship.captureEvidence' &&
        captureIds.has(document.fields?.sourceId?.stringValue),
    );
    return matching.length === 2 ? matching : null;
  });
  assert(facts.length === 2, 'one of the two captures lost its evidence');
  const contacts = await list(`users/${OWNER}/contacts`);
  assert(
    contacts.filter(
      (document) =>
        document.fields?.email?.stringValue === 'concurrent@example.com',
    ).length === 1,
    'concurrent capture race created duplicate contacts',
  );
});

await it('shared-link provenance is preserved without becoming an NFC tap', async () => {
  await post(`cards/${CARD}/captures`, {
    visitorName: { stringValue: 'Link Visitor' },
    visitorEmail: { nullValue: null },
    visitorCompany: { nullValue: null },
    note: { nullValue: null },
    captureChannel: { stringValue: 'link' },
    capturedAt: { timestampValue: new Date().toISOString() },
    processed: { booleanValue: false },
  });

  const contact = await waitFor('shared-link contact to be filed', async () => {
    const docs = await list(`users/${OWNER}/contacts`);
    return docs.find((d) => d.fields?.name?.stringValue === 'Link Visitor') || null;
  });
  const f = contact.fields;
  assert(f.capturedVia?.stringValue === 'shared-link', 'shared link became another channel');
  assert(f.captureChannel?.stringValue === 'link', 'link channel not preserved');
  assert(f.connectionSource?.stringValue === 'Shared link', 'link source not preserved');
  assert(/Saved from your shared card link/.test(f.summary?.stringValue || ''), 'link summary fabricated a tap');
});

await it('an unmarked legacy URL is filed as direct, never fabricated as NFC', async () => {
  await post(`cards/${CARD}/captures`, {
    visitorName: { stringValue: 'Direct Visitor' },
    visitorEmail: { nullValue: null },
    visitorCompany: { nullValue: null },
    note: { nullValue: null },
    capturedAt: { timestampValue: new Date().toISOString() },
    processed: { booleanValue: false },
  });

  const contact = await waitFor('direct contact to be filed', async () => {
    const docs = await list(`users/${OWNER}/contacts`);
    return docs.find((d) => d.fields?.name?.stringValue === 'Direct Visitor') || null;
  });
  const f = contact.fields;
  assert(f.capturedVia?.stringValue === 'public-card', 'direct URL fabricated another channel');
  assert(f.captureChannel?.stringValue === 'direct', 'direct channel missing');
  assert(f.connectionSource?.stringValue === 'Public card page', 'direct source missing');
  assert(
    f.captureProvenance?.mapValue?.fields?.channelEvidence?.stringValue === 'unmarked-url',
    'unmarked URL evidence missing',
  );
});

await it('a capture on an unknown card is retained for server recovery', async () => {
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
  assert(
    docs.length === 1,
    `expected the capture to remain available for recovery, found ${docs.length}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('Failing: ' + failures.join('; '));
  process.exit(1);
}
