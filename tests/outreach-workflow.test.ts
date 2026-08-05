import assert from 'node:assert/strict';
import test from 'node:test';
import type { GroundedSource } from '../src/lib/grounding';
import { getFollowUpQueueItems } from '../src/lib/tracker';
import {
  OUTREACH_AI_FEATURES,
  deliveryProofLabel,
  openedInMailClientState,
  providerVerifiedSendState,
  renderTemplate,
  reviewDraftGrounding,
  selectReplyTarget,
  userConfirmedSendState,
  validatedGroundedTags,
} from '../src/lib/outreachWorkflow';

const contactSource: GroundedSource = {
  id: 'contact-1',
  kind: 'contact',
  label: 'Contact profile',
  text: 'Maya Chen is a partner at Northstar Ventures.',
};

test('AI feature attribution is stable and specific to each workflow', () => {
  assert.deepEqual(OUTREACH_AI_FEATURES, {
    processReply: 'contact.reply.process',
    extractTags: 'contact.tags.extract',
    draftQuick: 'contact.outreach.draft.quick',
    draftPremium: 'contact.outreach.draft.premium',
  });
});

test('template variables are substituted and unresolved values stay visible', () => {
  const result = renderTemplate(
    {
      subject: 'Hello {{first_name}} at {{company}}',
      body: 'I am {{user_name}}. Could we discuss {{goal}}? {{unknown_value}}',
    },
    {
      contactName: 'Maya Chen',
      company: 'Northstar Ventures',
      userName: 'Dev',
      goal: 'the investor community',
    },
  );

  assert.equal(result.subject, 'Hello Maya at Northstar Ventures');
  assert.match(result.body, /I am Dev/);
  assert.deepEqual(result.unresolvedVariables, ['unknown_value']);
  assert.match(result.body, /{{unknown_value}}/);
});

test('reply mapping never falls back to the latest outreach', () => {
  const outreaches = [
    { id: 'latest', subject: 'Newest', status: 'Sent' },
    { id: 'chosen', subject: 'Original thread', status: 'Sent' },
  ];

  assert.equal(selectReplyTarget(outreaches, null), null);
  assert.equal(selectReplyTarget(outreaches, 'missing'), null);
  assert.equal(selectReplyTarget(outreaches, 'chosen')?.subject, 'Original thread');
});

test('AI tags are kept only when their evidence quote appears in the pasted conversation', () => {
  const tags = validatedGroundedTags(
    [
      {
        label: 'Mentioned: Moving to New York',
        evidenceQuote: 'moving to New York next month',
      },
      {
        label: 'Mentioned: Raising a Series B',
        evidenceQuote: 'raising a Series B',
      },
    ],
    'Maya said she is moving to New York next month and looking for a designer.',
  );

  assert.deepEqual(tags, ['Mentioned: moving to New York next month']);
});

test('hallucination gate blocks invented attachment, history, and news', () => {
  const issues = reviewDraftGrounding({
    draft: {
      subject: 'Following up on our recent call',
      body: 'I attached the one-pager after seeing your recent announcement.',
    },
    sources: [contactSource],
    unsupportedAssumptions: [],
  });

  assert.deepEqual(
    new Set(issues.map((issue) => issue.code)),
    new Set(['invented-attachment', 'invented-history', 'invented-news']),
  );
});

test('hallucination gate accepts risky claims only when the evidence contains them', () => {
  const issues = reviewDraftGrounding({
    draft: {
      subject: 'Following up on our recent call',
      body: 'I attached the one-pager we discussed after your recent announcement.',
    },
    sources: [
      contactSource,
      {
        id: 'meeting-1',
        kind: 'meeting',
        label: 'Meeting · Jul 28',
        text: 'We spoke on a call about the recent announcement and agreed that I would attach a one-pager.',
      },
    ],
    unsupportedAssumptions: [],
  });

  assert.deepEqual(issues, []);
});

test('a template is a constraint, not evidence for risky factual claims', () => {
  const issues = reviewDraftGrounding({
    draft: {
      subject: 'Following up',
      body: 'I attached the one-pager from our recent call.',
    },
    sources: [
      contactSource,
      {
        id: 'template-follow-up',
        kind: 'user-input',
        label: 'Template · Follow-up',
        text: 'I attached the one-pager from our recent call.',
      },
    ],
    unsupportedAssumptions: [],
  });

  assert.deepEqual(
    new Set(issues.map((issue) => issue.code)),
    new Set(['invented-attachment', 'invented-history']),
  );
});

test('delivery transitions preserve the distinction between handoff, confirmation, and provider proof', () => {
  assert.deepEqual(openedInMailClientState(), {
    status: 'Opened in Mail Client',
    verification: 'none',
    responseReceived: 'No',
    threadId: null,
  });
  assert.deepEqual(userConfirmedSendState(), {
    status: 'Sent (User Confirmed)',
    verification: 'user-confirmed',
    responseReceived: 'No',
    threadId: null,
  });
  assert.deepEqual(providerVerifiedSendState('thread-123'), {
    status: 'Sent (Provider Verified)',
    verification: 'provider-verified',
    responseReceived: 'No',
    threadId: 'thread-123',
  });
  assert.throws(() => providerVerifiedSendState(''), /requires a thread id/);
});

test('tracker labels legacy records without pretending they are verified', () => {
  assert.equal(
    deliveryProofLabel({ id: 'legacy', status: 'Sent' }),
    'Legacy record · verification unknown',
  );
  assert.equal(
    deliveryProofLabel({
      id: 'live',
      status: 'Sent (Provider Verified)',
      verification: 'provider-verified',
      threadId: 'thread-123',
    }),
    'Provider verified',
  );
  assert.equal(
    deliveryProofLabel({
      id: 'preview',
      status: 'Delivered',
      verification: 'preview-simulated',
    }),
    'Preview simulation',
  );
});

test('follow-up queue recognizes legacy and truthful send statuses but not mail-client handoff', () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
  const queue = getFollowUpQueueItems([
    {
      id: 'confirmed',
      contactId: 'confirmed',
      status: 'Sent (User Confirmed)',
      sentAt: tenDaysAgo,
    },
    {
      id: 'verified',
      contactId: 'verified',
      status: 'Sent (Provider Verified)',
      sentAt: tenDaysAgo,
    },
    {
      id: 'legacy',
      contactId: 'legacy',
      status: 'Sent',
      sentAt: tenDaysAgo,
    },
    {
      id: 'opened-only',
      contactId: 'opened-only',
      status: 'Opened in Mail Client',
      updatedAt: tenDaysAgo,
    },
  ]);

  assert.deepEqual(
    new Set(queue.map((row) => row.id)),
    new Set(['confirmed', 'verified', 'legacy']),
  );
});
