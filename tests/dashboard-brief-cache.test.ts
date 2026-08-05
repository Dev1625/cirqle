import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  clearAllDashboardBriefCaches,
  DASHBOARD_BRIEF_CACHE_TTL_MS,
  purgeDashboardBriefCaches,
  readDashboardBriefCache,
  writeDashboardBriefCache,
} from '../src/lib/dashboardBriefCache';

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

test('dashboard AI briefs live only in session storage and expire after thirty minutes', () => {
  const sessionStorage = new MemoryStorage();
  const localStorage = new MemoryStorage();
  const now = 1_000_000;

  assert.equal(
    writeDashboardBriefCache('user-a', 'encoded-private-brief', {
      now,
      sessionStorage,
      localStorage,
    }),
    true,
  );
  assert.equal(localStorage.length, 0);
  assert.equal(
    readDashboardBriefCache('user-a', {
      now: now + DASHBOARD_BRIEF_CACHE_TTL_MS - 1,
      sessionStorage,
      localStorage,
    }),
    'encoded-private-brief',
  );
  assert.equal(
    readDashboardBriefCache('user-a', {
      now: now + DASHBOARD_BRIEF_CACHE_TTL_MS,
      sessionStorage,
      localStorage,
    }),
    null,
  );
  assert.equal(sessionStorage.length, 0);
});

test('shared-browser startup retains only the active user cache and purges legacy persistent briefs', () => {
  const sessionStorage = new MemoryStorage();
  const localStorage = new MemoryStorage();
  const now = 2_000_000;

  writeDashboardBriefCache('user-a', 'private-a', {
    now,
    sessionStorage,
    localStorage,
  });
  writeDashboardBriefCache('user-b', 'private-b', {
    now,
    sessionStorage,
    localStorage,
  });
  localStorage.setItem('ai_brief_user-a', 'legacy-private-a');
  localStorage.setItem('ai_brief_time_user-a', String(now));
  localStorage.setItem('CIRQLE_CARD_VISITOR', 'Public card visitor');
  localStorage.setItem('unrelated-preference', 'keep');

  purgeDashboardBriefCaches('user-b', {
    now: now + 1,
    sessionStorage,
    localStorage,
  });

  assert.equal(
    readDashboardBriefCache('user-a', {
      now: now + 1,
      sessionStorage,
      localStorage,
    }),
    null,
  );
  assert.equal(
    readDashboardBriefCache('user-b', {
      now: now + 1,
      sessionStorage,
      localStorage,
    }),
    'private-b',
  );
  assert.equal(localStorage.getItem('ai_brief_user-a'), null);
  assert.equal(localStorage.getItem('ai_brief_time_user-a'), null);
  assert.equal(
    localStorage.getItem('CIRQLE_CARD_VISITOR'),
    'Public card visitor',
  );
  assert.equal(localStorage.getItem('unrelated-preference'), 'keep');
});

test('sign-out and deletion cleanup remove every private brief without touching public-card visitor storage', () => {
  const sessionStorage = new MemoryStorage();
  const localStorage = new MemoryStorage();

  writeDashboardBriefCache('user-a', 'private-a', {
    sessionStorage,
    localStorage,
  });
  writeDashboardBriefCache('user-b', 'private-b', {
    sessionStorage,
    localStorage,
  });
  localStorage.setItem('ai_brief_user-a', 'legacy-private-a');
  localStorage.setItem('CIRQLE_CARD_VISITOR', 'Public card visitor');

  clearAllDashboardBriefCaches({ sessionStorage, localStorage });

  assert.equal(sessionStorage.length, 0);
  assert.equal(localStorage.getItem('ai_brief_user-a'), null);
  assert.equal(
    localStorage.getItem('CIRQLE_CARD_VISITOR'),
    'Public card visitor',
  );
});

test('Dashboard and auth lifecycle are wired to the privacy-scoped cache', () => {
  const dashboard = readFileSync(
    new URL('../src/pages/Dashboard.tsx', import.meta.url),
    'utf8',
  );
  const authContext = readFileSync(
    new URL('../src/contexts/AuthContext.tsx', import.meta.url),
    'utf8',
  );
  const appLayout = readFileSync(
    new URL('../src/layouts/AppLayout.tsx', import.meta.url),
    'utf8',
  );
  const accountSecurity = readFileSync(
    new URL(
      '../src/components/settings/AccountSecurityPanel.tsx',
      import.meta.url,
    ),
    'utf8',
  );

  assert.doesNotMatch(dashboard, /localStorage/);
  assert.match(dashboard, /readDashboardBriefCache\(user\.uid\)/);
  assert.match(dashboard, /writeDashboardBriefCache\(user\.uid/);
  assert.ok(
    authContext.indexOf('purgeDashboardBriefCaches') <
      authContext.indexOf('setUser(user)'),
  );
  assert.ok(
    appLayout.indexOf('clearAllDashboardBriefCaches()') <
      appLayout.indexOf('auth.signOut()'),
  );
  assert.equal(
    accountSecurity.match(/clearAllDashboardBriefCaches\(\)/g)?.length,
    2,
  );
});
