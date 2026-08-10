import {
  MAX_AGENT_CONTACTS_PER_CALL,
  ingestAgentContacts,
} from './contact-ingest.js';
import {
  addAgentNote,
  logAgentMeeting,
  logAgentOutreach,
} from './interaction-ingest.js';

/**
 * Tool surface exposed to AI agents over MCP.
 *
 * The JSON Schemas here are the field contract. They are the only thing telling
 * a model that `relationshipTier` is a three-value enum, or that a summary must
 * not invent detail — so the descriptions are load-bearing, not documentation.
 * Write them for a reader who has never seen Cirqle.
 *
 * Additive operations only: no merge, archive, delete, or account tools. An
 * agent misreading a thread should at worst add something the owner can revoke,
 * never destroy a record.
 */

const MAX_SEARCH_RESULTS = 25;
const MAX_SCANNED_CONTACTS = 500;

const RELATIONSHIP_TIERS = ['Cold', 'Warm', 'Strong'];

export class McpToolError extends Error {
  constructor(message, code = 'tool_failed') {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
  }
}

const CONTACT_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      description:
        'Full name of the person. Required — do not infer it from an email address or company name. If the source text does not name them, skip the record.',
    },
    email: { type: 'string', description: 'Primary email address.' },
    phone: { type: 'string' },
    company: { type: 'string' },
    role: { type: 'string', description: 'Job title, e.g. "Head of Design".' },
    location: { type: 'string', description: 'City and region or country.' },
    linkedinUrl: {
      type: 'string',
      description: 'Full https:// LinkedIn profile URL.',
    },
    summary: {
      type: 'string',
      description:
        'Two or three sentences on who this person is, drawn ONLY from the supplied text. Do not add outside knowledge about them or their employer.',
    },
    relationshipTier: {
      type: 'string',
      enum: RELATIONSHIP_TIERS,
      description:
        'How well the owner knows them. Default to "Cold" unless the source text clearly shows an established relationship.',
    },
    industry: { type: 'string' },
    subIndustry: { type: 'string' },
    school: { type: 'string' },
    seniority: { type: 'string' },
    connectionSource: {
      type: 'string',
      description: 'Where the owner met or found them, if stated.',
    },
    whyTheyMatter: {
      type: 'string',
      description:
        'Why this relationship is worth keeping, only if the source says so.',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short topical labels.',
    },
    externalId: {
      type: 'string',
      description:
        'Optional stable id from your own system. Used to match on re-import when the contact has no email.',
    },
  },
});

export const MCP_TOOLS = Object.freeze([
  {
    name: 'search_contacts',
    title: 'Search contacts',
    description:
      "Search the owner's CRM by name, company, role, email, or tag. Call this BEFORE adding anyone, so you update the existing record instead of creating a duplicate.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description:
            'Free text matched against name, company, role, email, and tags. Omit to list recent contacts.',
        },
        relationshipTier: { type: 'string', enum: RELATIONSHIP_TIERS },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_SEARCH_RESULTS,
          default: 10,
        },
      },
    },
  },
  {
    name: 'get_contact',
    title: 'Get a contact',
    description:
      'Read one contact in full, including where each fact came from. Use it to check what is already recorded before overwriting anything.',
    inputSchema: {
      type: 'object',
      required: ['contactId'],
      additionalProperties: false,
      properties: {
        contactId: { type: 'string', description: 'Id from search_contacts.' },
      },
    },
  },
  {
    name: 'upsert_contacts',
    title: 'Add or update contacts',
    description:
      `Create or update up to ${MAX_AGENT_CONTACTS_PER_CALL} contacts in one call. Matching is by email, so re-sending the same person updates them rather than creating a duplicate — safe to retry. Fields you omit are left untouched; never send an empty string to clear something. Everything written is tagged as agent-written and can be revoked by the owner in one action.`,
    inputSchema: {
      type: 'object',
      required: ['contacts'],
      additionalProperties: false,
      properties: {
        contacts: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_AGENT_CONTACTS_PER_CALL,
          items: CONTACT_INPUT_SCHEMA,
        },
        batchId: {
          type: 'string',
          description:
            'Optional label for this import, shown to the owner when reviewing or revoking it. For example "linkedin-export-august".',
        },
      },
    },
  },
  {
    name: 'add_note',
    title: 'Add a note',
    description:
      'Attach a note to a contact — context about who they are, what was discussed, or something to remember. Use log_meeting for meetings and log_interaction for emails; this is for everything else.',
    inputSchema: {
      type: 'object',
      required: ['contactId', 'content'],
      additionalProperties: false,
      properties: {
        contactId: { type: 'string', description: 'Id from search_contacts.' },
        content: {
          type: 'string',
          maxLength: 20_000,
          description:
            'The note. Record only what the source text supports; do not add outside knowledge about the person.',
        },
      },
    },
  },
  {
    name: 'log_meeting',
    title: 'Log a meeting',
    description:
      'Record a meeting that already happened, with what was discussed. Use this for calls, coffees, and video meetings — not for emails.',
    inputSchema: {
      type: 'object',
      required: ['contactId', 'content'],
      additionalProperties: false,
      properties: {
        contactId: { type: 'string', description: 'Id from search_contacts.' },
        content: {
          type: 'string',
          maxLength: 70_000,
          description:
            'What was discussed, decided, and agreed. Only what the source text supports.',
        },
        occurredAt: {
          type: 'string',
          description:
            'When it happened, ISO format, e.g. "2026-08-10" or "2026-08-10T14:30:00Z". Defaults to now. Must not be in the future — log what has already happened, not what is scheduled.',
        },
      },
    },
  },
  {
    name: 'log_interaction',
    title: 'Log an email you sent',
    description:
      "Record an email the owner sent, from a thread they paste in. Recorded as sent-on-the-owner's-word — never as provider-verified, because reading a pasted thread is not proof of delivery. Set responseReceived when the thread shows the contact wrote back.",
    inputSchema: {
      type: 'object',
      required: ['contactId'],
      additionalProperties: false,
      properties: {
        contactId: { type: 'string', description: 'Id from search_contacts.' },
        subject: { type: 'string', maxLength: 500 },
        body: {
          type: 'string',
          maxLength: 20_000,
          description: 'What the owner sent. Quote the thread, do not summarise it away.',
        },
        sentAt: {
          type: 'string',
          description:
            'When it was sent, ISO format. Defaults to now. Must not be in the future.',
        },
        responseReceived: {
          type: 'boolean',
          description:
            'True only if the thread actually shows a reply from the contact.',
        },
        notes: {
          type: 'string',
          maxLength: 20_000,
          description: 'Anything worth remembering about the exchange.',
        },
      },
    },
  },
]);

function text(value) {
  return String(value ?? '').toLocaleLowerCase();
}

function contactSummary(id, data) {
  return {
    contactId: id,
    name: data.name || '',
    company: data.company || '',
    role: data.role || '',
    email: data.email || '',
    location: data.location || '',
    relationshipTier: data.relationshipTier || 'Cold',
    tags: Array.isArray(data.tags) ? data.tags : [],
    writtenByAgent: data.importProvenance?.sourceType === 'agent',
  };
}

/**
 * Substring search in memory rather than in Firestore.
 *
 * Firestore cannot do contains-style matching, and a personal CRM is small
 * enough that scanning a bounded page is both simpler and cheaper than
 * maintaining a search index. The scan is capped so this stays predictable if a
 * directory grows.
 */
async function searchContacts({ db, uid, args }) {
  const limit = Math.min(
    Math.max(1, Number(args.limit) || 10),
    MAX_SEARCH_RESULTS,
  );
  const snapshot = await db
    .collection(`users/${uid}/contacts`)
    .where('lifecycleStatus', '==', 'active')
    .limit(MAX_SCANNED_CONTACTS)
    .get();

  const needle = text(args.query).trim();
  const rows = [];
  for (const document of snapshot.docs) {
    const data = document.data() || {};
    if (
      args.relationshipTier &&
      (data.relationshipTier || 'Cold') !== args.relationshipTier
    ) {
      continue;
    }
    if (needle) {
      const haystack = text(
        [
          data.name,
          data.company,
          data.role,
          data.email,
          data.location,
          Array.isArray(data.tags) ? data.tags.join(' ') : '',
        ].join(' '),
      );
      if (!haystack.includes(needle)) continue;
    }
    rows.push(contactSummary(document.id, data));
    if (rows.length >= limit) break;
  }

  return {
    count: rows.length,
    scanLimited: snapshot.size >= MAX_SCANNED_CONTACTS,
    contacts: rows,
  };
}

async function getContact({ db, uid, args }) {
  const contactId = String(args.contactId || '').trim();
  if (!contactId || contactId.includes('/')) {
    throw new McpToolError('A valid contactId is required.', 'invalid_contact');
  }
  const ref = db.doc(`users/${uid}/contacts/${contactId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw new McpToolError('No contact with that id.', 'contact_not_found');
  }
  const data = snapshot.data() || {};
  const facts = await ref
    .collection('facts')
    .where('current', '==', true)
    .limit(50)
    .get();

  return {
    ...contactSummary(snapshot.id, data),
    summary: data.summary || '',
    whyTheyMatter: data.whyTheyMatter || '',
    industry: data.industry || '',
    school: data.school || '',
    seniority: data.seniority || '',
    connectionSource: data.connectionSource || '',
    linkedinUrl: data.linkedinUrl || '',
    // Provenance is exposed so an agent can see which values it wrote itself
    // and avoid treating its own earlier guess as independent confirmation.
    facts: facts.docs.map((document) => {
      const fact = document.data() || {};
      return {
        predicate: fact.predicate,
        value: fact.value,
        sourceType: fact.sourceType,
      };
    }),
  };
}

async function upsertContacts({ db, uid, authTime, args, client, now }) {
  const result = await ingestAgentContacts({
    db,
    uid,
    authTime,
    contacts: args.contacts,
    client,
    batchId: args.batchId || now.toISOString(),
    now,
  });
  return {
    created: result.created,
    updated: result.updated,
    failed: result.failed,
    skipped: result.skipped,
    sourceId: result.sourceId,
    revokeHint:
      'The owner can revoke this entire import from Settings → Privacy & AI.',
    results: result.results,
  };
}

const HANDLERS = Object.freeze({
  search_contacts: searchContacts,
  get_contact: getContact,
  upsert_contacts: upsertContacts,
  add_note: ({ db, uid, args, now }) =>
    addAgentNote({
      db,
      uid,
      contactId: args.contactId,
      content: args.content,
      now,
    }),
  log_meeting: ({ db, uid, args, now }) =>
    logAgentMeeting({
      db,
      uid,
      contactId: args.contactId,
      content: args.content,
      occurredAt: args.occurredAt,
      now,
    }),
  log_interaction: ({ db, uid, args, now }) =>
    logAgentOutreach({
      db,
      uid,
      contactId: args.contactId,
      subject: args.subject,
      body: args.body,
      channel: args.channel,
      sentAt: args.sentAt,
      responseReceived: args.responseReceived,
      notes: args.notes,
      now,
    }),
});

/**
 * Nothing an agent can call may remove data. Enforced rather than promised:
 * a tool whose name suggests destruction fails the build in
 * tests/mcp-server.test.mjs, so this survives someone adding a tool later
 * without reading this comment.
 */
export const DESTRUCTIVE_NAME_PATTERN =
  /delete|remove|destroy|purge|merge|archive|wipe|clear|drop|revoke/i;

export function listMcpTools() {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export async function callMcpTool({
  name,
  args = {},
  db,
  uid,
  authTime,
  client,
  now = new Date(),
}) {
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, name)
    ? HANDLERS[name]
    : null;
  if (!handler) {
    throw new McpToolError(`Unknown tool: ${name}`, 'unknown_tool');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new McpToolError('Tool arguments must be an object.', 'invalid_args');
  }
  return handler({ db, uid, authTime, args, client, now });
}
