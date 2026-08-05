import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = await Promise.all(
  [
    'src/pages/AuthPage.tsx',
    'src/pages/AuthActionPage.tsx',
    'src/hooks/usePasswordBreachCheck.ts',
    'src/components/settings/AccountSecurityPanel.tsx',
  ].map(async (path) => [path, await readFile(path, 'utf8')]),
);
const source = Object.fromEntries(files);

test('signup screens before Firebase creates an account', () => {
  const page = source['src/pages/AuthPage.tsx'];
  const screening = page.indexOf('await passwordBreach.checkNow()');
  const creation = page.indexOf('createUserWithEmailAndPassword(');
  assert.ok(screening > 0);
  assert.ok(creation > screening);
  assert.match(page, /breachResult\.status === 'breached'/);
});

test('reset and settings password-change entry both use the screened action flow', () => {
  const action = source['src/pages/AuthActionPage.tsx'];
  const screening = action.indexOf('await passwordBreach.checkNow()');
  const confirmation = action.indexOf('confirmPasswordReset(auth');
  assert.ok(screening > 0);
  assert.ok(confirmation > screening);
  assert.match(action, /breachResult\.status === 'breached'/);

  const settings =
    source['src/components/settings/AccountSecurityPanel.tsx'];
  assert.match(settings, /sendPasswordResetEmail\(auth, user\.email\)/);
  assert.match(settings, /screens the new password against known breach records/);
});

test('network screening is user-complete blur/submit, never an incremental effect', () => {
  const signup = source['src/pages/AuthPage.tsx'];
  const reset = source['src/pages/AuthActionPage.tsx'];
  const hook = source['src/hooks/usePasswordBreachCheck.ts'];

  assert.match(signup, /onBlur=\{\(\) => \{/);
  assert.match(reset, /onBlur=\{\(\) => void passwordBreach\.checkNow\(\)\}/);
  assert.doesNotMatch(
    signup,
    /onChange=\{[^}]*checkNow/s,
  );
  assert.doesNotMatch(
    reset,
    /onChange=\{[^}]*checkNow/s,
  );

  const effectStart = hook.indexOf('useEffect(() =>');
  const callbackStart = hook.indexOf('const checkNow = useCallback');
  const networkCall = hook.indexOf('await checkPasswordBreach(');
  assert.ok(effectStart > 0);
  assert.ok(callbackStart > effectStart);
  assert.ok(networkCall > callbackStart);
});
