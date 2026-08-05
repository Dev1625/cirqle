import React, { useEffect, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  RefreshCcw,
  ShieldAlert,
  Trash2,
} from 'lucide-react';

import { auth } from '../../config/firebase';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { useToast } from '../../contexts/ToastContext';
import {
  listManagedContacts,
  requestContactMergeRecovery,
  requestPermanentContactPurge,
  restoreContact,
} from '../../lib/contactManagement';
import {
  isContactPurgeEligible,
  type ManagedContact,
} from '../../lib/contactManagementCore';
import { Button } from '../ui/Button';
import { ReauthenticationDialog } from '../auth/ReauthenticationDialog';

export interface ContactRecoveryCenterProps {
  uid: string;
  onRestored?: (contact: ManagedContact) => void;
  className?: string;
}

export function ContactRecoveryCenter({
  uid,
  onRestored,
  className = '',
}: ContactRecoveryCenterProps) {
  const { toast } = useToast();
  const [contacts, setContacts] = useState<ManagedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [queuedMergeRecoveries, setQueuedMergeRecoveries] = useState<
    Set<string>
  >(new Set());
  const [pending, setPending] = useState<{
    kind: 'purge' | 'merge-recovery';
    contact: ManagedContact;
  } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    listManagedContacts(uid, {
      includeArchived: true,
      includeDeleted: true,
    })
      .then((records) => {
        if (active) {
          setContacts(
            records.filter(
              (contact) =>
                contact.lifecycleStatus === 'archived' ||
                contact.lifecycleStatus === 'deleted',
            ),
          );
        }
      })
      .catch(() => {
        if (active) setError('Recovery contacts could not be loaded.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [uid, revision]);

  const restore = async (contact: ManagedContact) => {
    setBusyId(contact.id);
    setError(null);
    try {
      const restored = await restoreContact(uid, contact.id);
      setContacts((current) =>
        current.filter((item) => item.id !== contact.id),
      );
      onRestored?.(restored);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The contact could not be restored.',
      );
    } finally {
      setBusyId(null);
    }
  };

  const runQueuedMaintenance = async () => {
    if (!pending) return;
    const contact = pending.contact;
    setBusyId(contact.id);
    setError(null);
    try {
      if (pending.kind === 'purge') {
        await requestPermanentContactPurge(uid, contact.id);
      } else {
        if (!contact.contactMergeOperationId) {
          throw new Error('The merge recovery operation ID is missing.');
        }
        await requestContactMergeRecovery(
          uid,
          contact.contactMergeOperationId,
        );
      }

      const response = await authenticatedFetch('/api/contacts/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxRequests: 4, maxMutations: 300 }),
      });
      const report = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          report?.error?.code === 'recent_login_required'
            ? 'Verify your identity again, then retry this recovery action.'
            : 'Secure contact maintenance could not finish. The request is queued and safe to retry.',
        );
      }
      const alreadySettled =
        report.schemaVersion === 1 &&
        report.requestsExamined === 0 &&
        report.hasMore === false;
      if (report.completed < 1 && !alreadySettled) {
        const reason =
          report.needsReview > 0
            ? 'The request needs review because the stored contact state changed.'
            : report.expired > 0
              ? 'The recovery window expired before the request could run.'
              : 'The request is queued and needs another maintenance pass.';
        throw new Error(reason);
      }
      if (alreadySettled) {
        toast(
          'That maintenance request was already settled. Recovery is refreshed.',
          'info',
        );
      }
      if (pending.kind === 'merge-recovery' && contact.contactMergeOperationId) {
        setQueuedMergeRecoveries((current) => {
          const next = new Set(current);
          next.add(contact.contactMergeOperationId as string);
          return next;
        });
      }
      setPending(null);
      setRevision((value) => value + 1);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Secure contact maintenance could not be completed.',
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      className={`border border-ink/15 bg-white ${className}`}
      aria-labelledby="contact-recovery-title"
    >
      <header className="flex items-start justify-between gap-4 border-b border-ink/10 p-5">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-brand">
            Reversible by design
          </p>
          <h2 id="contact-recovery-title" className="mt-1 font-serif text-2xl">
            Contact recovery
          </h2>
          <p className="mt-2 text-sm text-subtle">
            Archived contacts can always be restored. Deleted contacts remain
            recoverable for 30 days before permanent removal can be requested.
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Refresh contact recovery"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCcw size={16} aria-hidden="true" />
        </Button>
      </header>

      {error && (
        <p className="m-5 border border-red-300 bg-red-50 p-3 text-sm text-red-950" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p className="p-5 text-sm text-subtle" role="status">
          Loading recovery contacts…
        </p>
      )}
      {!loading && contacts.length === 0 && (
        <p className="p-8 text-center text-sm text-subtle">
          No archived or deleted contacts.
        </p>
      )}

      {contacts.length > 0 && (
        <ul className="divide-y divide-ink/10">
          {contacts.map((contact) => {
            const deleted = contact.lifecycleStatus === 'deleted';
            const merged = Boolean(contact.mergedIntoContactId);
            const purgeEligible = isContactPurgeEligible(contact, new Date());
            const queued = Boolean(
              (contact as ManagedContact & { purgeRequestQueued?: boolean })
                .purgeRequestQueued,
            );
            return (
              <li key={contact.id} className="p-5">
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                  <div className="flex min-w-0 gap-3">
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                        deleted ? 'bg-red-100 text-red-900' : 'bg-paper'
                      }`}
                    >
                      {deleted ? (
                        <Trash2 size={16} aria-hidden="true" />
                      ) : (
                        <Archive size={16} aria-hidden="true" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium">{contact.name}</p>
                      <p className="mt-1 text-sm text-subtle">
                        {[contact.role, contact.company]
                          .filter(Boolean)
                          .join(' · ') || 'No role or company'}
                      </p>
                      <p className="mt-2 font-mono text-[9px] uppercase tracking-widest text-muted">
                        {merged
                          ? `Merged into ${contact.mergedIntoContactId}`
                          : deleted && contact.purgeEligibleAt
                            ? `Recovery until ${contact.purgeEligibleAt.toLocaleDateString()}`
                            : 'Archived · no expiration'}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {!merged && !purgeEligible && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busyId === contact.id}
                        onClick={() => restore(contact)}
                      >
                        <ArchiveRestore size={13} aria-hidden="true" />
                        Restore
                      </Button>
                    )}
                    {!merged && deleted && purgeEligible && !queued && (
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        disabled={busyId === contact.id}
                        onClick={() =>
                          setPending({ kind: 'purge', contact })
                        }
                      >
                        Request permanent removal
                      </Button>
                    )}
                    {queued && (
                      <span className="self-center font-mono text-[9px] font-bold uppercase tracking-widest text-red-800">
                        Removal queued
                      </span>
                    )}
                    {merged && (
                      purgeEligible && !queued ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="danger"
                          disabled={busyId === contact.id}
                          onClick={() =>
                            setPending({ kind: 'purge', contact })
                          }
                        >
                          Request permanent removal
                        </Button>
                      ) : queued ? (
                        <span className="self-center font-mono text-[9px] font-bold uppercase tracking-widest text-red-800">
                          Removal queued
                        </span>
                      ) : queuedMergeRecoveries.has(
                        contact.contactMergeOperationId || '',
                      ) ? (
                        <span className="self-center font-mono text-[9px] font-bold uppercase tracking-widest text-amber-900">
                          Merge recovery queued
                        </span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={
                            busyId === contact.id ||
                            !contact.contactMergeOperationId
                          }
                          onClick={() =>
                            setPending({
                              kind: 'merge-recovery',
                              contact,
                            })
                          }
                        >
                          <ShieldAlert size={13} aria-hidden="true" />
                          Request merge recovery
                        </Button>
                      )
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {pending && auth.currentUser && (
        <ReauthenticationDialog
          open
          user={auth.currentUser}
          title={
            pending.kind === 'purge'
              ? `Permanently remove ${pending.contact.name}?`
              : `Recover the merge for ${pending.contact.name}?`
          }
          description={
            pending.kind === 'purge'
              ? 'The 30-day recovery window has ended. The server will recheck eligibility, remove all nested history and exact references, record a count-only receipt, and then remove the profile.'
              : 'The server will verify the original merge snapshots, restore both profiles and temporal facts, and refuse the recovery if either record has changed unexpectedly.'
          }
          confirmationPhrase={
            pending.kind === 'purge'
              ? 'DELETE CONTACT'
              : 'RESTORE MERGE'
          }
          confirmLabel={
            pending.kind === 'purge'
              ? 'Verify and permanently remove'
              : 'Verify and recover merge'
          }
          dangerous={pending.kind === 'purge'}
          onClose={() => setPending(null)}
          onVerified={runQueuedMaintenance}
        />
      )}
    </section>
  );
}
