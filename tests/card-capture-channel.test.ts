import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVCard,
  cardUrl,
  type PublicCard,
} from '../src/lib/card.ts';

test('owner-issued QR, NFC, share, and direct card URLs stay distinct', () => {
  assert.equal(cardUrl('23456789ab'), '/c/23456789ab');
  assert.equal(cardUrl('23456789ab', 'qr'), '/c/23456789ab?via=qr');
  assert.equal(cardUrl('23456789ab', 'nfc'), '/c/23456789ab?via=nfc');
  assert.equal(cardUrl('23456789ab', 'link'), '/c/23456789ab?via=link');
  assert.equal(
    new Set([
      cardUrl('23456789ab'),
      cardUrl('23456789ab', 'qr'),
      cardUrl('23456789ab', 'nfc'),
      cardUrl('23456789ab', 'link'),
    ]).size,
    4,
  );
});

test('downloaded vCards carry the shared-link marker instead of fabricating NFC', () => {
  const card: PublicCard = {
    cardId: '23456789ab',
    ownerUid: 'owner-1',
    mode: 'custom',
    accent: 'oxblood',
    layout: 'compact',
    name: 'Devarshi Dalal',
    role: 'Founder',
    company: 'Cirqle',
    intro: '',
    links: [],
    email: null,
    published: true,
  };
  const vcard = buildVCard(card);
  assert.match(vcard, /URL:\/c\/23456789ab\?via=link/);
  assert.doesNotMatch(vcard, /via=nfc/);
});

test('downloaded vCards escape carriage-return and line-feed injection', () => {
  const card: PublicCard = {
    cardId: '23456789ab',
    ownerUid: 'owner-1',
    mode: 'custom',
    accent: 'oxblood',
    layout: 'compact',
    name: 'Ada\r\nTEL;TYPE=CELL:+15551234567',
    role: 'Founder\rTITLE:Injected',
    company: 'Cirqle\nORG:Injected',
    intro: 'Hello\r\nURL:javascript:alert(1)',
    links: [],
    email: 'ada@example.com',
    published: true,
  };
  const vcard = buildVCard(card);
  assert.equal(vcard.includes('\r\nTEL;TYPE=CELL:+15551234567'), false);
  assert.equal(vcard.includes('\r\nTITLE:Injected'), false);
  assert.equal(vcard.includes('\r\nORG:Injected'), false);
  assert.equal(vcard.includes('\r\nURL:javascript:alert(1)'), false);
  assert.match(vcard, /FN:Ada\\nTEL\\;TYPE=CELL:\+15551234567/);
});
