import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampConfidence,
  factsForAI,
  factsToGroundedSources,
  groupFactHistory,
  normalizeFactValue,
  type TemporalFact,
} from '../src/lib/factLedgerCore';

const fact = (
  id: string,
  overrides: Partial<TemporalFact> = {},
): TemporalFact => ({
  id,
  predicate: 'identity.company',
  value: 'Cirqle',
  normalizedValue: 'cirqle',
  sourceType: 'profile',
  sourceId: 'contact-1',
  observedAt: new Date('2026-07-28T12:00:00Z'),
  confidence: 1,
  current: true,
  aiAllowed: true,
  correctionOf: null,
  supersededBy: null,
  createdAt: new Date('2026-07-28T12:00:00Z'),
  updatedAt: new Date('2026-07-28T12:00:00Z'),
  ...overrides,
});

test('normalizes values and clamps confidence deterministically', () => {
  assert.equal(normalizeFactValue('  New   York  '), 'new york');
  assert.equal(clampConfidence(-1), 0);
  assert.equal(clampConfidence(1.5), 1);
  assert.equal(clampConfidence('invalid'), 0.5);
});

test('never sends superseded or user-excluded facts to AI', () => {
  const usable = fact('usable');
  const history = fact('history', { current: false });
  const privateFact = fact('private', { aiAllowed: false });
  assert.deepEqual(factsForAI([usable, history, privateFact]), [usable]);

  const sources = factsToGroundedSources('contact-1', [
    usable,
    history,
    privateFact,
  ]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 'fact-usable');
  assert.match(sources[0].content, /"confidence":1/);
  assert.equal(sources[0].privacySourceType, 'profile');
  assert.equal(sources[0].privacySourceId, 'contact-1');
});

test('corrections inherit the privacy origin of the fact they replace', () => {
  const original = fact('original-note-fact', {
    sourceType: 'note',
    sourceId: 'note-private-1',
    current: false,
    supersededBy: 'corrected-fact',
  });
  const corrected = fact('corrected-fact', {
    sourceType: 'user-correction',
    sourceId: 'original-note-fact',
    correctionOf: 'original-note-fact',
  });
  const [source] = factsToGroundedSources('contact-1', [
    original,
    corrected,
  ]);
  assert.equal(source.privacySourceType, 'note');
  assert.equal(source.privacySourceId, 'note-private-1');

  const [standalone] = factsToGroundedSources('contact-1', [
    fact('standalone-correction', {
      sourceType: 'user-correction',
      correctionOf: null,
    }),
  ]);
  assert.equal(standalone.privacySourceType, 'user-input');
  assert.equal(standalone.privacySourceId, 'standalone-correction');
});

test('keeps correction history grouped in reverse chronology', () => {
  const older = fact('older', {
    value: 'Old Co',
    normalizedValue: 'old co',
    current: false,
    observedAt: new Date('2025-01-01T00:00:00Z'),
  });
  const newer = fact('newer', {
    value: 'New Co',
    normalizedValue: 'new co',
    correctionOf: 'older',
    observedAt: new Date('2026-01-01T00:00:00Z'),
  });
  const grouped = groupFactHistory([older, newer]);
  assert.deepEqual(
    grouped.get('identity.company')?.map((item) => item.id),
    ['newer', 'older'],
  );
});
