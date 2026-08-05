/**
 * The browser-side expectation for semantic-tier aliases.
 *
 * Features choose a semantic tier, never an upstream provider model. The
 * server independently derives the permitted alias from the required feature
 * ID in `api/_lib/ai-feature-policy.js`; a mismatch is rejected before any
 * gateway request.
 *
 * If an alias changes, keep these three places synchronized:
 *   1. this file
 *   2. `api/_lib/ai-feature-policy.js`
 *   3. `model_name` in `litellm-proxy/config.yaml`
 */

export type ModelTier = 'fast' | 'reasoning' | 'draft';

export type AIFeatureId =
  | 'dashboard-weekly-priorities'
  | 'global-natural-language-search'
  | 'pre-meeting-brief'
  | 'dormant-revival-draft'
  | 'commitment-extraction'
  | 'digital-card-draft'
  | 'voice-memo-summary'
  | 'directory-csv-import'
  | 'directory-contact-parse'
  | 'contact.reply.process'
  | 'contact.tags.extract'
  | 'contact.outreach.draft.quick'
  | 'contact.outreach.draft.premium';

const MODELS: Readonly<Record<ModelTier, string>> = Object.freeze({
  fast: 'gemini-3.5-flash-lite',
  reasoning: 'deepseek-v4-flash',
  draft: 'deepseek-v4-pro',
});

/**
 * A deploy-time browser override could drift from the server task policy,
 * LiteLLM routing table, and virtual-key allowlist. Keep the expected alias
 * code-owned and let the server enforce the authoritative pairing.
 */
export function modelFor(tier: ModelTier): string {
  return MODELS[tier];
}

export function allModelAliases(): string[] {
  return (Object.keys(MODELS) as ModelTier[]).map(modelFor);
}
