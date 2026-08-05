import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  canClaimVoiceEnrichment,
  cancelVoiceEnrichment,
  claimVoiceEnrichment,
  completeVoiceCommitments,
  completeVoiceSummary,
  createVoiceEnrichmentJob,
  failVoiceEnrichment,
  markVoiceStepRunning,
  normalizeVoiceMemoText,
  retryVoiceEnrichment,
  VOICE_MEMO_MAX_CHARS,
  voiceEnrichmentProgress,
} from '../src/lib/voiceEnrichmentCore';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const GROUNDING = {
  usedSourceIds: ['note-note-1'],
  unsupportedAssumptions: [],
  privacyExclusions: [],
  sourceLabels: { 'note-note-1': 'Voice memo' },
  sourceObservedAt: {
    'note-note-1': '2026-07-29T11:58:00.000Z',
  },
  consideredSourceCount: 2,
  dataFreshThrough: '2026-07-29T11:58:00.000Z',
  generatedAt: '2026-07-29T12:00:05.000Z',
};

test('voice enrichment preserves raw-note identity through a visible two-step job', () => {
  const queued = createVoiceEnrichmentJob({
    noteId: 'note-1',
    contactId: 'contact-1',
    contactName: 'Avery Stone',
    now: NOW,
  });
  assert.equal(queued.state, 'queued');
  assert.equal(queued.visible, true);
  assert.deepEqual(voiceEnrichmentProgress(queued), {
    completed: 0,
    total: 2,
    percent: 0,
  });

  const claimed = claimVoiceEnrichment(queued, 'worker-a', NOW);
  const summarizing = markVoiceStepRunning(claimed, 'summary', NOW);
  const summarized = completeVoiceSummary(summarizing, {
    text: 'Avery will share the reviewed timeline.',
    grounding: GROUNDING,
    now: new Date(NOW.getTime() + 5_000),
  });
  assert.equal(summarized.summary.status, 'complete');
  assert.equal(summarized.summary.text, 'Avery will share the reviewed timeline.');
  assert.deepEqual(voiceEnrichmentProgress(summarized), {
    completed: 1,
    total: 2,
    percent: 50,
  });

  const complete = completeVoiceCommitments(
    markVoiceStepRunning(summarized, 'commitments', NOW),
    {
      createdCount: 2,
      grounding: GROUNDING,
      now: new Date(NOW.getTime() + 10_000),
    },
  );
  assert.equal(complete.state, 'complete');
  assert.equal(complete.leaseOwner, null);
  assert.equal(complete.commitments.createdCount, 2);
  assert.equal(voiceEnrichmentProgress(complete).percent, 100);
});

test('voice enrichment leases are single-owner and become reclaimable after expiry', () => {
  const queued = createVoiceEnrichmentJob({
    noteId: 'note-1',
    contactId: 'contact-1',
    contactName: 'Avery Stone',
    now: NOW,
  });
  const claimed = claimVoiceEnrichment(queued, 'worker-a', NOW);
  assert.equal(
    canClaimVoiceEnrichment(claimed, 'worker-b', NOW.getTime() + 1_000),
    false,
  );
  assert.equal(
    canClaimVoiceEnrichment(
      claimed,
      'worker-b',
      (claimed.leaseExpiresAtMs as number) + 1,
    ),
    true,
  );
});

test('cancel and retry keep completed work while resetting only unfinished steps', () => {
  const queued = createVoiceEnrichmentJob({
    noteId: 'note-1',
    contactId: 'contact-1',
    contactName: 'Avery Stone',
    now: NOW,
  });
  const summarized = completeVoiceSummary(
    claimVoiceEnrichment(queued, 'worker-a', NOW),
    {
      text: 'The saved summary.',
      grounding: GROUNDING,
      now: NOW,
    },
  );
  const cancelled = cancelVoiceEnrichment(summarized, NOW);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.summary.status, 'complete');
  assert.equal(cancelled.commitments.status, 'cancelled');

  const retried = retryVoiceEnrichment(cancelled, NOW);
  assert.equal(retried.state, 'queued');
  assert.equal(retried.summary.status, 'complete');
  assert.equal(retried.commitments.status, 'pending');
  assert.equal(retried.cancelRequested, false);
});

test('a later-step failure is partial and never erases a completed summary', () => {
  const queued = createVoiceEnrichmentJob({
    noteId: 'note-1',
    contactId: 'contact-1',
    contactName: 'Avery Stone',
    now: NOW,
  });
  const summarized = completeVoiceSummary(
    claimVoiceEnrichment(queued, 'worker-a', NOW),
    {
      text: 'The saved summary.',
      grounding: GROUNDING,
      now: NOW,
    },
  );
  const failed = failVoiceEnrichment(
    summarized,
    'commitments',
    'Commitment enrichment could not finish.',
    NOW,
  );
  assert.equal(failed.state, 'partial');
  assert.equal(failed.summary.status, 'complete');
  assert.equal(failed.commitments.status, 'failed');
});

test('voice memo text is bounded before storage or AI enrichment', () => {
  const oversized = `memo\u0000\r\n${'x'.repeat(VOICE_MEMO_MAX_CHARS + 50)}`;
  const normalized = normalizeVoiceMemoText(oversized);
  assert.equal(normalized.truncated, true);
  assert.equal(normalized.text.includes('\u0000'), false);
  assert.equal(normalized.text.includes('\r'), false);
  assert.equal(normalized.text.length, VOICE_MEMO_MAX_CHARS);
});

test('microphone disclosure appears before the explicit dictation consent action', () => {
  const source = readFileSync(
    new URL('../src/components/voice/VoiceMemo.tsx', import.meta.url),
    'utf8',
  );
  const disclosure = source.indexOf(
    'Your browser may send microphone audio to its speech-recognition',
  );
  const consent = source.indexOf('I understand — start dictation');
  assert.ok(disclosure >= 0);
  assert.ok(consent > disclosure);
  assert.doesNotMatch(
    readFileSync(new URL('../src/lib/speech.ts', import.meta.url), 'utf8'),
    /no audio leaving the device/i,
  );
});
