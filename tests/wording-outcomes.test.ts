import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeWordingOutcomes,
  buildCommunicationGraph,
  type OutreachLifecycleRecord,
} from '../src/lib/moat/communicationGraph';

const records: OutreachLifecycleRecord[] = [
  'one',
  'two',
  'three',
].map((id, index) => ({
  id,
  contactId: `contact-${index}`,
  body: 'Could you meet next week?',
  createdAt: `2026-07-${20 + index}T10:00:00.000Z`,
  sentAt: `2026-07-${20 + index}T10:05:00.000Z`,
  verification: 'provider-verified',
  provider: 'gmail',
  threadId: `thread-${id}`,
  providerMessageId: `message-${id}`,
  replyEvidence:
    index < 2
      ? {
          occurredAt: `2026-07-${20 + index}T11:00:00.000Z`,
          source: 'provider',
          sourceRecordId: `reply-${id}`,
          provider: 'gmail',
          threadId: `thread-${id}`,
          messageId: `reply-message-${id}`,
          eventId: `reply-event-${id}`,
        }
      : null,
}));

test('wording learning exposes only coarse patterns after a private sample floor', () => {
  const graph = buildCommunicationGraph({ outreaches: records });
  const result = analyzeWordingOutcomes(records, graph);
  const clearAsk = result.signals.find(
    (signal) => signal.feature === 'clear-ask',
  );
  assert.deepEqual(clearAsk, {
    feature: 'clear-ask',
    evidencedSends: 3,
    replies: 2,
    replyRate: 2 / 3,
  });
  assert.match(result.recommendation || '', /personal pattern to test/);
  assert.doesNotMatch(JSON.stringify(result), /Could you meet/);
});

test('wording learning hides rates and recommendations below three sends', () => {
  const subset = records.slice(0, 2);
  const result = analyzeWordingOutcomes(
    subset,
    buildCommunicationGraph({ outreaches: subset }),
  );
  assert.equal(
    result.signals.find((signal) => signal.feature === 'clear-ask')
      ?.replyRate,
    null,
  );
  assert.equal(result.recommendation, null);
});
