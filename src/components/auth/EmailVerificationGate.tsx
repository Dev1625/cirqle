import React, { useEffect, useState } from 'react';
import { LockKeyhole, MailCheck, RefreshCw } from 'lucide-react';
import { sendEmailVerification, type User } from 'firebase/auth';

import { Button } from '../ui/Button';
import { friendlyAuthError } from '../../lib/authSecurity';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { ensureVerifiedUserProfile } from '../../lib/userBootstrap';

export function EmailVerificationNotice({
  user,
  compact = false,
  onVerified,
}: {
  user: User;
  compact?: boolean;
  onVerified?: () => void;
}) {
  const [verified, setVerified] = useState(user.emailVerified);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(
      () => setCooldown((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [cooldown]);

  useEffect(() => {
    setVerified(user.emailVerified);
  }, [user.emailVerified]);

  if (verified) {
    return (
      <div className="flex items-center gap-2 font-mono text-xs text-emerald-800" role="status">
        <MailCheck size={15} aria-hidden="true" />
        Email verified
      </div>
    );
  }

  const resend = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await sendEmailVerification(user, {
        url: `${window.location.origin}/app/settings?verified=1`,
      });
      setCooldown(60);
      setMessage('Verification email sent. Check your inbox and spam folder.');
    } catch (sendError) {
      setError(friendlyAuthError(sendError, 'verify'));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await user.reload();
      await user.getIdToken(true);
      if (user.emailVerified) {
        await ensureVerifiedUserProfile(user);
        setVerified(true);
        onVerified?.();
        try {
          const provisioning = await authenticatedFetch(
            '/api/register-user',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            },
          );
          setMessage(
            provisioning.ok
              ? 'Email verified. Paid AI is ready.'
              : 'Email verified. AI setup is still finishing; it will retry automatically.',
          );
        } catch {
          setMessage(
            'Email verified. AI setup is still finishing; it will retry automatically.',
          );
        }
      } else {
        setMessage('Not verified yet. Open the link in the email, then check again.');
      }
    } catch (refreshError) {
      setError(friendlyAuthError(refreshError, 'verify'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={`rounded-card border border-brand/25 bg-brand/5 ${
        compact ? 'p-4' : 'p-6'
      }`}
      aria-labelledby="verify-email-title"
    >
      <div className="flex items-start gap-3">
        <LockKeyhole
          size={compact ? 18 : 22}
          className="mt-0.5 shrink-0 text-brand"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h2
            id="verify-email-title"
            className={`font-serif font-bold italic ${
              compact ? 'text-xl' : 'text-2xl'
            }`}
          >
            Verify your email.
          </h2>
          <p className="mt-1 font-mono text-xs leading-relaxed text-subtle">
            Confirm {user.email || 'your address'} to unlock paid AI,
            public-card publishing, and external account connections.
          </p>
          {(message || error) && (
            <p
              role={error ? 'alert' : 'status'}
              className={`mt-3 font-mono text-xs ${
                error ? 'text-red-700' : 'text-ink'
              }`}
            >
              {error || message}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="brand"
              onClick={resend}
              disabled={busy || cooldown > 0}
              aria-busy={busy}
            >
              {cooldown > 0
                ? `Resend in ${cooldown}s`
                : 'Send verification email'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={refresh}
              disabled={busy}
              aria-busy={busy}
            >
              <RefreshCw size={12} className="mr-1.5" aria-hidden="true" />
              I verified it
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function EmailVerificationGate({
  user,
  children,
}: {
  user: User;
  children: React.ReactNode;
}) {
  const [verified, setVerified] = useState(user.emailVerified);

  useEffect(() => {
    setVerified(user.emailVerified);
  }, [user.emailVerified]);

  if (!verified) {
    return (
      <EmailVerificationNotice
        user={user}
        onVerified={() => setVerified(true)}
      />
    );
  }

  return <>{children}</>;
}
