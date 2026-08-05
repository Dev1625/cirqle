import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findOrphanCommitmentFeedback,
  orphanFeedbackApplyRequested,
} from '../scripts/cleanup-orphan-commitment-feedback.mjs';

test('legacy feedback cleanup finds missing and malformed parent references', () => {
  assert.deepEqual(
    findOrphanCommitmentFeedback(
      [
        { id: 'kept', commitmentId: 'commitment-live' },
        { id: 'missing', commitmentId: 'commitment-gone' },
        { id: 'malformed', commitmentId: '../foreign' },
      ],
      ['commitment-live'],
    ),
    [
      { id: 'missing', commitmentId: 'commitment-gone' },
      { id: 'malformed', commitmentId: '../foreign' },
    ],
  );
});

test('legacy feedback cleanup is dry-run by default and apply is double-gated', () => {
  assert.equal(orphanFeedbackApplyRequested([], {}), false);
  assert.throws(
    () => orphanFeedbackApplyRequested(['--apply'], {}),
    /exact confirmation/,
  );
  assert.throws(
    () =>
      orphanFeedbackApplyRequested(
        [
          '--apply',
          '--confirm=DELETE-ORPHAN-COMMITMENT-FEEDBACK',
        ],
        {},
      ),
    /CIRQLE_ORPHAN_FEEDBACK_CLEANUP_ALLOW/,
  );
  assert.equal(
    orphanFeedbackApplyRequested(
      [
        '--apply',
        '--confirm=DELETE-ORPHAN-COMMITMENT-FEEDBACK',
      ],
      { CIRQLE_ORPHAN_FEEDBACK_CLEANUP_ALLOW: 'true' },
    ),
    true,
  );
});
