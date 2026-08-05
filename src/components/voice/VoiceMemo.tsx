import React, { useEffect, useRef, useState } from 'react';
import {
  collection,
  doc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { Keyboard, Mic, Square, X } from 'lucide-react';

import { db } from '../../config/firebase';
import { useToast } from '../../contexts/ToastContext';
import {
  isSpeechSupported,
  startDictation,
  type SpeechSession,
} from '../../lib/speech';
import { enqueueVoiceEnrichment } from '../../lib/voiceEnrichment';
import {
  normalizeVoiceMemoText,
  VOICE_MEMO_MAX_CHARS,
} from '../../lib/voiceEnrichmentCore';
import { queueSourceFacts } from '../../lib/sourceFacts';
import { voiceSourceFacts } from '../../lib/sourceFactsCore';
import { AILabel } from '../ui/AISurface';
import { Button } from '../ui/Button';

type Phase = 'idle' | 'recording' | 'review' | 'saving';

/**
 * Raw words are committed before any optional enrichment is queued. The
 * durable app-level enrichment center owns summary/commitment processing, so
 * closing this modal, changing routes, or opening a second tab cannot silently
 * lose progress.
 */
export function VoiceMemo({
  uid,
  contactId,
  contactName,
  meetingTitle,
  aiAllowed = true,
  onClose,
  onSaved,
}: {
  uid: string;
  contactId: string;
  contactName: string;
  meetingTitle?: string | null;
  aiAllowed?: boolean;
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
    supported ? null : "This browser can't dictate — type the note instead.",
  );
  const sessionRef = useRef<SpeechSession | null>(null);

  useEffect(() => () => sessionRef.current?.stop(), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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
        const normalized = normalizeVoiceMemoText(`${final} ${interim}`);
        if (normalized.truncated) {
          setFinalText(normalized.text);
          setInterimText('');
          setNotice(
            `Dictation stopped at ${VOICE_MEMO_MAX_CHARS.toLocaleString()} characters. Review or shorten the memo before saving.`,
          );
          sessionRef.current?.stop();
          sessionRef.current = null;
          setPhase('review');
          return;
        }
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

  const transcript = `${finalText} ${interimText}`.trim();

  const save = async () => {
    const normalizedTranscript = normalizeVoiceMemoText(transcript);
    if (!normalizedTranscript.text) {
      toast('Nothing to save yet.', 'error');
      return;
    }
    if (normalizedTranscript.truncated) {
      setFinalText(normalizedTranscript.text);
      setInterimText('');
      setNotice(
        `Memos are limited to ${VOICE_MEMO_MAX_CHARS.toLocaleString()} characters. The extra text was not saved or sent to AI.`,
      );
      toast('Shorten the memo before saving.', 'error');
      return;
    }
    setPhase('saving');

    try {
      const noteRef = doc(collection(db, `users/${uid}/notes`));
      const observedAt = new Date();
      const batch = writeBatch(db);
      const factIds = queueSourceFacts(batch, {
        uid,
        contactId,
        sourceType: 'voice',
        sourceId: noteRef.id,
        observedAt,
        facts: voiceSourceFacts(
          normalizedTranscript.text,
          meetingTitle,
        ),
        aiAllowed,
      });
      batch.set(noteRef, {
          noteSchemaVersion: 2,
          userId: uid,
          contactId,
          content: normalizedTranscript.text,
          source: 'voice-memo',
          recordType: 'voice',
          privacySourceType: 'voice',
          sourceId: noteRef.id,
          sensitive: false,
          aiAllowed,
          meetingTitle: meetingTitle || null,
          observedAt,
          factIds,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, `users/${uid}/contacts/${contactId}`), {
        lastContactedAt: observedAt,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();

      if (aiAllowed) {
        try {
          await enqueueVoiceEnrichment({
            uid,
            noteId: noteRef.id,
            contactId,
            contactName,
          });
          toast(
            'Memo filed. Enrichment is continuing in the background.',
            'success',
          );
        } catch {
          toast(
            'Memo filed, but enrichment could not be queued. Your words are safe.',
            'info',
          );
        }
      } else {
        toast('Memo filed without AI.', 'success');
      }
      onSaved?.();
      onClose();
    } catch {
      toast('Could not save the memo. Your transcript is still here.', 'error');
      setPhase('review');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm animate-fade-in"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          sessionRef.current?.stop();
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        className="animate-fade-scale-in w-full max-w-lg rounded-card border border-ink/15 bg-white shadow-float"
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-memo-title"
      >
        <header className="flex items-start justify-between gap-4 border-b border-ink/15 p-6">
          <div>
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
              Voice memo
            </span>
            <h2
              id="voice-memo-title"
              className="mt-1.5 font-serif text-2xl font-bold italic"
            >
              {meetingTitle || `Notes on ${contactName}`}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => {
              sessionRef.current?.stop();
              onClose();
            }}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-card text-muted transition-colors hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            aria-label="Close voice memo"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="space-y-4 p-6">
          {notice && (
            <p
              className="rounded-card border border-ink/15 bg-paper/60 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-subtle"
              role="status"
            >
              {notice}
            </p>
          )}

          {phase === 'idle' && !typing && (
            <div className="flex flex-col items-center gap-4 py-6">
              <p className="text-center font-mono text-xs leading-relaxed text-muted">
                Say what happened. It files itself against {contactName}.
              </p>
              <p className="max-w-sm text-center font-mono text-[10px] leading-relaxed text-subtle">
                Your browser may send microphone audio to its speech-recognition
                service. Cirqle never stores the audio; only the transcript you
                choose to save is filed. You can type instead.
              </p>
              <Button variant="brand" size="lg" onClick={begin}>
                <Mic size={13} className="mr-2" aria-hidden="true" />
                I understand — start dictation
              </Button>
              <button
                type="button"
                onClick={() => {
                  setTyping(true);
                  setPhase('review');
                }}
                className="flex min-h-11 items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted underline-offset-4 transition-colors hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <Keyboard size={11} aria-hidden="true" />
                Type it instead
              </button>
            </div>
          )}

          {phase === 'recording' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted">
                  <span
                    className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  Listening
                </span>
                <Button variant="outline" size="sm" onClick={stop}>
                  <Square size={11} className="mr-1.5" aria-hidden="true" />
                  Stop
                </Button>
              </div>
              <div
                className="max-h-56 min-h-24 overflow-y-auto rounded-card border border-ink/15 bg-paper/50 p-3"
                aria-live="polite"
              >
                <p className="font-mono text-xs leading-relaxed">
                  {finalText}
                  <span className="text-muted">{interimText}</span>
                  {!transcript && (
                    <span className="text-muted">Waiting for you…</span>
                  )}
                </p>
              </div>
            </div>
          )}

          {(phase === 'review' ||
            phase === 'saving' ||
            (phase === 'idle' && typing)) && (
            <div className="space-y-3">
              <label
                htmlFor="voice-memo-transcript"
                className="block font-mono text-[10px] uppercase tracking-widest text-muted"
              >
                Transcript — edit freely
              </label>
              <textarea
                id="voice-memo-transcript"
                className="h-40 w-full rounded-card border border-ink/15 bg-paper/50 p-3 font-mono text-xs leading-relaxed transition-colors focus-visible:border-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                value={finalText}
                maxLength={VOICE_MEMO_MAX_CHARS}
                onChange={(event) => setFinalText(event.target.value)}
                placeholder={`What came out of the conversation with ${contactName}?`}
                autoFocus
              />
              <p className="text-right font-mono text-[10px] text-muted">
                {finalText.length.toLocaleString()} /{' '}
                {VOICE_MEMO_MAX_CHARS.toLocaleString()}
              </p>
              <AILabel>
                {aiAllowed
                  ? 'Raw memo saves first; grounded summary and commitment suggestions follow'
                  : 'Raw memo only — AI is disabled for this contact'}
              </AILabel>
            </div>
          )}
        </div>

        {phase !== 'recording' && phase !== 'idle' && (
          <div className="flex justify-end gap-2 border-t border-ink/15 p-6">
            {supported && !typing && (
              <Button
                variant="ghost"
                onClick={begin}
                disabled={phase === 'saving'}
              >
                <Mic size={12} className="mr-1.5" aria-hidden="true" />
                Record more
              </Button>
            )}
            <Button
              variant="brand"
              onClick={save}
              disabled={phase === 'saving' || !transcript}
            >
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
