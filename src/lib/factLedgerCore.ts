import type { GroundedSource } from './grounding';
import type { PrivacySourceType } from './moat/privacyPolicy';

export type FactSourceType =
  | 'profile'
  | 'import'
  | 'note'
  | 'meeting'
  | 'outreach'
  | 'voice'
  | 'public-card-capture'
  | 'user-correction'
  | 'system';

export interface TemporalFact {
  id: string;
  predicate: string;
  value: string;
  normalizedValue: string;
  sourceType: FactSourceType;
  sourceId: string | null;
  observedAt: Date | null;
  confidence: number;
  current: boolean;
  aiAllowed: boolean;
  correctionOf: string | null;
  supersededBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface NewFact {
  predicate: string;
  value: string;
  sourceType: FactSourceType;
  sourceId?: string | null;
  observedAt?: Date | null;
  confidence?: number;
  aiAllowed?: boolean;
  correctionOf?: string | null;
}

export function normalizeFactValue(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

export function clampConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.max(0, Math.min(1, parsed));
}

export function factSourceLabel(fact: Pick<
  TemporalFact,
  'predicate' | 'sourceType' | 'observedAt'
>): string {
  const predicate = fact.predicate
    .split('.')
    .at(-1)
    ?.replace(/([a-z])([A-Z])/g, '$1 $2') || 'fact';
  const source = fact.sourceType.replace(/-/g, ' ');
  const date = fact.observedAt
    ? ` · ${fact.observedAt.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year:
          fact.observedAt.getFullYear() === new Date().getFullYear()
            ? undefined
            : 'numeric',
      })}`
    : '';
  return `${predicate} · ${source}${date}`;
}

export function factsForAI(facts: TemporalFact[]): TemporalFact[] {
  return facts.filter(
    (fact) =>
      fact.current &&
      fact.aiAllowed &&
      Boolean(fact.value.trim()) &&
      fact.confidence > 0,
  );
}

export function factsToGroundedSources(
  contactId: string,
  facts: TemporalFact[],
): GroundedSource[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));

  const privacyOrigin = (
    fact: TemporalFact,
  ): { sourceType: PrivacySourceType; sourceId: string } => {
    let source = fact;
    const visited = new Set<string>();
    while (
      source.sourceType === 'user-correction' &&
      source.correctionOf &&
      !visited.has(source.id)
    ) {
      visited.add(source.id);
      const parent = byId.get(source.correctionOf);
      if (!parent) break;
      source = parent;
    }
    if (source.sourceType === 'user-correction') {
      return {
        sourceType: 'user-input',
        sourceId: fact.id,
      };
    }
    return {
      sourceType: source.sourceType,
      sourceId: source.sourceId || source.id,
    };
  };

  return factsForAI(facts).map((fact) => {
    const origin = privacyOrigin(fact);
    return {
    id: `fact-${fact.id}`,
    label: factSourceLabel(fact),
    kind: 'fact',
    content: JSON.stringify({
      contactId,
      predicate: fact.predicate,
      value: fact.value,
      observedAt: fact.observedAt?.toISOString() || null,
      confidence: fact.confidence,
      sourceType: fact.sourceType,
      sourceId: fact.sourceId,
    }),
    observedAt: fact.observedAt?.toISOString() || null,
    privacySourceType: origin.sourceType,
    privacySourceId: origin.sourceId,
  };
  });
}

export function groupFactHistory(
  facts: TemporalFact[],
): Map<string, TemporalFact[]> {
  const grouped = new Map<string, TemporalFact[]>();
  for (const fact of facts) {
    const list = grouped.get(fact.predicate) || [];
    list.push(fact);
    grouped.set(fact.predicate, list);
  }
  for (const list of grouped.values()) {
    list.sort(
      (a, b) =>
        (b.observedAt?.getTime() || b.createdAt?.getTime() || 0) -
        (a.observedAt?.getTime() || a.createdAt?.getTime() || 0),
    );
  }
  return grouped;
}
