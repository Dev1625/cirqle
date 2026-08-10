import type { GroundedSource } from '../grounding';

/**
 * Order is the display order of the Settings → Privacy & AI table.
 *
 * `server/api/_lib/source-retention.js` mirrors this list exactly and
 * `tests/security-config.test.mjs` asserts the two stay identical — a source
 * type the server can write but the policy cannot name is data the owner
 * cannot see, retain, or revoke.
 */
export const PRIVACY_SOURCE_TYPES = [
  'profile',
  'import',
  // Anything an AI agent wrote through the MCP server. Kept distinct from
  // `import` so an agent's work is visibly attributable and revocable in one
  // action, rather than blending into the owner's own CSV uploads.
  'agent',
  'note',
  'voice',
  'meeting',
  'calendar',
  'email',
  'outreach',
  'reply',
  'commitment',
  'public-card-capture',
  'user-input',
  'system',
] as const;

export type PrivacySourceType = (typeof PRIVACY_SOURCE_TYPES)[number];
export type RetentionMode = 'forever' | 'days' | 'delete-on-disconnect';
export type AIUseBoundary = 'allow' | 'never';

export interface SourcePrivacyBoundary {
  id: string;
  scope: 'source-type' | 'source';
  sourceType: PrivacySourceType;
  /** Required only for an exact-source boundary. */
  sourceId: string | null;
  retentionMode: RetentionMode;
  retentionDays: number | null;
  aiUse: AIUseBoundary;
}

export interface SourcePrivacyPolicy {
  schemaVersion: 1;
  defaultRetentionMode: RetentionMode;
  defaultRetentionDays: number | null;
  defaultAIUse: AIUseBoundary;
  boundaries: SourcePrivacyBoundary[];
}

export const DEFAULT_SOURCE_PRIVACY_POLICY: SourcePrivacyPolicy = {
  schemaVersion: 1,
  defaultRetentionMode: 'forever',
  defaultRetentionDays: null,
  defaultAIUse: 'allow',
  boundaries: [],
};

export interface PrivacyEvaluatedSource {
  id: string;
  sourceType: PrivacySourceType;
  observedAt?: Date | string | null;
  disconnected?: boolean;
}

export interface SourcePrivacyDecision {
  sourceId: string;
  sourceType: PrivacySourceType;
  boundaryId: string | 'default';
  retained: boolean;
  eligibleForAI: boolean;
  expiresAt: string | null;
  reasons: (
    | 'allowed'
    | 'never-use-in-ai'
    | 'retention-expired'
    | 'provider-disconnected'
    | 'observed-at-missing'
  )[];
}

function normalizedSourceId(value: unknown): string {
  return String(value || '')
    .trim()
    .slice(0, 180);
}

function validSourceType(value: unknown): value is PrivacySourceType {
  return PRIVACY_SOURCE_TYPES.includes(value as PrivacySourceType);
}

function normalizeRetentionDays(
  mode: RetentionMode,
  value: unknown,
): number | null {
  if (mode !== 'days') return null;
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3650) {
    throw new Error('Retention days must be between 1 and 3650.');
  }
  return parsed;
}

export function sourceTypeBoundaryId(sourceType: PrivacySourceType): string {
  return `type:${sourceType}`;
}

export function exactSourceBoundaryId(
  sourceType: PrivacySourceType,
  sourceId: string,
): string {
  const normalized = normalizedSourceId(sourceId);
  if (!normalized) throw new Error('sourceId is required.');
  return `source:${sourceType}:${normalized}`;
}

export function createSourcePrivacyBoundary(params: {
  sourceType: PrivacySourceType;
  sourceId?: string | null;
  retentionMode?: RetentionMode;
  retentionDays?: number | null;
  aiUse?: AIUseBoundary;
}): SourcePrivacyBoundary {
  if (!validSourceType(params.sourceType)) {
    throw new Error('Unknown privacy source type.');
  }
  const sourceId = normalizedSourceId(params.sourceId) || null;
  const scope = sourceId ? 'source' : 'source-type';
  const retentionMode = params.retentionMode || 'forever';
  if (!['forever', 'days', 'delete-on-disconnect'].includes(retentionMode)) {
    throw new Error('Unknown retention mode.');
  }
  const aiUse = params.aiUse || 'allow';
  if (!['allow', 'never'].includes(aiUse)) {
    throw new Error('Unknown AI-use boundary.');
  }
  return {
    id: sourceId
      ? exactSourceBoundaryId(params.sourceType, sourceId)
      : sourceTypeBoundaryId(params.sourceType),
    scope,
    sourceType: params.sourceType,
    sourceId,
    retentionMode,
    retentionDays: normalizeRetentionDays(
      retentionMode,
      params.retentionDays,
    ),
    aiUse,
  };
}

/**
 * Sanitizes stored/user-supplied policy and sorts it for deterministic export.
 * Duplicate boundary ids are resolved in favor of the last explicit value.
 */
export function normalizeSourcePrivacyPolicy(
  value: Partial<SourcePrivacyPolicy> | null | undefined,
): SourcePrivacyPolicy {
  let defaultRetentionMode = [
    'forever',
    'days',
    'delete-on-disconnect',
  ].includes(String(value?.defaultRetentionMode))
    ? (value?.defaultRetentionMode as RetentionMode)
    : 'forever';
  const defaultAIUse = value?.defaultAIUse === 'never' ? 'never' : 'allow';
  const byId = new Map<string, SourcePrivacyBoundary>();

  for (const candidate of Array.isArray(value?.boundaries)
    ? value.boundaries
    : []) {
    if (!candidate || !validSourceType(candidate.sourceType)) continue;
    try {
      const normalized = createSourcePrivacyBoundary(candidate);
      byId.set(normalized.id, normalized);
    } catch {
      // Malformed persisted boundaries are ignored rather than weakening the
      // rest of an otherwise valid policy.
    }
  }

  let defaultRetentionDays: number | null = null;
  try {
    defaultRetentionDays = normalizeRetentionDays(
      defaultRetentionMode,
      value?.defaultRetentionDays,
    );
  } catch {
    // A corrupted finite-retention default must not silently become
    // indefinite. Thirty days is a conservative, visible fallback.
    defaultRetentionMode = 'days';
    defaultRetentionDays = 30;
  }

  return {
    schemaVersion: 1,
    defaultRetentionMode,
    defaultRetentionDays,
    defaultAIUse,
    boundaries: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function upsertSourcePrivacyBoundary(
  policy: SourcePrivacyPolicy,
  boundary: SourcePrivacyBoundary,
): SourcePrivacyPolicy {
  const normalized = normalizeSourcePrivacyPolicy(policy);
  return normalizeSourcePrivacyPolicy({
    ...normalized,
    boundaries: [
      ...normalized.boundaries.filter((item) => item.id !== boundary.id),
      boundary,
    ],
  });
}

export function removeSourcePrivacyBoundary(
  policy: SourcePrivacyPolicy,
  boundaryId: string,
): SourcePrivacyPolicy {
  const normalized = normalizeSourcePrivacyPolicy(policy);
  return {
    ...normalized,
    boundaries: normalized.boundaries.filter(
      (boundary) => boundary.id !== boundaryId,
    ),
  };
}

function effectiveBoundary(
  source: PrivacyEvaluatedSource,
  policy: SourcePrivacyPolicy,
): SourcePrivacyBoundary | null {
  const exactId = exactSourceBoundaryId(source.sourceType, source.id);
  return (
    policy.boundaries.find((boundary) => boundary.id === exactId) ||
    policy.boundaries.find(
      (boundary) =>
        boundary.scope === 'source-type' &&
        boundary.sourceType === source.sourceType,
    ) ||
    null
  );
}

export function evaluateSourcePrivacy(
  rawSource: PrivacyEvaluatedSource,
  rawPolicy: SourcePrivacyPolicy,
  now: Date | string = new Date(),
): SourcePrivacyDecision {
  const source: PrivacyEvaluatedSource = {
    ...rawSource,
    id: normalizedSourceId(rawSource.id),
  };
  if (!source.id || !validSourceType(source.sourceType)) {
    throw new Error('A valid source id and type are required.');
  }
  const policy = normalizeSourcePrivacyPolicy(rawPolicy);
  const boundary = effectiveBoundary(source, policy);
  const retentionMode =
    boundary?.retentionMode || policy.defaultRetentionMode;
  const retentionDays =
    boundary?.retentionDays || policy.defaultRetentionDays;
  const aiUse = boundary?.aiUse || policy.defaultAIUse;
  const nowAt = Date.parse(now instanceof Date ? now.toISOString() : String(now));
  if (!Number.isFinite(nowAt)) throw new Error('now must be a valid date.');

  let retained = true;
  let expiresAt: string | null = null;
  const reasons: SourcePrivacyDecision['reasons'] = [];

  if (retentionMode === 'delete-on-disconnect' && source.disconnected) {
    retained = false;
    reasons.push('provider-disconnected');
  } else if (retentionMode === 'days') {
    const observedAt = Date.parse(
      rawSource.observedAt instanceof Date
        ? rawSource.observedAt.toISOString()
        : String(rawSource.observedAt || ''),
    );
    if (!Number.isFinite(observedAt)) {
      // Do not guess that undated material is fresh enough for AI. It remains
      // retained until deletion tooling can make a deliberate decision.
      reasons.push('observed-at-missing');
    } else {
      const expiresAtMs = observedAt + Number(retentionDays) * 86_400_000;
      expiresAt = new Date(expiresAtMs).toISOString();
      if (expiresAtMs <= nowAt) {
        retained = false;
        reasons.push('retention-expired');
      }
    }
  }

  if (aiUse === 'never') reasons.push('never-use-in-ai');
  if (reasons.length === 0) reasons.push('allowed');

  return {
    sourceId: source.id,
    sourceType: source.sourceType,
    boundaryId: boundary?.id || 'default',
    retained,
    eligibleForAI:
      retained &&
      aiUse === 'allow' &&
      !reasons.includes('observed-at-missing'),
    expiresAt,
    reasons,
  };
}

export function filterSourcesForAI<T extends PrivacyEvaluatedSource>(
  sources: T[],
  policy: SourcePrivacyPolicy,
  now: Date | string = new Date(),
): {
  allowed: T[];
  excluded: { source: T; decision: SourcePrivacyDecision }[];
} {
  const allowed: T[] = [];
  const excluded: { source: T; decision: SourcePrivacyDecision }[] = [];
  for (const source of sources) {
    const decision = evaluateSourcePrivacy(source, policy, now);
    if (decision.eligibleForAI) allowed.push(source);
    else excluded.push({ source, decision });
  }
  return { allowed, excluded };
}

export function sourcesDueForDeletion<T extends PrivacyEvaluatedSource>(
  sources: T[],
  policy: SourcePrivacyPolicy,
  now: Date | string = new Date(),
): { source: T; decision: SourcePrivacyDecision }[] {
  return sources
    .map((source) => ({
      source,
      decision: evaluateSourcePrivacy(source, policy, now),
    }))
    .filter((item) => !item.decision.retained);
}

function groundedKindToPrivacyType(
  kind: GroundedSource['kind'],
): PrivacySourceType {
  if (kind === 'reply') return 'reply';
  if (kind === 'meeting') return 'meeting';
  if (kind === 'outreach') return 'outreach';
  if (kind === 'commitment') return 'commitment';
  if (kind === 'note') return 'note';
  if (kind === 'profile' || kind === 'contact') return 'profile';
  if (kind === 'user-input') return 'user-input';
  return 'system';
}

/**
 * Drop-in boundary before `generateGroundedJSON`. It returns the excluded
 * source ids and exact policy reasons so the UI can disclose what was omitted.
 */
export function filterGroundedSourcesForAI(
  sources: GroundedSource[],
  policy: SourcePrivacyPolicy,
  now: Date | string = new Date(),
): {
  allowed: GroundedSource[];
  excluded: {
    source: GroundedSource;
    decision: SourcePrivacyDecision;
  }[];
} {
  const evaluated = sources.map((source) => ({
    source,
    id: normalizedSourceId(source.privacySourceId) || source.id,
    sourceType: validSourceType(source.privacySourceType)
      ? source.privacySourceType
      : groundedKindToPrivacyType(source.kind),
    observedAt: source.observedAt,
  }));
  const result = filterSourcesForAI(evaluated, policy, now);
  return {
    allowed: result.allowed.map((item) => item.source),
    excluded: result.excluded.map(({ source, decision }) => ({
      source: source.source,
      decision,
    })),
  };
}
