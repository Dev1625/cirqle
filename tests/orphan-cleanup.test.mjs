import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findOrphanUserIds,
  orphanSubject,
} from '../scripts/audit-orphan-accounts.mjs';

test('orphan audit compares Auth and Firestore without exposing raw ids', () => {
  assert.deepEqual(
    findOrphanUserIds(
      ['active-a', 'active-b'],
      ['active-b', 'orphan-z', 'active-a', 'orphan-c', 'orphan-z'],
    ),
    ['orphan-c', 'orphan-z'],
  );
  const subject = orphanSubject('private-firebase-uid');
  assert.match(subject, /^[a-f0-9]{16}$/);
  assert.equal(subject.includes('private'), false);
});
