import React, { useRef, useState } from 'react';
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  type User,
} from 'firebase/auth';

import { friendlyAuthError } from '../../lib/authSecurity';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';

export function ReauthenticationDialog({
  open,
  user,
  title,
  description,
  confirmLabel,
  confirmationPhrase,
  dangerous = false,
  onClose,
  onVerified,
}: {
  open: boolean;
  user: User;
  title: string;
  description: string;
  confirmLabel: string;
  confirmationPhrase?: string;
  dangerous?: boolean;
  onClose: () => void;
  onVerified: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const passwordRef = useRef<HTMLInputElement>(null);
  const providers = user.providerData.map((provider) => provider.providerId);
  const usesPassword = providers.includes('password');
  const usesGoogle = providers.includes('google.com');

  const close = () => {
    if (busy) return;
    setPassword('');
    setConfirmation('');
    setError('');
    onClose();
  };

  const verify = async () => {
    if (
      confirmationPhrase &&
      confirmation.trim() !== confirmationPhrase
    ) {
      setError(`Type ${confirmationPhrase} exactly to continue.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (usesPassword) {
        if (!user.email || !password) {
          throw Object.assign(new Error('Password required.'), {
            code: 'auth/invalid-credential',
          });
        }
        await reauthenticateWithCredential(
          user,
          EmailAuthProvider.credential(user.email, password),
        );
      } else if (usesGoogle) {
        await reauthenticateWithPopup(user, new GoogleAuthProvider());
      } else {
        throw Object.assign(new Error('Unsupported sign-in method.'), {
          code: 'auth/operation-not-allowed',
        });
      }
      await user.getIdToken(true);
      await onVerified();
      setPassword('');
      setConfirmation('');
      setError('');
      onClose();
    } catch (caught: any) {
      const firebaseError =
        typeof caught?.code === 'string' &&
        caught.code.startsWith('auth/');
      setError(
        firebaseError
          ? friendlyAuthError(caught, 'reauthenticate')
          : caught instanceof Error
            ? caught.message
            : 'This secure action could not be completed. It is safe to retry.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      closeOnBackdrop={!busy}
      title={title}
      description={description}
      initialFocusRef={usesPassword ? passwordRef : undefined}
      className="max-w-lg bg-white"
    >
      <section className="p-6">
        <h2 className="font-serif text-2xl font-bold italic">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {description}
        </p>

        {usesPassword && (
          <div className="mt-5">
            <label
              htmlFor="shared-reauth-password"
              className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-subtle"
            >
              Current password
            </label>
            <Input
              ref={passwordRef}
              id="shared-reauth-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        )}

        {confirmationPhrase && (
          <div className="mt-4">
            <label
              htmlFor="shared-reauth-confirmation"
              className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-subtle"
            >
              Type {confirmationPhrase}
            </label>
            <Input
              id="shared-reauth-confirmation"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
        )}

        {error && (
          <p className="mt-4 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            type="button"
            variant={dangerous ? 'danger' : 'brand'}
            onClick={verify}
            disabled={
              busy ||
              (usesPassword && !password) ||
              Boolean(
                confirmationPhrase &&
                  confirmation.trim() !== confirmationPhrase,
              )
            }
            aria-busy={busy}
          >
            {busy
              ? 'Verifying…'
              : usesGoogle && !usesPassword
                ? 'Continue with Google'
                : confirmLabel}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      </section>
    </Dialog>
  );
}
