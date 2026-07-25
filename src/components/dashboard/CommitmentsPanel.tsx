import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Handshake, X } from 'lucide-react';
import { AILabel } from '../ui/AISurface';
import { EmptyState } from '../ui/EmptyState';
import { useToast } from '../../contexts/ToastContext';
import { listCommitments, setCommitmentStatus, type Commitment } from '../../lib/commitments';

/**
 * Open commitments, in the Follow-Up Queue's visual language rather than a
 * new list type — same bordered rows, same mono metadata line, same
 * action-on-the-right rhythm. A second list that looks different would imply
 * it works differently.
 */
export function CommitmentsPanel({ uid }: { uid: string }) {
  const { toast } = useToast();
  const [items, setItems] = useState<Commitment[] | null>(null);

  const load = useCallback(() => {
    listCommitments(uid, { status: 'open' })
      .then(setItems)
      .catch(() => setItems([]));
  }, [uid]);

  useEffect(load, [load]);

  const resolve = async (commitment: Commitment, status: 'done' | 'dismissed') => {
    // Optimistic: the row leaves immediately. A failed write is recoverable
    // (the commitment is still there on reload) and not worth a spinner.
    setItems((current) => (current || []).filter((c) => c.id !== commitment.id));
    try {
      await setCommitmentStatus(uid, commitment.id, status);
      if (status === 'done') toast('Marked done.', 'success');
    } catch {
      toast('Could not update that. It will still be here on reload.', 'error');
      load();
    }
  };

  if (items === null) return null;

  return (
    <section className="rounded-card border border-ink/25 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/15 bg-[#F8F5EF] px-6 py-4">
        <div>
          <h2 className="flex items-center gap-2 font-serif text-xl font-bold italic">
            <Handshake size={17} className="text-brand" />
            You said you'd.
          </h2>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted">
            Pulled from your notes and memos
          </p>
        </div>
        {items.length > 0 && <AILabel>{items.length} open</AILabel>}
      </header>

      <div className="p-6">
        {items.length === 0 ? (
          <EmptyState
            icon={Handshake}
            line="Nothing outstanding. Commitments show up here when a note mentions one — 'I'll send the deck', that sort of thing."
          />
        ) : (
          <ul className="space-y-3">
            {items.slice(0, 6).map((commitment, index) => (
              <li
                key={commitment.id}
                className="animate-fade-slide-up flex flex-col gap-3 rounded-card border border-ink/15 p-4 transition-colors hover:bg-paper lg:flex-row lg:items-center lg:justify-between"
                style={{ animationDelay: `${Math.min(index * 35, 175)}ms` }}
              >
                <div className="min-w-0">
                  <p className="font-mono text-sm leading-relaxed">{commitment.text}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted">
                    <Link
                      to={`/app/directory/${commitment.contactId}`}
                      className="transition-colors hover:text-brand hover:underline"
                    >
                      {commitment.contactName}
                    </Link>
                    <span>{commitment.owedBy === 'you' ? 'You owe' : 'They owe'}</span>
                    {commitment.dueHint && <span>{commitment.dueHint}</span>}
                  </div>
                </div>

                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => resolve(commitment, 'dismissed')}
                    title="Not a real commitment"
                    className="flex h-8 w-8 items-center justify-center rounded-card border border-ink/15 text-muted transition-colors hover:border-ink/25 hover:text-ink"
                  >
                    <X size={13} />
                    <span className="sr-only">Dismiss</span>
                  </button>
                  <button
                    onClick={() => resolve(commitment, 'done')}
                    title="Done"
                    className="flex h-8 w-8 items-center justify-center rounded-card bg-ink text-paper transition-colors hover:bg-zinc-800"
                  >
                    <Check size={13} />
                    <span className="sr-only">Mark done</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
