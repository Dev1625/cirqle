import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyStoredRetentionDocument,
  decodeRetentionSweepCursor,
  evaluateServerSourceRetention,
  executeSourceRetentionSweep,
  normalizeServerSourcePrivacyPolicy,
  runAdminSourceRetentionSweep,
  scanFirestoreRetentionCandidates,
} from '../server/api/_lib/source-retention.js';
import { createSourceRetentionSweepHandler } from '../server/api/account/retention-sweep.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const OLD = new Date('2026-01-01T12:00:00.000Z');
const FRESH = new Date('2026-07-20T12:00:00.000Z');
const IDENTITY = Object.freeze({
  uid: 'owner-uid',
  email: 'owner@cirqle.test',
  emailVerified: true,
  authTime: 1_800_000_000,
});
const QUIET_LOGGER = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

function daysPolicy(sourceType, days, sourceId = null) {
  return {
    schemaVersion: 1,
    defaultRetentionMode: 'forever',
    defaultRetentionDays: null,
    defaultAIUse: 'allow',
    boundaries: [
      {
        id: sourceId
          ? `source:${sourceType}:${sourceId}`
          : `type:${sourceType}`,
        scope: sourceId ? 'source' : 'source-type',
        sourceType,
        sourceId,
        retentionMode: 'days',
        retentionDays: days,
        aiUse: 'allow',
      },
    ],
  };
}

function ref(path) {
  return Object.freeze({ path });
}

function candidate({
  sourceType = 'note',
  sourceId = 'record-1',
  observedAt = OLD,
  disconnected = false,
  path = `users/owner-uid/notes/${sourceId}`,
  storageKind = 'notes',
} = {}) {
  return {
    sourceType,
    sourceId,
    observedAt,
    disconnected,
    storageKind,
    ref: ref(path),
  };
}

function request({
  method = 'POST',
  body = {},
  authorization = 'Bearer owner-token',
} = {}) {
  return {
    method,
    body,
    headers: authorization ? { authorization } : {},
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function fakeFirestore(collectionData) {
  const sorted = (path) =>
    Object.entries(collectionData[path] || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, data]) => makeDocument(path, id, data));

  function makeDocument(collectionPath, id, data) {
    const path = `${collectionPath}/${id}`;
    return {
      id,
      path,
      data: () => data,
      ref: {
        id,
        path,
        collection(name) {
          return makeCollection(`${path}/${name}`);
        },
      },
    };
  }

  function makeCollection(path, state = {}) {
    return {
      path,
      orderBy() {
        return makeCollection(path, state);
      },
      limit(value) {
        return makeCollection(path, { ...state, limit: value });
      },
      startAfter(value) {
        return makeCollection(path, { ...state, afterId: value });
      },
      async get() {
        const documents = sorted(path).filter(
          (document) =>
            !state.afterId ||
            document.id.localeCompare(state.afterId) > 0,
        );
        return {
          docs: documents.slice(0, state.limit ?? documents.length),
        };
      },
    };
  }

  return {
    collection(path) {
      return makeCollection(path);
    },
    doc(path) {
      const parts = path.split('/');
      const id = parts.at(-1);
      const collectionPath = parts.slice(0, -1).join('/');
      const data = collectionData[collectionPath]?.[id];
      const document = makeDocument(collectionPath, id, data || {});
      return {
        ...document.ref,
        async get() {
          return {
            exists: data != null,
            data: () => data || {},
          };
        },
      };
    },
  };
}

test('server policy normalization mirrors conservative browser semantics', () => {
  const policy = normalizeServerSourcePrivacyPolicy({
    defaultRetentionMode: 'days',
    defaultRetentionDays: 'corrupt',
    defaultAIUse: 'never',
    boundaries: [
      {
        sourceType: 'note',
        retentionMode: 'days',
        retentionDays: 90,
        aiUse: 'allow',
      },
      {
        sourceType: 'note',
        retentionMode: 'days',
        retentionDays: 30,
        aiUse: 'never',
      },
      {
        sourceType: 'profile',
        retentionMode: 'days',
        retentionDays: 0,
      },
    ],
  });

  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.defaultRetentionMode, 'days');
  assert.equal(policy.defaultRetentionDays, 30);
  assert.equal(policy.defaultAIUse, 'never');
  assert.equal(policy.boundaries.length, 1);
  assert.equal(policy.boundaries[0].id, 'type:note');
  assert.equal(policy.boundaries[0].retentionDays, 30);
  assert.equal(policy.boundaries[0].aiUse, 'never');
});

test('exact-source retention overrides its source-type boundary', () => {
  const policy = {
    ...daysPolicy('note', 30),
    boundaries: [
      daysPolicy('note', 30).boundaries[0],
      daysPolicy('note', 365, 'keep-this').boundaries[0],
    ],
  };

  const ordinary = evaluateServerSourceRetention(
    candidate({ sourceId: 'ordinary' }),
    policy,
    NOW,
  );
  const exact = evaluateServerSourceRetention(
    candidate({ sourceId: 'keep-this' }),
    policy,
    NOW,
  );

  assert.equal(ordinary.eligible, true);
  assert.equal(ordinary.boundaryId, 'type:note');
  assert.equal(exact.eligible, false);
  assert.equal(exact.boundaryId, 'source:note:keep-this');
});

test('finite retention is inclusive at expiry and never guesses an undated age', () => {
  const policy = daysPolicy('note', 30);
  const expiry = new Date(NOW.getTime() - 30 * 86_400_000);

  assert.equal(
    evaluateServerSourceRetention(
      candidate({ observedAt: expiry }),
      policy,
      NOW,
    ).eligible,
    true,
  );
  const missing = evaluateServerSourceRetention(
    candidate({ observedAt: null }),
    policy,
    NOW,
  );
  assert.equal(missing.eligible, false);
  assert.equal(missing.reason, 'observed-at-missing');
});

test('delete-on-disconnect requires a known disconnected provider state', () => {
  const policy = {
    defaultRetentionMode: 'delete-on-disconnect',
    boundaries: [],
  };
  assert.equal(
    evaluateServerSourceRetention(
      candidate({ sourceType: 'email', disconnected: true }),
      policy,
      NOW,
    ).eligible,
    true,
  );
  assert.equal(
    evaluateServerSourceRetention(
      candidate({ sourceType: 'email', disconnected: false }),
      policy,
      NOW,
    ).eligible,
    false,
  );
  assert.equal(
    evaluateServerSourceRetention(
      {
        ...candidate({ sourceType: 'email' }),
        disconnected: undefined,
      },
      policy,
      NOW,
    ).eligible,
    false,
  );
});

test('document classification uses exact metadata boundaries without reading content', () => {
  const secret = 'private note body that must never appear in a report';
  const cases = [
    [
      {
        collectionName: 'notes',
        documentId: 'plain-note',
        data: { content: secret, createdAt: OLD },
      },
      'note',
    ],
    [
      {
        collectionName: 'notes',
        documentId: 'capture-note',
        data: {
          content: secret,
          source: 'public-card-capture',
          privacySourceType: 'public-card-capture',
          createdAt: OLD,
        },
      },
      'public-card-capture',
    ],
    [
      {
        collectionName: 'notes',
        documentId: 'ai-tag-note',
        data: {
          content: secret,
          source: 'ai-tag-extraction',
          privacySourceType: 'user-input',
          createdAt: OLD,
        },
      },
      'user-input',
    ],
    [
      {
        collectionName: 'notes',
        documentId: 'voice-note',
        data: { content: secret, source: 'voice-memo', createdAt: OLD },
      },
      'voice',
    ],
    [
      {
        collectionName: 'notes',
        documentId: 'meeting-note',
        data: {
          content: secret,
          source: 'meeting-log',
          meetingAt: OLD,
        },
      },
      'meeting',
    ],
    [
      {
        collectionName: 'notes',
        documentId: 'reply-note',
        data: {
          content: secret,
          replyTargetOutreachId: 'outreach-1',
          createdAt: OLD,
        },
      },
      'reply',
    ],
    [
      {
        collectionName: 'outreaches',
        documentId: 'email-shaped-outreach',
        data: { channel: 'Email', body: secret, createdAt: OLD },
      },
      'outreach',
    ],
    [
      {
        collectionName: 'threads',
        documentId: 'gmail-thread',
        data: { subject: secret, sentAt: OLD },
        connections: { gmail: false },
      },
      'email',
    ],
    [
      {
        collectionName: 'commitments',
        documentId: 'commitment-1',
        data: { text: secret, sourceType: 'voice', createdAt: OLD },
      },
      'commitment',
    ],
    [
      {
        collectionName: 'facts',
        documentId: 'fact-1',
        data: {
          value: secret,
          sourceType: 'note',
          sourceId: 'plain-note',
          observedAt: OLD,
        },
      },
      'note',
    ],
    [
      {
        collectionName: 'facts',
        documentId: 'correction-1',
        data: {
          value: secret,
          sourceType: 'user-correction',
          observedAt: OLD,
        },
      },
      'user-input',
    ],
  ];

  for (const [input, expectedSourceType] of cases) {
    const result = classifyStoredRetentionDocument(input);
    assert.equal(result.sourceType, expectedSourceType);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(
    classifyStoredRetentionDocument({
      collectionName: 'contacts',
      documentId: 'primary-contact',
      data: { name: secret, createdAt: OLD },
    }),
    null,
  );
  assert.equal(
    classifyStoredRetentionDocument({
      collectionName: 'unknown',
      documentId: 'unknown',
      data: { content: secret },
    }),
    null,
  );
});

test('provider disconnection applies only to explicitly provider-backed records', () => {
  const gmailThread = classifyStoredRetentionDocument({
    collectionName: 'threads',
    documentId: 'thread-1',
    data: { sentAt: OLD },
    connections: { gmail: false },
  });
  const pastedReply = classifyStoredRetentionDocument({
    collectionName: 'notes',
    documentId: 'reply-1',
    data: {
      replyTargetThreadId: 'thread-1',
      createdAt: OLD,
    },
    connections: { gmail: false },
  });
  const calendarMeeting = classifyStoredRetentionDocument({
    collectionName: 'notes',
    documentId: 'meeting-1',
    data: {
      source: 'calendar-meeting',
      createdAt: OLD,
    },
    connections: { calendar: false },
  });

  assert.equal(gmailThread.disconnected, true);
  assert.equal(pastedReply.sourceType, 'reply');
  assert.equal(pastedReply.disconnected, false);
  assert.equal(calendarMeeting.disconnected, true);
});

test('dry run reports eligible counts without deleting or leaking paths/content', async () => {
  let commits = 0;
  const report = await executeSourceRetentionSweep({
    candidates: [
      candidate({ sourceId: 'expired', observedAt: OLD }),
      candidate({ sourceId: 'fresh', observedAt: FRESH }),
      candidate({ sourceId: 'undated', observedAt: null }),
    ],
    policy: daysPolicy('note', 30),
    dryRun: true,
    now: NOW,
    commitDeleteBatch: async () => {
      commits += 1;
    },
  });

  assert.equal(report.scanned, 3);
  assert.equal(report.eligible, 1);
  assert.equal(report.deleted, 0);
  assert.equal(report.retained, 2);
  assert.equal(report.missingObservedAt, 1);
  assert.equal(commits, 0);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('users/'), false);
  assert.equal(serialized.includes('expired'), false);
  assert.equal(serialized.includes('private'), false);
});

test('apply mode de-duplicates references and commits bounded batches', async () => {
  const records = Array.from({ length: 9 }, (_, index) =>
    candidate({
      sourceId: `record-${index}`,
      path: `users/owner-uid/notes/record-${index}`,
    }),
  );
  records.push(records[0]);
  const batches = [];

  const report = await executeSourceRetentionSweep({
    candidates: records,
    policy: daysPolicy('note', 30),
    dryRun: false,
    now: NOW,
    batchSize: 4,
    commitDeleteBatch: async (refs) => {
      batches.push(refs.map((item) => item.path));
    },
  });

  assert.deepEqual(
    batches.map((batch) => batch.length),
    [4, 4, 1],
  );
  assert.equal(new Set(batches.flat()).size, 9);
  assert.equal(report.scanned, 9);
  assert.equal(report.eligible, 9);
  assert.equal(report.deleted, 9);
});

test('admin seam passes only scoped controls and produces a resumable count report', async () => {
  const observed = {};
  const result = await runAdminSourceRetentionSweep({
    db: { marker: 'fake-admin-db' },
    uid: IDENTITY.uid,
    dryRun: true,
    now: NOW,
    cursor: 'opaque-input-cursor',
    maxDocuments: 12,
    pageSize: 5,
    loadPolicy: async (_db, uid) => {
      observed.policyUid = uid;
      return daysPolicy('note', 30);
    },
    loadConnections: async (_db, uid) => {
      observed.connectionUid = uid;
      return { gmail: false, calendar: null };
    },
    scanCandidates: async (input) => {
      observed.scan = input;
      return {
        candidates: [candidate()],
        hasMore: true,
        nextCursor: 'opaque-output-cursor',
      };
    },
  });

  assert.equal(observed.policyUid, IDENTITY.uid);
  assert.equal(observed.connectionUid, IDENTITY.uid);
  assert.equal(observed.scan.uid, IDENTITY.uid);
  assert.deepEqual(observed.scan.connections, {
    gmail: false,
    calendar: null,
  });
  assert.equal(observed.scan.cursor, 'opaque-input-cursor');
  assert.equal(observed.scan.maxDocuments, 12);
  assert.equal(observed.scan.pageSize, 5);
  assert.equal(result.eligible, 1);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, 'opaque-output-cursor');
});

test('Firestore scanner stays inside the user tree and resumes without repeating documents', async () => {
  const db = fakeFirestore({
    'users/owner-uid/notes': {
      a: { createdAt: OLD },
      b: { source: 'voice-memo', createdAt: OLD },
      c: { replyTargetOutreachId: 'outreach-1', createdAt: OLD },
      d: { source: 'meeting-log', meetingAt: OLD },
    },
    'users/owner-uid/contacts': {
      'contact-a': { name: 'Primary contact is traversal only' },
    },
    'users/owner-uid/contacts/contact-a/facts': {
      'fact-a': {
        sourceType: 'note',
        sourceId: 'a',
        observedAt: OLD,
        value: 'must not enter the report',
      },
    },
    // A different account is present in the fake store. The scanner must
    // never form this path from its cursor or include this record.
    'users/another-user/notes': {
      private: { createdAt: OLD },
    },
  });

  const first = await scanFirestoreRetentionCandidates({
    db,
    uid: IDENTITY.uid,
    maxDocuments: 3,
    pageSize: 2,
  });
  assert.equal(first.hasMore, true);
  assert.equal(first.candidates.length, 3);
  assert.deepEqual(
    first.candidates.map((item) => item.sourceType),
    ['note', 'voice', 'reply'],
  );

  const second = await scanFirestoreRetentionCandidates({
    db,
    uid: IDENTITY.uid,
    cursor: first.nextCursor,
    maxDocuments: 3,
    pageSize: 2,
  });
  assert.equal(second.hasMore, false);
  assert.deepEqual(
    second.candidates.map((item) => [
      item.sourceType,
      item.sourceId,
      item.ref.path,
    ]),
    [
      ['meeting', 'd', 'users/owner-uid/notes/d'],
      ['note', 'a', 'users/owner-uid/contacts/contact-a/facts/fact-a'],
    ],
  );
  assert.equal(
    second.candidates.some((item) =>
      item.ref.path.includes('another-user'),
    ),
    false,
  );
  assert.equal(
    second.candidates.some(
      (item) => item.ref.path === 'users/owner-uid/contacts/contact-a',
    ),
    false,
  );
});

test('cursor parser rejects malformed, oversized, and path-bearing state', () => {
  for (const value of [
    'not-base64-json',
    Buffer.from(
      JSON.stringify({ version: 2, sourceIndex: 0 }),
    ).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        version: 1,
        sourceIndex: 0,
        afterDocumentId: '../another-user',
      }),
    ).toString('base64url'),
    'a'.repeat(4_097),
  ]) {
    assert.throws(
      () => decodeRetentionSweepCursor(value),
      (error) => error.code === 'retention_cursor_invalid',
    );
  }
});

test('endpoint defaults to a safe dry run and rejects cross-user claims', async () => {
  const calls = [];
  const handler = createSourceRetentionSweepHandler({
    verifyIdentity: async () => IDENTITY,
    assertRecent() {
      throw new Error('dry run must not require recent login');
    },
    sweepAccount: async (input) => {
      calls.push(input);
      return {
        schemaVersion: 1,
        dryRun: input.dryRun,
        scanned: 0,
        eligible: 0,
        deleted: 0,
        hasMore: false,
        nextCursor: null,
      };
    },
    logger: QUIET_LOGGER,
  });

  const crossUser = response();
  await handler(
    request({ body: { userId: 'another-user' } }),
    crossUser,
  );
  assert.equal(crossUser.statusCode, 403);
  assert.equal(calls.length, 0);

  const preview = response();
  await handler(request(), preview);
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.payload.dryRun, true);
  assert.equal(calls.length, 1);
  assert.equal(
    preview.headers['cache-control'],
    'private, no-store, max-age=0',
  );
});

test('destructive endpoint mode requires exact confirmation and recent auth', async () => {
  let sweeps = 0;
  let recentChecks = 0;
  const handler = createSourceRetentionSweepHandler({
    verifyIdentity: async () => IDENTITY,
    assertRecent() {
      recentChecks += 1;
    },
    sweepAccount: async ({ dryRun }) => {
      sweeps += 1;
      return {
        schemaVersion: 1,
        dryRun,
        scanned: 1,
        eligible: 1,
        deleted: 1,
        hasMore: false,
        nextCursor: null,
      };
    },
    logger: QUIET_LOGGER,
  });

  const unconfirmed = response();
  await handler(
    request({ body: { dryRun: false, confirmation: 'apply retention' } }),
    unconfirmed,
  );
  assert.equal(unconfirmed.statusCode, 400);
  assert.equal(unconfirmed.payload.error.code, 'confirmation_required');
  assert.equal(sweeps, 0);

  const applied = response();
  await handler(
    request({
      body: { dryRun: false, confirmation: 'APPLY RETENTION' },
    }),
    applied,
  );
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.payload.deleted, 1);
  assert.equal(recentChecks, 1);
  assert.equal(sweeps, 1);
});

test('endpoint emits stable sanitized failures with no source content or UID in logs', async () => {
  const privateDetail =
    'owner-uid private note content sk-provider-secret stack trace';
  const logs = [];
  const handler = createSourceRetentionSweepHandler({
    verifyIdentity: async () => IDENTITY,
    sweepAccount: async () => {
      throw Object.assign(new Error(privateDetail), {
        code: 'firestore-private-provider-detail',
      });
    },
    logger: {
      error(...args) {
        logs.push(args);
      },
    },
  });
  const res = response();

  await handler(request(), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error.code, 'retention_sweep_unavailable');
  const serializedResponse = JSON.stringify(res.payload);
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedResponse.includes(privateDetail), false);
  assert.equal(serializedLogs.includes(privateDetail), false);
  assert.equal(serializedLogs.includes('owner-uid'), false);
  assert.equal(serializedLogs.includes('stack'), false);
});

test('endpoint accepts POST only and rejects unauthenticated requests before storage', async () => {
  let sweeps = 0;
  const handler = createSourceRetentionSweepHandler({
    verifyIdentity: async () => {
      throw Object.assign(new Error('missing'), {
        code: 'unauthorized',
      });
    },
    sweepAccount: async () => {
      sweeps += 1;
    },
    logger: QUIET_LOGGER,
  });

  const wrongMethod = response();
  await handler(request({ method: 'GET' }), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');

  const unauthorized = response();
  await handler(request({ authorization: null }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.payload.error.code, 'unauthorized');
  assert.equal(sweeps, 0);
});
