import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  getStoredVisitorName,
  PUBLIC_CARD_VISITOR_TTL_MS,
  storeVisitorName,
} from '../src/lib/publicCardVisitor';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const SESSION_KEY = 'cirqle:public-card-visitor:v2';

test('public-card visitor identity is normalized into expiring session storage only', () => {
  const sessionStorage = new MemoryStorage();
  const localStorage = new MemoryStorage();
  const now = 1_000_000;
  localStorage.setItem('CIRQLE_CARD_VISITOR', 'Previous device user');

  assert.equal(
    storeVisitorName('  Alex   Rivera  ', {
      now,
      sessionStorage,
      localStorage,
    }),
    true,
  );
  assert.equal(localStorage.getItem('CIRQLE_CARD_VISITOR'), null);
  assert.equal(localStorage.length, 0);
  assert.equal(
    getStoredVisitorName({
      now: now + PUBLIC_CARD_VISITOR_TTL_MS - 1,
      sessionStorage,
      localStorage,
    }),
    'Alex Rivera',
  );

  const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}');
  assert.equal(stored.name, 'Alex Rivera');
  assert.equal(stored.expiresAt - stored.storedAt, PUBLIC_CARD_VISITOR_TTL_MS);
});

test('expired or malformed visitor identities are forgotten on a shared device', () => {
  const sessionStorage = new MemoryStorage();
  const localStorage = new MemoryStorage();
  const now = 2_000_000;

  storeVisitorName('First Visitor', {
    now,
    sessionStorage,
    localStorage,
  });
  assert.equal(
    getStoredVisitorName({
      now: now + PUBLIC_CARD_VISITOR_TTL_MS,
      sessionStorage,
      localStorage,
    }),
    null,
  );
  assert.equal(sessionStorage.getItem(SESSION_KEY), null);

  sessionStorage.setItem(SESSION_KEY, '{"version":2,"name":42}');
  assert.equal(
    getStoredVisitorName({ now, sessionStorage, localStorage }),
    null,
  );
  assert.equal(sessionStorage.getItem(SESSION_KEY), null);

  sessionStorage.setItem(SESSION_KEY, 'not-json');
  assert.equal(
    getStoredVisitorName({ now, sessionStorage, localStorage }),
    null,
  );
  assert.equal(sessionStorage.getItem(SESSION_KEY), null);
});

test('legacy persistent visitor PII is blindly purged rather than migrated', () => {
  const sessionStorage = new MemoryStorage();
  const localStorage = new MemoryStorage();
  localStorage.setItem('CIRQLE_CARD_VISITOR', 'Do not migrate this name');
  localStorage.setItem('unrelated-public-card-preference', 'keep');

  assert.equal(
    getStoredVisitorName({ sessionStorage, localStorage }),
    null,
  );
  assert.equal(localStorage.getItem('CIRQLE_CARD_VISITOR'), null);
  assert.equal(
    localStorage.getItem('unrelated-public-card-preference'),
    'keep',
  );
  assert.equal(sessionStorage.length, 0);
});

test('every public-card submission visibly confirms or changes the remembered identity', () => {
  const source = readFileSync(
    new URL('../src/pages/PublicCard.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /Identity shared when saving/);
  assert.match(source, /Check this name on a shared device/);
  assert.match(source, /\{visitorName \? 'Change' : 'Add name'\}/);
  assert.match(source, /onClick=\{\(\) => openIdentity\('submit'\)\}/);
  assert.match(source, /Confirm before sharing/);
  assert.match(source, /Confirm and save/);
  assert.match(source, /const shouldSubmit = identityIntent === 'submit'/);
  assert.match(
    source,
    /if \(shouldSubmit\) void saveWithConfirmedIdentity\(cleaned\)/,
  );
  assert.match(source, /visitorName: confirmedName/);
  assert.doesNotMatch(source, /visitorName \|\| 'Someone'/);
  assert.doesNotMatch(source, /localStorage/);
});
