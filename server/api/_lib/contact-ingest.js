import { createHash } from 'node:crypto';

import {
  CONTACT_PROFILE_FIELDS,
  ContactProfileError,
  PROFILE_FACT_FIELDS,
  deterministicFactId,
  executeAdminContactProfileSave,
  validateProfile,
} from './contact-profile.js';

/**
 * Server-side contact ingest for the MCP server.
 *
 * `executeAdminContactProfileSave` only updates: it 404s on a missing contact
 * and needs the caller to know the current `profileRevision`. Nothing could
 * create a contact server-side, so that lives here. Updates still delegate to
 * that function rather than reimplementing it, which is what keeps fact history
 * and job-history tracking working for agent edits.
 *
 * Normalisation and validation come from `validateProfile`, so an agent is held
 * to exactly the same field limits as the profile editor.
 */

export const MAX_AGENT_CONTACTS_PER_CALL = 50;
const AGENT_SOURCE_TYPE = 'agent';
const MAX_CLIENT_LABEL = 80;

export class ContactIngestError extends Error {
  constructor({
    code = 'contact_ingest_invalid',
    message = 'The ingest request is invalid.',
    status = 400,
  } = {}) {
    super(message);
    this.name = 'ContactIngestError';
    this.code = code;
    this.status = status;
  }
}

function ingestError(code, message, status = 400) {
  return new ContactIngestError({ code, message, status });
}

export function normalizeAgentEmail(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/**
 * Deterministic id derived from the email, mirroring
 * `captureContactDocumentId` in functions/capture-filing.js.
 *
 * Agents retry — a dropped connection, a replayed tool call, a user asking
 * twice. Deriving the id from the email makes a repeat of the same import land
 * on the same document instead of creating a second copy of the person.
 * Contacts with no email get a random id and are matched on the caller's
 * `externalId` instead.
 */
export function agentContactDocumentId(email) {
  const normalized = normalizeAgentEmail(email);
  if (!normalized) return null;
  return `agent-email-${createHash('sha256')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, 40)}`;
}

/**
 * The client name becomes part of a source id, which the owner reads in
 * Settings and which is compared as a string by the privacy boundaries. Keep it
 * to characters that are unambiguous in both places.
 */
function clientLabel(value) {
  const label = String(value ?? '')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_CLIENT_LABEL);
  return label || 'unknown-agent';
}

/**
 * One source id per ingest call, not per contact.
 *
 * The privacy table revokes by source boundary, so a whole import has to
 * collapse to a single revocable unit — "undo what Claude added on Tuesday"
 * rather than fifty separate deletions.
 */
export function agentSourceId({ client, batchId }) {
  return `agent:${clientLabel(client)}:${clientLabel(batchId)}`.slice(0, 300);
}

function factValue(value) {
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
}

function normalizedFactValue(value) {
  return factValue(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Identity facts for a brand-new contact, in the same shape and with the same
 * ids `executeAdminContactProfileSave` would use at revision 0, so the fact
 * ledger and retention sweep cannot tell a created contact from an edited one.
 */
export function agentProfileFacts({ uid, contactId, profile, sourceId, now }) {
  const facts = [];
  for (const [field, predicate] of Object.entries(PROFILE_FACT_FIELDS)) {
    const value = factValue(profile[field]);
    if (!value) continue;
    facts.push({
      id: deterministicFactId({ uid, contactId, revision: 0, predicate }),
      data: {
        predicate,
        value: value.slice(0, 20_000),
        normalizedValue: normalizedFactValue(value).slice(0, 20_000),
        sourceType: AGENT_SOURCE_TYPE,
        sourceId,
        observedAt: now,
        confidence: 1,
        current: true,
        aiAllowed: true,
        correctionOf: null,
        supersededBy: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  return facts;
}

export function normalizeAgentContactInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ingestError(
      'contact_ingest_invalid',
      'Each contact must be an object.',
    );
  }
  const suppliedProfile = Object.fromEntries(
    CONTACT_PROFILE_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
      .map((field) => [field, value[field]]),
  );
  if (
    Object.prototype.hasOwnProperty.call(suppliedProfile, 'name') &&
    !String(suppliedProfile.name ?? '').trim()
  ) {
    throw ingestError('contact_profile_invalid', 'A contact name cannot be empty.');
  }
  // Run every supplied value through the canonical profile normalizer while
  // retaining only the fields the agent actually sent. This makes partial
  // updates real: omitted fields stay omitted instead of becoming empty
  // defaults (or an accidental Cold relationship tier).
  const normalized = validateProfile({
    ...suppliedProfile,
    name: suppliedProfile.name || 'Existing contact',
  });
  const profile = Object.freeze(
    Object.fromEntries(
      Object.keys(suppliedProfile).map((field) => [field, normalized[field]]),
    ),
  );
  const contactId =
    value.contactId == null
      ? null
      : String(value.contactId).normalize('NFKC').trim();
  if (
    contactId &&
    (contactId.length > 300 ||
      contactId.includes('/') ||
      contactId === '.' ||
      contactId === '..')
  ) {
    throw ingestError('invalid_contact', 'The contactId is invalid.');
  }
  if (!contactId && !String(suppliedProfile.name ?? '').trim()) {
    throw ingestError(
      'contact_profile_invalid',
      'A contact name is required when contactId is not supplied.',
    );
  }
  const externalId =
    value.externalId == null
      ? null
      : String(value.externalId).normalize('NFKC').trim().slice(0, 300) ||
        null;
  return { profile, externalId, contactId: contactId || null };
}

async function resolveTarget({ db, uid, profile, externalId, contactId }) {
  const contacts = db.collection(`users/${uid}/contacts`);
  if (contactId) {
    const snapshot = await contacts.doc(contactId).get();
    if (!snapshot.exists) {
      throw ingestError('contact_not_found', 'No contact with that contactId.', 404);
    }
    return { ref: contacts.doc(contactId), existing: snapshot };
  }

  const deterministicId = agentContactDocumentId(profile.email);

  if (deterministicId) {
    const snapshot = await contacts.doc(deterministicId).get();
    if (snapshot.exists) {
      return { ref: contacts.doc(deterministicId), existing: snapshot };
    }
    // Contacts created in the dashboard have random ids. Match their
    // canonical email before falling back to the deterministic MCP id.
    const emailMatches = await contacts
      .where('normalizedEmail', '==', normalizeAgentEmail(profile.email))
      .limit(1)
      .get();
    if (!emailMatches.empty) {
      return { ref: emailMatches.docs[0].ref, existing: emailMatches.docs[0] };
    }
    const legacyEmailMatches = await contacts
      .where('email', '==', normalizeAgentEmail(profile.email))
      .limit(1)
      .get();
    if (!legacyEmailMatches.empty) {
      return {
        ref: legacyEmailMatches.docs[0].ref,
        existing: legacyEmailMatches.docs[0],
      };
    }
    return { ref: contacts.doc(deterministicId), existing: snapshot };
  }

  if (externalId) {
    const matches = await contacts
      .where('importProvenance.rowId', '==', externalId)
      .limit(1)
      .get();
    if (!matches.empty) {
      return { ref: matches.docs[0].ref, existing: matches.docs[0] };
    }
  }

  return { ref: contacts.doc(), existing: null };
}

function contactAcceptsAgentWrite(data) {
  if (!data) return true;
  return (
    data.lifecycleStatus !== 'deleted' &&
    !data.mergedIntoContactId &&
    !data.purgeFence &&
    !data.factSyncPending
  );
}

async function createContact({
  db,
  uid,
  ref,
  profile,
  externalId,
  sourceId,
  now,
}) {
  const completeProfile = validateProfile(profile);
  const batch = db.batch();
  batch.set(ref, {
    ...completeProfile,
    normalizedEmail: completeProfile.email,
    lifecycleStatus: 'active',
    aiAllowed: true,
    profileRevision: 0,
    userId: uid,
    createdAt: now,
    updatedAt: now,
    lastContactedAt: null,
    importProvenance: {
      sourceType: AGENT_SOURCE_TYPE,
      sourceId,
      rowId: externalId,
      mapping: 'ai-grounded',
      importedAt: now,
    },
  });
  for (const fact of agentProfileFacts({
    uid,
    contactId: ref.id,
    profile: completeProfile,
    sourceId,
    now,
  })) {
    batch.set(ref.collection('facts').doc(fact.id), fact.data);
  }
  await batch.commit();
  return { contactId: ref.id, created: true, changedFields: [] };
}

async function updateContact({
  db,
  uid,
  ref,
  existing,
  profile,
  authTime,
  now,
  saveProfile,
}) {
  const data = existing.data() || {};
  // Merge rather than replace. The agent only sees what the thread mentioned; a
  // field it did not mention must not blank out something the owner typed.
  const nonEmptyPatch = Object.fromEntries(
    Object.entries(profile).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : Boolean(value),
    ),
  );
  const merged = validateProfile({ ...data, ...nonEmptyPatch });

  const result = await saveProfile({
    db,
    uid,
    authTime,
    now,
    input: {
      contactId: ref.id,
      expectedProfileRevision: Number(data.profileRevision) || 0,
      profile: merged,
    },
  });
  return {
    contactId: ref.id,
    created: false,
    changedFields: result.changedFields || [],
  };
}

/**
 * Create or update a batch of agent-supplied contacts.
 *
 * Reports a per-contact outcome instead of throwing on the first bad record: an
 * agent handing over thirty people should not lose twenty-nine because one had
 * a malformed email, and it needs to know which ones to retry.
 */
export async function ingestAgentContacts({
  db,
  uid,
  authTime,
  contacts,
  client,
  batchId,
  now = new Date(),
  // Injected so the batching, dedup, and merge behaviour can be tested without
  // a Firestore transaction, matching how the API handlers take their
  // collaborators.
  saveProfile = executeAdminContactProfileSave,
}) {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    throw ingestError('contact_ingest_empty', 'Provide at least one contact.');
  }
  if (contacts.length > MAX_AGENT_CONTACTS_PER_CALL) {
    throw ingestError(
      'contact_ingest_too_large',
      `Send at most ${MAX_AGENT_CONTACTS_PER_CALL} contacts per call.`,
    );
  }

  const sourceId = agentSourceId({ client, batchId });
  const results = [];
  // Sequential on purpose: two entries in one call can resolve to the same
  // deterministic id (the same person mentioned twice in a thread), and running
  // them concurrently would race to create that document twice.
  for (const [index, candidate] of contacts.entries()) {
    try {
      const { profile, externalId, contactId } = normalizeAgentContactInput(candidate);
      const { ref, existing } = await resolveTarget({
        db,
        uid,
        profile,
        externalId,
        contactId,
      });

      if (existing?.exists && !contactAcceptsAgentWrite(existing.data())) {
        results.push({
          index,
          status: 'skipped',
          contactId: ref.id,
          reason: 'contact_not_writable',
        });
        continue;
      }

      const outcome = existing?.exists
        ? await updateContact({
            db,
            uid,
            ref,
            existing,
            profile,
            authTime,
            now,
            saveProfile,
          })
        : await createContact({
            db,
            uid,
            ref,
            profile,
            externalId,
            sourceId,
            now,
          });
      results.push({ index, status: 'ok', ...outcome });
    } catch (error) {
      const known =
        error instanceof ContactIngestError ||
        error instanceof ContactProfileError;
      results.push({
        index,
        status: 'failed',
        reason: known ? error.code : 'contact_ingest_failed',
        message: known ? error.message : 'This contact could not be saved.',
      });
    }
  }

  return {
    sourceId,
    created: results.filter((row) => row.created).length,
    updated: results.filter((row) => row.status === 'ok' && !row.created)
      .length,
    failed: results.filter((row) => row.status === 'failed').length,
    skipped: results.filter((row) => row.status === 'skipped').length,
    results,
  };
}

export const __testing = Object.freeze({
  AGENT_SOURCE_TYPE,
  clientLabel,
  contactAcceptsAgentWrite,
});
