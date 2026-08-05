import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, Handshake } from 'lucide-react';
import { AILabel } from '../ui/AISurface';
import { AIProvenance } from '../ui/AIProvenance';
import { EmptyState } from '../ui/EmptyState';
import { useToast } from '../../contexts/ToastContext';
import { listCommitments, type Commitment } from '../../lib/commitments';
import { PersistedCommitmentFeedbackControls } from '../commitments/CommitmentFeedbackControls';

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
                className="animate-fade-slide-up rounded-card border border-ink/15 p-4 transition-colors hover:bg-paper"
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
                  {commitment.aiGrounding && (
                    <AIProvenance
                      className="mt-3"
                      sourceIds={commitment.aiGrounding.usedSourceIds}
                      sourceLabels={commitment.aiGrounding.sourceLabels}
                      unsupportedAssumptions={commitment.aiGrounding.unsupportedAssumptions}
                      privacyExclusions={commitment.aiGrounding.privacyExclusions}
                      generatedAt={commitment.aiGrounding.generatedAt}
                      sourceObservedAt={commitment.aiGrounding.sourceObservedAt}
                      consideredSourceCount={commitment.aiGrounding.consideredSourceCount}
                      dataFreshThrough={commitment.aiGrounding.dataFreshThrough}
                      generation={commitment.aiGrounding.generation}
                    />
                  )}
                </div>

                <details className="group mt-4 border-t border-ink/10 pt-3">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-mono text-[10px] font-bold uppercase tracking-widest text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
                    Review commitment and outcome
                    <ChevronDown
                      size={14}
                      aria-hidden="true"
                      className="transition-transform group-open:rotate-180 motion-reduce:transition-none"
                    />
                  </summary>
                  <PersistedCommitmentFeedbackControls
                    className="mt-3"
                    uid={uid}
                    commitmentId={commitment.id}
                    state={commitment.feedback}
                    onStateChange={(feedback) => {
                      setItems((current) =>
                        (current || []).map((item) =>
                          item.id === commitment.id
                            ? { ...item, feedback }
                            : item,
                        ),
                      );
                      toast('Commitment feedback saved.', 'success');
                    }}
                  />
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
