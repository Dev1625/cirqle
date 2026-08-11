import { authenticatedFetch, AuthenticationRequiredError } from './authenticatedFetch';
import type { AIFeatureId } from './aiConfig';

/**
 * Transport for every model call in the app.
 *
 * The browser never receives a LiteLLM key. It authenticates to Cirqle with a
 * short-lived Firebase ID token; the server verifies the caller,
 * deterministically derives the caller's capped virtual key in memory, and
 * forwards the request to LiteLLM's provider-agnostic chat-completions
 * endpoint. LiteLLM stores only the corresponding managed-key record.
 */

export class AIUnavailableError extends Error {
  constructor(message = 'AI is temporarily unavailable. Your work is still saved.') {
    super(message);
    this.name = 'AIUnavailableError';
  }
}

export class AIKeyMissingError extends AIUnavailableError {
  constructor() {
    super('AI access is still being prepared for this account. Try again in a moment.');
    this.name = 'AIKeyMissingError';
  }
}

export class AICancelledError extends AIUnavailableError {
  constructor() {
    super('Generation canceled. Your work is still here.');
    this.name = 'AICancelledError';
  }
}

export interface ChatOptions {
  model: string;
  prompt: string;
  /** Ask the model for a JSON object rather than prose. */
  json?: boolean;
  timeoutMs?: number;
  /** Kept low by default: these are short, factual outputs. */
  temperature?: number;
  maxTokens?: number;
  /** Stable feature name for spend attribution and quality telemetry. */
  feature: AIFeatureId;
  /** Lets an AI surface cancel a request without losing its draft state. */
  signal?: AbortSignal;
}

export interface AIResponseMeta {
  requestId: string;
  feature: string;
  modelAlias: string;
  semanticTier: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AIChatResult {
  text: string;
  meta: AIResponseMeta;
}

function boundedTokenCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0
    ? Math.min(Math.floor(count), 10_000_000)
    : 0;
}

/**
 * One chat completion. AbortController cancels slow upstream work instead of
 * leaving a detached, billable request running after the UI times out.
 */
export async function chatWithMetadata(
  options: ChatOptions,
): Promise<AIChatResult> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  const cancel = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });

  try {
    const response = await authenticatedFetch('/api/ai/chat', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        prompt: options.prompt,
        temperature: options.temperature ?? 0.4,
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
        ...(options.json ? { json: true } : {}),
        feature: options.feature,
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        throw new AIUnavailableError('Your session expired. Sign in again to continue.');
      }
      if (response.status === 402 || response.status === 403) {
        if (body?.error === 'email_verification_required') {
          throw new AIUnavailableError(
            'Verify your email in Settings before using paid AI features.',
          );
        }
        throw new AIUnavailableError(
          'This account has reached its AI budget or does not have access to this model.',
        );
      }
      if (response.status === 429) {
        throw new AIUnavailableError('AI is receiving too many requests. Try again in a moment.');
      }
      if (body?.error === 'ai-not-provisioned') throw new AIKeyMissingError();
      // Keyed on the server's error code rather than the status, because 502
      // covers both a gateway that is briefly down and a model that answered
      // with nothing. Those need different advice, and telling someone the
      // service is restarting when it is not just sends them to wait for a
      // recovery that already happened.
      if (body?.error === 'gateway_unavailable') {
        throw new AIUnavailableError(
          'The AI service is restarting. Wait a few seconds and try again — nothing was lost.',
        );
      }
      if (body?.error === 'invalid_model_response') {
        throw new AIUnavailableError(
          'The model returned an empty answer. Try again.',
        );
      }
      if (body?.error === 'gateway_timeout' || response.status === 504) {
        throw new AIUnavailableError('The model took too long. Try again.');
      }
      throw new AIUnavailableError();
    }

    const payload = await response.json();
    const text = payload?.text?.trim();
    if (!text) throw new AIUnavailableError('The model returned nothing.');
    return {
      text,
      meta: {
        requestId:
          typeof payload?.requestId === 'string'
            ? payload.requestId.slice(0, 100)
            : '',
        feature:
          typeof payload?.feature === 'string'
            ? payload.feature.slice(0, 64)
            : options.feature,
        modelAlias:
          typeof payload?.model === 'string'
            ? payload.model.slice(0, 100)
            : options.model,
        semanticTier:
          typeof payload?.tier === 'string'
            ? payload.tier.slice(0, 30)
            : null,
        usage: {
          promptTokens: boundedTokenCount(payload?.usage?.promptTokens),
          completionTokens: boundedTokenCount(
            payload?.usage?.completionTokens,
          ),
          totalTokens: boundedTokenCount(payload?.usage?.totalTokens),
        },
      },
    };
  } catch (error: any) {
    if (error instanceof AIUnavailableError) throw error;
    if (error instanceof AuthenticationRequiredError) {
      throw new AIUnavailableError(error.message);
    }
    if (error?.name === 'AbortError') {
      if (options.signal?.aborted) throw new AICancelledError();
      throw new AIUnavailableError('The model took too long. Try again.');
    }
    throw new AIUnavailableError();
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}

/** Backwards-compatible text-only seam for non-grounded infrastructure use. */
export async function chat(options: ChatOptions): Promise<string> {
  return (await chatWithMetadata(options)).text;
}
