import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const OWNER = 'schema-owner';
const OTHER = 'schema-other';

let passed = 0;
let failed = 0;
const failures = [];

async function it(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message || error}`);
    failed += 1;
    failures.push(name);
  }
}

const env = await initializeTestEnvironment({
  projectId: 'cirqle-private-schema-test',
  firestore: {
    host: '127.0.0.1',
    port: Number(process.env.FIRESTORE_EMULATOR_PORT || 8590),
    rules: RULES,
  },
});

await env.clearFirestore();
await env.withSecurityRulesDisabled(async (context) => {
  const db = context.firestore();
  await Promise.all([
    setDoc(doc(db, `_accountSecurity/${OWNER}`), {
      status: 'active',
      revokedAfterSeconds: 0,
    }),
    setDoc(doc(db, `_accountSecurity/${OTHER}`), {
      status: 'active',
      revokedAfterSeconds: 0,
    }),
    setDoc(doc(db, `users/${OWNER}/contacts/contact-1`), {
      name: 'Ada',
      lifecycleStatus: 'active',
    }),
    setDoc(doc(db, `users/${OWNER}/contacts/contact-2`), {
      name: 'Lin',
      lifecycleStatus: 'active',
    }),
    setDoc(doc(db, `users/${OWNER}/contacts/contact-purging`), {
      name: 'Grace',
      lifecycleStatus: 'deleted',
      purgeFence: {
        requestId: 'contact-purging',
        leaseId: 'server-lease',
      },
    }),
    setDoc(doc(db, `users/${OWNER}/notes/voice-note`), {
      contactId: 'contact-1',
      recordType: 'voice',
    }),
    setDoc(doc(db, `users/${OWNER}/notes/purging-voice-note`), {
      contactId: 'contact-purging',
      recordType: 'voice',
    }),
    setDoc(doc(db, `users/${OWNER}/integrations/live-gmail`), {
      provider: 'gmail',
      mode: 'live',
      connected: true,
      historyId: 'server-cursor',
      updatedAt: new Date(),
    }),
    setDoc(doc(db, `users/${OWNER}/threads/live-thread`), {
      userId: OWNER,
      threadId: 'live-thread',
      contactId: 'contact-1',
      contactName: 'Ada',
      subject: 'Server verified',
      outreachId: 'server-outreach',
      status: 'sent',
      sentAt: new Date(),
      lastCheckedAt: new Date(),
      mode: 'live',
      providerVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    setDoc(doc(db, `users/${OWNER}/eventSessions/server-session`), {
      eventName: 'Server fixture',
    }),
    setDoc(doc(db, `users/${OWNER}/serverOnlyFuture/secret`), {
      refreshToken: 'must-never-be-readable-through-a-fallback',
    }),
  ]);
});

const owner = env.authenticatedContext(OWNER, {
  email: 'owner@example.com',
  email_verified: true,
  auth_time: 10,
}).firestore();
const other = env.authenticatedContext(OTHER, {
  email: 'other@example.com',
  email_verified: true,
  auth_time: 10,
}).firestore();

function outreach(overrides = {}) {
  return {
    userId: OWNER,
    contactId: 'contact-1',
    contactName: 'Ada',
    type: 'Email',
    channel: 'Email',
    subject: 'Hello',
    body: 'A short draft.',
    status: 'Drafted',
    verification: 'none',
    threadId: null,
    nextFollowUpDate: null,
    responseReceived: 'No',
    dateOfResponse: null,
    meetingHeld: false,
    meetingDate: null,
    nextAction: null,
    referralGenerated: false,
    applicationLinked: null,
    notes: null,
    aiSummary: null,
    sentAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function contact(overrides = {}) {
  return {
    userId: OWNER,
    name: 'Exact Contact',
    email: 'exact@example.com',
    normalizedEmail: 'exact@example.com',
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

function commitment(overrides = {}) {
  return {
    contactId: 'contact-1',
    contactName: 'Ada',
    text: 'Send the deck',
    dueHint: null,
    owedBy: 'you',
    status: 'open',
    sourceType: 'note',
    sourceId: 'voice-note',
    aiGrounding: null,
    feedback: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function mockThread(overrides = {}) {
  return {
    userId: OWNER,
    threadId: 'mock-thread',
    contactId: 'contact-1',
    contactName: 'Ada',
    subject: 'Preview thread',
    outreachId: null,
    status: 'sent',
    sentAt: new Date(),
    lastCheckedAt: new Date(),
    mode: 'mock',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function voiceJob(overrides = {}) {
  return {
    version: 1,
    noteId: 'voice-note',
    contactId: 'contact-1',
    contactName: 'Ada',
    state: 'queued',
    visible: true,
    cancelRequested: false,
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAtMs: null,
    queuedAt: '2026-07-29T12:00:00.000Z',
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-07-29T12:00:00.000Z',
    summary: {
      status: 'pending',
      error: null,
      completedAt: null,
      grounding: null,
      text: null,
    },
    commitments: {
      status: 'pending',
      error: null,
      completedAt: null,
      grounding: null,
      createdCount: 0,
    },
    ...overrides,
  };
}

function connection(connectionId, overrides = {}) {
  const observedAt = new Date('2026-07-20T12:00:00.000Z');
  return {
    userId: OWNER,
    sourceId: 'contact-1',
    targetId: 'contact-2',
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
      sourceId: `connection:${connectionId}`,
      observedAt,
    },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

await it('unknown private collections have no wildcard read or write access', async () => {
  await assertFails(
    getDoc(doc(owner, `users/${OWNER}/serverOnlyFuture/secret`)),
  );
  await assertFails(
    setDoc(doc(owner, `users/${OWNER}/futureClientData/forged`), {
      userId: OWNER,
    }),
  );
});

await it('contacts use an exact create schema and reject privileged root fields', async () => {
  const reference = doc(owner, `users/${OWNER}/contacts/exact-contact`);
  await assertSucceeds(setDoc(reference, contact()));
  await assertSucceeds(setDoc(
    doc(owner, `users/${OWNER}/contacts/csv-contact`),
    contact({
      name: 'Imported Contact',
      importProvenance: {
        sourceType: 'csv',
        sourceId: 'csv:csv-contact:row-1',
        rowId: 'row-1',
        mapping: 'ai-grounded',
        importedAt: serverTimestamp(),
      },
      aiGrounding: {
        feature: 'contact.csv.parse',
      },
      lastContactedAt: null,
    }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/contacts/unknown-field`),
    contact({ billingRole: 'admin' }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/contacts/forged-merge`),
    contact({
      mergedIntoContactId: 'contact-1',
      contactMergeOperationId: 'forged-operation',
    }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/contacts/forged-purge`),
    contact({
      purgeFence: {
        requestId: 'forged-purge',
        leaseId: 'browser',
      },
    }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/contacts/bad-email`),
    contact({ normalizedEmail: 'other@example.com' }),
  ));
});

await it('direct contact writes cannot bypass the profile revision API or server metadata', async () => {
  const reference = doc(owner, `users/${OWNER}/contacts/exact-contact`);
  await assertFails(updateDoc(reference, {
    company: 'Forged direct profile write',
    profileRevision: 1,
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    profileRevision: 99,
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    mergedIntoContactId: 'contact-1',
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    contactMergeOperationId: 'forged-operation',
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    purgeFence: { requestId: 'forged', leaseId: 'browser' },
    updatedAt: serverTimestamp(),
  }));
});

await it('contact lifecycle transitions remain recoverable but reject impossible states', async () => {
  const reference = doc(owner, `users/${OWNER}/contacts/exact-contact`);
  const archivedAt = new Date();
  await assertSucceeds(updateDoc(reference, {
    lifecycleStatus: 'archived',
    archivedAt,
    deletedAt: null,
    purgeEligibleAt: null,
    restoredAt: null,
    aiAllowed: false,
    aiAllowedBeforeLifecycle: true,
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(reference, {
    lifecycleStatus: 'active',
    archivedAt: null,
    deletedAt: null,
    purgeEligibleAt: null,
    restoredAt: new Date(),
    aiAllowed: true,
    aiAllowedBeforeLifecycle: null,
    updatedAt: serverTimestamp(),
  }));
  const deletedAt = new Date();
  const purgeEligibleAt = new Date(
    deletedAt.getTime() + 30 * 86_400_000,
  );
  await assertSucceeds(updateDoc(reference, {
    lifecycleStatus: 'deleted',
    archivedAt: null,
    deletedAt,
    purgeEligibleAt,
    aiAllowed: false,
    aiAllowedBeforeLifecycle: true,
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    lifecycleStatus: 'archived',
    archivedAt: new Date(),
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    lifecycleStatus: 'active',
    deletedAt: null,
    purgeEligibleAt: null,
    restoredAt: new Date(),
    aiAllowed: true,
    aiAllowedBeforeLifecycle: null,
    mergedIntoContactId: 'forged-restore-target',
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(reference, {
    lifecycleStatus: 'active',
    archivedAt: null,
    deletedAt: null,
    purgeEligibleAt: null,
    restoredAt: new Date(),
    aiAllowed: true,
    aiAllowedBeforeLifecycle: null,
    updatedAt: serverTimestamp(),
  }));
});

await it('contact activity, privacy, health, and introduction writers remain exact', async () => {
  const reference = doc(owner, `users/${OWNER}/contacts/exact-contact`);
  await assertSucceeds(updateDoc(reference, {
    lastContactedAt: new Date(),
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(reference, {
    healthPinned: true,
    healthPinnedAt: new Date(),
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(reference, {
    aiAllowed: false,
    privacyUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(reference, {
    introductionWillingness: 'likely',
    activeIntroductionRequests: 1,
    introductionCapacity: 3,
    introductionRequestsLast90Days: 2,
    lastIntroductionRequestAt: new Date(),
    introductionStaleAfterDays: 180,
    introductionConflicts: [],
    introductionMutualContext: 'Former teammates',
    introductionSignalsUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    introductionWillingness: 'guaranteed',
    introductionSignalsUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
});

await it('outreach draft, mail-client handoff, and user confirmation remain allowed', async () => {
  const reference = doc(owner, `users/${OWNER}/outreaches/outreach-1`);
  await assertSucceeds(setDoc(reference, outreach()));
  await assertSucceeds(updateDoc(reference, {
    status: 'Opened in Mail Client',
    verification: 'none',
    deliveryMode: 'mailto',
    openedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(reference, {
    status: 'Sent (User Confirmed)',
    verification: 'user-confirmed',
    userConfirmedAt: serverTimestamp(),
    sentAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
});

await it('a browser cannot forge provider send proof or unexpected outreach fields', async () => {
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/outreaches/forged-provider`),
    outreach({
      status: 'Sent (Provider Verified)',
      verification: 'provider-verified',
      threadId: 'gmail-thread',
      provider: 'gmail',
      providerSendState: 'completed',
      providerMessageId: 'gmail-message',
    }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/outreaches/extra-field`),
    outreach({ refreshToken: 'secret' }),
  ));
  const reference = doc(owner, `users/${OWNER}/outreaches/proof-update`);
  await assertSucceeds(setDoc(reference, outreach()));
  await assertFails(updateDoc(reference, {
    verification: 'provider-verified',
    threadId: 'gmail-thread',
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    providerRequestDigest: 'a'.repeat(64),
    providerReservationAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(reference));
});

await it('linked outreach writes stop at a contact purge fence', async () => {
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/outreaches/purge-race`),
    outreach({ contactId: 'contact-purging' }),
  ));
});

await it('commitments support create and status updates but reject forged schemas', async () => {
  const reference = doc(owner, `users/${OWNER}/commitments/commitment-1`);
  await assertSucceeds(setDoc(reference, commitment()));
  await assertSucceeds(updateDoc(reference, {
    status: 'done',
    resolvedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(reference, {
    status: 'dismissed',
    feedback: {
      schemaVersion: 1,
      reality: 'not-real',
      resolution: 'dismissed',
      snoozedUntil: null,
      dismissReason: 'false-positive',
      dismissNote: null,
      relationshipOutcome: 'unknown',
      relationshipOutcomeNote: null,
      lastEventId: 'feedback-1',
      lastEventAt: '2026-07-29T12:00:00.000Z',
      counters: {
        events: 1,
        realityReviews: 1,
        markedReal: 0,
        markedNotReal: 1,
        completed: 0,
        snoozed: 0,
        dismissed: 1,
        outcomesRecorded: 0,
      },
    },
    feedbackUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/commitments/bad-owner`),
    commitment({ owedBy: 'system' }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/commitments/bad-extra`),
    commitment({ modelOutput: 'uncited' }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/commitments/purge-race`),
    commitment({ contactId: 'contact-purging' }),
  ));
  await assertFails(deleteDoc(reference));
});

await it('templates support exact create, edit, recovery, and restore transitions', async () => {
  const reference = doc(owner, `users/${OWNER}/templates/template-1`);
  await assertSucceeds(setDoc(reference, {
    userId: OWNER,
    lifecycleStatus: 'active',
    name: 'Warm intro',
    subject: 'Intro',
    body: 'Hello {{first_name}}',
    source: 'manual',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(reference, {
    name: 'Warm introduction',
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(reference, {
    lifecycleStatus: 'deleted',
    deletedAt: serverTimestamp(),
    purgeAfter: new Date(Date.now() + 30 * 86_400_000),
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(reference, {
    lifecycleStatus: 'active',
    deletedAt: null,
    purgeAfter: null,
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    apiKey: 'forged',
    updatedAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(reference));
});

await it('mock integration state remains interactive and exact', async () => {
  const reference = doc(owner, `users/${OWNER}/integrations/gmail`);
  const now = new Date();
  await assertSucceeds(setDoc(reference, {
    provider: 'gmail',
    connected: true,
    mode: 'mock',
    email: 'owner@example.com',
    connectedAt: now,
    lastSyncedAt: now,
    expiresAt: new Date(now.getTime() + 7 * 86_400_000),
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(reference, {
    connected: false,
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    historyId: 'browser-cursor',
    updatedAt: serverTimestamp(),
  }));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/integrations/drive`),
    {
      provider: 'drive',
      connected: true,
      mode: 'mock',
      email: 'owner@example.com',
      connectedAt: now,
      lastSyncedAt: now,
      expiresAt: now,
      updatedAt: serverTimestamp(),
    },
  ));
});

await it('live integration status and server cursors are browser read-only', async () => {
  const reference = doc(owner, `users/${OWNER}/integrations/live-gmail`);
  await assertSucceeds(getDoc(reference));
  await assertFails(updateDoc(reference, {
    connected: false,
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    historyId: 'attacker-cursor',
    updatedAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(reference));
});

await it('mock threads can advance deterministically but live proof is server-only', async () => {
  const reference = doc(owner, `users/${OWNER}/threads/mock-thread`);
  await assertSucceeds(setDoc(reference, mockThread()));
  await assertSucceeds(updateDoc(reference, {
    status: 'delivered',
    lastCheckedAt: new Date(),
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    providerVerified: true,
    updatedAt: serverTimestamp(),
  }));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/threads/forged-live-thread`),
    mockThread({
      threadId: 'forged-live-thread',
      mode: 'live',
      providerVerified: true,
    }),
  ));
  await assertFails(updateDoc(
    doc(owner, `users/${OWNER}/threads/live-thread`),
    {
      status: 'replied',
      lastCheckedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  ));
  await assertFails(deleteDoc(reference));
});

await it('thread creation is path-bound and fenced to a live contact', async () => {
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/threads/path-thread`),
    mockThread({ threadId: 'different-thread' }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/threads/purging-thread`),
    mockThread({
      threadId: 'purging-thread',
      contactId: 'contact-purging',
    }),
  ));
});

await it('privacy settings accept only exact normalized policies and boundaries', async () => {
  const reference = doc(owner, `users/${OWNER}/settings/privacy`);
  const sourceTypes = [
    'profile', 'import', 'note', 'voice', 'meeting', 'calendar', 'email',
    'outreach', 'reply', 'commitment', 'public-card-capture', 'user-input',
    'system',
  ];
  const policy = {
    schemaVersion: 1,
    defaultRetentionMode: 'days',
    defaultRetentionDays: 30,
    defaultAIUse: 'allow',
    boundaries: sourceTypes.map((sourceType) => ({
      id: `type:${sourceType}`,
      scope: 'source-type',
      sourceType,
      sourceId: null,
      retentionMode: 'delete-on-disconnect',
      retentionDays: null,
      aiUse: 'never',
    })),
    updatedAt: serverTimestamp(),
  };
  await assertSucceeds(setDoc(reference, policy));
  await assertFails(setDoc(reference, {
    ...policy,
    boundaries: [{ ...policy.boundaries[0], accessToken: 'forged' }],
  }));
  await assertFails(setDoc(reference, {
    ...policy,
    defaultRetentionMode: 'days',
    defaultRetentionDays: null,
  }));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/settings/admin`),
    { role: 'owner', updatedAt: serverTimestamp() },
  ));
  await assertFails(deleteDoc(reference));
});

await it('bulk contact operation receipts follow their exact browser state machine', async () => {
  const reference = doc(
    owner,
    `users/${OWNER}/contactBulkOperations/bulk-1`,
  );
  await assertSucceeds(setDoc(reference, {
    type: 'soft-delete',
    actorUid: OWNER,
    requestedCount: 3,
    eligibleCount: 2,
    status: 'running',
    startedAt: serverTimestamp(),
    immutable: true,
  }));
  const deletedAt = new Date();
  await assertSucceeds(updateDoc(
    doc(owner, `users/${OWNER}/contacts/exact-contact`),
    {
      lifecycleStatus: 'deleted',
      deletedAt,
      purgeEligibleAt: new Date(
        deletedAt.getTime() + 30 * 86_400_000,
      ),
      aiAllowed: false,
      aiAllowedBeforeLifecycle: false,
      bulkOperationId: 'bulk-1',
      updatedAt: serverTimestamp(),
    },
  ));
  await assertSucceeds(updateDoc(reference, {
    completedCount: 1,
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(reference, {
    status: 'completed',
    completedCount: 2,
    completedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    requestedCount: 999,
  }));
  await assertFails(updateDoc(reference, {
    actorUid: OTHER,
  }));
  await assertFails(updateDoc(reference, {
    adminReceipt: true,
  }));
  await assertFails(deleteDoc(reference));
});

await it('event-session documents are server-only while the owner may read them', async () => {
  const reference = doc(
    owner,
    `users/${OWNER}/eventSessions/server-session`,
  );
  await assertSucceeds(getDoc(reference));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/eventSessions/forged-session`),
    { eventName: 'Forged' },
  ));
  await assertFails(updateDoc(reference, { eventName: 'Rewritten' }));
  await assertFails(deleteDoc(reference));
});

await it('voice jobs support browser queue, lease, cancellation, retry, and dismiss shapes', async () => {
  const reference = doc(
    owner,
    `users/${OWNER}/voiceEnrichmentJobs/voice-note`,
  );
  await assertSucceeds(setDoc(reference, voiceJob()));
  await assertSucceeds(setDoc(reference, voiceJob({
    state: 'running',
    attempt: 1,
    leaseOwner: 'tab-worker',
    leaseExpiresAtMs: Date.now() + 60_000,
    startedAt: '2026-07-29T12:00:01.000Z',
    updatedAt: '2026-07-29T12:00:01.000Z',
  })));
  await assertSucceeds(updateDoc(reference, {
    cancelRequested: true,
    updatedAt: '2026-07-29T12:00:02.000Z',
  }));
  await assertSucceeds(updateDoc(reference, {
    visible: false,
    updatedAt: '2026-07-29T12:00:03.000Z',
  }));
});

await it('voice jobs are note-bound, contact-fenced, exact, and not hard deletable', async () => {
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/voiceEnrichmentJobs/wrong-path`),
    voiceJob(),
  ));
  await assertFails(setDoc(
    doc(
      owner,
      `users/${OWNER}/voiceEnrichmentJobs/purging-voice-note`,
    ),
    voiceJob({
      noteId: 'purging-voice-note',
      contactId: 'contact-purging',
    }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/voiceEnrichmentJobs/voice-note-extra`),
    voiceJob({
      noteId: 'voice-note-extra',
      modelApiKey: 'forged',
    }),
  ));
  await assertFails(deleteDoc(
    doc(owner, `users/${OWNER}/voiceEnrichmentJobs/voice-note`),
  ));
});

await it('relationship edges accept only the exact explicit-evidence shape', async () => {
  const connectionId = 'contact-1--contact-2';
  const reference = doc(
    owner,
    `users/${OWNER}/connections/${connectionId}`,
  );
  await assertSucceeds(setDoc(
    reference,
    connection(connectionId),
  ));
  await assertSucceeds(updateDoc(reference, {
    direction: 'directed',
    weight: 4,
    strength: 0.8,
    updatedAt: serverTimestamp(),
  }));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/connections/extra-edge`),
    connection('extra-edge', { modelConclusion: 'close friends' }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/connections/self-edge`),
    connection('self-edge', { targetId: 'contact-1' }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/connections/missing-edge`),
    connection('missing-edge', { targetId: 'missing-contact' }),
  ));
  await assertFails(setDoc(
    doc(owner, `users/${OWNER}/connections/purging-edge`),
    connection('purging-edge', { targetId: 'contact-purging' }),
  ));
  await assertFails(updateDoc(reference, {
    sourceId: 'contact-2',
    targetId: 'contact-1',
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(reference, {
    contactMergeOperationId: 'forged-merge',
    updatedAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(reference));
});

await it('another authenticated user cannot read or mutate exact private collections', async () => {
  for (const pathName of [
    'outreaches/outreach-1',
    'contacts/exact-contact',
    'commitments/commitment-1',
    'templates/template-1',
    'integrations/gmail',
    'threads/mock-thread',
    'settings/privacy',
    'contactBulkOperations/bulk-1',
    'eventSessions/server-session',
    'voiceEnrichmentJobs/voice-note',
    'connections/contact-1--contact-2',
  ]) {
    await assertFails(getDoc(doc(other, `users/${OWNER}/${pathName}`)));
  }
});

await env.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`Failing: ${failures.join(', ')}`);
  process.exitCode = 1;
}
