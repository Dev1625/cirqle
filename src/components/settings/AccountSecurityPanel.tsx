import React, { useEffect, useRef, useState } from 'react';
import {
  Download,
  KeyRound,
  Laptop,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  sendPasswordResetEmail,
  signOut,
  type User,
} from 'firebase/auth';
import { useNavigate } from 'react-router';

import { auth } from '../../config/firebase';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import {
  friendlyAuthError,
  rememberAccountDeletionReceipt,
} from '../../lib/authSecurity';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { EmailVerificationNotice } from '../auth/EmailVerificationGate';
import { AIUsagePanel } from './AIUsagePanel';
import { SessionActivityPanel } from './SessionActivityPanel';
import { Dialog } from '../ui/Dialog';
import { clearAllDashboardBriefCaches } from '../../lib/dashboardBriefCache';

type SensitiveAction = 'export' | 'sessions' | 'delete' | null;

const PUBLIC_API_ERRORS: Record<string, string> = {
  unauthorized: 'Your session expired. Log in again to continue.',
  recent_login_required: 'Verify your identity again, then retry.',
  export_unavailable:
    'Your export could not be prepared right now. Please try again.',
  session_revocation_unavailable:
    'Your other sessions could not be signed out right now.',
  account_deletion_incomplete:
    'Account deletion did not finish. Your sign-in still works, so you can safely try again.',
};

class PublicAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicAccountError';
  }
}

function isFirebaseAuthError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.startsWith('auth/'),
  );
}

async function publicAPIError(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    const code = payload?.error?.code;
    if (typeof code === 'string' && PUBLIC_API_ERRORS[code]) {
      return PUBLIC_API_ERRORS[code];
    }
  } catch {
    // A fixed message below keeps HTML/platform errors out of the UI.
  }
  return 'That secure account action could not be completed. Please try again.';
}

export function AccountSecurityPanel({ user }: { user: User }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [action, setAction] = useState<SensitiveAction>(null);
  const [password, setPassword] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [emailVerified, setEmailVerified] = useState(user.emailVerified);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reauthInputRef = useRef<HTMLInputElement>(null);

  const providerIds = user.providerData.map((provider) => provider.providerId);
  const usesPassword = providerIds.includes('password');
  const usesGoogle = providerIds.includes('google.com');

  useEffect(() => {
    setEmailVerified(user.emailVerified);
  }, [user.emailVerified]);

  const closeAction = () => {
    if (busy) return;
    setAction(null);
    setPassword('');
    setError('');
  };

  const reauthenticate = async () => {
    if (usesPassword) {
      if (!user.email || !password) {
        throw Object.assign(new Error('Password required.'), {
          code: 'auth/invalid-credential',
        });
      }
      const credential = EmailAuthProvider.credential(user.email, password);
      await reauthenticateWithCredential(user, credential);
    } else if (usesGoogle) {
      await reauthenticateWithPopup(user, new GoogleAuthProvider());
    } else {
      throw Object.assign(new Error('Unsupported provider.'), {
        code: 'auth/operation-not-allowed',
      });
    }
    await user.getIdToken(true);
  };

  const downloadExport = async () => {
    const response = await authenticatedFetch('/api/account/export');
    if (!response.ok) {
      throw new PublicAccountError(await publicAPIError(response));
    }

    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `cirqle-account-export-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  const runAction = async () => {
    if (!action) return;
    if (action === 'delete' && deleteConfirmation !== 'DELETE') {
      setError('Type DELETE exactly before continuing.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      await reauthenticate();

      if (action === 'export') {
        await downloadExport();
        toast('Your private account export is downloading.', 'success');
        setAction(null);
        setPassword('');
        return;
      }

      if (action === 'sessions') {
        const response = await authenticatedFetch(
          '/api/account/revoke-sessions',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
        );
        if (!response.ok) {
          throw new PublicAccountError(await publicAPIError(response));
        }
        clearAllDashboardBriefCaches();
        await signOut(auth);
        navigate('/login?sessions=revoked', { replace: true });
        return;
      }

      const response = await authenticatedFetch('/api/account/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'DELETE' }),
      });
      if (!response.ok) {
        throw new PublicAccountError(await publicAPIError(response));
      }
      const deletion = await response.json();
      rememberAccountDeletionReceipt(deletion.receipt);
      clearAllDashboardBriefCaches();
      await signOut(auth);
      navigate('/login?deleted=1', { replace: true });
    } catch (actionError) {
      const message =
        actionError instanceof PublicAccountError
          ? actionError.message
          : isFirebaseAuthError(actionError)
            ? friendlyAuthError(actionError, 'reauthenticate')
            : 'The secure account service could not be reached. Check your connection and try again.';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const sendPasswordEmail = async () => {
    if (!user.email) return;
    setBusy(true);
    setError('');
    try {
      await sendPasswordResetEmail(auth, user.email);
      toast('Password-reset email sent.', 'success');
    } catch (resetError) {
      setError(friendlyAuthError(resetError, 'resetRequest'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-6 animate-fade-in">
      <section className="rounded-card border border-ink/15 bg-white p-8">
        <div className="flex items-start gap-3">
          <ShieldCheck size={22} className="mt-1 text-brand" aria-hidden="true" />
          <div>
            <h2 className="font-serif text-2xl font-bold italic">
              Account security.
            </h2>
            <p className="mt-1 font-mono text-xs leading-relaxed text-muted">
              Signed in as {user.email || 'a private account'}.
            </p>
          </div>
        </div>
        <div className="mt-6 border-t border-ink/15 pt-6">
          <EmailVerificationNotice
            user={user}
            compact
            onVerified={() => setEmailVerified(true)}
          />
        </div>
        {usesPassword && (
          <div className="mt-6 flex items-center justify-between gap-4 border-t border-ink/15 pt-6">
            <div>
              <h3 className="font-mono text-xs font-bold uppercase tracking-widest">
                Password
              </h3>
              <p className="mt-1 font-mono text-xs text-muted">
                Change it through a secure email link. A reset signs out older
                sessions automatically, enforces local password rules, and
                screens the new password against known breach records.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={sendPasswordEmail}
              disabled={busy}
            >
              <KeyRound size={13} className="mr-2" aria-hidden="true" />
              Reset password
            </Button>
          </div>
        )}
      </section>

      {emailVerified ? (
        <AIUsagePanel />
      ) : (
        <section className="rounded-card border border-ink/15 bg-white p-6">
          <h2 className="font-serif text-xl font-bold italic">AI usage.</h2>
          <p className="mt-2 font-mono text-xs leading-relaxed text-muted">
            Verify your email to provision paid AI and view personal spend,
            requests, tokens, and the $5 period cap.
          </p>
        </section>
      )}

      {emailVerified && <SessionActivityPanel uid={user.uid} />}

      {emailVerified && (
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-card border border-ink/15 bg-white p-6">
          <Download size={20} className="mb-4 text-brand" aria-hidden="true" />
          <h2 className="font-serif text-xl font-bold italic">
            Download your data.
          </h2>
          <p className="mt-2 min-h-14 font-mono text-xs leading-relaxed text-muted">
            Export your profile, contacts, relationship history, templates,
            tracker records, public cards, and safe integration metadata.
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => {
              setAction('export');
              setError('');
            }}
          >
            Prepare export
          </Button>
        </div>

        <div className="rounded-card border border-ink/15 bg-white p-6">
          <Laptop size={20} className="mb-4 text-brand" aria-hidden="true" />
          <h2 className="font-serif text-xl font-bold italic">
            Sign out everywhere.
          </h2>
          <p className="mt-2 min-h-14 font-mono text-xs leading-relaxed text-muted">
            Revoke every Cirqle refresh session, including this device. Useful
            if a device is lost or a session feels unfamiliar.
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => {
              setAction('sessions');
              setError('');
            }}
          >
            Sign out all devices
          </Button>
        </div>
      </section>
      )}

      <section className="rounded-card border border-red-200 bg-red-50/50 p-8">
        <Trash2 size={20} className="mb-4 text-red-700" aria-hidden="true" />
        <h2 className="font-serif text-2xl font-bold italic text-red-800">
          Delete your account.
        </h2>
        <p className="mt-2 max-w-2xl font-mono text-xs leading-relaxed text-red-900">
          Permanently removes your AI credential and LiteLLM user, revokes
          connected Google access, deletes public cards and captures, removes
          all private data and subcollections, then deletes your login. This
          cannot be undone.
        </p>
        <label
          htmlFor="delete-confirmation"
          className="mt-5 block font-mono text-[10px] font-bold uppercase tracking-widest text-red-800"
        >
          Type DELETE to continue
        </label>
        <Input
          id="delete-confirmation"
          className="mt-2 max-w-xs border-red-300"
          value={deleteConfirmation}
          onChange={(event) => setDeleteConfirmation(event.target.value)}
          autoComplete="off"
        />
        <Button
          className="mt-4"
          variant="danger"
          disabled={deleteConfirmation !== 'DELETE'}
          onClick={() => {
            setAction('delete');
            setError('');
          }}
        >
          Permanently delete account
        </Button>
      </section>

      <Dialog
        open={Boolean(action)}
        onClose={closeAction}
        closeOnBackdrop={!busy}
        title="Verify it is you"
        description="A fresh sign-in protects this sensitive account action."
        initialFocusRef={usesPassword ? reauthInputRef : undefined}
        className="max-w-lg bg-white"
      >
        {action && (
        <section className="p-6">
          <h2 className="font-serif text-2xl font-bold italic">
            Verify it is you.
          </h2>
          <p className="mt-2 font-mono text-xs leading-relaxed text-muted">
            {action === 'delete'
              ? 'Account deletion is permanent, so Cirqle requires a fresh sign-in first.'
              : action === 'sessions'
                ? 'Session revocation affects every device, so Cirqle requires a fresh sign-in first.'
                : 'Your export contains private relationship data, so Cirqle requires a fresh sign-in first.'}
          </p>

          {usesPassword && (
            <div className="mt-5 max-w-sm">
              <label
                htmlFor="reauth-password"
                className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-subtle"
              >
                Current password
              </label>
              <Input
                ref={reauthInputRef}
                id="reauth-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'reauth-error' : undefined}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') runAction();
                }}
              />
            </div>
          )}

          {error && (
            <p id="reauth-error" role="alert" className="mt-4 font-mono text-xs text-red-700">
              {error}
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              variant={action === 'delete' ? 'danger' : 'brand'}
              onClick={runAction}
              disabled={busy || (usesPassword && !password)}
              aria-busy={busy}
            >
              {busy
                ? 'Verifying…'
                : usesGoogle && !usesPassword
                  ? 'Continue with Google'
                  : action === 'delete'
                    ? 'Verify and delete'
                    : 'Verify and continue'}
            </Button>
            <Button variant="outline" onClick={closeAction} disabled={busy}>
              Cancel
            </Button>
          </div>
        </section>
        )}
      </Dialog>
    </div>
  );
}
