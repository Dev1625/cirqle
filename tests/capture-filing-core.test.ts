import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCaptureEvidence,
  captureContactDocumentId,
  captureEvidenceSummary,
  chooseExistingCaptureContact,
  contactCanReceiveCapture,
  normalizeCaptureEmail,
} from '../src/lib/captureFilingCore.ts';
import {
  buildCaptureEvidence as buildServerCaptureEvidence,
  captureContactDocumentId as serverCaptureContactDocumentId,
  captureEvidenceSummary as serverCaptureEvidenceSummary,
  normalizeCaptureEmail as normalizeServerCaptureEmail,
} from '../functions/capture-filing.js';

test('browser and trigger normalize and key capture emails identically', async () => {
  const input = '  ALEx.Rivera@EXAMPLE.COM  ';
  assert.equal(normalizeCaptureEmail(input), 'alex.rivera@example.com');
  assert.equal(
    normalizeServerCaptureEmail(input),
    'alex.rivera@example.com',
  );
  assert.equal(
    await captureContactDocumentId(input),
    serverCaptureContactDocumentId(input),
  );
  assert.equal(normalizeCaptureEmail('not-an-email'), null);
  assert.equal(normalizeServerCaptureEmail('not-an-email'), null);
});

test('email dedupe is deterministic and never attaches to unsafe contacts', () => {
  const email = 'repeat@example.com';
  const candidates = [
    {
      id: 'z-deleted',
      data: { email, lifecycleStatus: 'deleted' },
    },
    {
      id: 'a-purging',
      data: { email, purgeFence: { requestId: 'purge-1' } },
    },
    {
      id: 'b-merged',
      data: { email, mergedIntoContactId: 'primary' },
    },
    {
      id: 'd-safe',
      data: { email: 'REPEAT@example.com', name: 'Do not overwrite' },
    },
    {
      id: 'c-safe',
      data: { email, lifecycleStatus: 'archived' },
    },
  ];

  assert.equal(contactCanReceiveCapture(candidates[0].data), false);
  assert.equal(contactCanReceiveCapture(candidates[1].data), false);
  assert.equal(contactCanReceiveCapture(candidates[2].data), false);
  assert.equal(contactCanReceiveCapture(candidates[4].data), true);
  assert.equal(
    chooseExistingCaptureContact(candidates, email)?.id,
    'c-safe',
  );
});

test('capture dedupe uses canonical email keys and retains legacy records', () => {
  const canonical = chooseExistingCaptureContact(
    [
      {
        id: 'canonical',
        data: {
          email: 'stale@example.com',
          normalizedEmail: 'person@example.com',
          lifecycleStatus: 'active',
        },
      },
    ],
    'PERSON@example.com',
  );
  assert.equal(canonical?.id, 'canonical');

  const legacy = chooseExistingCaptureContact(
    [
      {
        id: 'legacy',
        data: {
          email: 'person@example.com',
          lifecycleStatus: 'active',
        },
      },
    ],
    'person@example.com',
  );
  assert.equal(legacy?.id, 'legacy');
});

test('capture evidence preserves consent, event, and unverified channel provenance', () => {
  const capturedAt = new Date('2026-07-29T18:30:00.000Z');
  const params = {
    cardId: '23456789ab',
    captureId: 'capture-1',
    contactId: 'existing-contact',
    data: {
      visitorName: 'Alex Rivera',
      visitorEmail: 'ALEX@EXAMPLE.COM',
      visitorCompany: 'Original visitor claim',
      note: 'Met after the keynote',
      consentToFollowUp: true,
      privacyNoticeVersion: '2026-07-29',
      eventSessionId: 'saastr-2026',
      eventName: 'SaaStr Annual 2026',
      eventSource: 'manual',
      captureChannel: 'nfc',
    },
    capturedAt,
    deduplicated: true,
  } as const;

  const evidence = buildCaptureEvidence(params);
  const serverEvidence = buildServerCaptureEvidence(params);
  assert.deepEqual(evidence, serverEvidence);
  assert.equal(evidence.visitorEmail, 'alex@example.com');
  assert.equal(evidence.consentRecordedAt, capturedAt);
  assert.equal(evidence.channelEvidence, 'client-url-marker');
  assert.equal(evidence.channelVerified, false);
  assert.equal(evidence.deduplicatedIntoExistingContact, true);
  assert.match(captureEvidenceSummary(evidence), /consent granted/i);
  assert.match(captureEvidenceSummary(evidence), /session saastr-2026/i);
  assert.equal(
    captureEvidenceSummary(evidence),
    serverCaptureEvidenceSummary(serverEvidence),
  );
});
