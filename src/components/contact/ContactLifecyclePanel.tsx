import React, { useEffect, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Eye,
  EyeOff,
  ShieldAlert,
  Trash2,
} from 'lucide-react';

import {
  archiveContact,
  requestContactMergeRecovery,
  requestPermanentContactPurge,
  restoreContact,
  setContactAIAllowed,
  softDeleteContact,
} from '../../lib/contactManagement';
import {
  isContactPurgeEligible,
  type ManagedContact,
} from '../../lib/contactManagementCore';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

export interface ContactLifecyclePanelProps {
  uid: string;
  contact: ManagedContact;
  onChanged?: (contact: ManagedContact) => void;
  onPurgeRequested?: (requestId: string) => void;
  className?: string;
}

export function ContactLifecyclePanel({
  uid,
  contact,
  onChanged,
  onPurgeRequested,
  className = '',
}: ContactLifecyclePanelProps) {
  const [current, setCurrent] = useState(contact);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [purgeQueued, setPurgeQueued] = useState(false);
  const [mergeRecoveryQueued, setMergeRecoveryQueued] = useState(false);

  useEffect(() => {
    setCurrent(contact);
    setConfirmingDelete(false);
    setConfirmation('');
    setPurgeQueued(false);
    setMergeRecoveryQueued(false);
    setError(null);
  }, [contact]);

  const status = current.lifecycleStatus || 'active';
  const purgeEligible = isContactPurgeEligible(current, new Date());

  const runLifecycle = async (
    action: 'archive' | 'restore' | 'delete',
  ) => {
    setBusy(action);
    setError(null);
    try {
      const next =
        action === 'archive'
          ? await archiveContact(uid, current.id)
          : action === 'restore'
            ? await restoreContact(uid, current.id)
            : await softDeleteContact(uid, current.id);
      setCurrent(next);
      setConfirmingDelete(false);
      setConfirmation('');
      onChanged?.(next);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The contact status could not be changed.',
      );
    } finally {
      setBusy(null);
    }
  };

  const toggleAI = async () => {
    const nextAllowed = current.aiAllowed === false;
    setBusy('privacy');
    setError(null);
    try {
      await setContactAIAllowed({
        uid,
        contactId: current.id,
        aiAllowed: nextAllowed,
      });
      const next = { ...current, aiAllowed: nextAllowed };
      setCurrent(next);
      onChanged?.(next);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The privacy setting could not be changed.',
      );
    } finally {
      setBusy(null);
    }
  };

  const requestPurge = async () => {
    setBusy('purge');
    setError(null);
    try {
      const request = await requestPermanentContactPurge(uid, current.id);
      setPurgeQueued(true);
      onPurgeRequested?.(request.requestId);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Permanent deletion could not be requested.',
      );
    } finally {
      setBusy(null);
    }
  };

  const requestMergeRecovery = async () => {
    if (!current.contactMergeOperationId) {
      setError('The merge recovery operation ID is missing.');
      return;
    }
    setBusy('merge-recovery');
    setError(null);
    try {
      await requestContactMergeRecovery(
        uid,
        current.contactMergeOperationId,
      );
      setMergeRecoveryQueued(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Merge recovery could not be requested.',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className={`border border-ink/15 bg-white p-5 ${className}`}
      aria-labelledby={`contact-controls-${current.id}`}
    >
      <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-subtle">
        Privacy and recovery
      </p>
      <h2
        id={`contact-controls-${current.id}`}
        className="mt-1 font-serif text-xl"
      >
        Contact controls
      </h2>

      {error && (
        <p
          className="mt-4 border border-red-300 bg-red-50 p-3 text-sm text-red-950"
          role="alert"
        >
          {error}
        </p>
      )}

      {status === 'active' && (
        <>
          <div className="mt-5 flex flex-col justify-between gap-4 border border-ink/10 bg-paper/40 p-4 sm:flex-row sm:items-center">
            <div className="flex gap-3">
              {current.aiAllowed === false ? (
                <EyeOff size={18} className="shrink-0" aria-hidden="true" />
              ) : (
                <Eye size={18} className="shrink-0" aria-hidden="true" />
              )}
              <div>
                <p className="font-medium">Use this contact in AI</p>
                <p className="mt-1 text-xs text-subtle">
                  When off, the full profile and every fact are excluded from
                  prompts, even if an individual fact is marked as allowed.
                </p>
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant={current.aiAllowed === false ? 'outline' : 'ghost'}
              aria-pressed={current.aiAllowed !== false}
              disabled={busy !== null}
              onClick={toggleAI}
            >
              {current.aiAllowed === false ? 'Allow AI' : 'Exclude from AI'}
            </Button>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className="flex min-h-24 items-start gap-3 border border-ink/15 p-4 text-left transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              disabled={busy !== null}
              onClick={() => runLifecycle('archive')}
            >
              <Archive size={18} className="shrink-0" aria-hidden="true" />
              <span>
                <span className="block font-medium">Archive</span>
                <span className="mt-1 block text-xs text-subtle">
                  Hide from the active directory and AI. Restore at any time.
                </span>
              </span>
            </button>
            <button
              type="button"
              className="flex min-h-24 items-start gap-3 border border-red-200 p-4 text-left text-red-950 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
              disabled={busy !== null}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 size={18} className="shrink-0" aria-hidden="true" />
              <span>
                <span className="block font-medium">Move to recovery</span>
                <span className="mt-1 block text-xs text-red-800">
                  Soft-delete for 30 days before permanent removal is possible.
                </span>
              </span>
            </button>
          </div>
        </>
      )}

      {status === 'archived' && (
        <div className="mt-5 border border-amber-300 bg-amber-50 p-4">
          <div className="flex gap-3 text-amber-950">
            <Archive size={18} className="shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">This contact is archived</p>
              <p className="mt-1 text-sm">
                It is hidden from the active directory and excluded from AI.
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => runLifecycle('restore')}
            >
              <ArchiveRestore size={14} aria-hidden="true" />
              Restore
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy !== null}
              onClick={() => setConfirmingDelete(true)}
            >
              Move to recovery
            </Button>
          </div>
        </div>
      )}

      {status === 'deleted' && (
        <div className="mt-5 border border-red-300 bg-red-50 p-4 text-red-950">
          <div className="flex gap-3">
            <ShieldAlert size={18} className="shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">
                {current.mergedIntoContactId
                  ? 'This duplicate was merged'
                  : 'This contact is in recovery'}
              </p>
              <p className="mt-1 text-sm">
                {current.mergedIntoContactId
                  ? `Its history was moved to contact ${current.mergedIntoContactId}. Use the merge recovery operation before restoring this duplicate.`
                  : current.purgeEligibleAt
                    ? `Restore until ${current.purgeEligibleAt.toLocaleDateString()}. After that date, permanent removal can be requested.`
                    : 'Restore this contact before permanent removal.'}
              </p>
              {current.contactMergeOperationId && (
                <p className="mt-2 font-mono text-[9px] uppercase tracking-widest">
                  Recovery operation {current.contactMergeOperationId}
                </p>
              )}
            </div>
          </div>

          {current.mergedIntoContactId ? (
            <div className="mt-4">
              {purgeEligible && !purgeQueued ? (
                <Button
                  type="button"
                  variant="danger"
                  disabled={busy !== null}
                  onClick={requestPurge}
                >
                  Request permanent removal
                </Button>
              ) : purgeQueued ? (
                <p className="font-mono text-[10px] font-bold uppercase tracking-widest">
                  Permanent removal queued
                </p>
              ) : !mergeRecoveryQueued ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy !== null || !current.contactMergeOperationId}
                  onClick={requestMergeRecovery}
                >
                  Request merge recovery
                </Button>
              ) : (
                <p className="font-mono text-[10px] font-bold uppercase tracking-widest">
                  Merge recovery queued
                </p>
              )}
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-3">
              {!purgeEligible && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => runLifecycle('restore')}
                >
                  <ArchiveRestore size={14} aria-hidden="true" />
                  Restore contact
                </Button>
              )}
              {purgeEligible && !purgeQueued && (
                <Button
                  type="button"
                  variant="danger"
                  disabled={busy !== null}
                  onClick={requestPurge}
                >
                  Request permanent removal
                </Button>
              )}
              {purgeQueued && (
                <p className="font-mono text-[10px] font-bold uppercase tracking-widest">
                  Permanent removal queued
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {confirmingDelete && status !== 'deleted' && (
        <div className="mt-5 border border-red-300 bg-red-50 p-4" role="alert">
          <p className="font-medium text-red-950">Confirm recovery move</p>
          <p className="mt-1 text-sm text-red-900">
            Type <strong>{current.name}</strong> to continue. Notes, outreach,
            commitments, threads, and fact history are retained during the
            30-day recovery window.
          </p>
          <label
            htmlFor={`delete-contact-${current.id}`}
            className="mt-3 block font-mono text-[10px] font-bold uppercase tracking-widest text-red-900"
          >
            Contact name
          </label>
          <Input
            id={`delete-contact-${current.id}`}
            className="mt-1 border-red-300 bg-white"
            value={confirmation}
            autoComplete="off"
            onChange={(event) => setConfirmation(event.target.value)}
          />
          <div className="mt-4 flex flex-wrap justify-end gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setConfirmingDelete(false);
                setConfirmation('');
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={confirmation.trim() !== current.name.trim() || busy !== null}
              onClick={() => runLifecycle('delete')}
            >
              Move to recovery
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
