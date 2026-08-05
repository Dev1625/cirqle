import type { FactSourceType } from './factLedgerCore';

export const MAX_SOURCE_FACTS_PER_RECORD = 20;

export interface SourceFactDraft {
  predicate: string;
  value: string;
  confidence: number;
}

export const PROFILE_FACT_PREDICATES = Object.freeze({
  name: 'identity.name',
  email: 'identity.email',
  phone: 'identity.phone',
  company: 'identity.company',
  role: 'identity.role',
  location: 'identity.location',
  linkedinUrl: 'identity.linkedinUrl',
  relationshipTier: 'relationship.tier',
  whyTheyMatter: 'relationship.whyTheyMatter',
  summary: 'identity.summary',
  industry: 'identity.industry',
  subIndustry: 'identity.subIndustry',
  school: 'identity.school',
  seniority: 'identity.seniority',
  connectionSource: 'relationship.connectionSource',
  tags: 'relationship.tags',
} as const);

function cleanValue(value: unknown, limit = 20_000): string {
  return typeof value === 'string'
    ? value
        .replace(/\u0000/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, limit)
    : '';
}

function fact(
  predicate: string,
  value: unknown,
  confidence = 1,
): SourceFactDraft | null {
  const cleaned = cleanValue(value);
  if (!cleaned) return null;
  return {
    predicate: predicate.slice(0, 200),
    value: cleaned,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

export function profileSourceFacts(
  profile: Record<string, unknown>,
): SourceFactDraft[] {
  const result = Object.entries(PROFILE_FACT_PREDICATES)
    .filter(([field]) => field !== 'tags')
    .map(([field, predicate]) => fact(predicate, profile[field]))
    .filter((entry): entry is SourceFactDraft => Boolean(entry));

  const tags = Array.isArray(profile.tags)
    ? profile.tags
        .map((tag) => cleanValue(tag, 120))
        .filter(Boolean)
        .slice(0, 100)
    : [];
  if (tags.length > 0) {
    result.push({
      predicate: 'relationship.tags',
      value: tags.join(', ').slice(0, 20_000),
      confidence: 1,
    });
  }
  return result.slice(0, MAX_SOURCE_FACTS_PER_RECORD);
}

export function profileFactDraft(
  field: string,
  value: unknown,
): SourceFactDraft | null {
  const predicate =
    PROFILE_FACT_PREDICATES[
      field as keyof typeof PROFILE_FACT_PREDICATES
    ];
  if (!predicate) return null;
  if (field === 'tags') {
    const tags = Array.isArray(value)
      ? value
          .map((tag) => cleanValue(tag, 120))
          .filter(Boolean)
          .slice(0, 100)
      : [];
    return tags.length > 0
      ? {
          predicate,
          value: tags.join(', ').slice(0, 20_000),
          confidence: 1,
        }
      : null;
  }
  return fact(predicate, value);
}

export function noteSourceFacts(text: unknown): SourceFactDraft[] {
  const value = fact('relationship.note', text);
  return value ? [value] : [];
}

export function voiceSourceFacts(
  text: unknown,
  meetingTitle?: unknown,
): SourceFactDraft[] {
  const result = [
    fact('relationship.voiceMemo', text),
    fact('meeting.title', meetingTitle),
  ].filter((entry): entry is SourceFactDraft => Boolean(entry));
  return result.slice(0, MAX_SOURCE_FACTS_PER_RECORD);
}

export function meetingSourceFacts(input: {
  date?: unknown;
  discussed?: unknown;
  promised?: unknown;
  nextSteps?: unknown;
}): SourceFactDraft[] {
  return [
    fact('meeting.date', input.date),
    fact('meeting.discussed', input.discussed),
    fact('meeting.promised', input.promised),
    fact('meeting.nextSteps', input.nextSteps),
  ]
    .filter((entry): entry is SourceFactDraft => Boolean(entry))
    .slice(0, MAX_SOURCE_FACTS_PER_RECORD);
}

/**
 * Stable, non-secret FNV-1a identifier. Firestore document IDs need
 * idempotency here, not cryptographic secrecy: the source itself remains in a
 * private owner-only tree and every value is still validated by rules.
 */
export function sourceFactDocumentId(input: {
  sourceType: Exclude<FactSourceType, 'system' | 'user-correction'>;
  sourceId: string;
  predicate: string;
}): string {
  const value = `${input.sourceType}\u001f${input.sourceId}\u001f${input.predicate}`;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${input.sourceType}-${hash.toString(16).padStart(16, '0')}`;
}
