import assert from 'node:assert/strict';
import test from 'node:test';

import {
  rankRelationshipsLocally,
  relationshipFeatures,
} from '../src/lib/moat/localRelationshipIndex';

test('local relationship index ranks explicit first-party fields deterministically', () => {
  const contacts = [
    {
      id: 'engineering',
      name: 'Morgan',
      role: 'Platform engineer',
      company: 'Northstar',
    },
    {
      id: 'investing',
      name: 'Maya',
      role: 'Private equity marketing lead',
      tags: ['fundraising', 'growth'],
    },
    {
      id: 'recruiting',
      name: 'Sam',
      role: 'Executive recruiter',
    },
  ];
  const ranked = rankRelationshipsLocally(
    'Who knows private equity marketing and fundraising?',
    contacts,
  );
  assert.equal(ranked[0].contact.id, 'investing');
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].matchedFeatures.includes('market'));
});

test('local relationship features are normalized and bounded', () => {
  const features = relationshipFeatures(
    'Investing, investors, and MARKETING in São Paulo',
  );
  assert.ok(features.includes('invest'));
  assert.ok(features.includes('market'));
  assert.ok(features.includes('sao'));
  assert.ok(features.length <= 400);
  assert.equal(features.includes('and'), false);
});
