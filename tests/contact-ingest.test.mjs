import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_AGENT_CONTACTS_PER_CALL,
  agentContactDocumentId,
  agentProfileFacts,
  agentSourceId,
  ingestAgentContacts,
  normalizeAgentContactInput,
  normalizeAgentEmail,
} from '../server/api/_lib/contact-ingest.js';

const UID = 'ingest-owner';
const NOW = new Date('2026-08-10T12:00:00.000Z');

/**
 * Minimal in-memory stand-in for the Admin Firestore surface this module uses:
 * collection/doc/get, an equality query for externalId, and batched writes.
 * Enough to exercise dedup and batching without an emulator, which is the same
 * split the other API tests use.
 */
function fakeDb(seed = {}) {
  const docs = new Map(Object.entries(seed));
  let autoId = 0;

  const makeRef = (path) => ({
    id: path.split('/').pop(),
    path,
    async get() {
      const data = docs.get(path);
      return {
        id: path.split('/').pop(),
        exists: data !== undefined,
        ref: makeRef(path),
        data: () => (data === undefined ? undefined : { ...data }),
      };
    },
    collection: (name) => makeCollection(`${path}/${name}`),
  });

  const makeCollection = (base) => ({
    doc: (id) => makeRef(`${base}/${id ?? `auto-${(autoId += 1)}`}`),
    where(field, _op, value) {
      return {
        limit: () => ({
          async get() {
            const hits = [...docs.entries()].filter(([path, data]) => {
              if (!path.startsWith(`${base}/`)) return false;
              return field
                .split('.')
                .reduce((acc, key) => acc?.[key], data) === value;
            });
            return {
              empty: hits.length === 0,
              docs: hits.map(([path, data]) => ({
                id: path.split('/').pop(),
                exists: true,
                ref: makeRef(path),
                data: () => ({ ...data }),
              })),
            };
          },
        }),
      };
    },
  });

  return {
    docs,
    collection: makeCollection,
    doc: (path) => makeRef(path),
    batch() {
      const writes = [];
      return {
        set: (ref, data) => writes.push([ref.path, data]),
        async commit() {
          for (const [path, data] of writes) docs.set(path, data);
        },
      };
    },
  };
}

function contact(overrides = {}) {
  return {
    name: 'Dana Okonkwo',
    email: 'dana@lumenstudio.example',
    company: 'Lumen Studio',
    role: 'Head of Design',
    location: 'London',
    relationshipTier: 'Warm',
    ...overrides,
  };
}

function ingest(db, contacts, extra = {}) {
  return ingestAgentContacts({
    db,
    uid: UID,
    authTime: Math.floor(NOW.getTime() / 1000),
    contacts,
    client: 'Claude Desktop',
    batchId: 'batch-1',
    now: NOW,
    saveProfile: async ({ input }) => ({
      contactId: input.contactId,
      changedFields: ['role'],
    }),
    ...extra,
  });
}

test('the same email always resolves to the same document id', () => {
  const id = agentContactDocumentId('Dana@Lumenstudio.Example');
  assert.equal(id, agentContactDocumentId('  dana@lumenstudio.example  '));
  assert.ok(id.startsWith('agent-email-'));
  assert.equal(agentContactDocumentId('not-an-email'), null);
  assert.equal(normalizeAgentEmail('A@B.CO'), 'a@b.co');
});

// The whole point of a deterministic id: an agent that retries a dropped call
// must not end up creating the same person twice.
test('re-running the same import updates instead of duplicating', async () => {
  const db = fakeDb();

  const first = await ingest(db, [contact()]);
  assert.equal(first.created, 1);
  assert.equal(first.updated, 0);

  const second = await ingest(db, [contact({ role: 'Design Director' })]);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  assert.equal(second.results[0].contactId, first.results[0].contactId);

  const contactPaths = [...db.docs.keys()].filter(
    (path) => path.startsWith(`users/${UID}/contacts/`) && !path.includes('/facts/'),
  );
  assert.equal(contactPaths.length, 1, 'a retry must not create a second person');
});

// Same person listed twice inside one call — sequential processing is what
// stops the two entries racing to create the document.
test('a person repeated within one call collapses to one contact', async () => {
  const db = fakeDb();
  const result = await ingest(db, [
    contact(),
    contact({ role: 'Design Director' }),
  ]);

  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.equal(
    result.results[0].contactId,
    result.results[1].contactId,
  );
});

test('one bad record does not sink the rest of the batch', async () => {
  const db = fakeDb();
  const result = await ingest(db, [
    contact(),
    contact({ name: '', email: 'nameless@example.com' }),
    contact({ name: 'Ravi Menon', email: 'ravi@example.com' }),
  ]);

  assert.equal(result.created, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.results[1].status, 'failed');
  // The agent needs to know which index to fix and resend.
  assert.equal(result.results[1].index, 1);
});

test('rejects an empty or oversized batch', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => ingest(db, []),
    (error) => error.code === 'contact_ingest_empty',
  );
  await assert.rejects(
    () =>
      ingest(
        db,
        Array.from({ length: MAX_AGENT_CONTACTS_PER_CALL + 1 }, (_, index) =>
          contact({ email: `person${index}@example.com` }),
        ),
      ),
    (error) => error.code === 'contact_ingest_too_large',
  );
});

// A field the agent did not mention must not erase something the owner typed.
test('an update fills gaps without blanking existing values', async () => {
  const db = fakeDb();
  await ingest(db, [contact()]);
  const contactId = agentContactDocumentId(contact().email);

  let sent = null;
  await ingest(db, [{ name: 'Dana Okonkwo', email: contact().email }], {
    saveProfile: async ({ input }) => {
      sent = input;
      return { contactId: input.contactId, changedFields: [] };
    },
  });

  assert.equal(sent.contactId, contactId);
  assert.equal(sent.profile.company, 'Lumen Studio');
  assert.equal(sent.profile.location, 'London');
  assert.equal(sent.expectedProfileRevision, 0);
});

test('skips contacts that are deleted, merged, or mid-purge', async () => {
  const contactId = agentContactDocumentId(contact().email);
  for (const state of [
    { lifecycleStatus: 'deleted' },
    { mergedIntoContactId: 'other' },
    { purgeFence: { requestId: 'x' } },
    { factSyncPending: true },
  ]) {
    const db = fakeDb({
      [`users/${UID}/contacts/${contactId}`]: { name: 'Existing', ...state },
    });
    const result = await ingest(db, [contact()]);
    assert.equal(result.skipped, 1, JSON.stringify(state));
    assert.equal(result.results[0].reason, 'contact_not_writable');
  }
});

// One revocable unit per import: "undo what Claude added" has to be one action.
test('every contact in a call shares one source id', async () => {
  const db = fakeDb();
  const result = await ingest(db, [
    contact(),
    contact({ name: 'Ravi Menon', email: 'ravi@example.com' }),
  ]);

  assert.equal(result.sourceId, agentSourceId({
    client: 'Claude Desktop',
    batchId: 'batch-1',
  }));

  const provenance = [...db.docs.entries()]
    .filter(([path]) => !path.includes('/facts/'))
    .map(([, data]) => data.importProvenance);
  assert.equal(provenance.length, 2);
  for (const entry of provenance) {
    assert.equal(entry.sourceType, 'agent');
    assert.equal(entry.sourceId, result.sourceId);
  }
});

test('creation facts are stamped as agent-sourced', () => {
  const { profile } = normalizeAgentContactInput(contact());
  const facts = agentProfileFacts({
    uid: UID,
    contactId: 'contact-1',
    profile,
    sourceId: 'agent:Claude-Desktop:batch-1',
    now: NOW,
  });

  assert.ok(facts.length > 0);
  for (const fact of facts) {
    assert.equal(fact.data.sourceType, 'agent');
    assert.equal(fact.data.current, true);
    assert.ok(fact.id.startsWith('profile-fact-'));
  }
  // Ids must be stable so a later edit supersedes rather than duplicates.
  const again = agentProfileFacts({
    uid: UID,
    contactId: 'contact-1',
    profile,
    sourceId: 'agent:Claude-Desktop:batch-1',
    now: NOW,
  });
  assert.deepEqual(facts.map((f) => f.id), again.map((f) => f.id));
});

test('a name is required rather than guessed from the email', () => {
  assert.throws(
    () => normalizeAgentContactInput({ email: 'someone@example.com' }),
    (error) => error.code === 'contact_profile_invalid',
  );
  assert.throws(
    () => normalizeAgentContactInput(null),
    (error) => error.code === 'contact_ingest_invalid',
  );
});
