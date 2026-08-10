/**
 * Server-owned AI task policy.
 *
 * The browser may describe the feature it is invoking and may include the
 * alias it expects, but this registry is the authority for model selection and
 * generation limits. Never accept an arbitrary model/feature pairing from a
 * client.
 */

/**
 * Spend-log attribution travels as LiteLLM request tags.
 *
 * LiteLLM narrows spend-log metadata to its own SpendLogsMetadata allowlist,
 * so custom keys are dropped before the row is written. Tags are persisted
 * verbatim as `request_tags`, which makes them the only durable channel for
 * "which Cirqle feature spent this". `/api/ai/chat` writes them and
 * `/api/ai/usage` reads them; keep the two in step.
 */
export const FEATURE_TAG_PREFIX = 'cirqle-feature:';
export const TIER_TAG_PREFIX = 'cirqle-tier:';

export const AI_MODEL_ALIASES_BY_TIER = Object.freeze({
  fast: 'gemini-3.5-flash-lite',
  reasoning: 'deepseek-v4-flash',
  draft: 'deepseek-v4-pro',
});

function definePolicy({
  tier,
  label,
  group,
  defaultMaxTokens,
  maxOutputTokens = defaultMaxTokens,
  defaultTemperature,
  maxTemperature = defaultTemperature,
  synthetic = false,
  exactPrompt = null,
}) {
  const modelAlias = AI_MODEL_ALIASES_BY_TIER[tier];
  if (!modelAlias) {
    throw new TypeError(`Unknown AI model tier: ${tier}`);
  }
  if (
    !Number.isInteger(defaultMaxTokens) ||
    defaultMaxTokens < 1 ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < defaultMaxTokens
  ) {
    throw new TypeError(`Invalid output-token policy for ${label}`);
  }
  if (
    !Number.isFinite(defaultTemperature) ||
    defaultTemperature < 0 ||
    !Number.isFinite(maxTemperature) ||
    maxTemperature < defaultTemperature ||
    maxTemperature > 1
  ) {
    throw new TypeError(`Invalid temperature policy for ${label}`);
  }

  return Object.freeze({
    tier,
    modelAlias,
    sendsTemperature: !modelAlias.startsWith('gemini-3.'),
    label,
    group,
    defaultMaxTokens,
    maxOutputTokens,
    defaultTemperature,
    maxTemperature,
    synthetic,
    exactPrompt,
  });
}

export const AI_FEATURE_POLICIES = Object.freeze({
  'dashboard-weekly-priorities': definePolicy({
    tier: 'reasoning',
    label: 'Weekly priorities',
    group: 'Dashboard',
    defaultMaxTokens: 500,
    defaultTemperature: 0.4,
  }),
  'global-natural-language-search': definePolicy({
    tier: 'reasoning',
    label: 'Natural-language directory search',
    group: 'Directory',
    defaultMaxTokens: 800,
    defaultTemperature: 0.4,
  }),
  'pre-meeting-brief': definePolicy({
    tier: 'reasoning',
    label: 'Pre-meeting brief',
    group: 'Dashboard',
    defaultMaxTokens: 700,
    defaultTemperature: 0.4,
  }),
  'dormant-revival-draft': definePolicy({
    tier: 'reasoning',
    label: 'Dormant contact revival',
    group: 'Dashboard',
    defaultMaxTokens: 450,
    defaultTemperature: 0.4,
  }),
  'commitment-extraction': definePolicy({
    tier: 'reasoning',
    label: 'Commitment extraction',
    group: 'Relationship memory',
    defaultMaxTokens: 900,
    defaultTemperature: 0.4,
  }),
  'digital-card-draft': definePolicy({
    tier: 'draft',
    label: 'Digital card draft',
    group: 'Digital card',
    defaultMaxTokens: 450,
    defaultTemperature: 0.4,
  }),
  'voice-memo-summary': definePolicy({
    tier: 'fast',
    label: 'Voice memo summary',
    group: 'Relationship memory',
    defaultMaxTokens: 120,
    defaultTemperature: 0.4,
  }),
  'directory-csv-import': definePolicy({
    tier: 'fast',
    label: 'CSV contact import',
    group: 'Directory',
    defaultMaxTokens: 3_200,
    defaultTemperature: 0.4,
  }),
  'directory-contact-parse': definePolicy({
    tier: 'fast',
    label: 'Pasted contact parsing',
    group: 'Directory',
    defaultMaxTokens: 700,
    defaultTemperature: 0.4,
  }),
  'contact.reply.process': definePolicy({
    tier: 'reasoning',
    label: 'Reply processing',
    group: 'Outreach',
    defaultMaxTokens: 350,
    defaultTemperature: 0.1,
  }),
  'contact.tags.extract': definePolicy({
    tier: 'fast',
    label: 'Conversation tag extraction',
    group: 'Relationship memory',
    defaultMaxTokens: 700,
    defaultTemperature: 0,
  }),
  'contact.outreach.draft.quick': definePolicy({
    tier: 'fast',
    label: 'Quick outreach draft',
    group: 'Outreach',
    defaultMaxTokens: 550,
    defaultTemperature: 0.2,
  }),
  'contact.outreach.draft.premium': definePolicy({
    tier: 'draft',
    label: 'Premium outreach draft',
    group: 'Outreach',
    defaultMaxTokens: 900,
    defaultTemperature: 0.2,
  }),
  'production-signup-smoke': definePolicy({
    tier: 'fast',
    label: 'Production signup smoke test',
    group: 'System',
    defaultMaxTokens: 8,
    defaultTemperature: 0,
    synthetic: true,
    exactPrompt: 'Reply with only OK.',
  }),
});

export const AI_FEATURE_IDS = Object.freeze(
  Object.keys(AI_FEATURE_POLICIES),
);

export const PRODUCTION_MODEL_ALIASES = Object.freeze(
  Object.values(AI_MODEL_ALIASES_BY_TIER),
);

export function getAIFeaturePolicy(feature) {
  if (typeof feature !== 'string') return null;
  return AI_FEATURE_POLICIES[feature] || null;
}

function humanizeFeature(feature) {
  if (!feature || feature === 'unattributed') return 'Unattributed AI';
  return feature
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function getAIFeatureUsageDescriptor(feature) {
  const policy = getAIFeaturePolicy(feature);
  if (policy) {
    return {
      label: policy.label,
      group: policy.group,
    };
  }
  return {
    label: humanizeFeature(feature),
    group: 'Other',
  };
}
