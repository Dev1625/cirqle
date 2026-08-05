import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
} from 'firebase/auth';

import { auth } from '../config/firebase';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { PasswordStrength } from '../components/auth/PasswordStrength';
import {
  assessPassword,
  clearAccountDeletionReceipt,
  friendlyAuthError,
  readAccountDeletionReceipt,
} from '../lib/authSecurity';
import { usePasswordBreachCheck } from '../hooks/usePasswordBreachCheck';

export default function AuthPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const isLogin = location.pathname === '/login';
  const isForgotPassword =
    isLogin && searchParams.get('mode') === 'forgot';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(() => {
    if (searchParams.get('reset') === 'success') {
      return 'Password updated. Log in with your new password.';
    }
    if (searchParams.get('verified') === '1') {
      return 'Email verified. Log in to continue.';
    }
    if (searchParams.get('sessions') === 'revoked') {
      return 'Every session has been signed out. Log in again on this device.';
    }
    if (searchParams.get('deleted') === '1') {
      return 'Your Cirqle account and its data were deleted.';
    }
    return '';
  });
  const [loading, setLoading] = useState(false);
  const [deletionReceipt] = useState(() =>
    searchParams.get('deleted') === '1'
      ? readAccountDeletionReceipt()
      : null,
  );
  const [receiptCopied, setReceiptCopied] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const passwordAssessment = useMemo(
    () => assessPassword(password),
    [password],
  );
  const passwordBreach = usePasswordBreachCheck(password, {
    enabled: !isLogin && !isForgotPassword,
  });

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    document.title = `${
      isForgotPassword
        ? 'Reset password'
        : isLogin
          ? 'Log in'
          : 'Create account'
    } — Cirqle`;
  }, [isForgotPassword, isLogin]);

  const handleGoogleSignIn = async () => {
    setError('');
    setNotice('');
    setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      if (result.user) {
        clearAccountDeletionReceipt();
        navigate('/app', { replace: true });
      }
    } catch (signInError: unknown) {
      setError(friendlyAuthError(signInError, 'google'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);

    try {
      if (isForgotPassword) {
        await sendPasswordResetEmail(auth, email);
        setNotice(
          'If an account exists for that address, a password-reset link is on its way.',
        );
        return;
      }

      if (isLogin) {
        const { user } = await signInWithEmailAndPassword(
          auth,
          email,
          password,
        );
        clearAccountDeletionReceipt();
        navigate(
          user.emailVerified
            ? '/app'
            : '/app/settings?verification=needed',
          { replace: true },
        );
        return;
      }

      if (!passwordAssessment.isStrong) {
        setError('Complete every password requirement before continuing.');
        return;
      }
      const breachResult = await passwordBreach.checkNow();
      if (breachResult.status === 'breached') {
        setError(
          'This password appears in known breach records. Choose a unique password you do not use anywhere else.',
        );
        return;
      }

      const { user } = await createUserWithEmailAndPassword(
        auth,
        email,
        password,
      );
      clearAccountDeletionReceipt();

      try {
        await sendEmailVerification(user, {
          url: `${window.location.origin}/app/settings?verified=1`,
        });
      } catch {
        // Settings provides a resend path. Never turn a successfully-created
        // account into an apparent failure because delivery hiccupped.
        console.warn('[auth] verification email deferred');
      }
      navigate('/app/settings?verification=sent', { replace: true });
    } catch (authError: unknown) {
      const operation = isForgotPassword
        ? 'resetRequest'
        : isLogin
          ? 'signIn'
          : 'signUp';
      const message = friendlyAuthError(authError, operation);
      if (
        isForgotPassword &&
        message.startsWith('If an account exists')
      ) {
        setNotice(message);
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center bg-paper p-6">
      <section
        className="w-full max-w-sm rounded-card border border-ink/20 bg-white p-6 sm:p-8"
        aria-labelledby="auth-heading"
      >
        <h1 id="auth-heading" className="mb-2 font-serif text-3xl font-black italic">
          {isForgotPassword
            ? 'Reset your password.'
            : isLogin
              ? 'Welcome back.'
              : 'Create your account.'}
        </h1>
        <p className="mb-6 font-mono text-xs leading-relaxed text-muted">
          {isForgotPassword
            ? 'We will send a secure reset link if the address has a Cirqle account.'
            : isLogin
              ? 'Your relationship memory is waiting.'
              : 'Start building a private, useful record of your network.'}
        </p>

        {error && (
          <div
            ref={errorRef}
            id="auth-form-error"
            role="alert"
            aria-atomic="true"
            tabIndex={-1}
            className="mb-4 border border-red-200 bg-red-50 p-3 font-mono text-xs text-red-700"
          >
            {error}
          </div>
        )}

        {notice && (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="mb-4 border border-ink/15 bg-paper p-3 font-mono text-xs leading-relaxed text-ink"
          >
            {notice}
          </div>
        )}
        {deletionReceipt && (
          <section
            className="mb-4 border border-ink/15 bg-white p-3 font-mono text-[11px] leading-relaxed text-ink"
            aria-label="Account deletion receipt"
          >
            <p className="font-bold uppercase tracking-widest">
              Deletion receipt
            </p>
            <p className="mt-1 break-all text-muted">
              {deletionReceipt.id}
            </p>
            <p className="mt-1 text-muted">
              Status: {deletionReceipt.status}. Account lock:{' '}
              {deletionReceipt.accountLockStatus}.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(deletionReceipt.id);
                  setReceiptCopied(true);
                } catch {
                  setNotice(
                    'Copy was blocked by the browser. Select the receipt ID above to save it.',
                  );
                }
              }}
            >
              {receiptCopied ? 'Receipt copied' : 'Copy receipt ID'}
            </Button>
          </section>
        )}

        {!isForgotPassword && (
          <>
            <Button
              type="button"
              variant="default"
              className="mb-6 w-full font-mono text-xs uppercase"
              onClick={handleGoogleSignIn}
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? 'Processing…' : 'Continue with Google'}
            </Button>

            <div className="mb-6 flex items-center gap-2">
              <div className="h-px flex-1 bg-ink/20" />
              <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">
                or email
              </span>
              <div className="h-px flex-1 bg-ink/20" />
            </div>
          </>
        )}

        <form
          onSubmit={handleSubmit}
          className="space-y-4 font-mono"
          aria-busy={loading}
        >
          <div>
            <label
              htmlFor="auth-email"
              className="mb-1 block text-[10px] uppercase tracking-widest text-subtle"
            >
              Email
            </label>
            <Input
              id="auth-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={loading}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'auth-form-error' : undefined}
              required
            />
          </div>
          {!isForgotPassword && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label
                  htmlFor="auth-password"
                  className="block text-[10px] uppercase tracking-widest text-subtle"
                >
                  Password
                </label>
                {isLogin && (
                  <Link
                    to="/login?mode=forgot"
                    className="inline-flex min-h-11 items-center text-[10px] font-bold uppercase tracking-widest text-brand hover:underline"
                  >
                    Forgot password?
                  </Link>
                )}
              </div>
              <Input
                id="auth-password"
                type="password"
                autoComplete={
                  isLogin ? 'current-password' : 'new-password'
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onBlur={() => {
                  if (!isLogin) void passwordBreach.checkNow();
                }}
                disabled={loading}
                aria-invalid={Boolean(error)}
                aria-describedby={
                  [
                    !isLogin ? 'signup-password-guidance' : null,
                    error ? 'auth-form-error' : null,
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                required
              />
              {!isLogin && (
                <PasswordStrength
                  password={password}
                  id="signup-password-guidance"
                  breachState={passwordBreach.state}
                />
              )}
            </div>
          )}
          <Button
            type="submit"
            variant="outline"
            className="w-full"
            disabled={loading}
            aria-busy={loading}
          >
            {loading
              ? 'Processing…'
              : isForgotPassword
                ? 'Send reset link'
                : isLogin
                  ? 'Log in'
                  : 'Create account'}
          </Button>
        </form>

        <p className="mt-6 text-center font-mono text-xs text-muted">
          {isForgotPassword ? (
            <Link to="/login" className="inline-flex min-h-11 items-center font-bold text-ink hover:underline">
              Back to login
            </Link>
          ) : isLogin ? (
            <>
              New to Cirqle?{' '}
              <Link
                to="/signup"
                className="inline-flex min-h-11 items-center font-bold text-ink hover:underline"
              >
                Create an account
              </Link>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <Link
                to="/login"
                className="inline-flex min-h-11 items-center font-bold text-ink hover:underline"
              >
                Log in
              </Link>
            </>
          )}
        </p>
      </section>
    </div>
  );
}
