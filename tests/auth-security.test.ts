import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assessPassword,
  clearAccountDeletionReceipt,
  friendlyAuthError,
  readAccountDeletionReceipt,
  rememberAccountDeletionReceipt,
} from '../src/lib/authSecurity';
import { captureFirebaseAuthAction } from '../src/lib/authActionUrl';

test('password assessment requires length, case variety, and a number or symbol', () => {
  assert.equal(assessPassword('short').isStrong, false);
  assert.equal(assessPassword('alllowercase1').isStrong, false);
  assert.equal(assessPassword('ALLUPPERCASE1').isStrong, false);
  assert.equal(assessPassword('LongEnoughSeahorse!').isStrong, true);
  assert.equal(assessPassword('LongEnoughSeahorse2').isStrong, true);
  assert.equal(assessPassword('Password123!').isStrong, false);
  assert.equal(assessPassword('QwertySecure1!').isStrong, false);
});

test('Firebase sign-in failures are friendly and do not expose raw details', () => {
  const raw =
    'Firebase: private-project-id auth/invalid-credential stack trace';
  const message = friendlyAuthError(
    { code: 'auth/invalid-credential', message: raw },
    'signIn',
  );

  assert.match(message, /did not match/i);
  assert.equal(message.includes(raw), false);
  assert.equal(message.includes('auth/'), false);
  assert.equal(message.includes('Firebase'), false);
});

test('unknown auth failures use fixed operation-specific messages', () => {
  const secret = 'sk-secret-in-unknown-error';
  const message = friendlyAuthError(
    { code: 'auth/internal-error', message: secret },
    'reauthenticate',
  );

  assert.equal(
    message,
    'We could not verify your identity. Check your details and try again.',
  );
  assert.equal(message.includes(secret), false);
});

test('password reset request does not reveal account existence', () => {
  assert.equal(
    friendlyAuthError({ code: 'auth/user-not-found' }, 'resetRequest'),
    'If an account exists for that address, a reset link is on its way.',
  );
  assert.equal(
    friendlyAuthError(
      { code: 'auth/invalid-credential' },
      'resetRequest',
    ),
    'If an account exists for that address, a reset link is on its way.',
  );
});

test('Firebase action code is removed from the visible URL and history entry', () => {
  const replacements: Array<{
    state: unknown;
    title: string;
    url: string | URL | null | undefined;
  }> = [];
  const historyState = { navigationIndex: 4 };
  const history = {
    state: historyState,
    replaceState(
      state: unknown,
      title: string,
      url?: string | URL | null,
    ) {
      replacements.push({ state, title, url });
    },
  };

  captureFirebaseAuthAction({
    href:
      'https://app.cirqle.example/auth/action?mode=resetPassword&oobCode=secret-action-code&continueUrl=%2Flogin#reset',
    history,
  });

  assert.deepEqual(replacements, [
    {
      state: historyState,
      title: '',
      url: '/auth/action?mode=resetPassword&continueUrl=%2Flogin#reset',
    },
  ]);
  assert.equal(String(replacements[0].url).includes('secret-action-code'), false);
  assert.equal(String(replacements[0].url).includes('oobCode'), false);
});

test('Firebase action flow retains its captured code after URL scrubbing', () => {
  let scrubbedUrl = '';
  const captured = captureFirebaseAuthAction({
    href:
      'https://app.cirqle.example/auth/action?mode=verifyEmail&oobCode=verify-once&lang=en',
    history: {
      state: null,
      replaceState(_state, _title, url) {
        scrubbedUrl = String(url);
      },
    },
  });

  assert.deepEqual(captured, {
    mode: 'verifyEmail',
    code: 'verify-once',
  });
  assert.equal(scrubbedUrl, '/auth/action?mode=verifyEmail&lang=en');
  assert.equal(scrubbedUrl.includes(captured.code), false);
  assert.equal(captured.code, 'verify-once');
});

test('account deletion receipts survive the sign-out redirect without storing identity', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) || null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
  const receipt = rememberAccountDeletionReceipt(
    {
      id: 'deletion_receipt_123456',
      status: 'completed',
      accountLockStatus: 'deleted',
      uid: 'must-not-persist',
      email: 'must-not-persist@example.com',
    },
    storage,
    new Date('2026-07-29T12:00:00.000Z'),
  );

  assert.deepEqual(readAccountDeletionReceipt(storage), receipt);
  assert.doesNotMatch([...values.values()][0], /must-not-persist|@/);
  clearAccountDeletionReceipt(storage);
  assert.equal(readAccountDeletionReceipt(storage), null);
});

test('malformed deletion receipts are rejected and removed', () => {
  const values = new Map([['cirqle.account-deletion-receipt.v1', '{"id":"x"}']]);
  const storage = {
    getItem(key: string) {
      return values.get(key) || null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };

  assert.equal(readAccountDeletionReceipt(storage), null);
  assert.equal(values.size, 0);
});
