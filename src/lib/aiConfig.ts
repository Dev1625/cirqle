/**
 * THE ONE PLACE MODELS ARE NAMED.
 *
 * Every AI call in the app asks for a *tier*, never a model. Change a model
 * here (or via env) and every feature on that tier moves with it — no hunting
 * through twelve call sites, which is exactly what this replaced.
 *
 * The strings below are LiteLLM **aliases**, not upstream model ids. The real
 * provider and model live in `litellm-proxy/config.yaml`, which is also where
 * the provider API keys are read from. That indirection is the point: swapping
 * DeepSeek for something else is a proxy config change and a redeploy of the
 * proxy, with no app change and no rebuild.
 *
 * ── If you change an alias here, three things must agree ──────────────────
 *   1. this file (or the matching VITE_AI_MODEL_* env var)
 *   2. `model_name:` in litellm-proxy/config.yaml
 *   3. the `models: [...]` allowlist in api/register-user.js — virtual keys
 *      are scoped to a model list, and a model missing from it is rejected at
 *      request time with an auth-shaped error that looks nothing like the
 *      actual cause.
 */

export type ModelTier = 'fast' | 'reasoning' | 'draft';

/**
 * Defaults, chosen for cost during beta.
 *
 * fast      — bulk extraction and structured parsing. High volume, low
 *             judgement: tagging, CSV import, one-line summaries.
 * reasoning — anything writing prose a human reads, or making a judgement
 *             call. The default workhorse.
 * draft     — the few places where output quality is the product rather than
 *             a convenience, and a better model earns its cost.
 *
 * None of these need multimodal input; every call in this app is text in,
 * text or JSON out.
 */
const DEFAULT_MODELS: Record<ModelTier, string> = {
  fast: 'gemini-2.5-flash-lite',
  reasoning: 'deepseek-v4-flash',
  draft: 'deepseek-v4-pro',
};

/**
 * Per-tier env override, so a model can be changed on a deploy without a code
 * change. Safe to expose: these are alias strings, not credentials.
 *
 *   VITE_AI_MODEL_FAST / VITE_AI_MODEL_REASONING / VITE_AI_MODEL_DRAFT
 */
export function modelFor(tier: ModelTier): string {
  const override = (import.meta as any).env?.[`VITE_AI_MODEL_${tier.toUpperCase()}`];
  return typeof override === 'string' && override.length > 0 ? override : DEFAULT_MODELS[tier];
}

/** Every alias the app can ask for — used to keep the key allowlist honest. */
export function allModelAliases(): string[] {
  return (Object.keys(DEFAULT_MODELS) as ModelTier[]).map(modelFor);
}

/**
 * Gateway base URL, normalised to the OpenAI-compatible root.
 *
 * Deliberately strips a trailing `/gemini`: the previous client appended that
 * to reach LiteLLM's Gemini passthrough, and any env var still carrying it
 * would otherwise produce a 404 that looks like a dead gateway.
 */
export function gatewayBaseUrl(): string {
  let url = (import.meta as any).env?.VITE_GATEWAY_URL || 'http://localhost:4000';
  if (url.endsWith('/')) url = url.slice(0, -1);
  if (url.endsWith('/gemini')) url = url.slice(0, -'/gemini'.length);
  if (url.endsWith('/v1')) url = url.slice(0, -'/v1'.length);
  return url;
}

/** localStorage key holding this user's per-user virtual key. */
export const USER_KEY_STORAGE = 'CIRQLE_USER_PROXY_KEY';
