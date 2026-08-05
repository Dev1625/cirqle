import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import {
  createFirestoreGoogleIntegrationRepository,
} from '../functions/integrations.js';

const EMULATOR_AVAILABLE = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const PROJECT_ID = 'cirqle-google-send-test';
const NOW = new Date('2026-07-29T19:00:00.000Z');
const app = EMULATOR_AVAILABLE
  ? initializeApp({ projectId: PROJECT_ID }, 'google-send-emulator-test')
  : null;
const db = app ? getFirestore(app) : null;

before(async () => {
  if (!EMULATOR_AVAILABLE) return;
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.equal(response.ok, true);
});

after(async () => {
  if (app) await deleteApp(app);
});

async function seedDraft({
  uid,
  outreachId,
  contactId = 'contact',
  email = 'person@example.com',
  subject = 'Provider-owned proof',
  body = 'This exact saved body must be sent.',
}) {
  await Promise.all([
    db.doc(`_accountSecurity/${uid}`).set({
      status: 'active',
      revokedAfterSeconds: 0,
    }),
    db.doc(`users/${uid}/contacts/${contactId}`).set({
      name: 'Provider Recipient',
      email,
      lifecycleStatus: 'active',
    }),
    db.doc(`users/${uid}/outreaches/${outreachId}`).set({
      userId: uid,
      contactId,
      contactName: 'Provider Recipient',
      subject,
      body,
      status: 'Drafted',
      verification: 'none',
      threadId: null,
    }),
  ]);
  return { contactId, email, subject, body };
}

test(
  'provider success atomically owns the outreach proof, sent-thread registry, and live thread',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'provider-proof-owner';
    const outreachId = 'outreach_provider_proof_123';
    const draft = await seedDraft({ uid, outreachId });
    const repository = createFirestoreGoogleIntegrationRepository(db);
    const requestDigest = 'provider-request-digest';

    assert.deepEqual(
      await repository.beginGmailSend(uid, {
        idempotencyKey: outreachId,
        requestDigest,
        to: draft.email,
        subject: draft.subject,
        message: draft.body,
        createdAt: NOW,
      }),
      { status: 'reserved' },
    );
    const reserved = await db
      .doc(`users/${uid}/outreaches/${outreachId}`)
      .get();
    assert.equal(reserved.data().providerSendState, 'reserved');
    assert.equal(reserved.data().verification, 'none');

    await repository.completeGmailSend(uid, {
      idempotencyKey: outreachId,
      requestDigest,
      threadId: 'thread_provider_123',
      messageId: 'message_provider_456',
      completedAt: NOW,
    });

    const [outreach, thread, sentThread, receipt] = await Promise.all([
      db.doc(`users/${uid}/outreaches/${outreachId}`).get(),
      db.doc(`users/${uid}/threads/thread_provider_123`).get(),
      db
        .doc(`oauthTokens/${uid}/sentThreads/thread_provider_123`)
        .get(),
      db.doc(`oauthTokens/${uid}/gmailSends/${outreachId}`).get(),
    ]);
    assert.equal(outreach.data().verification, 'provider-verified');
    assert.equal(outreach.data().providerSendState, 'completed');
    assert.equal(outreach.data().threadId, 'thread_provider_123');
    assert.equal(thread.data().providerVerified, true);
    assert.equal(thread.data().outreachId, outreachId);
    assert.equal(sentThread.data().messageId, 'message_provider_456');
    assert.equal(receipt.data().status, 'completed');

    await repository.recordGmailPoll(uid, {
      statuses: { thread_provider_123: 'replied' },
      historyId: '123456789',
      checkedAt: new Date(NOW.getTime() + 60_000),
    });
    const [polledThread, gmailStatus] = await Promise.all([
      db.doc(`users/${uid}/threads/thread_provider_123`).get(),
      db.doc(`users/${uid}/integrations/gmail`).get(),
    ]);
    assert.equal(polledThread.data().status, 'replied');
    assert.equal(gmailStatus.data().historyId, '123456789');

    assert.deepEqual(
      await repository.beginGmailSend(uid, {
        idempotencyKey: outreachId,
        requestDigest,
        to: draft.email,
        subject: draft.subject,
        message: draft.body,
        createdAt: new Date(NOW.getTime() + 1_000),
      }),
      {
        status: 'completed',
        threadId: 'thread_provider_123',
        messageId: 'message_provider_456',
      },
    );
  },
);

test(
  'a forged recipient or changed body cannot reserve a provider send',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'provider-forgery-owner';
    const outreachId = 'outreach_provider_forgery_123';
    const draft = await seedDraft({ uid, outreachId });
    const repository = createFirestoreGoogleIntegrationRepository(db);

    await assert.rejects(
      repository.beginGmailSend(uid, {
        idempotencyKey: outreachId,
        requestDigest: 'forged-request-digest',
        to: 'attacker@example.com',
        subject: draft.subject,
        message: 'A browser-altered body.',
        createdAt: NOW,
      }),
      (error) =>
        error?.code === 'outreach_not_sendable' && error?.status === 409,
    );
    assert.equal(
      (
        await db
          .doc(`oauthTokens/${uid}/gmailSends/${outreachId}`)
          .get()
      ).exists,
      false,
    );
    assert.equal(
      (
        await db
          .doc(`users/${uid}/outreaches/${outreachId}`)
          .get()
      ).data().providerSendState,
      undefined,
    );
  },
);

test(
  'a reserved send cannot be completed with a different provider result digest',
  { skip: !EMULATOR_AVAILABLE },
  async () => {
    const uid = 'provider-digest-owner';
    const outreachId = 'outreach_provider_digest_123';
    const draft = await seedDraft({ uid, outreachId });
    const repository = createFirestoreGoogleIntegrationRepository(db);
    await repository.beginGmailSend(uid, {
      idempotencyKey: outreachId,
      requestDigest: 'original-request-digest',
      to: draft.email,
      subject: draft.subject,
      message: draft.body,
      createdAt: NOW,
    });

    await assert.rejects(
      repository.completeGmailSend(uid, {
        idempotencyKey: outreachId,
        requestDigest: 'different-request-digest',
        threadId: 'thread_wrong_digest',
        messageId: 'message_wrong_digest',
        completedAt: NOW,
      }),
      (error) => error?.code === 'send_status_unknown',
    );
    const outreach = await db
      .doc(`users/${uid}/outreaches/${outreachId}`)
      .get();
    assert.equal(outreach.data().providerSendState, 'reserved');
    assert.equal(outreach.data().verification, 'none');
    assert.equal(
      (
        await db
          .doc(`users/${uid}/threads/thread_wrong_digest`)
          .get()
      ).exists,
      false,
    );
  },
);
