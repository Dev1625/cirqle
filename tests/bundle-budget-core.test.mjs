import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readPositiveKilobyteBudget,
} from '../scripts/bundle-budget-core.mjs';

test('bundle budgets use their measured defaults when no override exists', () => {
  assert.equal(
    readPositiveKilobyteBudget({}, 'CIRQLE_INITIAL_GZIP_KB', 320),
    320 * 1024,
  );
  assert.equal(
    readPositiveKilobyteBudget(
      {},
      'CIRQLE_ROUTE_CHUNK_GZIP_KB',
      315,
    ),
    315 * 1024,
  );
});

test('bundle budgets accept finite positive overrides', () => {
  assert.equal(
    readPositiveKilobyteBudget(
      { CIRQLE_INITIAL_GZIP_KB: '300.5' },
      'CIRQLE_INITIAL_GZIP_KB',
      320,
    ),
    300.5 * 1024,
  );
});

test('bundle budgets reject overrides that could bypass enforcement', () => {
  for (const value of [
    '',
    '   ',
    'invalid',
    'NaN',
    'Infinity',
    '0',
    '-1',
    '1e309',
  ]) {
    assert.throws(
      () =>
        readPositiveKilobyteBudget(
          { CIRQLE_INITIAL_GZIP_KB: value },
          'CIRQLE_INITIAL_GZIP_KB',
          320,
        ),
      /finite positive number/,
      value,
    );
  }
});
