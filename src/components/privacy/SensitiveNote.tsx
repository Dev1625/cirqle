import React, { useId, useState } from 'react';
import { Eye, EyeOff, LockKeyhole } from 'lucide-react';

import {
  decryptSensitiveNote,
  encryptSensitiveNote,
  sensitiveNoteNeedsMigration,
  type SensitiveNoteEnvelope,
  type SensitiveNoteEnvelopeV1,
  type SensitiveNoteEnvelopeV2,
} from '../../lib/sensitiveNotes';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

export function SensitiveNoteOption({
  enabled,
  passphrase,
  onEnabledChange,
  onPassphraseChange,
  disabled = false,
}: {
  enabled: boolean;
  passphrase: string;
  onEnabledChange: (enabled: boolean) => void;
  onPassphraseChange: (passphrase: string) => void;
  disabled?: boolean;
}) {
  const [show, setShow] = useState(false);

  return (
    <div className="space-y-3 rounded-card border border-ink/15 bg-paper/50 p-3">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-xs">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
          className="h-4 w-4 accent-brand"
        />
        <span>
          <span className="block font-bold">Sensitive private note</span>
          <span className="mt-0.5 block text-subtle">
            End-to-end encrypted in your browser and never included in AI.
          </span>
        </span>
      </label>

      {enabled && (
        <div>
          <label
            htmlFor="sensitive-note-passphrase"
            className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-subtle"
          >
            Private vault passphrase
          </label>
          <div className="flex gap-2">
            <Input
              id="sensitive-note-passphrase"
              type={show ? 'text' : 'password'}
              autoComplete="off"
              minLength={12}
              maxLength={512}
              disabled={disabled}
              value={passphrase}
              onChange={(event) => onPassphraseChange(event.target.value)}
              aria-describedby="sensitive-note-passphrase-help"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={show ? 'Hide vault passphrase' : 'Show vault passphrase'}
              aria-pressed={show}
              onClick={() => setShow((value) => !value)}
            >
              {show ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
            </Button>
          </div>
          <p
            id="sensitive-note-passphrase-help"
            className="mt-2 text-[11px] leading-relaxed text-subtle"
          >
            Cirqle cannot recover this passphrase. It stays only in this open
            form and is never saved or sent to a model.
          </p>
        </div>
      )}
    </div>
  );
}

export function LockedSensitiveNote({
  envelope,
  uid,
  noteId,
  onMigrate,
}: {
  envelope: SensitiveNoteEnvelope;
  uid: string;
  noteId: string;
  onMigrate?: (
    expected: SensitiveNoteEnvelopeV1,
    replacement: SensitiveNoteEnvelopeV2,
  ) => Promise<void>;
}) {
  const inputId = useId();
  const [passphrase, setPassphrase] = useState('');
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [migrationNotice, setMigrationNotice] = useState('');
  const [busy, setBusy] = useState(false);

  if (plaintext !== null) {
    return (
      <div className="rounded-card border border-ink/15 bg-paper/50 p-3">
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{plaintext}</p>
        {migrationNotice && (
          <p role="status" className="mt-2 text-xs text-amber-800">
            {migrationNotice}
          </p>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-3"
          onClick={() => {
            setPlaintext(null);
            setPassphrase('');
          }}
        >
          <LockKeyhole size={13} aria-hidden="true" />
          Lock note
        </Button>
      </div>
    );
  }

  const unlock = async () => {
    setBusy(true);
    setError('');
    setMigrationNotice('');
    try {
      const password = passphrase;
      const unlocked = await decryptSensitiveNote(envelope, password, {
        uid,
        noteId,
      });
      setPlaintext(unlocked);
      if (
        sensitiveNoteNeedsMigration(envelope) &&
        envelope.schemaVersion === 1 &&
        onMigrate
      ) {
        try {
          const replacement = await encryptSensitiveNote(
            unlocked,
            password,
            { uid, noteId },
          );
          await onMigrate(envelope, replacement);
        } catch {
          setMigrationNotice(
            'This note is unlocked. Its encryption upgrade will retry the next time you unlock it.',
          );
        }
      }
      setPassphrase('');
    } catch {
      setError('That passphrase could not unlock this note.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-card border border-ink/15 bg-paper/50 p-3">
      <p className="flex items-center gap-2 text-xs font-bold">
        <LockKeyhole size={14} aria-hidden="true" />
        End-to-end encrypted note
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor={inputId} className="sr-only">
          Vault passphrase
        </label>
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          placeholder="Vault passphrase"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && passphrase.length >= 12) {
              event.preventDefault();
              void unlock();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || passphrase.length < 12}
          onClick={unlock}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      <p className="text-[11px] text-subtle">
        The plaintext is kept only in memory until you lock it or leave this
        page. Sensitive notes are excluded from every AI evidence packet.
      </p>
    </div>
  );
}
