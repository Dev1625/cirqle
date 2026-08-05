/**
 * Web Speech API wrapper for voice memos.
 *
 * The browser's own recogniser is the right low-friction default here: it
 * requires no Cirqle transcription credential and works well in Chromium.
 * Depending on the browser and operating system, speech may be sent to that
 * platform's recognition service. Callers must disclose that before requesting
 * microphone permission and must always offer manual text entry. Firefox has
 * no support and Safari's is uneven, so an unsupported browser must never be a
 * dead end.
 *
 * A paid transcription service could slot in behind the same mock/live env
 * gate as the other integrations; it was not added because the free path
 * covers the use case and adding a credential nobody has configured would
 * make the feature less demoable, not more.
 */

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

function getRecognitionConstructor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const anyWindow = window as any;
  return anyWindow.SpeechRecognition || anyWindow.webkitSpeechRecognition || null;
}

export function isSpeechSupported(): boolean {
  return getRecognitionConstructor() !== null;
}

export interface SpeechSession {
  stop: () => void;
}

/**
 * Starts continuous dictation.
 *
 * Interim results are surfaced so the user can see it working — a recorder
 * that shows nothing for thirty seconds reads as broken. Finalised segments
 * accumulate; interim text is replaced on each event rather than appended,
 * which is the part that is easy to get wrong and produces stuttering
 * duplicated words.
 */
export function startDictation(handlers: {
  onTranscript: (finalText: string, interimText: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
  lang?: string;
}): SpeechSession | null {
  const Constructor = getRecognitionConstructor();
  if (!Constructor) return null;

  const recognition = new Constructor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = handlers.lang || 'en-US';

  let finalText = '';
  let stopped = false;

  recognition.onresult = (event: any) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalText += result[0].transcript;
      } else {
        interim += result[0].transcript;
      }
    }
    handlers.onTranscript(finalText, interim);
  };

  recognition.onerror = (event: any) => {
    const code = event?.error;
    if (code === 'no-speech') return; // benign; the recogniser keeps going
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      handlers.onError('Microphone access was blocked. You can type the note instead.');
    } else if (code === 'network') {
      handlers.onError('Speech recognition needs a network connection. Type it instead?');
    } else {
      handlers.onError('Dictation stopped unexpectedly. Your text so far has been kept.');
    }
  };

  recognition.onend = () => {
    // Chrome ends the session on its own after a pause. Restart unless the
    // user actually asked to stop, otherwise a thinking pause ends the memo.
    if (!stopped) {
      try {
        recognition.start();
        return;
      } catch {
        /* fall through to ending cleanly */
      }
    }
    handlers.onEnd();
  };

  try {
    recognition.start();
  } catch {
    handlers.onError('Could not start the microphone.');
    return null;
  }

  return {
    stop: () => {
      stopped = true;
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    },
  };
}
