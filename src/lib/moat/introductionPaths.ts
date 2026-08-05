/**
 * Deterministic warm-introduction path ranking.
 *
 * Every score component comes from an explicit relationship edge. The
 * explanation is formatted from those same fields—there is no generative text
 * and therefore no invented mutual context.
 */

export type IntroductionWillingness =
  | 'yes'
  | 'likely'
  | 'unknown'
  | 'reluctant'
  | 'no';

export interface IntroductionConflict {
  id: string;
  label: string;
  severity: 'warning' | 'block';
}

export interface IntroductionEdgeProvenance {
  sourceType:
    | 'profile'
    | 'note'
    | 'meeting'
    | 'outreach'
    | 'user-correction'
    | 'system';
  sourceId: string;
  observedAt: Date | string;
}

export interface IntroductionRelationshipEdge {
  id: string;
  fromId: string;
  toId: string;
  /** Mutual edges are traversable in both directions. */
  direction?: 'directed' | 'mutual';
  /** Explicit relationship strength, from 0 to 1. */
  strength: number;
  willingness: IntroductionWillingness;
  lastInteractionAt: Date | string;
  /** Active introduction asks currently carried by the introducer. */
  activeIntroductionRequests?: number;
  /** Comfortable simultaneous introduction load; defaults to 3. */
  introductionCapacity?: number;
  /** Ask frequency is an explicit fatigue signal, never inferred from email. */
  introductionRequestsLast90Days?: number;
  lastIntroductionRequestAt?: Date | string | null;
  conflicts?: IntroductionConflict[];
  /** Optional mutual context shown only with its own exact evidence id. */
  mutualContext?: {
    text: string;
    sourceType: IntroductionEdgeProvenance['sourceType'];
    sourceId: string;
  } | null;
  /** The edge begins receiving a strong freshness penalty after this age. */
  staleAfterDays?: number;
  provenance: IntroductionEdgeProvenance;
}

export interface IntroductionNode {
  id: string;
  label: string;
}

export interface IntroductionEdgeScore {
  edgeId: string;
  score: number;
  strengthScore: number;
  freshnessScore: number;
  willingnessScore: number;
  loadScore: number;
  fatigueScore: number;
  conflictPenalty: number;
  ageDays: number;
  stale: boolean;
  blocked: boolean;
  reasons: string[];
}

export interface RankedIntroductionPath {
  id: string;
  nodeIds: string[];
  labels: string[];
  edges: IntroductionRelationshipEdge[];
  edgeScores: IntroductionEdgeScore[];
  score: number;
  limitingEdgeId: string;
  warnings: string[];
  explanation: string;
}

export interface ExcludedIntroductionEdge {
  edgeId: string;
  fromId: string;
  toId: string;
  reasons: string[];
}

export interface RankIntroductionPathsResult {
  paths: RankedIntroductionPath[];
  excludedEdges: ExcludedIntroductionEdge[];
}

const WILLINGNESS_SCORE: Record<IntroductionWillingness, number> = {
  yes: 1,
  likely: 0.82,
  unknown: 0.48,
  reluctant: 0.18,
  no: 0,
};

function clamp(value: unknown, min = 0, max = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function timestamp(value: Date | string | null | undefined): number | null {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function daysBetween(later: number, earlier: number): number {
  return Math.max(0, (later - earlier) / 86_400_000);
}

function labelFor(nodes: Map<string, IntroductionNode>, id: string): string {
  return nodes.get(id)?.label || id;
}

export function scoreIntroductionEdge(
  edge: IntroductionRelationshipEdge,
  now: Date | string = new Date(),
): IntroductionEdgeScore {
  const nowAt = timestamp(now);
  if (nowAt === null) throw new Error('now must be a valid date.');
  const interactionAt = timestamp(edge.lastInteractionAt);
  const evidenceAt = timestamp(edge.provenance.observedAt);
  const reasons: string[] = [];
  const conflicts = edge.conflicts || [];
  const blockingConflict = conflicts.find((conflict) => conflict.severity === 'block');
  const blocked =
    edge.willingness === 'no' ||
    Boolean(blockingConflict) ||
    interactionAt === null ||
    evidenceAt === null ||
    !edge.provenance.sourceId?.trim();

  if (edge.willingness === 'no') {
    reasons.push('willingness is explicitly no');
  }
  if (blockingConflict) {
    reasons.push(`blocked conflict: ${blockingConflict.label}`);
  }
  if (interactionAt === null) reasons.push('last interaction date is invalid');
  if (evidenceAt === null) reasons.push('provenance date is invalid');
  if (!edge.provenance.sourceId?.trim()) {
    reasons.push('provenance source id is missing');
  }

  const ageDays =
    interactionAt === null ? Number.POSITIVE_INFINITY : daysBetween(nowAt, interactionAt);
  const staleAfterDays = Math.max(1, Number(edge.staleAfterDays) || 180);
  // A current edge stays useful through half its stale window, then decays
  // linearly to a small floor at twice that window.
  const freshnessScore =
    ageDays <= staleAfterDays / 2
      ? 1
      : clamp(
          1 - (ageDays - staleAfterDays / 2) / (staleAfterDays * 1.5),
          0.08,
          1,
        );
  const stale = ageDays > staleAfterDays;
  if (stale) reasons.push(`relationship is stale at ${Math.floor(ageDays)} days`);

  const capacity = Math.max(1, Math.floor(Number(edge.introductionCapacity) || 3));
  const active = Math.max(
    0,
    Math.floor(Number(edge.activeIntroductionRequests) || 0),
  );
  const loadScore = clamp(1 - active / capacity);
  if (active >= capacity) reasons.push(`introduction load is full (${active}/${capacity})`);
  else if (active > 0) reasons.push(`introduction load is ${active}/${capacity}`);

  const recentRequests = Math.max(
    0,
    Math.floor(Number(edge.introductionRequestsLast90Days) || 0),
  );
  const frequencyScore = clamp(1 - recentRequests / 5);
  const lastRequestAt = timestamp(edge.lastIntroductionRequestAt);
  const cooldownScore =
    lastRequestAt === null ? 1 : clamp(daysBetween(nowAt, lastRequestAt) / 30);
  const fatigueScore = Math.min(frequencyScore, cooldownScore);
  if (recentRequests >= 3 || cooldownScore < 0.5) {
    reasons.push(
      `introduction fatigue: ${recentRequests} asks in 90 days${
        lastRequestAt === null
          ? ''
          : `, last asked ${Math.floor(daysBetween(nowAt, lastRequestAt))} days ago`
      }`,
    );
  }

  const warningConflicts = conflicts.filter(
    (conflict) => conflict.severity === 'warning',
  );
  for (const conflict of warningConflicts) {
    reasons.push(`conflict warning: ${conflict.label}`);
  }
  const conflictPenalty = Math.min(0.45, warningConflicts.length * 0.15);
  const strengthScore = clamp(edge.strength);
  const willingnessScore = WILLINGNESS_SCORE[edge.willingness] ?? 0;
  const weighted =
    strengthScore * 0.34 +
    freshnessScore * 0.24 +
    willingnessScore * 0.22 +
    loadScore * 0.12 +
    fatigueScore * 0.08;
  const score = blocked
    ? 0
    : Math.round(clamp(weighted - conflictPenalty) * 10_000) / 100;

  return {
    edgeId: edge.id,
    score,
    strengthScore,
    freshnessScore,
    willingnessScore,
    loadScore,
    fatigueScore,
    conflictPenalty,
    ageDays,
    stale,
    blocked,
    reasons,
  };
}

interface TraversableEdge {
  edge: IntroductionRelationshipEdge;
  fromId: string;
  toId: string;
  score: IntroductionEdgeScore;
}

function edgeNarrative(
  edge: IntroductionRelationshipEdge,
  score: IntroductionEdgeScore,
  nodes: Map<string, IntroductionNode>,
  fromId: string,
  toId: string,
): string {
  const capacity = Math.max(1, Math.floor(Number(edge.introductionCapacity) || 3));
  const active = Math.max(
    0,
    Math.floor(Number(edge.activeIntroductionRequests) || 0),
  );
  const requestCount = Math.max(
    0,
    Math.floor(Number(edge.introductionRequestsLast90Days) || 0),
  );
  return `${labelFor(nodes, fromId)} → ${labelFor(nodes, toId)}: ${Math.round(
    clamp(edge.strength) * 100,
  )}% strength, ${Math.floor(score.ageDays)} days since interaction, willingness ${
    edge.willingness
  }, load ${active}/${capacity}, ${requestCount} intro asks in 90 days; evidence ${
    edge.provenance.sourceType
  } · ${edge.provenance.sourceId}.`;
}

export function explainIntroductionPath(params: {
  nodeIds: string[];
  traversed: TraversableEdge[];
  nodes: Map<string, IntroductionNode>;
  score: number;
}): string {
  const limiting = [...params.traversed].sort(
    (a, b) => a.score.score - b.score.score || a.edge.id.localeCompare(b.edge.id),
  )[0];
  const path = params.nodeIds
    .map((nodeId) => labelFor(params.nodes, nodeId))
    .join(' → ');
  const edgeDetails = params.traversed
    .map((entry) =>
      edgeNarrative(
        entry.edge,
        entry.score,
        params.nodes,
        entry.fromId,
        entry.toId,
      ),
    )
    .join(' ');
  const contextDetails = params.traversed
    .map((entry) => entry.edge.mutualContext)
    .filter(
      (
        context,
      ): context is NonNullable<IntroductionRelationshipEdge['mutualContext']> =>
        Boolean(context?.text.trim() && context.sourceId.trim()),
    )
    .map(
      (context) =>
        `Mutual context: ${context.text
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 240)} (evidence ${context.sourceType} · ${
          context.sourceId
        }).`,
    )
    .join(' ');
  return `Warm path (${params.score.toFixed(1)}/100): ${path}. Limiting edge: ${
    limiting
      ? `${labelFor(params.nodes, limiting.fromId)} → ${labelFor(
          params.nodes,
          limiting.toId,
        )} at ${limiting.score.score.toFixed(1)}/100`
      : 'none'
  }. ${edgeDetails} ${contextDetails}`.trim();
}

export function rankWarmIntroductionPaths(params: {
  nodes: IntroductionNode[];
  edges: IntroductionRelationshipEdge[];
  startId: string;
  targetId: string;
  now?: Date | string;
  maxDepth?: number;
  maxPaths?: number;
}): RankIntroductionPathsResult {
  const nodes = new Map(params.nodes.map((node) => [node.id, node]));
  const maxDepth = Math.min(6, Math.max(1, params.maxDepth || 4));
  const maxPaths = Math.min(20, Math.max(1, params.maxPaths || 5));
  const excludedEdges: ExcludedIntroductionEdge[] = [];
  const adjacency = new Map<string, TraversableEdge[]>();

  const add = (
    edge: IntroductionRelationshipEdge,
    fromId: string,
    toId: string,
  ) => {
    const score = scoreIntroductionEdge(edge, params.now);
    if (score.blocked) {
      excludedEdges.push({
        edgeId: edge.id,
        fromId,
        toId,
        reasons: score.reasons,
      });
      return;
    }
    const list = adjacency.get(fromId) || [];
    list.push({ edge, fromId, toId, score });
    adjacency.set(fromId, list);
  };

  for (const edge of params.edges) {
    add(edge, edge.fromId, edge.toId);
    if (edge.direction === 'mutual') add(edge, edge.toId, edge.fromId);
  }
  for (const list of adjacency.values()) {
    list.sort(
      (a, b) =>
        b.score.score - a.score.score ||
        a.toId.localeCompare(b.toId) ||
        a.edge.id.localeCompare(b.edge.id),
    );
  }

  const found: TraversableEdge[][] = [];
  const visit = (
    currentId: string,
    visited: Set<string>,
    path: TraversableEdge[],
  ) => {
    if (path.length > maxDepth) return;
    if (currentId === params.targetId) {
      if (path.length > 0) found.push([...path]);
      return;
    }
    if (path.length === maxDepth) return;
    for (const next of adjacency.get(currentId) || []) {
      if (visited.has(next.toId)) continue;
      visited.add(next.toId);
      path.push(next);
      visit(next.toId, visited, path);
      path.pop();
      visited.delete(next.toId);
    }
  };
  visit(params.startId, new Set([params.startId]), []);

  const paths = found
    .map((traversed): RankedIntroductionPath => {
      const nodeIds = [params.startId, ...traversed.map((entry) => entry.toId)];
      const edgeScores = traversed.map((entry) => entry.score);
      const limiting = [...traversed].sort(
        (a, b) =>
          a.score.score - b.score.score || a.edge.id.localeCompare(b.edge.id),
      )[0];
      const average =
        edgeScores.reduce((sum, edgeScore) => sum + edgeScore.score, 0) /
        edgeScores.length;
      const bottleneck = Math.min(...edgeScores.map((edgeScore) => edgeScore.score));
      const hopPenalty = Math.max(0, traversed.length - 2) * 4;
      const score =
        Math.round(
          Math.max(0, bottleneck * 0.62 + average * 0.38 - hopPenalty) * 10,
        ) / 10;
      const warnings = traversed.flatMap((entry) =>
        entry.score.reasons.map(
          (reason) =>
            `${labelFor(nodes, entry.fromId)} → ${labelFor(
              nodes,
              entry.toId,
            )}: ${reason}`,
        ),
      );
      return {
        id: nodeIds.join('->'),
        nodeIds,
        labels: nodeIds.map((id) => labelFor(nodes, id)),
        edges: traversed.map((entry) => entry.edge),
        edgeScores,
        score,
        limitingEdgeId: limiting.edge.id,
        warnings,
        explanation: explainIntroductionPath({
          nodeIds,
          traversed,
          nodes,
          score,
        }),
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.nodeIds.length - b.nodeIds.length ||
        a.id.localeCompare(b.id),
    )
    .slice(0, maxPaths);

  return {
    paths,
    excludedEdges: excludedEdges.sort(
      (a, b) =>
        a.edgeId.localeCompare(b.edgeId) ||
        a.fromId.localeCompare(b.fromId) ||
        a.toId.localeCompare(b.toId),
    ),
  };
}
