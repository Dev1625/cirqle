import { gatewayBaseUrl, USER_KEY_STORAGE } from './aiConfig';

/**
 * Transport for every model call in the app: LiteLLM's OpenAI-compatible
 * `/v1/chat/completions`.
 *
 * ── Why this replaced the @google/genai client ────────────────────────────
 *
 * The old client pointed the Gemini SDK at LiteLLM's `/gemini` passthrough.
 * That path speaks Gemini's wire format and forwards to Google, so it can
 * only ever reach Gemini models — a hard ceiling the moment you want DeepSeek,
 * Anthropic, or anything else. `/v1/chat/completions` is provider-agnostic:
 * LiteLLM maps the alias to whatever upstream is configured, and this file
 * never learns which provider answered.
 *
 * ── Credentials ──────────────────────────────────────────────────────────
 *
 * The only credential here is the user's own per-user virtual key, minted
 * server-side by api/register-user.js and capped by budget.
 *
 * The previous client fell back to `import.meta.env.VITE_GEMINI_API_KEY`.
 * Anything VITE_-prefixed is inlined into the browser bundle at build time,
 * so setting that variable would have shipped a real provider key to every
 * visitor, permanently, in a file anyone can read. That fallback is gone and
 * must not come back: no provider key and no master key belongs in any
 * variable this file can see.
 */

export class AIUnavailableError extends Error {
  constructor(message = 'No answer from the model. The gateway may not be running.') {
    super(message);
    this.name = 'AIUnavailableError';
  }
}

export class AIKeyMissingError extends AIUnavailableError {
  constructor() {
    super('No AI key for this account yet. Reload the app to have one issued.');
    this.name = 'AIKeyMissingError';
  }
}

function userKey(): string {
  const key = typeof window !== 'undefined' ? localStorage.getItem(USER_KEY_STORAGE) : null;
  if (!key) throw new AIKeyMissingError();
  return key;
}

export interface ChatOptions {
  model: string;
  prompt: string;
  /** Ask the model for a JSON object rather than prose. */
  json?: boolean;
  timeoutMs?: number;
  /** Kept low by default — these are short, factual outputs, not creative ones. */
  temperature?: number;
  maxTokens?: number;
}

/**
 * One chat completion. Aborts on timeout via AbortController rather than a
 * dangling Promise.race, so a slow request is actually cancelled instead of
 * left running and billed.
 */
export async function chat(options: ChatOptions): Promise<string> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);

  try {
    const response = await fetch(`${gatewayBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userKey()}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: options.prompt }],
        temperature: options.temperature ?? 0.4,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // 401/403 from LiteLLM usually means the virtual key is unknown, expired,
      // or — the subtle one — not allowed to use this model alias, because the
      // key's `models` allowlist and the app's aliases have drifted apart.
      if (response.status === 401 || response.status === 403) {
        throw new AIUnavailableError(
          'The AI gateway rejected this key. It may be out of budget, or not permitted to use this model.'
        );
      }
      if (response.status === 429) {
        throw new AIUnavailableError('Rate limited by the AI gateway. Try again in a moment.');
      }
      throw new AIUnavailableError(`The AI gateway returned ${response.status}. ${body.slice(0, 140)}`);
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AIUnavailableError('The model returned nothing.');
    return text;
  } catch (error: any) {
    if (error instanceof AIUnavailableError) throw error;
    if (error?.name === 'AbortError') {
      throw new AIUnavailableError('The model took too long. Try again.');
    }
    // Gateway down, DNS failure, CORS — all indistinguishable from here and
    // all mean the same thing to the user.
    throw new AIUnavailableError();
  } finally {
    window.clearTimeout(timer);
  }
}
