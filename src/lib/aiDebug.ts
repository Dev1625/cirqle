import React from 'react';

/**
 * Dev Mode — the one place that knows which model every AI feature runs on,
 * plus a live log of the calls actually made this session.
 *
 * Before this, the model id was a string literal sitting inline at each of the
 * six `generateContent` call sites, so the only way to answer "what model did
 * that just use?" was to go and read the source. The registry below is now the
 * single source of truth: call sites import their model from it, and Dev Mode
 * renders the same object. If a call ever runs on something other than what
 * the registry advertises, the log records the model the SDK was actually
 * handed, so the two can be compared rather than assumed equal.
 */

export type AiFeatureKey =
  | 'dashboardBrief'
  | 'globalSearch'
  | 'contactDraft'
  | 'replyParse'
  | 'conversationTags'
  | 'contactParse'
  | 'csvImport';

export type AiFeature = {
  /** Human label, shown in Dev Mode and in the call log. */
  label: string;
  /** Where in the product this fires. */
  surface: string;
  /** The model id handed to the SDK. */
  model: string;
  /** What the call is for, in one line. */
  purpose: string;
};

export const AI_FEATURES: Record<AiFeatureKey, AiFeature> = {
  dashboardBrief: {
    label: "This Week's AI Priorities",
    surface: 'Dashboard',
    model: 'gemini-3-flash-preview',
    purpose: 'Summarises the tracker into a three-bullet weekly brief.',
  },
  globalSearch: {
    label: 'Natural language search',
    surface: 'Global search bar',
    model: 'gemini-3-flash-preview',
    purpose: 'Answers a plain-English question against the whole directory.',
  },
  contactDraft: {
    label: 'Draft outreach',
    surface: 'Contact detail',
    model: 'gemini-3-flash-preview',
    purpose: 'Writes an outreach message from your profile and their history.',
  },
  replyParse: {
    label: 'Process reply',
    surface: 'Contact detail',
    model: 'gemini-3-flash-preview',
    purpose: 'Reads a pasted reply and suggests the next action.',
  },
  conversationTags: {
    label: 'Log a conversation',
    surface: 'Contact detail',
    model: 'gemini-2.5-flash-lite',
    purpose: 'Pulls "they mentioned…" tags out of conversation notes.',
  },
  contactParse: {
    label: 'Parse pasted contact',
    surface: 'Directory',
    model: 'gemini-2.5-flash-lite',
    purpose: 'Turns unstructured pasted text into a structured contact.',
  },
  csvImport: {
    label: 'CSV import',
    surface: 'Directory',
    model: 'gemini-2.5-flash-lite',
    purpose: 'Maps messy CSV columns onto clean contact records, 25 rows a call.',
  },
};

/* ── Dev Mode flag ───────────────────────────────────────────────────── */

const DEV_MODE_KEY = 'CIRQLE_DEV_MODE';

export function isDevMode(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(DEV_MODE_KEY) === 'true';
}

export function setDevMode(on: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DEV_MODE_KEY, String(on));
  notify();
}

/* ── Call log ────────────────────────────────────────────────────────── */

export type AiCall = {
  id: string;
  feature: AiFeatureKey;
  /** The model string the SDK was actually given, not the registry's. */
  model: string;
  endpoint: string;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  /** Character count of the prompt as sent — a cheap proxy for cost. */
  promptChars: number;
  /** First slice of the prompt, for eyeballing what was sent. */
  promptPreview: string;
  responseChars?: number;
  tokens?: { prompt?: number; response?: number; total?: number };
  error?: string;
};

/** Kept deliberately small — this is a debugging aid, not telemetry. */
const MAX_CALLS = 25;
const PREVIEW_CHARS = 400;

let calls: AiCall[] = [];
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function getAiCalls(): AiCall[] {
  return calls;
}

export function clearAiCalls() {
  calls = [];
  notify();
}

function recordAiCall(call: AiCall) {
  calls = [call, ...calls].slice(0, MAX_CALLS);
  notify();
  if (isDevMode()) {
    // Mirrored to the console so a call can still be traced after navigating
    // away from Settings.
    console.info(
      `[Cirqle AI] ${AI_FEATURES[call.feature]?.label ?? call.feature} · ${call.model} · ` +
        `${call.durationMs}ms · ${call.status}`,
      call
    );
  }
}

/** Subscribe a component to the log. Returns the current list. */
export function useAiCalls(): AiCall[] {
  return React.useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getAiCalls,
    getAiCalls
  );
}

/** Subscribe a component to the Dev Mode flag. */
export function useDevMode(): [boolean, (on: boolean) => void] {
  const enabled = React.useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    isDevMode,
    () => false
  );
  return [enabled, setDevMode];
}

/* ── Instrumentation ─────────────────────────────────────────────────── */

function promptOf(params: any): string {
  const contents = params?.contents;
  if (typeof contents === 'string') return contents;
  try {
    return JSON.stringify(contents ?? '');
  } catch {
    return '';
  }
}

/**
 * Wraps a GoogleGenAI client so every `models.generateContent` through it is
 * timed and logged against `feature`.
 *
 * A Proxy rather than a spread copy: `models` is a class instance whose
 * methods live on the prototype, so spreading it would quietly drop
 * everything except own properties. Non-instrumented members are bound back
 * to the real target so the SDK's internal (private) state stays reachable.
 */
export function instrumentGenAI<T extends object>(
  client: T,
  feature: AiFeatureKey,
  endpoint: string
): T {
  return new Proxy(client, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (prop !== 'models' || !value || typeof value !== 'object') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return wrapModels(value, feature, endpoint);
    },
  }) as T;
}

function wrapModels(models: any, feature: AiFeatureKey, endpoint: string) {
  return new Proxy(models, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (prop !== 'generateContent') return value.bind(target);

      return async (params: any) => {
        const startedAt = Date.now();
        const started = performance.now();
        const prompt = promptOf(params);
        const base = {
          id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
          feature,
          model: params?.model ?? 'unknown',
          endpoint,
          startedAt,
          promptChars: prompt.length,
          promptPreview: prompt.slice(0, PREVIEW_CHARS),
        };

        try {
          const response = await value.call(target, params);
          const usage = response?.usageMetadata;
          recordAiCall({
            ...base,
            durationMs: Math.round(performance.now() - started),
            status: 'ok',
            responseChars: (response?.text || '').length,
            tokens: usage
              ? {
                  prompt: usage.promptTokenCount,
                  response: usage.candidatesTokenCount,
                  total: usage.totalTokenCount,
                }
              : undefined,
          });
          return response;
        } catch (error) {
          recordAiCall({
            ...base,
            durationMs: Math.round(performance.now() - started),
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      };
    },
  });
}
