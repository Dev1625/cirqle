import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasCardValidationErrors,
  isSafeHttpsUrl,
  validateCardConfig,
} from '../src/lib/cardValidation';
import { publicCardFromRecord } from '../src/lib/card';

const validCard = {
  mode: 'custom' as const,
  accent: 'oxblood',
  layout: 'expanded' as const,
  name: 'Alex Rivera',
  role: '',
  company: '',
  intro: '',
  portedUrl: null,
  email: 'alex@example.com',
  links: [{ label: 'Portfolio', url: 'https://example.com/alex' }],
  published: false,
};

test('accepts a card that mirrors the public Firestore schema', () => {
  assert.deepEqual(validateCardConfig(validCard), {});
  assert.equal(hasCardValidationErrors(validateCardConfig(validCard)), false);
});

test('requires a safe HTTPS URL for ported cards and public links', () => {
  assert.equal(isSafeHttpsUrl('https://example.com/path'), true);
  for (const unsafe of [
    'http://example.com',
    'javascript:alert(1)',
    'data:text/html,test',
    'https://user:pass@example.com',
  ]) {
    assert.equal(isSafeHttpsUrl(unsafe), false);
  }

  assert.match(
    validateCardConfig({ ...validCard, mode: 'ported', portedUrl: '' })
      .portedUrl || '',
    /Add the HTTPS page/,
  );
  assert.match(
    validateCardConfig({
      ...validCard,
      links: [{ label: 'Unsafe', url: 'javascript:alert(1)' }],
    }).links || '',
    /full HTTPS URL/,
  );
});

test('mirrors all server-side public field caps', () => {
  const errors = validateCardConfig({
    ...validCard,
    name: 'x'.repeat(121),
    role: 'x'.repeat(161),
    company: 'x'.repeat(161),
    intro: 'x'.repeat(241),
    email: `${'x'.repeat(310)}@example.com`,
    links: Array.from({ length: 7 }, (_, index) => ({
      label: `Link ${index}`,
      url: `https://example.com/${index}`,
    })),
  });

  assert.deepEqual(Object.keys(errors).sort(), [
    'company',
    'email',
    'intro',
    'links',
    'name',
    'role',
  ]);
});

test('defensively rejects malformed legacy public-card records before rendering', () => {
  const record = {
    cardId: '23456789ab',
    ownerUid: 'owner-1',
    ...validCard,
    published: true,
  };
  assert.ok(publicCardFromRecord('23456789ab', record));
  assert.equal(
    publicCardFromRecord('23456789ab', {
      ...record,
      portedUrl: 'https://trusted.example@attacker.example/profile',
    }),
    null,
  );
  assert.equal(
    publicCardFromRecord('23456789ab', {
      ...record,
      name: 'Ada\r\nTEL:+15551234567',
    }),
    null,
  );
  assert.equal(
    publicCardFromRecord('23456789ab', {
      ...record,
      published: 'yes',
    }),
    null,
  );
});
