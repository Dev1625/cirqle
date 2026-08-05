import React, { useEffect, useRef, useState } from 'react';
import {
  applyActionCode,
  confirmPasswordReset,
  verifyPasswordResetCode,
} from 'firebase/auth';
import { Link, useNavigate } from 'react-router';
import { CheckCircle2 } from 'lucide-react';

import { auth } from '../config/firebase';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Logo } from '../components/Logo';
import { PasswordStrength } from '../components/auth/PasswordStrength';
import {
  assessPassword,
  friendlyAuthError,
} from '../lib/authSecurity';
import { captureFirebaseAuthAction } from '../lib/authActionUrl';
import { usePasswordBreachCheck } from '../hooks/usePasswordBreachCheck';

type ActionState = 'checking' | 'ready' | 'saving' | 'success' | 'error';

// App imports this page eagerly, so this capture runs during module evaluation:
// before main.tsx starts web-vitals telemetry and before React/StrictMode can
// render the page twice. Only the in-memory copy retains the one-time code.
const initialActionRequest =
  typeof window === 'undefined'
    ? { mode: null, code: '' }
    : captureFirebaseAuthAction({
        href: window.location.href,
        history: window.history,
      });

export default function AuthActionPage() {
  const navigate = useNavigate();
  const { mode, code } = initialActionRequest;
  const [state, setState] = useState<ActionState>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  const passwordBreach = usePasswordBreachCheck(password, {
    enabled: mode === 'resetPassword',
  });

  useEffect(() => {
    let active = true;

    const check = async () => {
      if (!code || !['resetPassword', 'verifyEmail'].includes(mode || '')) {
        if (active) {
          setError('That account link is incomplete. Request a fresh email.');
          setState('error');
        }
        return;
      }

      try {
        if (mode === 'resetPassword') {
          const address = await verifyPasswordResetCode(auth, code);
          if (active) {
            setEmail(address);
            setState('ready');
          }
          return;
        }

        await applyActionCode(auth, code);
        await auth.currentUser?.reload();
        if (active) setState('success');
      } catch (actionError) {
        if (active) {
          setError(friendlyAuthError(actionError, 'verify'));
          setState('error');
        }
      }
    };

    check();
    return () => {
      active = false;
    };
  }, [code, mode]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    document.title = `${
      mode === 'verifyEmail' ? 'Verify email' : 'Reset password'
    } — Cirqle`;
  }, [mode]);

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!assessPassword(password).isStrong) {
      setError('Complete every password requirement before continuing.');
      return;
    }

    setError('');
    setState('saving');
    try {
      const breachResult = await passwordBreach.checkNow();
      if (breachResult.status === 'breached') {
        setError(
          'This password appears in known breach records. Choose a unique password you do not use anywhere else.',
        );
        setState('ready');
        return;
      }
      await confirmPasswordReset(auth, code, password);
      navigate('/login?reset=success', { replace: true });
    } catch (resetError) {
      setError(friendlyAuthError(resetError, 'resetConfirm'));
      setState('ready');
    }
  };

  const verifying = mode === 'verifyEmail';

  return (
    <main className="min-h-screen bg-paper p-6">
      <Link
        to="/"
        className="mx-auto mb-10 flex min-h-11 w-fit items-center text-ink"
        aria-label="Cirqle home"
      >
        <Logo size="sm" kicker={null} />
      </Link>
      <section
        className="mx-auto w-full max-w-md rounded-card border border-ink/20 bg-white p-6 sm:p-8"
        aria-labelledby="auth-action-heading"
        aria-busy={state === 'checking' || state === 'saving'}
      >
        <h1 id="auth-action-heading" className="font-serif text-3xl font-black italic">
          {verifying ? 'Verify your email.' : 'Choose a new password.'}
        </h1>

        {state === 'checking' && (
          <p role="status" aria-live="polite" className="mt-5 font-mono text-xs text-muted">
            Checking this secure link…
          </p>
        )}

        {state === 'success' && (
          <div className="mt-6" role="status" aria-live="polite">
            <CheckCircle2 size={24} className="mb-3 text-brand" aria-hidden="true" />
            <p className="font-mono text-sm leading-relaxed">
              Your email is verified. Paid AI, public-card publishing, and
              external connections are now unlocked.
            </p>
            <Button
              className="mt-6 w-full"
              variant="brand"
              onClick={() =>
                navigate(auth.currentUser ? '/app/settings' : '/login')
              }
            >
              Continue to Cirqle
            </Button>
          </div>
        )}

        {state === 'error' && (
          <div className="mt-6">
            <div
              ref={errorRef}
              id="auth-action-error"
              role="alert"
              aria-atomic="true"
              tabIndex={-1}
              className="border border-red-200 bg-red-50 p-3 font-mono text-xs text-red-700"
            >
              {error}
            </div>
            <Link
              to={verifying ? '/login' : '/login?mode=forgot'}
              className="mt-5 inline-flex min-h-11 items-center font-mono text-xs font-bold uppercase tracking-widest text-brand hover:underline"
            >
              {verifying ? 'Return to login' : 'Request a new link'}
            </Link>
          </div>
        )}

        {(state === 'ready' || state === 'saving') &&
          mode === 'resetPassword' && (
            <form
              className="mt-6 space-y-5 font-mono"
              onSubmit={submitPassword}
              aria-busy={state === 'saving'}
            >
              <p className="text-xs leading-relaxed text-muted">
                Resetting the password for{' '}
                <strong className="text-ink">{email}</strong>. This also signs
                out older sessions.
              </p>
              {error && (
                <div
                  ref={errorRef}
                  id="auth-action-form-error"
                  role="alert"
                  aria-atomic="true"
                  tabIndex={-1}
                  className="border border-red-200 bg-red-50 p-3 text-xs text-red-700"
                >
                  {error}
                </div>
              )}
              <div>
                <label
                  htmlFor="new-password"
                  className="mb-1 block text-[10px] uppercase tracking-widest text-subtle"
                >
                  New password
                </label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onBlur={() => void passwordBreach.checkNow()}
                  aria-invalid={Boolean(error)}
                  aria-describedby={[
                    'reset-password-guidance',
                    error ? 'auth-action-form-error' : null,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={state === 'saving'}
                  required
                />
                <PasswordStrength
                  password={password}
                  id="reset-password-guidance"
                  breachState={passwordBreach.state}
                />
              </div>
              <Button
                type="submit"
                variant="brand"
                className="w-full"
                disabled={state === 'saving'}
                aria-busy={state === 'saving'}
              >
                {state === 'saving' ? 'Saving…' : 'Save new password'}
              </Button>
            </form>
          )}
      </section>
    </main>
  );
}
