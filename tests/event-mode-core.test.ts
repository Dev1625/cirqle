import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeterministicEventRecap,
  buildEventAudienceMap,
  captureProvenanceFor,
  createEventSessionIdentity,
} from '../src/lib/eventModeCore.ts';

const session = createEventSessionIdentity({
  sessionId: 'session-saastr-2026',
  eventName: '  SaaStr   Annual 2026  ',
  source: 'calendar',
  active: false,
  startedAt: '2026-07-28T09:00:00.000Z',
  endedAt: '2026-07-28T18:00:00.000Z',
});

test('event identity normalizes a completed calendar session', () => {
  assert.deepEqual(
    {
      ...session,
      startedAt: session.startedAt?.toISOString(),
      endedAt: session.endedAt?.toISOString(),
    },
    {
      sessionId: 'session-saastr-2026',
      eventName: 'SaaStr Annual 2026',
      source: 'calendar',
      status: 'completed',
      startedAt: '2026-07-28T09:00:00.000Z',
      endedAt: '2026-07-28T18:00:00.000Z',
    },
  );
  assert.throws(
    () =>
      createEventSessionIdentity({
        sessionId: '',
        eventName: 'SaaStr',
      }),
    /session id/i,
  );
});

test('capture provenance reports recorded QR and NFC channels without inventing a missing channel', () => {
  assert.deepEqual(
    captureProvenanceFor({
      id: 'nfc',
      capturedVia: 'nfc-card',
      capturedAt: '2026-07-28T10:00:00.000Z',
      captureProvenance: { sourceId: 'private-capture-nfc' },
    }),
    {
      channel: 'nfc',
      label: 'NFC card',
      confidence: 'recorded',
      evidence: 'legacy-record',
      verifiedHardware: false,
      sourceId: 'private-capture-nfc',
      capturedAt: new Date('2026-07-28T10:00:00.000Z'),
    },
  );
  assert.equal(
    captureProvenanceFor({
      id: 'qr',
      captureChannel: 'qr-code',
    }).channel,
    'qr',
  );
  assert.deepEqual(
    captureProvenanceFor({ id: 'unknown' }),
    {
      channel: 'unknown',
      label: 'Public card (channel not recorded)',
      confidence: 'unknown',
      evidence: 'legacy-record',
      verifiedHardware: false,
      sourceId: null,
      capturedAt: null,
    },
  );
  const direct = captureProvenanceFor({
    id: 'direct',
    captureChannel: 'direct',
    captureProvenance: { channelEvidence: 'unmarked-url' },
  });
  assert.equal(direct.channel, 'public-card');
  assert.equal(direct.evidence, 'unmarked-url');
  assert.equal(direct.verifiedHardware, false);
});

test('event recap creates a deterministic consent-first action queue', () => {
  const recap = buildDeterministicEventRecap({
    session,
    contacts: [
      {
        id: 'no-consent',
        name: 'Priya Rao',
        company: 'Atlas',
        email: 'priya@example.com',
        consentToFollowUp: false,
        capturedAt: '2026-07-28T11:00:00.000Z',
        captureChannel: 'qr-code',
      },
      {
        id: 'ready',
        name: 'Maya Chen',
        company: 'Northstar',
        email: 'maya@example.com',
        consentToFollowUp: true,
        capturedAt: '2026-07-28T10:00:00.000Z',
        capturedVia: 'nfc-card',
      },
      {
        id: 'no-channel',
        name: 'Jon Bell',
        consentToFollowUp: true,
        capturedAt: '2026-07-28T12:00:00.000Z',
      },
    ],
  });

  assert.equal(recap.generatedWithoutAI, true);
  assert.equal(recap.contactCount, 3);
  assert.equal(recap.consentedCount, 2);
  assert.equal(recap.suggestedFollowUps, 1);
  assert.deepEqual(
    recap.contacts.map((contact) => contact.id),
    ['ready', 'no-consent', 'no-channel'],
  );
  assert.deepEqual(
    recap.nextActions.map((action) => [
      action.kind,
      action.outreachAllowed,
    ]),
    [
      ['follow-up', true],
      ['confirm-channel', false],
      ['review-only', false],
    ],
  );
  assert.equal(
    recap.nextActions[0].dueAt?.toISOString(),
    '2026-07-30T10:00:00.000Z',
  );
  assert.match(recap.nextActions[2].reason, /must not create outreach/i);
  assert.deepEqual(recap.channelCounts, {
    nfc: 1,
    qr: 1,
    'shared-link': 0,
    'public-card': 0,
    unknown: 1,
  });
});

test('public and attendee maps are aggregate-only and suppress small cohorts', () => {
  const privateNames = [
    'Avery Private',
    'Blair Private',
    'Casey Private',
    'Devon Private',
  ];
  const privateIds = ['avery-id', 'blair-id', 'casey-id', 'devon-id'];
  const privateEmails = privateIds.map((id) => `${id}@example.com`);
  const recap = buildDeterministicEventRecap({
    session,
    contacts: privateNames.map((name, index) => ({
      id: privateIds[index],
      name,
      email: privateEmails[index],
      company: index < 3 ? 'Northstar' : 'One Person Co',
      consentToFollowUp: true,
      captureProvenance: { sourceId: `source-${index}` },
    })),
  });

  const organizer = buildEventAudienceMap(recap, 'organizer', 'Organizer');
  assert.equal(organizer.nodes.length, 5);
  assert.equal(organizer.edges.length, 4);
  assert.ok(organizer.nodes.some((node) => node.label === 'Avery Private'));

  for (const scope of ['attendee', 'public'] as const) {
    const safeMap = buildEventAudienceMap(recap, scope);
    const serialized = JSON.stringify(safeMap);

    assert.deepEqual(safeMap.cohorts, [
      { label: 'Northstar cohort', attendeeCount: 3 },
    ]);
    assert.equal(safeMap.suppressedAttendees, 1);
    for (const secret of [
      ...privateNames,
      ...privateIds,
      ...privateEmails,
      'One Person Co',
      'source-0',
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.match(safeMap.disclaimer, /no contact names, ids, email addresses/i);
  }
});

test('empty recap is explicit and still produces a safe zero-person map', () => {
  const recap = buildDeterministicEventRecap({ session, contacts: [] });
  assert.equal(recap.headline, 'No captures at SaaStr Annual 2026 yet.');
  assert.deepEqual(recap.nextActions, []);

  const publicMap = buildEventAudienceMap(recap, 'public');
  assert.equal(publicMap.totalAttendees, 0);
  assert.deepEqual(publicMap.cohorts, []);
  assert.equal(publicMap.suppressedAttendees, 0);
});
