import {
  chat,
  chatWithMetadata,
  AICancelledError,
  AIUnavailableError,
  AIKeyMissingError,
  type AIResponseMeta,
} from './aiClient';
import { modelFor, type AIFeatureId, type ModelTier } from './aiConfig';

/**
 * The only way the app talks to a model.
 *
 * Callers name a *tier* ('fast' | 'reasoning' | 'draft'), never a model. That
 * is what makes a model swap a one-line change in aiConfig.ts instead of a
 * twelve-file search-and-replace, and it is why the tier names describe the
 * job rather than the vendor — 'reasoning' stays meaningful when the model
 * behind it changes.
 *
 * Everything routed through here gets, for free:
 *   - a real timeout that aborts the request rather than abandoning it
 *   - honest error text, ready to drop into AISurface's error state
 *   - tolerant JSON parsing, because models fence JSON in ``` often enough
 *     that not handling it is a bug rather than a nicety
 */

export { AICancelledError, AIUnavailableError, AIKeyMissingError };
export type { AIResponseMeta };

export interface GenerateOptions {
  /** Defaults to 'fast' — the cheap tier. Opt *up*, never accidentally. */
  tier: ModelTier;
  timeoutMs?: number | null;
  temperature?: number;
  maxTokens?: number;
  /** Stable product feature name used for spend and quality attribution. */
  feature: AIFeatureId;
  /** Optional UI cancellation signal. */
  signal?: AbortSignal;
}

export async function generateText(prompt: string, options: GenerateOptions): Promise<string> {
  return chat({
    model: modelFor(options.tier ?? 'fast'),
    prompt,
    timeoutMs: options.timeoutMs,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    feature: options.feature,
    signal: options.signal,
  });
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

export async function generateJSON<T>(prompt: string, options: GenerateOptions): Promise<T> {
  const raw = await chat({
    model: modelFor(options.tier),
    prompt,
    json: true,
    timeoutMs: options.timeoutMs,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    feature: options.feature,
    signal: options.signal,
  });
  return parseLooseJSON<T>(raw);
}

export async function generateJSONWithMetadata<T>(
  prompt: string,
  options: GenerateOptions,
): Promise<{ value: T; meta: AIResponseMeta }> {
  const completion = await chatWithMetadata({
    model: modelFor(options.tier),
    prompt,
    json: true,
    timeoutMs: options.timeoutMs,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    feature: options.feature,
    signal: options.signal,
  });
  return {
    value: parseLooseJSON<T>(completion.text),
    meta: completion.meta,
  };
}
