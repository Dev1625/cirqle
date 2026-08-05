import React, { useEffect, useState } from 'react';
import { Pencil, X } from 'lucide-react';

import { loadManagedContact } from '../../lib/contactManagement';
import type { ManagedContact } from '../../lib/contactManagementCore';
import { Button } from '../ui/Button';
import { ContactDuplicateCandidates } from './ContactDuplicateCandidates';
import { ContactJobHistory } from './ContactJobHistory';
import { ContactLifecyclePanel } from './ContactLifecyclePanel';
import { ContactProfileEditor } from './ContactProfileEditor';
import { DuplicateMergeDialog } from './DuplicateMergeDialog';
import { FactLedgerPanel } from './FactLedgerPanel';

export interface ContactManagementWorkspaceProps {
  uid: string;
  contact: ManagedContact;
  onContactChanged?: (contact: ManagedContact) => void;
  onFactsChanged?: () => void;
  onLifecycleExit?: (contact: ManagedContact) => void;
  className?: string;
}

/**
 * One integration point for ContactDetail. The individual components remain
 * reusable, but mounting this workspace exposes the complete edit, history,
 * privacy, lifecycle, duplicate-review, and merge flow together.
 */
export function ContactManagementWorkspace({
  uid,
  contact,
  onContactChanged,
  onFactsChanged,
  onLifecycleExit,
  className = '',
}: ContactManagementWorkspaceProps) {
  const [current, setCurrent] = useState(contact);
  const [editing, setEditing] = useState(false);
  const [mergeCandidate, setMergeCandidate] =
    useState<ManagedContact | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setCurrent(contact);
  }, [contact]);

  const publishChange = (next: ManagedContact) => {
    setCurrent(next);
    setRefreshKey((value) => value + 1);
    onContactChanged?.(next);
  };

  return (
    <section
      className={`space-y-5 ${className}`}
      aria-label="Contact data management"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-brand">
            Contact data
          </p>
          <h2 className="mt-1 font-serif text-2xl">
            Profile, history, and privacy
          </h2>
        </div>
        <Button
          type="button"
          variant={editing ? 'ghost' : 'outline'}
          onClick={() => setEditing((value) => !value)}
        >
          {editing ? (
            <X size={14} aria-hidden="true" />
          ) : (
            <Pencil size={14} aria-hidden="true" />
          )}
          {editing ? 'Close editor' : 'Edit full profile'}
        </Button>
      </div>

      {editing && (
        <div className="border border-ink/15 bg-white p-5">
          <ContactProfileEditor
            uid={uid}
            contactId={current.id}
            initialContact={current}
            onCancel={() => setEditing(false)}
            onSaved={(saved) => {
              publishChange(saved.contact);
              setEditing(false);
            }}
          />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <ContactJobHistory
          uid={uid}
          contactId={current.id}
          refreshKey={refreshKey}
        />
        <ContactDuplicateCandidates
          uid={uid}
          contact={current}
          refreshKey={refreshKey}
          onReviewMerge={setMergeCandidate}
        />
      </div>

      <FactLedgerPanel
        uid={uid}
        contactId={current.id}
        contactState={current}
        refreshKey={refreshKey}
        onFactsChanged={onFactsChanged}
      />

      <ContactLifecyclePanel
        uid={uid}
        contact={current}
        onChanged={(next) => {
          publishChange(next);
          if (next.lifecycleStatus !== 'active') onLifecycleExit?.(next);
        }}
      />

      {mergeCandidate && (
        <DuplicateMergeDialog
          uid={uid}
          primary={current}
          duplicate={mergeCandidate}
          onCancel={() => setMergeCandidate(null)}
          onMerged={async () => {
            const refreshed = await loadManagedContact(uid, current.id);
            if (refreshed) publishChange(refreshed);
          }}
        />
      )}
    </section>
  );
}
