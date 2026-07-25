import { getGemini } from './gemini';

/**
 * Shared wrapper for the AI surfaces added in this pass.
 *
 * Exists because the same three things were being reimplemented at every call
 * site, and the first polish pass had to go back and fix a Dashboard brief
 * that had none of them:
 *
 *   1. A timeout. The gateway may simply be absent in local dev (lib/gemini.ts
 *      falls back to a placeholder key against localhost:4000), and a fetch
 *      against nothing hangs rather than rejecting. Without this, "loading"
 *      is forever and the user cannot tell it from slow.
 *   2. Honest error text. Callers get a short, dry sentence they can put
 *      straight into AISurface's error state, not a raw stack.
 *   3. Tolerant JSON parsing. Models fence JSON in ``` often enough that
 *      not handling it is a bug, not a nicety.
 */

const MODEL_FAST = 'gemini-2.5-flash-lite';
const MODEL_REASONING = 'gemini-3-flash-preview';

export class AIUnavailableError extends Error {
  constructor(message = 'No answer from the model. The gateway may not be running.') {
    super(message);
    this.name = 'AIUnavailableError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new AIUnavailableError('The model took too long. Try again.')),
      ms
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function generateText(
  prompt: string,
  options: { model?: 'fast' | 'reasoning'; timeoutMs?: number } = {}
): Promise<string> {
  const model = options.model === 'reasoning' ? MODEL_REASONING : MODEL_FAST;
  try {
    const ai = getGemini();
    const response = await withTimeout(
      ai.models.generateContent({ model, contents: prompt }),
      options.timeoutMs ?? 20000
    );
    const text = (response as any)?.text?.trim();
    if (!text) throw new AIUnavailableError('The model returned nothing.');
    return text;
  } catch (error) {
    if (error instanceof AIUnavailableError) throw error;
    throw new AIUnavailableError();
  }
}

/** Strips ``` fences and pulls the first balanced JSON value out of a reply. */
export function parseLooseJSON<T>(raw: string): T {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1)) as T;
    }
    throw new AIUnavailableError("The model's reply wasn't usable.");
  }
}

export async function generateJSON<T>(
  prompt: string,
  options: { model?: 'fast' | 'reasoning'; timeoutMs?: number } = {}
): Promise<T> {
  const model = options.model === 'reasoning' ? MODEL_REASONING : MODEL_FAST;
  try {
    const ai = getGemini();
    const response = await withTimeout(
      ai.models.generateContent({
        model,
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      }),
      options.timeoutMs ?? 20000
    );
    const text = (response as any)?.text?.trim();
    if (!text) throw new AIUnavailableError('The model returned nothing.');
    return parseLooseJSON<T>(text);
  } catch (error) {
    if (error instanceof AIUnavailableError) throw error;
    throw new AIUnavailableError();
  }
}
