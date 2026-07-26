import React, { useEffect, useRef, useState } from 'react';
import { addDoc, collection, serverTimestamp, updateDoc, doc } from 'firebase/firestore';
import { Mic, Square, Keyboard, X } from 'lucide-react';
import { db } from '../../config/firebase';
import { Button } from '../ui/Button';
import { AILabel } from '../ui/AISurface';
import { useToast } from '../../contexts/ToastContext';
import { isSpeechSupported, startDictation, type SpeechSession } from '../../lib/speech';
import { extractAndStore } from '../../lib/commitments';
import { generateText } from '../../lib/ai';

/**
 * Post-meeting voice memo.
 *
 * Reachable two ways on purpose: prompted when a calendar meeting just ended,
 * and manually from any contact regardless of whether Calendar is connected.
 * The manual path means this feature is never blocked on an integration the
 * owner has not set up.
 *
 * Three degradation steps, each explicit rather than silent:
 *   dictation → typing (browser unsupported or mic denied) → save raw text
 *   (AI gateway unreachable).
 */

type Phase = 'idle' | 'recording' | 'review' | 'saving';

export function VoiceMemo({
  uid,
  contactId,
  contactName,
  meetingTitle,
  onClose,
  onSaved,
}: {
  uid: string;
  contactId: string;
  contactName: string;
  meetingTitle?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { toast } = useToast();
  const supported = isSpeechSupported();

  const [phase, setPhase] = useState<Phase>('idle');
  const [finalText, setFinalText] = useState('');
  const [interimText, setInterimText] = useState('');
  const [typing, setTyping] = useState(!supported);
  const [notice, setNotice] = useState<string | null>(
    supported ? null : "This browser can't dictate — type the note instead."
  );

  const sessionRef = useRef<SpeechSession | null>(null);

  useEffect(() => {
    return () => sessionRef.current?.stop();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        sessionRef.current?.stop();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const begin = () => {
    setNotice(null);
    setPhase('recording');
    sessionRef.current = startDictation({
      onTranscript: (final, interim) => {
        setFinalText(final);
        setInterimText(interim);
      },
      onError: (message) => {
        setNotice(message);
        setTyping(true);
        setPhase('review');
      },
      onEnd: () => {
        setInterimText('');
        setPhase('review');
      },
    });

    if (!sessionRef.current) {
      setTyping(true);
      setPhase('review');
    }
  };

  const stop = () => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setPhase('review');
  };

  const transcript = (finalText + ' ' + interimText).trim();

  const save = async () => {
    const text = transcript;
    if (!text) {
      toast('Nothing to save yet.', 'error');
      return;
    }
    setPhase('saving');

    try {
      // The note is written first and unconditionally. Everything after this
      // is enrichment, and a failure in it must not lose the user's words.
      const noteRef = await addDoc(collection(db, `users/${uid}/notes`), {
        userId: uid,
        contactId,
        content: text,
        source: 'voice-memo',
        meetingTitle: meetingTitle || null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await updateDoc(doc(db, `users/${uid}/contacts/${contactId}`), {
        lastContactedAt: new Date(),
        updatedAt: serverTimestamp(),
      });

      toast('Memo filed.', 'success');
      onSaved?.();
      onClose();

      // Enrichment runs after the modal closes — the user does not wait on it.
      try {
        const summary = await generateText(
          `Summarise this post-meeting voice memo about ${contactName} in one dry sentence, max 140 characters. No preamble.\n\n"${text.slice(0, 3000)}"`
        );
        await updateDoc(doc(db, `users/${uid}/notes/${noteRef.id}`), { aiSummary: summary });
      } catch {
        /* the raw note is already saved and readable */
      }

      try {
        const created = await extractAndStore({
          uid,
          contactId,
          contactName,
          text,
          sourceType: 'voice',
          sourceId: noteRef.id,
        });
        if (created.length > 0) {
          toast(
            created.length === 1
              ? `Tracked a commitment: ${created[0].text}`
              : `Tracked ${created.length} commitments from that memo.`,
            'info'
          );
        }
      } catch {
        /* commitment extraction is a bonus, not the point of saving */
      }
    } catch {
      toast('Could not save the memo.', 'error');
      setPhase('review');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          sessionRef.current?.stop();
          onClose();
        }
      }}
    >
      <div className="animate-fade-scale-in w-full max-w-lg rounded-card border border-ink/15 bg-white shadow-float">
        <header className="flex items-start justify-between gap-4 border-b border-ink/15 p-6">
          <div>
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
              Voice memo
            </span>
            <h2 className="mt-1.5 font-serif text-2xl font-bold italic">
              {meetingTitle || `Notes on ${contactName}`}
            </h2>
          </div>
          <button
            onClick={() => {
              sessionRef.current?.stop();
              onClose();
            }}
            className="shrink-0 text-muted transition-colors hover:text-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="space-y-4 p-6">
          {notice && (
            <p className="rounded-card border border-ink/15 bg-paper/60 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-subtle">
              {notice}
            </p>
          )}

          {phase === 'idle' && !typing && (
            <div className="flex flex-col items-center gap-4 py-6">
              <p className="text-center font-mono text-xs leading-relaxed text-muted">
                Say what happened. It files itself against {contactName}.
              </p>
              <Button variant="brand" size="lg" onClick={begin}>
                <Mic size={13} className="mr-2" />
                Start talking
              </Button>
              <button
                onClick={() => {
                  setTyping(true);
                  setPhase('review');
                }}
                className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
              >
                <Keyboard size={11} />
                Type it instead
              </button>
            </div>
          )}

          {phase === 'recording' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted">
                  {/* The one continuous animation here is a recording
                      indicator — functional, and it stills under
                      prefers-reduced-motion via the global override. */}
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" />
                  Listening
                </span>
                <Button variant="outline" size="sm" onClick={stop}>
                  <Square size={11} className="mr-1.5" />
                  Stop
                </Button>
              </div>
              <div className="max-h-56 min-h-24 overflow-y-auto rounded-card border border-ink/15 bg-paper/50 p-3">
                <p className="font-mono text-xs leading-relaxed">
                  {finalText}
                  <span className="text-muted">{interimText}</span>
                  {!transcript && <span className="text-muted">Waiting for you…</span>}
                </p>
              </div>
            </div>
          )}

          {(phase === 'review' || phase === 'saving' || (phase === 'idle' && typing)) && (
            <div className="space-y-3">
              <label className="block font-mono text-[10px] uppercase tracking-widest text-muted">
                Transcript — edit freely
              </label>
              <textarea
                className="h-40 w-full rounded-card border border-ink/15 bg-paper/50 p-3 font-mono text-xs leading-relaxed transition-colors focus-visible:border-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                value={finalText}
                onChange={(e) => setFinalText(e.target.value)}
                placeholder={`What came out of the conversation with ${contactName}?`}
                autoFocus
              />
              <AILabel>Filed against {contactName}, with commitments pulled out</AILabel>
            </div>
          )}
        </div>

        {phase !== 'recording' && phase !== 'idle' && (
          <div className="flex justify-end gap-2 border-t border-ink/15 p-6">
            {supported && !typing && (
              <Button variant="ghost" onClick={begin} disabled={phase === 'saving'}>
                <Mic size={12} className="mr-1.5" />
                Record more
              </Button>
            )}
            <Button variant="brand" onClick={save} disabled={phase === 'saving' || !transcript}>
              {phase === 'saving' ? 'Filing…' : 'Save memo'}
            </Button>
          </div>
        )}

        {phase === 'idle' && typing && (
          <div className="flex justify-end gap-2 border-t border-ink/15 p-6">
            <Button variant="brand" onClick={save} disabled={!transcript}>
              Save memo
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
