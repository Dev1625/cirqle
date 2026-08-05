import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import {
  collection,
  doc,
  onSnapshot,
  query,
  where
} from 'firebase/firestore';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Flame,
  Link2,
  Network,
  Pin,
  Radar,
  Search,
  ShieldAlert,
  Users,
  Waypoints
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { db } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { TierBadge } from '../components/ui/TierBadge';
import { AccentRule } from '../components/ui/AccentRule';
import { IntroductionEdgeEditor } from '../components/contact/IntroductionEdgeEditor';
import { computeHealth } from '../lib/health';
import {
  rankWarmIntroductionPaths,
  type IntroductionConflict,
  type IntroductionEdgeProvenance,
  type IntroductionRelationshipEdge,
  type IntroductionWillingness,
  type RankedIntroductionPath
} from '../lib/moat/introductionPaths';

type Tier = 'Strong' | 'Warm' | 'Cold' | 'Dormant';

type ContactRecord = {
  id: string;
  name: string;
  company?: string | null;
  role?: string | null;
  industry?: string | null;
  relationshipTier?: string | null;
  summary?: string | null;
  tags?: string[] | null;
  location?: string | null;
  school?: string | null;
  connectionSource?: string | null;
  seniority?: string | null;
  lastContactedAt?: any;
  createdAt?: any;
  updatedAt?: any;
  introductionWillingness?: string | null;
  activeIntroductionRequests?: number | null;
  introductionCapacity?: number | null;
  introductionRequestsLast90Days?: number | null;
  lastIntroductionRequestAt?: any;
  introductionConflicts?: IntroductionConflict[] | null;
  introductionStaleAfterDays?: number | null;
  introductionMutualContext?: string | null;
  introductionSignalsUpdatedAt?: any;
  lifecycleStatus?: string | null;
  mergedIntoContactId?: string | null;
};

type OutreachRecord = {
  id: string;
  contactId?: string | null;
  status?: string | null;
  responseReceived?: string | null;
  meetingHeld?: boolean | null;
  referralGenerated?: boolean | null;
  nextFollowUpDate?: any;
  sentAt?: any;
  updatedAt?: any;
  aiSummary?: string | null;
};

type NoteRecord = {
  id: string;
  contactId?: string | null;
  content?: string | null;
  createdAt?: any;
};

type ConnectionRecord = {
  id: string;
  sourceId: string;
  targetId: string;
  type?: string | null;
  inferred?: boolean | null;
  weight?: number | null;
  strength?: number | null;
  direction?: 'directed' | 'mutual' | null;
  willingness?: string | null;
  lastInteractionAt?: any;
  activeIntroductionRequests?: number | null;
  introductionCapacity?: number | null;
  introductionRequestsLast90Days?: number | null;
  lastIntroductionRequestAt?: any;
  staleAfterDays?: number | null;
  conflicts?: IntroductionConflict[] | null;
  mutualContext?: {
    text?: string | null;
    sourceType?: IntroductionEdgeProvenance['sourceType'] | null;
    sourceId?: string | null;
  } | null;
  provenance?: {
    sourceType?: IntroductionEdgeProvenance['sourceType'] | null;
    sourceId?: string | null;
    observedAt?: any;
  } | null;
  createdAt?: any;
  updatedAt?: any;
  mergeHistorical?: boolean | null;
  mergeSuppressed?: boolean | null;
};

type IntroductionEvidenceGap = {
  id: string;
  label: string;
  detail: string;
  targetId?: string;
};

type IntroductionEdgeEvidence = {
  edgeId: string;
  fromId: string;
  toId: string;
  relation: string;
  strengthLabel: string;
  lastInteractionAt: Date;
  strengthKnown: boolean;
  freshnessKnown: boolean;
  willingnessKnown: boolean;
  loadKnown: boolean;
  fatigueKnown: boolean;
  directionKnown: boolean;
};

type IntroductionEvidenceModel = {
  edges: IntroductionRelationshipEdge[];
  evidenceByEdgeId: Record<string, IntroductionEdgeEvidence>;
  gaps: IntroductionEvidenceGap[];
};

type ContactInsight = {
  score: number;
  radius: number;
  lastTouch: Date | null;
  lastTouchDays: number;
  responseRate: number;
  outreachCount: number;
  notesCount: number;
  recentPulse: boolean;
  seniorityBucket: string;
  locationBucket: string;
  hasReferral: boolean;
  /** From the shared scorer — the graph does not compute these itself. */
  pinned: boolean;
  neverContacted: boolean;
  /** The explanation minus its leading score, since the panel shows /100. */
  healthDetail: string;
};

type GraphNodeDatum = {
  id: string;
  kind: 'me' | 'industry' | 'contact' | 'gap';
  name: string;
  subtitle?: string;
  color: string;
  ringColor: string;
  radius: number;
  dashedRing?: boolean;
  industryKey?: string;
  tier?: Tier;
  score: number;
  lastTouchDays: number;
  initials: string;
  targetX: number;
  targetY: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
  contact?: ContactRecord;
  matchesSearch?: boolean;
  matchesFocus?: boolean;
};

type GraphLinkDatum = {
  id: string;
  source: string | GraphNodeDatum;
  target: string | GraphNodeDatum;
  kind: 'backbone' | 'membership' | 'explicit';
  relation: string;
  weight: number;
};

type ClusterStat = {
  key: string;
  label: string;
  count: number;
  responseRate: number;
  staleCount: number;
  averageStrength: number;
};

type GapItem = {
  id: string;
  title: string;
  detail: string;
  action: string;
  industryKey?: string;
};

type AlertItem = {
  id: string;
  title: string;
  detail: string;
  tone: 'amber' | 'green' | 'violet';
};

type GraphAnalysis = {
  nodes: GraphNodeDatum[];
  links: GraphLinkDatum[];
  nodeById: Record<string, GraphNodeDatum>;
  insights: Record<string, ContactInsight>;
  adjacency: Record<string, { to: string; linkId: string }[]>;
  clusterStats: ClusterStat[];
  gapItems: GapItem[];
  alerts: AlertItem[];
  inferredNeighbors: Record<string, string[]>;
  networkScore: number;
  activeCount: number;
  staleCount: number;
  overallResponseRate: number;
};

const INDUSTRY_ORDER = ['banking', 'consulting', 'pe', 'vc', 'hedge', 'healthcare', 'tech', 'other'];
const INDUSTRY_COLORS: Record<string, { label: string; color: string }> = {
  banking: { label: 'Investment Banking', color: '#56606A' },
  consulting: { label: 'Consulting', color: '#746B60' },
  pe: { label: 'Private Equity', color: '#66715F' },
  vc: { label: 'Venture Capital', color: '#9A7447' },
  hedge: { label: 'Hedge Fund', color: '#7D5B52' },
  healthcare: { label: 'Healthcare', color: '#617672' },
  tech: { label: 'Tech', color: '#6A6473' },
  other: { label: 'Other', color: '#8B877D' }
};

const INDUSTRY_SHORT_LABELS: Record<string, string> = {
  banking: 'IB',
  consulting: 'CO',
  pe: 'PE',
  vc: 'VC',
  hedge: 'HF',
  healthcare: 'HC',
  tech: 'TC',
  other: 'OT'
};
function lower(value?: string | null) {
  return (value || '').trim().toLowerCase();
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') return value.toDate();
  const next = new Date(value);
  return Number.isNaN(next.getTime()) ? null : next;
}

function daysSince(date: Date | null) {
  if (!date) return 999;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24)));
}

function getTier(value?: string | null): Tier {
  if (value === 'Strong' || value === 'Warm' || value === 'Dormant') return value;
  return 'Cold';
}

function getInitials(name: string) {
  const parts = name.split(' ').filter(Boolean);
  return parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('') || '?';
}

function hashSeed(input: string) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) % 1000000;
  }
  return hash;
}

function getIndustryKey(value?: string | null) {
  const text = lower(value);
  if (text.includes('bank')) return 'banking';
  if (text.includes('consult')) return 'consulting';
  if (text.includes('private equity') || text === 'pe') return 'pe';
  if (text.includes('venture') || text === 'vc') return 'vc';
  if (text.includes('hedge')) return 'hedge';
  if (text.includes('health')) return 'healthcare';
  if (text.includes('tech') || text.includes('software') || text.includes('engineering') || text.includes('product')) return 'tech';
  return 'other';
}

function getSeniorityBucket(contact: ContactRecord) {
  const text = lower(contact.seniority || contact.role);
  if (!text) return 'Unknown';
  if (
    text.includes('partner') ||
    text.includes('principal') ||
    text.includes('vice president') ||
    text.includes('vp') ||
    text.includes('director') ||
    text.includes('managing director')
  ) {
    return 'VP+';
  }
  if (text.includes('associate') || text.includes('manager') || text.includes('consultant')) {
    return 'Associate / Manager';
  }
  if (text.includes('analyst') || text.includes('intern')) {
    return 'Analyst';
  }
  return 'Mid-Level';
}

function getLocationBucket(location?: string | null) {
  const text = lower(location);
  if (!text) return 'Unknown';
  if (text.includes('new york') || text.includes('nyc') || text.includes('brooklyn')) return 'New York';
  if (text.includes('san francisco') || text.includes('palo alto') || text.includes('bay area')) return 'Bay Area';
  if (text.includes('chicago')) return 'Chicago';
  if (text.includes('boston') || text.includes('cambridge')) return 'Boston';
  if (text.includes('los angeles')) return 'Los Angeles';
  if (text.includes('michigan') || text.includes('ann arbor') || text.includes('midwest') || text.includes('detroit')) return 'Midwest';
  if (text.includes('seattle')) return 'Seattle';
  return 'Global';
}

function tintHex(hex: string, mix = 0.84) {
  const safeHex = hex.replace('#', '');
  const value = safeHex.length === 3
    ? safeHex.split('').map((character) => character + character).join('')
    : safeHex;
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  const next = (channel: number) => Math.round(channel * (1 - mix) + 245 * mix);
  return `rgb(${next(red)}, ${next(green)}, ${next(blue)})`;
}

function getSignalColor(score: number) {
  if (score >= 75) return '#171717';
  if (score >= 55) return '#4C6A69';
  if (score >= 35) return '#8B877D';
  return '#8B877D';
}

function getContactVisual(insight: ContactInsight, detailMode: boolean) {
  if (!detailMode) {
    return {
      color: '#E9E4DB',
      ringColor: 'rgba(26,26,26,0.34)',
      radius: 14,
      dashedRing: false
    };
  }

  const signalColor = getSignalColor(insight.score);
  if (insight.score >= 75) {
    return {
      color: tintHex(signalColor, 0.72),
      ringColor: signalColor,
      radius: 22,
      dashedRing: false
    };
  }
  if (insight.score >= 55) {
    return {
      color: tintHex(signalColor, 0.8),
      ringColor: signalColor,
      radius: 17,
      dashedRing: false
    };
  }
  return {
    color: tintHex(signalColor, 0.88),
    ringColor: signalColor,
    radius: 13,
    dashedRing: false
  };
}

function formatDays(days: number) {
  if (days >= 999) return 'Never touched';
  if (days === 0) return 'Touched today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

const INTRODUCTION_WILLINGNESS = new Set<IntroductionWillingness>([
  'yes',
  'likely',
  'unknown',
  'reluctant',
  'no'
]);

function normalizeIntroductionWillingness(value: unknown): {
  value: IntroductionWillingness;
  recorded: boolean;
} {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (INTRODUCTION_WILLINGNESS.has(normalized as IntroductionWillingness)) {
    return {
      value: normalized as IntroductionWillingness,
      recorded: true
    };
  }
  return { value: 'unknown', recorded: false };
}

function finiteNumber(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && !value.trim())
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIntroductionConflicts(value: unknown): IntroductionConflict[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Partial<IntroductionConflict>;
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    const severity = candidate.severity === 'block' || candidate.severity === 'warning'
      ? candidate.severity
      : null;
    if (!label || !severity) return [];
    return [{
      id: typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id.trim()
        : `conflict-${index}`,
      label,
      severity
    }];
  });
}

function isIntroductionProvenanceSourceType(
  value: unknown
): value is IntroductionEdgeProvenance['sourceType'] {
  return (
    value === 'profile' ||
    value === 'note' ||
    value === 'meeting' ||
    value === 'outreach' ||
    value === 'user-correction' ||
    value === 'system'
  );
}

function normalizeProvenanceSourceType(
  value: unknown
): IntroductionEdgeProvenance['sourceType'] {
  return isIntroductionProvenanceSourceType(value) ? value : 'system';
}

function newestUserRelationshipEvidence(params: {
  contact: ContactRecord;
  notes: NoteRecord[];
  outreaches: OutreachRecord[];
}): IntroductionEdgeProvenance | null {
  const candidates: IntroductionEdgeProvenance[] = [];
  const lastContactedAt = toDate(params.contact.lastContactedAt);
  if (lastContactedAt) {
    candidates.push({
      sourceType: 'profile',
      sourceId: `${params.contact.id}:lastContactedAt`,
      observedAt: lastContactedAt
    });
  }

  params.notes.forEach((note) => {
    if (note.contactId !== params.contact.id) return;
    const observedAt = toDate(note.createdAt);
    if (!observedAt) return;
    candidates.push({
      sourceType: 'note',
      sourceId: note.id,
      observedAt
    });
  });

  params.outreaches.forEach((outreach) => {
    if (outreach.contactId !== params.contact.id) return;
    const observedAt = toDate(outreach.sentAt);
    if (!observedAt) return;
    candidates.push({
      sourceType: 'outreach',
      sourceId: outreach.id,
      observedAt
    });
  });

  return candidates.sort((left, right) => {
    const leftAt = toDate(left.observedAt)?.getTime() || 0;
    const rightAt = toDate(right.observedAt)?.getTime() || 0;
    return rightAt - leftAt;
  })[0] || null;
}

function buildIntroductionEvidenceModel(params: {
  contacts: ContactRecord[];
  notes: NoteRecord[];
  outreaches: OutreachRecord[];
  connections: ConnectionRecord[];
  insights: Record<string, ContactInsight>;
}): IntroductionEvidenceModel {
  const contactById = new Map(params.contacts.map((contact) => [contact.id, contact]));
  const edges: IntroductionRelationshipEdge[] = [];
  const evidenceByEdgeId: Record<string, IntroductionEdgeEvidence> = {};
  const gaps: IntroductionEvidenceGap[] = [];

  const addEdge = (
    edge: IntroductionRelationshipEdge,
    evidence: Omit<IntroductionEdgeEvidence, 'edgeId' | 'fromId' | 'toId'>
  ) => {
    edges.push(edge);
    evidenceByEdgeId[edge.id] = {
      edgeId: edge.id,
      fromId: edge.fromId,
      toId: edge.toId,
      ...evidence
    };
  };

  params.contacts.forEach((contact) => {
    const relationshipEvidence = newestUserRelationshipEvidence({
      contact,
      notes: params.notes,
      outreaches: params.outreaches
    });
    if (!relationshipEvidence) {
      gaps.push({
        id: `relationship-date:${contact.id}`,
        label: `You → ${contact.name}`,
        detail: 'No dated note, sent outreach, or last-contacted field is available, so this relationship cannot anchor a warm path.',
        targetId: contact.id
      });
      return;
    }

    const insight = params.insights[contact.id];
    if (!insight) return;
    const willingness = normalizeIntroductionWillingness(contact.introductionWillingness);
    const activeRequests = finiteNumber(contact.activeIntroductionRequests);
    const capacity = finiteNumber(contact.introductionCapacity);
    const loadKnown = activeRequests !== null && capacity !== null && capacity > 0;
    const recentRequests = finiteNumber(contact.introductionRequestsLast90Days);
    const fatigueKnown = recentRequests !== null;
    const lastIntroductionRequestAt = toDate(contact.lastIntroductionRequestAt);
    const lastInteractionAt = toDate(relationshipEvidence.observedAt) as Date;
    const edgeId = `relationship:me:${contact.id}`;
    const directContext =
      typeof contact.introductionMutualContext === 'string'
        ? contact.introductionMutualContext.trim().slice(0, 500)
        : '';

    addEdge(
      {
        id: edgeId,
        fromId: 'me',
        toId: contact.id,
        direction: 'directed',
        strength: clamp(insight.score / 100, 0, 1),
        willingness: willingness.value,
        lastInteractionAt,
        // Unknown operational dimensions are scored conservatively. The UI
        // labels them unknown and never displays these sentinels as facts.
        activeIntroductionRequests: loadKnown ? Math.max(0, activeRequests) : 1,
        introductionCapacity: loadKnown ? Math.max(1, capacity) : 1,
        introductionRequestsLast90Days: fatigueKnown
          ? Math.max(0, recentRequests)
          : 5,
        lastIntroductionRequestAt,
        conflicts: normalizeIntroductionConflicts(contact.introductionConflicts),
        mutualContext: directContext
          ? {
              text: directContext,
              sourceType: 'user-correction',
              sourceId: `contact:${contact.id}:introduction-context`,
            }
          : null,
        staleAfterDays: finiteNumber(contact.introductionStaleAfterDays) || undefined,
        provenance: relationshipEvidence
      },
      {
        relation: 'Your recorded relationship',
        strengthLabel: `CRM relationship signal ${Math.round(insight.score)}/100`,
        lastInteractionAt,
        strengthKnown: true,
        freshnessKnown: true,
        willingnessKnown: willingness.recorded,
        loadKnown,
        fatigueKnown,
        directionKnown: true
      }
    );
  });

  params.connections.forEach((connection) => {
    const source = contactById.get(connection.sourceId);
    const target = contactById.get(connection.targetId);
    const gapTargetId = target?.id || connection.targetId;
    const label = `${source?.name || connection.sourceId} → ${target?.name || connection.targetId}`;

    if (connection.inferred === true) {
      gaps.push({
        id: `inferred:${connection.id}`,
        label,
        detail: 'This edge is marked inferred, so it remains visible as graph context but is never used for an introduction path.',
        targetId: gapTargetId
      });
      return;
    }
    if (!source || !target || source.id === target.id) {
      gaps.push({
        id: `endpoint:${connection.id}`,
        label,
        detail: 'The recorded connection does not resolve to two current contact records.',
        targetId: gapTargetId
      });
      return;
    }

    const rawStrength = finiteNumber(connection.strength);
    const graphWeight = finiteNumber(connection.weight);
    let strength: number | null = null;
    let strengthLabel = '';
    if (rawStrength !== null) {
      strength = clamp(rawStrength, 0, 1);
      strengthLabel = `Recorded relationship strength ${Math.round(strength * 100)}%`;
    } else if (graphWeight !== null && graphWeight > 0) {
      strength = graphWeight <= 1
        ? clamp(graphWeight, 0, 1)
        : clamp(graphWeight / 3.4, 0, 1);
      strengthLabel = `Recorded graph weight ${graphWeight.toFixed(1)} (normalized for ranking)`;
    }

    const strengthKnown = strength !== null;
    const recordedLastInteractionAt = toDate(connection.lastInteractionAt);
    const freshnessKnown = Boolean(recordedLastInteractionAt);
    const observedAt =
      toDate(connection.provenance?.observedAt) ||
      toDate(connection.updatedAt) ||
      toDate(connection.createdAt) ||
      recordedLastInteractionAt;
    if (!observedAt) {
      gaps.push({
        id: `provenance-date:${connection.id}`,
        label,
        detail: 'The connection has no dated provenance, so it cannot enter an evidence-backed path.',
        targetId: target.id
      });
      return;
    }
    const lastInteractionAt = recordedLastInteractionAt || new Date(0);
    const rankedStrength = strength ?? 0;
    if (!strengthKnown) strengthLabel = 'Unknown — not recorded';

    const willingness = normalizeIntroductionWillingness(connection.willingness);
    const activeRequests = finiteNumber(connection.activeIntroductionRequests);
    const capacity = finiteNumber(connection.introductionCapacity);
    const loadKnown = activeRequests !== null && capacity !== null && capacity > 0;
    const recentRequests = finiteNumber(connection.introductionRequestsLast90Days);
    const fatigueKnown = recentRequests !== null;
    const sourceId =
      typeof connection.provenance?.sourceId === 'string' &&
      connection.provenance.sourceId.trim()
        ? connection.provenance.sourceId.trim()
        : connection.id;
    const contextText =
      typeof connection.mutualContext?.text === 'string'
        ? connection.mutualContext.text.trim()
        : '';
    const contextSourceId =
      typeof connection.mutualContext?.sourceId === 'string'
        ? connection.mutualContext.sourceId.trim()
        : '';
    const contextSourceType = connection.mutualContext?.sourceType;
    const mutualContext =
      contextText &&
      contextSourceId &&
      isIntroductionProvenanceSourceType(contextSourceType)
        ? {
            text: contextText,
            sourceType: contextSourceType,
            sourceId: contextSourceId
          }
        : null;
    if (contextText && !mutualContext) {
      gaps.push({
        id: `context-provenance:${connection.id}`,
        label,
        detail: 'Mutual context exists but has no complete source type and source ID, so it is omitted from the narrative.',
        targetId: target.id
      });
    }

    const directionKnown =
      connection.direction === 'directed' || connection.direction === 'mutual';
    addEdge(
      {
        id: `connection:${connection.id}`,
        fromId: source.id,
        toId: target.id,
        direction: directionKnown ? connection.direction as 'directed' | 'mutual' : 'mutual',
        strength: rankedStrength,
        willingness: willingness.value,
        lastInteractionAt,
        activeIntroductionRequests: loadKnown ? Math.max(0, activeRequests) : 1,
        introductionCapacity: loadKnown ? Math.max(1, capacity) : 1,
        introductionRequestsLast90Days: fatigueKnown
          ? Math.max(0, recentRequests)
          : 5,
        lastIntroductionRequestAt: toDate(connection.lastIntroductionRequestAt),
        conflicts: normalizeIntroductionConflicts(connection.conflicts),
        mutualContext,
        staleAfterDays: finiteNumber(connection.staleAfterDays) || undefined,
        provenance: {
          sourceType: normalizeProvenanceSourceType(connection.provenance?.sourceType),
          sourceId,
          observedAt
        }
      },
      {
        relation: connection.type?.trim() || 'Recorded connection',
        strengthLabel,
        lastInteractionAt,
        strengthKnown,
        freshnessKnown,
        willingnessKnown: willingness.recorded,
        loadKnown,
        fatigueKnown,
        directionKnown
      }
    );
  });

  params.contacts.forEach((contact) => {
    const sourceName = contact.connectionSource?.trim();
    if (!sourceName) return;
    const matchingSources = params.contacts.filter(
      (candidate) => lower(candidate.name) === lower(sourceName)
    );
    if (matchingSources.length > 1) {
      gaps.push({
        id: `ambiguous-source:${contact.id}`,
        label: `${sourceName} → ${contact.name}`,
        detail: 'More than one contact has this introducer name, so Cirqle will not guess which record forms the edge.',
        targetId: contact.id
      });
      return;
    }
    const source = matchingSources[0];
    if (!source || source.id === contact.id) return;
    const coveredByConnection = params.connections.some((connection) => {
      const endpoints = new Set([connection.sourceId, connection.targetId]);
      return endpoints.has(source.id) && endpoints.has(contact.id);
    });
    if (coveredByConnection) return;
    const observedAt =
      toDate(contact.createdAt) ||
      toDate(contact.updatedAt) ||
      toDate(
        newestUserRelationshipEvidence({
          contact,
          notes: params.notes,
          outreaches: params.outreaches
        })?.observedAt
      );
    if (!observedAt) {
      gaps.push({
        id: `manual-source:${source.id}:${contact.id}`,
        label: `${source.name} → ${contact.name}`,
        detail: 'The introducer name is recorded, but its profile evidence has no date, so the edge is not ranked.',
        targetId: contact.id
      });
      return;
    }
    const edgeId = `manual-source:${source.id}:${contact.id}`;
    addEdge(
      {
        id: edgeId,
        fromId: source.id,
        toId: contact.id,
        direction: 'directed',
        // The edge itself is explicit. Missing scoring dimensions use
        // conservative sentinels internally and remain labelled unknown.
        strength: 0,
        willingness: 'unknown',
        lastInteractionAt: new Date(0),
        activeIntroductionRequests: 1,
        introductionCapacity: 1,
        introductionRequestsLast90Days: 5,
        provenance: {
          sourceType: 'profile',
          sourceId: `${contact.id}:connectionSource`,
          observedAt
        }
      },
      {
        relation: 'Recorded introducer link',
        strengthLabel: 'Unknown — not recorded',
        lastInteractionAt: new Date(0),
        strengthKnown: false,
        freshnessKnown: false,
        willingnessKnown: false,
        loadKnown: false,
        fatigueKnown: false,
        directionKnown: true
      }
    );
  });

  return { edges, evidenceByEdgeId, gaps };
}

function formatIntroductionDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(value);
}

function createRadialAnchorForce(strength = 0.055) {
  let nodes: GraphNodeDatum[] = [];

  const force = (alpha: number) => {
    nodes.forEach((node) => {
      if (node.kind === 'me' || node.x === undefined || node.y === undefined) return;
      const pull = node.kind === 'industry' ? strength : strength * 0.7;
      node.vx = (node.vx || 0) + (node.targetX - node.x) * pull * alpha;
      node.vy = (node.vy || 0) + (node.targetY - node.y) * pull * alpha;
    });
  };

  force.initialize = (nextNodes: GraphNodeDatum[]) => {
    nodes = nextNodes;
  };

  return force;
}

function buildAnalysis(params: {
  profile: any;
  contacts: ContactRecord[];
  outreaches: OutreachRecord[];
  notes: NoteRecord[];
  connections: ConnectionRecord[];
  searchText: string;
  focusIndustry: string | null;
  detailMode: boolean;
}): GraphAnalysis {
  const { profile, contacts, outreaches, notes, connections, searchText, focusIndustry, detailMode } = params;
  const normalizedSearch = lower(searchText);

  const notesByContact: Record<string, NoteRecord[]> = {};
  const outreachByContact: Record<string, OutreachRecord[]> = {};

  notes.forEach((note) => {
    const contactId = note.contactId || '';
    notesByContact[contactId] = [...(notesByContact[contactId] || []), note];
  });

  outreaches.forEach((outreach) => {
    const contactId = outreach.contactId || '';
    outreachByContact[contactId] = [...(outreachByContact[contactId] || []), outreach];
  });

  const insights: Record<string, ContactInsight> = {};

  contacts.forEach((contact) => {
    const contactNotes = notesByContact[contact.id] || [];
    const contactOutreaches = outreachByContact[contact.id] || [];
    const lastTouch = [
      toDate(contact.lastContactedAt),
      toDate(contact.updatedAt),
      ...contactNotes.map((note) => toDate(note.createdAt)),
      ...contactOutreaches.map((outreach) => toDate(outreach.sentAt) || toDate(outreach.updatedAt))
    ]
      .filter(Boolean)
      .sort((left, right) => (right as Date).getTime() - (left as Date).getTime())[0] as Date | null;

    const responseCount = contactOutreaches.filter((outreach) => lower(outreach.responseReceived) === 'yes').length;
    const referralCount = contactOutreaches.filter((outreach) => outreach.referralGenerated).length;
    const responseRate = contactOutreaches.length > 0 ? responseCount / contactOutreaches.length : 0;

    // Scoring is delegated to lib/health.ts — the single implementation. This
    // block used to carry its own copy of the same arithmetic, which is fine
    // until the two drift and one contact reads 72 on the graph and 58 on
    // their record.
    //
    // Two behaviour changes come with the switch, both deliberate:
    //
    // 1. `contact.updatedAt` is no longer treated as a "touch". The graph used
    //    to count it, so renaming a contact or fixing a typo in their company
    //    reset their decay clock — an edit is not a conversation. The shared
    //    scorer only counts real signals: lastContactedAt, capturedAt, notes
    //    and outreach. Expect recently-edited contacts to score lower here
    //    than they did, which is the correct number, not a regression.
    // 2. Pinned contacts stop decaying on the graph too, which is the whole
    //    point of pinning and previously applied only on Contact Detail.
    const health = computeHealth({
      contact,
      notes: contactNotes,
      outreaches: contactOutreaches,
    });

    insights[contact.id] = {
      score: health.score,
      radius: clamp(9 + health.score * 0.14, 10, 24),
      // The shared scorer reports "never contacted" as a large sentinel; the
      // graph wants the real last-touch date it already computed for display.
      lastTouch,
      lastTouchDays: health.lastTouchDays,
      responseRate,
      outreachCount: contactOutreaches.length,
      notesCount: contactNotes.length,
      recentPulse: health.lastTouchDays <= 7,
      seniorityBucket: getSeniorityBucket(contact),
      locationBucket: getLocationBucket(contact.location),
      hasReferral: referralCount > 0,
      pinned: health.pinned,
      neverContacted: health.neverContacted,
      healthDetail: health.detail,
    };
  });

  const meNode: GraphNodeDatum = {
    id: 'me',
    kind: 'me',
    name: profile?.name || 'You',
    subtitle: `${profile?.role || 'Network owner'}${profile?.company ? ` | ${profile.company}` : ''}`,
    color: '#1A1A1A',
    ringColor: '#8C7A65',
    radius: 28,
    score: 100,
    lastTouchDays: 0,
    initials: profile?.name ? getInitials(profile.name) : '◎',
    targetX: 0,
    targetY: 0,
    fx: 0,
    fy: 0,
    matchesSearch: true,
    matchesFocus: true
  };

  const contactsByIndustry = INDUSTRY_ORDER.reduce<Record<string, ContactRecord[]>>((result, industryKey) => {
    result[industryKey] = contacts.filter((contact) => getIndustryKey(contact.industry) === industryKey);
    return result;
  }, {});

  const nodes: GraphNodeDatum[] = [meNode];
  const nodeById: Record<string, GraphNodeDatum> = { me: meNode };
  const industryNodeIds: Record<string, string> = {};

  INDUSTRY_ORDER.forEach((industryKey, index) => {
    const clusterContacts = contactsByIndustry[industryKey];
    if (!clusterContacts || clusterContacts.length === 0) return;

    const angle = (index / INDUSTRY_ORDER.length) * Math.PI * 2 - Math.PI / 2;
    const targetX = Math.cos(angle) * 185;
    const targetY = Math.sin(angle) * 150;

    const industryNodeId = `industry:${industryKey}`;
    industryNodeIds[industryKey] = industryNodeId;

    const industryNode: GraphNodeDatum = {
      id: industryNodeId,
      kind: 'industry',
      name: INDUSTRY_COLORS[industryKey].label,
      subtitle: `${clusterContacts.length} contact${clusterContacts.length === 1 ? '' : 's'}`,
      color: INDUSTRY_COLORS[industryKey].color,
      ringColor: 'rgba(26,26,26,0.22)',
      radius: clamp(18 + clusterContacts.length * 1.4, 22, 34),
      industryKey,
      score: 100,
      lastTouchDays: 0,
      initials: INDUSTRY_SHORT_LABELS[industryKey] || getInitials(INDUSTRY_COLORS[industryKey].label),
      targetX,
      targetY,
      x: targetX,
      y: targetY,
      matchesSearch: true,
      matchesFocus: !focusIndustry || focusIndustry === industryKey
    };

    nodes.push(industryNode);
    nodeById[industryNode.id] = industryNode;
  });

  const clusterOffsets = new Map<string, number>();

  contacts
    .slice()
    .sort((left, right) => insights[right.id].score - insights[left.id].score)
    .forEach((contact) => {
      const insight = insights[contact.id];
      const industryKey = getIndustryKey(contact.industry);
      const tier = getTier(contact.relationshipTier);
      const offsetIndex = clusterOffsets.get(industryKey) || 0;
      clusterOffsets.set(industryKey, offsetIndex + 1);

      const industryIndex = INDUSTRY_ORDER.indexOf(industryKey);
      const angle = (industryIndex / INDUSTRY_ORDER.length) * Math.PI * 2 - Math.PI / 2;
      const seed = hashSeed(contact.id);
      const orbitAngle = angle + offsetIndex * 0.42 + (seed % 17) * 0.03;
      const hubNode = nodeById[industryNodeIds[industryKey]];
      const hubX = hubNode?.targetX || 0;
      const hubY = hubNode?.targetY || 0;
      const jitterX = ((seed % 7) - 3) * 9;
      const jitterY = ((Math.floor(seed / 7) % 7) - 3) * 9;
      const ringRadius = tier === 'Strong' ? 52 : tier === 'Warm' ? 78 : tier === 'Cold' ? 102 : 126;
      const targetX = hubX + Math.cos(orbitAngle) * ringRadius + jitterX;
      const targetY = hubY + Math.sin(orbitAngle) * ringRadius + jitterY;

      const matchesSearch = !normalizedSearch || [
        contact.name,
        contact.company,
        contact.industry,
        contact.location,
        contact.school,
        ...(contact.tags || [])
      ].some((value) => lower(value).includes(normalizedSearch));

      const matchesFocus = !focusIndustry || focusIndustry === industryKey;
      const visual = getContactVisual(insight, detailMode);

      const node: GraphNodeDatum = {
        id: contact.id,
        kind: 'contact',
        name: contact.name,
        subtitle: `${contact.role || 'Contact'}${contact.company ? ` | ${contact.company}` : ''}`,
        color: visual.color,
        ringColor: visual.ringColor,
        radius: visual.radius,
        dashedRing: visual.dashedRing,
        industryKey,
        tier,
        score: insight.score,
        lastTouchDays: insight.lastTouchDays,
        initials: getInitials(contact.name),
        targetX,
        targetY,
        x: targetX,
        y: targetY,
        contact,
        matchesSearch,
        matchesFocus
      };

      nodes.push(node);
      nodeById[node.id] = node;
    });

  const links: GraphLinkDatum[] = [];
  const inferredNeighbors: Record<string, Set<string>> = {};
  const seenLinks = new Set<string>();

  function pushLink(sourceId: string, targetId: string, kind: GraphLinkDatum['kind'], relation: string, weight: number) {
    if (!nodeById[sourceId] || !nodeById[targetId]) return;
    const ordered = [sourceId, targetId].sort();
    const key = `${kind}:${ordered[0]}:${ordered[1]}:${relation}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    links.push({ id: key, source: sourceId, target: targetId, kind, relation, weight });
    inferredNeighbors[sourceId] = inferredNeighbors[sourceId] || new Set();
    inferredNeighbors[targetId] = inferredNeighbors[targetId] || new Set();
    inferredNeighbors[sourceId].add(targetId);
    inferredNeighbors[targetId].add(sourceId);
  }

  Object.entries(industryNodeIds).forEach(([industryKey, industryNodeId]) => {
    const contactCount = contactsByIndustry[industryKey]?.length || 0;
    pushLink('me', industryNodeId, 'backbone', 'industry lane', clamp(2 + contactCount * 0.12, 2.2, 4.4));
  });

  contacts.forEach((contact) => {
    const industryKey = getIndustryKey(contact.industry);
    const industryNodeId = industryNodeIds[industryKey];
    if (!industryNodeId) return;
    pushLink(industryNodeId, contact.id, 'membership', 'industry contact', clamp(insights[contact.id].score / 36, 1.2, 2.8));
  });

  contacts.forEach((contact) => {
    if (!contact.connectionSource) return;
    const target = contacts.find((candidate) => lower(candidate.name) === lower(contact.connectionSource));
    if (!target || target.id === contact.id) return;
    pushLink(contact.id, target.id, 'explicit', 'manual connection', 2.3);
    inferredNeighbors[contact.id] = inferredNeighbors[contact.id] || new Set();
    inferredNeighbors[target.id] = inferredNeighbors[target.id] || new Set();
    inferredNeighbors[contact.id].add(target.id);
    inferredNeighbors[target.id].add(contact.id);
  });

  connections.forEach((connection) => {
    pushLink(connection.sourceId, connection.targetId, 'explicit', connection.type || 'manual connection', clamp(connection.weight || 2, 1.2, 3.4));
    inferredNeighbors[connection.sourceId] = inferredNeighbors[connection.sourceId] || new Set();
    inferredNeighbors[connection.targetId] = inferredNeighbors[connection.targetId] || new Set();
    inferredNeighbors[connection.sourceId].add(connection.targetId);
    inferredNeighbors[connection.targetId].add(connection.sourceId);
  });

  for (let leftIndex = 0; leftIndex < contacts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < contacts.length; rightIndex += 1) {
      const left = contacts[leftIndex];
      const right = contacts[rightIndex];
      let score = 0;
      let relation = 'shared signal';

      if (lower(left.company) && lower(left.company) === lower(right.company)) {
        score += 4.5;
        relation = 'same firm';
      }

      if (lower(left.school) && lower(left.school) === lower(right.school)) {
        score += 3.5;
        relation = relation === 'shared signal' ? 'same school' : relation;
      }

      if (getIndustryKey(left.industry) === getIndustryKey(right.industry)) {
        score += 1.5;
        relation = relation === 'shared signal' ? 'same industry' : relation;
      }

      if (getLocationBucket(left.location) === getLocationBucket(right.location) && getLocationBucket(left.location) !== 'Unknown') {
        score += 1.2;
      }

      if (score >= 4.2) {
        inferredNeighbors[left.id] = inferredNeighbors[left.id] || new Set();
        inferredNeighbors[right.id] = inferredNeighbors[right.id] || new Set();
        inferredNeighbors[left.id].add(right.id);
        inferredNeighbors[right.id].add(left.id);
      }
    }
  }

  const adjacency: Record<string, { to: string; linkId: string }[]> = {};
  links.forEach((link) => {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    adjacency[sourceId] = [...(adjacency[sourceId] || []), { to: targetId, linkId: link.id }];
    adjacency[targetId] = [...(adjacency[targetId] || []), { to: sourceId, linkId: link.id }];
  });

  const clusterStats = INDUSTRY_ORDER
    .map((industryKey) => {
      const clusterContacts = contacts.filter((contact) => getIndustryKey(contact.industry) === industryKey);
      if (clusterContacts.length === 0) return null;
      const averageStrength = clusterContacts.reduce((sum, contact) => sum + insights[contact.id].score, 0) / clusterContacts.length;
      const responseRate = clusterContacts.reduce((sum, contact) => sum + insights[contact.id].responseRate, 0) / clusterContacts.length;
      const staleCount = clusterContacts.filter((contact) => insights[contact.id].lastTouchDays > 60).length;
      return {
        key: industryKey,
        label: INDUSTRY_COLORS[industryKey].label,
        count: clusterContacts.length,
        responseRate,
        staleCount,
        averageStrength
      } satisfies ClusterStat;
    })
    .filter(Boolean) as ClusterStat[];

  const gapItems: GapItem[] = [];
  INDUSTRY_ORDER.forEach((industryKey) => {
    const count = clusterStats.find((item) => item.key === industryKey)?.count || 0;
    if (count < 3) {
      gapItems.push({
        id: `gap-${industryKey}`,
        title: `${INDUSTRY_COLORS[industryKey].label} coverage is thin`,
        detail: count === 0
          ? `You have no visible contacts in ${INDUSTRY_COLORS[industryKey].label}.`
          : `You only have ${count} contact${count === 1 ? '' : 's'} in ${INDUSTRY_COLORS[industryKey].label}.`,
        action: 'Use a warm node in an adjacent cluster to open the lane.',
        industryKey
      });
    }
  });

  const vpCount = contacts.filter((contact) => insights[contact.id].seniorityBucket === 'VP+').length;
  if (vpCount < 3) {
    gapItems.push({
      id: 'gap-seniority',
      title: 'Senior coverage is light',
      detail: `Only ${vpCount} VP+ contact${vpCount === 1 ? '' : 's'} are visible across your graph.`,
      action: 'Push introductions upward from your strongest warm cluster.'
    });
  }

  const activeCount = contacts.filter((contact) => insights[contact.id].lastTouchDays <= 30).length;
  const staleCount = contacts.filter((contact) => insights[contact.id].lastTouchDays > 60).length;
  const totalOutreach = outreaches.length;
  const responseCount = outreaches.filter((outreach) => lower(outreach.responseReceived) === 'yes').length;
  const overallResponseRate = totalOutreach > 0 ? responseCount / totalOutreach : 0;

  const weightedContacts = contacts.reduce((sum, contact) => {
    const tier = getTier(contact.relationshipTier);
    return sum + (tier === 'Strong' ? 12 : tier === 'Warm' ? 9 : tier === 'Dormant' ? 4 : 6);
  }, 0);

  const networkScore = Math.round(
    clamp(
      weightedContacts
        + clusterStats.length * 5
        + (contacts.length > 0 ? (activeCount / contacts.length) * 25 : 0)
        + overallResponseRate * 18
        + Math.min(12, notes.length / Math.max(1, contacts.length) * 6),
      12,
      100
    )
  );

  const alerts: AlertItem[] = [];
  const staleLeader = contacts
    .filter((contact) => insights[contact.id].lastTouchDays > 60)
    .sort((left, right) => insights[right.id].score - insights[left.id].score)[0];
  if (staleLeader) {
    alerts.push({
      id: 'stale',
      title: `${staleLeader.name} is going cold`,
      detail: `${formatDays(insights[staleLeader.id].lastTouchDays)} since your last touch.`,
      tone: 'amber'
    });
  }

  const weeklyResponses = outreaches.filter((outreach) => {
    if (lower(outreach.responseReceived) !== 'yes') return false;
    const updated = toDate(outreach.updatedAt) || toDate(outreach.sentAt);
    return updated && daysSince(updated) <= 7;
  }).length;
  if (weeklyResponses > 0) {
    alerts.push({
      id: 'momentum',
      title: `${weeklyResponses} response${weeklyResponses === 1 ? '' : 's'} this week`,
      detail: 'Your active clusters are warming up. Keep the momentum going.',
      tone: 'green'
    });
  }

  const overdueCount = outreaches.filter((outreach) => {
    const followUp = toDate(outreach.nextFollowUpDate);
    return followUp && followUp.getTime() < Date.now() && lower(outreach.status) !== 'closed';
  }).length;
  if (overdueCount > 0) {
    alerts.push({
      id: 'overdue',
      title: `${overdueCount} follow-up${overdueCount === 1 ? '' : 's'} overdue`,
      detail: 'There is latent value sitting in your tracker right now.',
      tone: 'violet'
    });
  }

  return {
    nodes,
    links,
    nodeById,
    insights,
    adjacency,
    clusterStats,
    gapItems: gapItems.slice(0, 4),
    alerts,
    inferredNeighbors: Object.fromEntries(Object.entries(inferredNeighbors).map(([key, value]) => [key, [...value]])),
    networkScore,
    activeCount,
    staleCount,
    overallResponseRate
  };
}

function toneClasses(tone: AlertItem['tone']) {
  if (tone === 'green') return 'border-[#66715F]/35 bg-[#F0F3EC] text-ink';
  if (tone === 'violet') return 'border-[#6A6473]/30 bg-[#F0EEF3] text-ink';
  return 'border-[#9A7447]/35 bg-[#F7F0E5] text-ink';
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="border border-ink/15 rounded-card bg-white p-5">
      <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-subtle">
        <Icon size={14} />
        {label}
      </div>
      <div className="mb-1 font-serif text-4xl font-black leading-none">{value}</div>
      <p className="font-mono text-xs text-subtle">{detail}</p>
    </div>
  );
}

function IntroductionPathCard({
  path,
  evidenceByEdgeId,
  selected,
  onSelect
}: {
  path: RankedIntroductionPath;
  evidenceByEdgeId: Record<string, IntroductionEdgeEvidence>;
  selected: boolean;
  onSelect: () => void;
}) {
  const limitingIndex = path.edges.findIndex(
    (edge) => edge.id === path.limitingEdgeId
  );
  const limitingLabel = limitingIndex >= 0
    ? `${path.labels[limitingIndex]} → ${path.labels[limitingIndex + 1]}`
    : 'the lowest-scoring recorded edge';
  const unknownCount = path.edges.reduce((count, edge) => {
    const evidence = evidenceByEdgeId[edge.id];
    if (!evidence) return count;
    return count
      + (evidence.strengthKnown ? 0 : 1)
      + (evidence.freshnessKnown ? 0 : 1)
      + (evidence.willingnessKnown ? 0 : 1)
      + (evidence.loadKnown ? 0 : 1)
      + (evidence.fatigueKnown ? 0 : 1)
      + (evidence.directionKnown ? 0 : 1);
  }, 0);

  return (
    <article
      className={`border p-4 transition-colors motion-reduce:transition-none ${
        selected
          ? 'border-[#8C7A65] bg-[#F7F0E5]'
          : 'border-ink/15 bg-white'
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">
              {path.nodeIds.length - 1} hop{path.nodeIds.length === 2 ? '' : 's'}
            </span>
            <span className="border border-ink/15 bg-white px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-subtle">
              {unknownCount > 0
                ? `${unknownCount} unknown signal${unknownCount === 1 ? '' : 's'}`
                : 'Complete operating signals'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" aria-label={`Path: ${path.labels.join(' to ')}`}>
            {path.labels.map((label, index) => (
              <React.Fragment key={`${path.id}:${path.nodeIds[index]}`}>
                {index > 0 && <ArrowRight size={13} className="text-[#8C7A65]" aria-hidden="true" />}
                <span className="font-serif text-lg font-bold">{label}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="shrink-0 text-left sm:text-right">
          <div className="font-serif text-3xl font-black">{path.score.toFixed(1)}</div>
          <div className="font-mono text-[9px] uppercase tracking-widest text-subtle">
            Conservative signal / 100
          </div>
        </div>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-subtle">
        This route uses {path.edges.length} recorded relationship edge{path.edges.length === 1 ? '' : 's'}.
        {' '}Its limiting connection is {limitingLabel}. Unknown introduction-specific signals are penalized
        conservatively and are never treated as zero activity.
      </p>

      <div className="mt-4 space-y-3">
        {path.edges.map((edge, index) => {
          const evidence = evidenceByEdgeId[edge.id];
          const edgeScore = path.edgeScores[index];
          if (!evidence || !edgeScore) return null;
          const activeRequests = Number(edge.activeIntroductionRequests);
          const capacity = Number(edge.introductionCapacity);
          const recentRequests = Number(edge.introductionRequestsLast90Days);
          const lastIntroductionRequestAt = toDate(edge.lastIntroductionRequestAt);
          const lastAskDays = lastIntroductionRequestAt
            ? daysSince(lastIntroductionRequestAt)
            : null;
          const loadWarning =
            evidence.loadKnown && capacity > 0 && activeRequests >= capacity;
          const fatigueWarning =
            evidence.fatigueKnown &&
            (recentRequests >= 3 || (lastAskDays !== null && lastAskDays < 15));
          const conflicts = edge.conflicts || [];
          const warningConflicts = conflicts.filter((conflict) => conflict.severity === 'warning');

          return (
            <div key={edge.id} className="border-l-2 border-[#8C7A65]/50 pl-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold">
                  {path.labels[index]} → {path.labels[index + 1]}
                </div>
                <span className="font-mono text-[9px] uppercase tracking-widest text-subtle">
                  Edge {edgeScore.score.toFixed(1)}/100
                </span>
              </div>
              <div className="mt-2 grid gap-2 text-xs text-subtle sm:grid-cols-2">
                <div>
                  <span className="font-semibold text-ink">Strength:</span> {evidence.strengthLabel}
                </div>
                <div>
                  <span className="font-semibold text-ink">Freshness:</span>{' '}
                  {evidence.freshnessKnown
                    ? `${formatIntroductionDate(evidence.lastInteractionAt)} (${formatDays(Math.floor(edgeScore.ageDays))})`
                    : 'Unknown — no last-interaction date'}
                </div>
                <div>
                  <span className="font-semibold text-ink">Willingness:</span>{' '}
                  {evidence.willingnessKnown
                    ? edge.willingness === 'unknown'
                      ? 'Unknown (recorded)'
                      : edge.willingness
                    : 'Unknown — not recorded'}
                </div>
                <div>
                  <span className="font-semibold text-ink">Introduction load:</span>{' '}
                  {evidence.loadKnown ? `${activeRequests}/${capacity} active` : 'Unknown — not recorded'}
                </div>
                <div>
                  <span className="font-semibold text-ink">Ask fatigue:</span>{' '}
                  {evidence.fatigueKnown
                    ? `${recentRequests} ask${recentRequests === 1 ? '' : 's'} in 90 days${
                        lastIntroductionRequestAt
                          ? `; last asked ${formatIntroductionDate(lastIntroductionRequestAt)}`
                          : '; last-ask date unknown'
                      }`
                    : 'Unknown — not recorded'}
                </div>
                <div>
                  <span className="font-semibold text-ink">Direction:</span>{' '}
                  {evidence.directionKnown
                    ? edge.direction === 'mutual' ? 'Mutual' : 'Recorded direction'
                    : 'Undirected in the current graph schema'}
                </div>
              </div>

              {((edgeScore.stale && evidence.freshnessKnown) ||
                !evidence.strengthKnown ||
                !evidence.freshnessKnown ||
                !evidence.willingnessKnown ||
                !evidence.loadKnown ||
                !evidence.fatigueKnown ||
                !evidence.directionKnown ||
                edge.willingness === 'reluctant' ||
                loadWarning ||
                fatigueWarning ||
                warningConflicts.length > 0) && (
                <ul className="mt-2 space-y-1 text-xs text-[#76562F]">
                  {edgeScore.stale && evidence.freshnessKnown && (
                    <li>Freshness warning: this relationship is beyond its recorded stale threshold.</li>
                  )}
                  {!evidence.strengthKnown && (
                    <li>Relationship strength is unknown and was scored conservatively.</li>
                  )}
                  {!evidence.freshnessKnown && (
                    <li>Relationship freshness is unknown and was scored conservatively.</li>
                  )}
                  {!evidence.willingnessKnown && (
                    <li>Willingness is unknown; confirm before asking for an introduction.</li>
                  )}
                  {edge.willingness === 'reluctant' && (
                    <li>Willingness is recorded as reluctant.</li>
                  )}
                  {!evidence.loadKnown && (
                    <li>Current introduction load is unknown and was scored conservatively.</li>
                  )}
                  {loadWarning && (
                    <li>Load warning: the recorded introduction capacity is currently full.</li>
                  )}
                  {!evidence.fatigueKnown && (
                    <li>Recent ask fatigue is unknown and was scored conservatively.</li>
                  )}
                  {fatigueWarning && (
                    <li>Fatigue warning: recent introduction asks suggest waiting or confirming capacity.</li>
                  )}
                  {!evidence.directionKnown && (
                    <li>Connection direction is not stored; confirm this person can introduce in this direction.</li>
                  )}
                  {warningConflicts.map((conflict) => (
                    <li key={conflict.id}>Conflict warning: {conflict.label}</li>
                  ))}
                </ul>
              )}

              {edge.mutualContext && (
                <div className="mt-2 border border-[#617672]/25 bg-[#F0F3EC] p-2 text-xs leading-relaxed text-ink">
                  <span className="font-semibold">Mutual context:</span> {edge.mutualContext.text}
                  <span className="block font-mono text-[9px] uppercase tracking-widest text-subtle mt-1">
                    Evidence {edge.mutualContext.sourceType} · {edge.mutualContext.sourceId}
                  </span>
                </div>
              )}
              <div className="mt-2 font-mono text-[9px] uppercase tracking-widest text-subtle">
                {evidence.relation} · Evidence {edge.provenance.sourceType} · {edge.provenance.sourceId}
              </div>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`mt-4 min-h-11 border px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-colors motion-reduce:transition-none ${
          selected
            ? 'border-ink bg-ink text-white'
            : 'border-ink/20 bg-white hover:bg-paper'
        }`}
      >
        {selected ? 'Focused on graph' : 'Focus this path'}
      </button>
    </article>
  );
}

export default function NetworkGraph() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const introductionSearchRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<any>(null);
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [outreaches, setOutreaches] = useState<OutreachRecord[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [searchText, setSearchText] = useState('');
  const [focusIndustry, setFocusIndustry] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState(false);
  const [introductionMode, setIntroductionMode] = useState(false);
  const [introductionSearch, setIntroductionSearch] = useState('');
  const [introductionTargetId, setIntroductionTargetId] = useState<string | null>(null);
  const [selectedIntroductionPathId, setSelectedIntroductionPathId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ width: 960, height: 440 });

  // Hover state: `hoverNode` drives the tooltip content (changes rarely, on
  // enter/leave). The refs are read every frame inside the canvas render loop
  // so the highlight fade can ease without triggering React re-renders.
  const [hoverNode, setHoverNode] = useState<GraphNodeDatum | null>(null);
  const hoverIdRef = useRef<string | null>(null);
  const highlightSetRef = useRef<Set<string> | null>(null);
  const hoverProgressRef = useRef(0);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Entrance assembly: a one-time flourish on load/refresh where the graph
  // builds itself — "You" first, then the industry hubs, then each cluster's
  // contacts, with links drawing in behind their endpoints. Deliberately NOT
  // a persistent ambient animation: this is a working tool, and someone
  // reading it doesn't want motion competing for attention. (The landing
  // showcase graph is the one that gets continuous life — it's decorative.)
  const assemblyStartRef = useRef<number | null>(null);
  const assemblyProgressRef = useRef(1);
  // id -> the fraction of the assembly window at which that node begins.
  const assemblyOrderRef = useRef<Record<string, number>>({});
  const [analysis, setAnalysis] = useState<GraphAnalysis>({
    nodes: [],
    links: [],
    nodeById: {},
    insights: {},
    adjacency: {},
    clusterStats: [],
    gapItems: [],
    alerts: [],
    inferredNeighbors: {},
    networkScore: 0,
    activeCount: 0,
    staleCount: 0,
    overallResponseRate: 0
  });

  const deferredSearch = useDeferredValue(searchText);

  useEffect(() => {
    const updateDimensions = () => {
      if (!containerRef.current) return;
      setDimensions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight
      });
    };

    updateDimensions();
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateDimensions) : null;
    if (containerRef.current) {
      resizeObserver?.observe(containerRef.current);
    }
    window.addEventListener('resize', updateDimensions);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateDimensions);
    };
  }, []);

  useEffect(() => {
    if (!user) return;

    const unsubscribers = [
      onSnapshot(doc(db, 'users', user.uid), (snapshot) => {
        setProfile(snapshot.data() || null);
      }),
      onSnapshot(
        query(collection(db, `users/${user.uid}/contacts`), where('userId', '==', user.uid)),
        (snapshot) => {
          setGraphError(null);
          setContacts(
            snapshot.docs
              .map((item) => ({ id: item.id, ...item.data() } as ContactRecord))
              .filter(
                (contact) =>
                  contact.lifecycleStatus !== 'deleted' &&
                  !contact.mergedIntoContactId,
              ),
          );
        },
        (error) => {
          if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
            setGraphError('Firestore rules are still blocking this graph. Publish your project rules, then refresh.');
            return;
          }
          throw error;
        }
      ),
      onSnapshot(
        query(collection(db, `users/${user.uid}/outreaches`), where('userId', '==', user.uid)),
        (snapshot) => {
          setOutreaches(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as OutreachRecord)));
        }
      ),
      onSnapshot(
        query(collection(db, `users/${user.uid}/notes`), where('userId', '==', user.uid)),
        (snapshot) => {
          setNotes(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as NoteRecord)));
        }
      ),
      onSnapshot(collection(db, `users/${user.uid}/connections`), (snapshot) => {
        setConnections(
          snapshot.docs
            .map((item) => ({ id: item.id, ...item.data() } as ConnectionRecord))
            .filter(
              (connection) =>
                connection.mergeHistorical !== true &&
                connection.mergeSuppressed !== true &&
                connection.sourceId !== connection.targetId,
            ),
        );
      })
    ];

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [user]);

  useEffect(() => {
    setAnalysis(
      buildAnalysis({
        profile,
        contacts,
        outreaches,
        notes,
        connections,
        searchText: deferredSearch,
        focusIndustry,
        detailMode
      })
    );
  }, [profile, contacts, outreaches, notes, connections, deferredSearch, focusIndustry, detailMode]);

  useEffect(() => {
    if (!introductionMode) return;
    const handle = window.setTimeout(() => introductionSearchRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
  }, [introductionMode]);

  useEffect(() => {
    if (
      introductionTargetId &&
      !contacts.some((contact) => contact.id === introductionTargetId)
    ) {
      setIntroductionTargetId(null);
      setSelectedIntroductionPathId(null);
    }
  }, [contacts, introductionTargetId]);

  const introductionEvidence = useMemo(
    () => buildIntroductionEvidenceModel({
      contacts,
      notes,
      outreaches,
      connections,
      insights: analysis.insights
    }),
    [contacts, notes, outreaches, connections, analysis.insights]
  );
  const introductionTarget = introductionTargetId
    ? contacts.find((contact) => contact.id === introductionTargetId) || null
    : null;
  const introductionCandidates = useMemo(() => {
    const queryText = lower(introductionSearch);
    return contacts
      .filter((contact) => {
        if (!queryText) return true;
        return [
          contact.name,
          contact.company,
          contact.role,
          contact.industry,
          contact.location
        ].some((value) => lower(value).includes(queryText));
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 8);
  }, [contacts, introductionSearch]);
  const introductionRanking = useMemo(() => {
    if (!introductionTargetId) {
      return { paths: [], excludedEdges: [] };
    }
    const ranked = rankWarmIntroductionPaths({
      nodes: [
        { id: 'me', label: profile?.name || 'You' },
        ...contacts.map((contact) => ({ id: contact.id, label: contact.name }))
      ],
      edges: introductionEvidence.edges,
      startId: 'me',
      targetId: introductionTargetId,
      maxDepth: 4,
      maxPaths: 20
    });
    return {
      ...ranked,
      // A one-hop result is a direct relationship, not a warm introduction.
      // It remains visible in the selected contact card, while this mode only
      // describes routes through at least one recorded intermediary.
      paths: ranked.paths
        .filter((path) => path.nodeIds.length >= 3)
        .slice(0, 3)
    };
  }, [
    contacts,
    introductionEvidence.edges,
    introductionTargetId,
    profile?.name
  ]);
  const activeIntroductionPath = introductionMode
    ? introductionRanking.paths.find((path) => path.id === selectedIntroductionPathId) ||
      introductionRanking.paths[0] ||
      null
    : null;
  const activeIntroductionNodeIds = useMemo(
    () => new Set(activeIntroductionPath?.nodeIds || []),
    [activeIntroductionPath]
  );
  const activeIntroductionLinkPairs = useMemo(() => {
    const pairs = new Set<string>();
    const nodeIds = activeIntroductionPath?.nodeIds || [];
    for (let index = 0; index < nodeIds.length - 1; index += 1) {
      pairs.add([nodeIds[index], nodeIds[index + 1]].sort().join(':'));
    }
    return pairs;
  }, [activeIntroductionPath]);
  const introductionTargetGaps = useMemo(() => {
    if (!introductionTargetId) return [];
    return introductionEvidence.gaps
      .filter((gap) => gap.targetId === introductionTargetId)
      .slice(0, 4);
  }, [introductionEvidence.gaps, introductionTargetId]);
  const introductionDirectRelationship = introductionTargetId
    ? introductionEvidence.edges.find(
        (edge) => edge.fromId === 'me' && edge.toId === introductionTargetId
      ) || null
    : null;
  const introductionExcludedDetails = useMemo(() => {
    const contactNames = new Map(contacts.map((contact) => [contact.id, contact.name]));
    if (!introductionTargetId) return [];
    const targetNeighbors = new Set<string>();
    introductionEvidence.edges.forEach((edge) => {
      if (edge.fromId === introductionTargetId) targetNeighbors.add(edge.toId);
      if (edge.toId === introductionTargetId) targetNeighbors.add(edge.fromId);
    });
    return introductionRanking.excludedEdges
      .filter((excluded) => {
        if (
          excluded.fromId === introductionTargetId ||
          excluded.toId === introductionTargetId
        ) {
          return true;
        }
        return (
          (excluded.fromId === 'me' && targetNeighbors.has(excluded.toId)) ||
          (excluded.toId === 'me' && targetNeighbors.has(excluded.fromId))
        );
      })
      .slice(0, 4)
      .map((excluded) => ({
        id: `${excluded.edgeId}:${excluded.fromId}:${excluded.toId}`,
        label: `${excluded.fromId === 'me' ? profile?.name || 'You' : contactNames.get(excluded.fromId) || excluded.fromId} → ${
          excluded.toId === 'me' ? profile?.name || 'You' : contactNames.get(excluded.toId) || excluded.toId
        }`,
        reasons: excluded.reasons
      }));
  }, [
    contacts,
    introductionEvidence.edges,
    introductionRanking.excludedEdges,
    introductionTargetId,
    profile?.name
  ]);

  useEffect(() => {
    if (!graphRef.current) return;
    const chargeForce = graphRef.current.d3Force('charge');
    if (chargeForce) {
      chargeForce.strength(-150);
    }
    const linkForce = graphRef.current.d3Force('link');
    if (linkForce) {
      linkForce.distance((link: GraphLinkDatum) => {
        if (link.kind === 'backbone') return 128;
        if (link.kind === 'membership') return 76;
        return 88;
      });
      linkForce.strength?.((link: GraphLinkDatum) => {
        if (link.kind === 'backbone') return 0.22;
        if (link.kind === 'membership') return 0.18;
        return 0.14;
      });
    }
    graphRef.current.d3Force('radialAnchor', createRadialAnchorForce());
  }, [analysis.links.length]);

  useEffect(() => {
    if (!graphRef.current || analysis.nodes.length === 0) return;
    const handle = window.setTimeout(() => {
      graphRef.current.zoomToFit(650, 48);
    }, 80);
    return () => window.clearTimeout(handle);
  }, [analysis.nodes.length, focusIndustry]);

  useEffect(() => {
    if (!graphRef.current) return;
    if (!activeIntroductionPath) {
      if (!introductionMode && introductionTargetId) {
        const restoreHandle = window.setTimeout(
          () => graphRef.current?.zoomToFit?.(0, 48),
          80
        );
        return () => window.clearTimeout(restoreHandle);
      }
      return;
    }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const handle = window.setTimeout(() => {
      graphRef.current?.zoomToFit?.(
        reduceMotion ? 0 : 450,
        64,
        (node: GraphNodeDatum) => activeIntroductionNodeIds.has(node.id)
      );
    }, 80);
    return () => window.clearTimeout(handle);
  }, [
    activeIntroductionNodeIds,
    activeIntroductionPath,
    introductionMode,
    introductionTargetId
  ]);

  const isNodeFaded = (node: GraphNodeDatum) => {
    if (node.kind === 'contact' || node.kind === 'industry') {
      if (node.kind === 'contact' && activeIntroductionPath) {
        return !activeIntroductionNodeIds.has(node.id);
      }
      const searchFaded = node.matchesSearch === false;
      const focusFaded = node.matchesFocus === false;
      return searchFaded || focusFaded;
    }
    return false;
  };
  const graphData = useMemo(() => ({ nodes: analysis.nodes, links: analysis.links }), [analysis.nodes, analysis.links]);

  // (Re)schedule the entrance assembly whenever the underlying graph data
  // changes — i.e. on load and on refresh. Filtering by industry or search
  // does not land here, because those only change per-node flags, not the
  // memoized graphData identity, so the graph doesn't re-assemble every time
  // someone clicks a lane.
  useEffect(() => {
    const order: Record<string, number> = {};
    if (analysis.nodes.length === 0) {
      assemblyOrderRef.current = order;
      return;
    }

    // Cluster order follows the industry hubs' own order, so the assembly
    // sweeps around the ring the same way the layout reads.
    const clusterIndex: Record<string, number> = {};
    let nextCluster = 0;
    analysis.nodes.forEach((node) => {
      if (node.kind === 'industry' && node.industryKey && !(node.industryKey in clusterIndex)) {
        clusterIndex[node.industryKey] = nextCluster;
        nextCluster += 1;
      }
    });

    const CLUSTER_STEP = 0.055;
    const perClusterCount: Record<string, number> = {};

    analysis.nodes.forEach((node) => {
      if (node.kind === 'me') {
        order[node.id] = 0;
        return;
      }
      const ci = node.industryKey != null ? (clusterIndex[node.industryKey] ?? nextCluster) : nextCluster;
      if (node.kind === 'industry') {
        order[node.id] = 0.08 + ci * CLUSTER_STEP;
        return;
      }
      const key = String(node.industryKey ?? '_');
      const within = perClusterCount[key] || 0;
      perClusterCount[key] = within + 1;
      const base = node.kind === 'gap' ? 0.4 : 0.14;
      // Cap so the last arrival still finishes inside the window.
      order[node.id] = Math.min(0.72, base + ci * CLUSTER_STEP + within * 0.012);
    });

    assemblyOrderRef.current = order;

    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (reduce) {
      // Respect the user's preference: no build, just the finished graph.
      assemblyStartRef.current = null;
      assemblyProgressRef.current = 1;
      return;
    }

    assemblyStartRef.current = null; // set on the first frame after this
    assemblyProgressRef.current = 0;
  }, [graphData, analysis.nodes]);
  const isLinkFaded = (link: GraphLinkDatum) => {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    const sourceNode = analysis.nodeById[sourceId];
    const targetNode = analysis.nodeById[targetId];
    return (!!sourceNode && isNodeFaded(sourceNode)) || (!!targetNode && isNodeFaded(targetNode));
  };
  const isActiveIntroductionLink = (link: GraphLinkDatum) => {
    if (link.kind !== 'explicit' || activeIntroductionLinkPairs.size === 0) return false;
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    return activeIntroductionLinkPairs.has([sourceId, targetId].sort().join(':'));
  };

  const selectedNode = selectedNodeId ? analysis.nodeById[selectedNodeId] : null;
  const selectedInsight = selectedNode?.contact ? analysis.insights[selectedNode.id] : null;
  const selectedNeighbors = selectedNode
    ? (analysis.inferredNeighbors[selectedNode.id] || [])
        .map((id) => analysis.nodeById[id])
        .filter((node): node is GraphNodeDatum => Boolean(node) && node.kind === 'contact')
        .slice(0, 5)
    : [];
  const activeCluster = focusIndustry
    ? analysis.clusterStats.find((cluster) => cluster.key === focusIndustry) || null
    : selectedNode?.industryKey
      ? analysis.clusterStats.find((cluster) => cluster.key === selectedNode.industryKey) || null
      : analysis.clusterStats[0] || null;

  const selectIntroductionTarget = (contact: ContactRecord) => {
    setIntroductionTargetId(contact.id);
    setIntroductionSearch(contact.name);
    setSelectedIntroductionPathId(null);
    setSelectedNodeId(contact.id);
  };

  const openIntroductionModeFor = (contact: ContactRecord) => {
    setIntroductionMode(true);
    selectIntroductionTarget(contact);
  };

  const handleNodeHover = (node: any) => {
    const datum = node as GraphNodeDatum | null;
    hoverIdRef.current = datum?.id ?? null;
    setHoverNode(datum);
    if (datum) {
      // Highlight = the node itself plus everyone it links to (explicit links
      // via adjacency, plus inferred same-firm/school/industry neighbors).
      const set = new Set<string>([datum.id]);
      (analysis.adjacency[datum.id] || []).forEach((edge) => set.add(edge.to));
      (analysis.inferredNeighbors[datum.id] || []).forEach((id) => set.add(id));
      highlightSetRef.current = set;
    } else {
      highlightSetRef.current = null;
    }
    if (containerRef.current) {
      containerRef.current.style.cursor = datum ? 'pointer' : 'grab';
    }
  };

  // How long the whole build takes, and how much of that window a single
  // node/link spends fading in.
  const ASSEMBLY_MS = 1250;
  const NODE_SPAN = 0.28;
  const LINK_SPAN = 0.22;
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

  /** 0 → 1 arrival progress for one node, or 1 once assembly is finished. */
  const nodeAssemblyT = (id: string) => {
    const p = assemblyProgressRef.current;
    if (p >= 1) return 1;
    const start = assemblyOrderRef.current[id] ?? 0;
    return easeOut(Math.max(0, Math.min(1, (p - start) / NODE_SPAN)));
  };

  /** A link starts drawing only once both of its endpoints have landed. */
  const linkAssemblyT = (link: GraphLinkDatum) => {
    const p = assemblyProgressRef.current;
    if (p >= 1) return 1;
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    const start =
      Math.max(assemblyOrderRef.current[sourceId] ?? 0, assemblyOrderRef.current[targetId] ?? 0) + 0.05;
    return easeOut(Math.max(0, Math.min(1, (p - start) / LINK_SPAN)));
  };

  const advanceHoverFrame = () => {
    // Drive the one-time entrance assembly off the same frame callback that
    // already runs for the hover easing — no extra rAF loop.
    if (assemblyProgressRef.current < 1) {
      const now = performance.now();
      if (assemblyStartRef.current === null) assemblyStartRef.current = now;
      assemblyProgressRef.current = Math.min(1, (now - assemblyStartRef.current) / ASSEMBLY_MS);
    }

    const target = hoverIdRef.current ? 1 : 0;
    // Eased approach toward the target each frame — no instant alpha snap.
    hoverProgressRef.current += (target - hoverProgressRef.current) * 0.16;

    const tip = tooltipRef.current;
    const id = hoverIdRef.current;
    if (tip && id && graphRef.current?.graph2ScreenCoords) {
      const node = analysis.nodeById[id];
      if (node && typeof node.x === 'number' && typeof node.y === 'number') {
        const screen = graphRef.current.graph2ScreenCoords(node.x, node.y);
        tip.style.transform = `translate(${Math.round(screen.x + 14)}px, ${Math.round(screen.y - 12)}px)`;
      }
    }
  };

  const nodeCanvasObject = (
    node: GraphNodeDatum,
    context: CanvasRenderingContext2D,
    globalScale: number
  ) => {
    // Entrance assembly: nodes fade and scale up in cluster order. Once the
    // build has finished `at` is a constant 1, so this costs nothing on every
    // subsequent frame.
    const at = nodeAssemblyT(node.id);
    if (at <= 0.001) return;

    const x = node.x || 0;
    const y = node.y || 0;
    const radius = node.radius * (0.55 + 0.45 * at);
    const selected = selectedNodeId === node.id;
    const hovered = hoverIdRef.current === node.id;
    const emphasized = selected || hovered;
    const baseAlpha = isNodeFaded(node) ? 0.18 : 1;
    const highlightSet = highlightSetRef.current;
    const hp = hoverProgressRef.current;
    const alpha =
      (highlightSet && !highlightSet.has(node.id) ? baseAlpha * (1 - 0.82 * hp) : baseAlpha) * at;
    // Labels would pop in at full opacity over a half-formed node; hold them
    // until the node itself has essentially landed.
    const labelVisible =
      at > 0.9 && (globalScale > 1.75 || emphasized || node.kind === 'me' || node.kind === 'industry');

    context.save();
    context.globalAlpha = alpha;

    if (node.kind === 'gap') {
      context.setLineDash([8, 6]);
      context.strokeStyle = 'rgba(97, 118, 114, 0.7)';
      context.lineWidth = 1.4;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.stroke();
      context.setLineDash([]);
      context.restore();
      return;
    }

    if (node.kind === 'industry') {
      context.fillStyle = node.color;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();

      context.strokeStyle = 'rgba(26,26,26,0.16)';
      context.lineWidth = 2.5;
      context.beginPath();
      context.arc(x, y, radius + 4, 0, Math.PI * 2);
      context.stroke();

      context.fillStyle = '#FFFFFF';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = `800 ${Math.max(10, radius * 0.75)}px Inter`;
      context.fillText(node.initials, x, y);
    } else {
    if (node.kind === 'contact' && emphasized) {
      context.fillStyle = 'rgba(97, 118, 114, 0.14)';
      context.beginPath();
      context.arc(x, y, radius + 9, 0, Math.PI * 2);
      context.fill();
    }
    if (node.kind === 'contact' && activeIntroductionNodeIds.has(node.id)) {
      context.strokeStyle = '#8C7A65';
      context.lineWidth = 2.4;
      context.beginPath();
      context.arc(x, y, radius + 9, 0, Math.PI * 2);
      context.stroke();
    }

    context.fillStyle = node.kind === 'me' ? node.color : node.color;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = node.ringColor;
    context.lineWidth = node.kind === 'me'
      ? 3.5
      : emphasized
        ? 3.2
        : detailMode && node.kind === 'contact'
          ? (node.score >= 75 ? 3.2 : node.score >= 55 ? 2.5 : 1.7)
          : 1.8;
    if (node.dashedRing) {
      context.setLineDash([6, 4]);
    }
    context.beginPath();
    context.arc(x, y, radius + 3, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);

      context.fillStyle = node.kind === 'me' ? '#F5F0E8' : '#1A1A1A';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = `700 ${Math.max(8, radius * 0.9)}px Inter`;
      context.fillText(node.initials, x, y);
    }

    if (labelVisible) {
      const label = node.name;
      const subtitle = node.subtitle || '';
      const fontSize = 11 / globalScale;
      context.font = `600 ${fontSize}px Inter`;
      const labelWidth = context.measureText(label).width;
      const subtitleWidth = subtitle ? context.measureText(subtitle).width : 0;
      const boxWidth = Math.max(labelWidth, subtitleWidth) + 18 / globalScale;
      const boxHeight = subtitle ? 28 / globalScale : 18 / globalScale;
      const boxX = x + radius + 10 / globalScale;
      const boxY = y - boxHeight / 2;

      context.fillStyle = 'rgba(245, 240, 232, 0.94)';
      context.strokeStyle = 'rgba(26,26,26,0.16)';
      context.lineWidth = 1 / globalScale;
      context.fillRect(boxX, boxY, boxWidth, boxHeight);
      context.strokeRect(boxX, boxY, boxWidth, boxHeight);

      context.fillStyle = '#1A1A1A';
      context.textAlign = 'left';
      context.textBaseline = 'top';
      context.fillText(label, boxX + 8 / globalScale, boxY + 4 / globalScale);

      if (subtitle) {
        context.font = `500 ${8 / globalScale}px Inter`;
        context.fillStyle = 'rgba(26,26,26,0.58)';
        context.fillText(subtitle, boxX + 8 / globalScale, boxY + 14 / globalScale);
      }
    }

    context.restore();
  };

  if (!user) return null;

  return (
    <div className="space-y-6 pb-12">
      <div className="border-b border-ink/20 pb-6">
        <div>
          <AccentRule className="mb-4" />
          <h1 className="font-serif text-5xl italic font-black mb-2">Network Graph.</h1>
          <p className="font-mono text-xs uppercase tracking-widest text-muted">
            You at the center, industry lanes around you, and contacts nested inside each lane.
          </p>
        </div>
      </div>

      {graphError && (
        <div role="alert" className="border border-red-300 bg-red-50 p-4 font-mono text-xs leading-relaxed text-red-800">
          {graphError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          icon={Radar}
          label="Network Strength"
          value={`${analysis.networkScore}`}
          detail="Weighted by depth, diversity, and recency"
        />
        <MetricCard
          icon={Users}
          label="Visible Contacts"
          value={`${contacts.length}`}
          detail={`${analysis.activeCount} touched in the last 30 days`}
        />
        <MetricCard
          icon={Flame}
          label="At Risk"
          value={`${analysis.staleCount}`}
          detail="Contacts drifting cold beyond 60 days"
        />
        <MetricCard
          icon={Link2}
          label="Response Rate"
          value={`${Math.round(analysis.overallResponseRate * 100)}%`}
          detail="Across logged outreach activity"
        />
      </div>

      <div className="bg-white border border-ink/15 rounded-card p-5 space-y-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="relative w-full max-w-xl">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" size={16} aria-hidden="true" />
            <Input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Search firms, names, tags, cities..."
              className="pl-10 bg-paper/40"
              aria-label="Search network contacts"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setIntroductionMode((current) => !current)}
              aria-pressed={introductionMode}
              aria-controls="introduction-path-finder"
              className={`inline-flex min-h-11 items-center gap-2 border px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-colors motion-reduce:transition-none ${
                introductionMode
                  ? 'border-[#8C7A65] bg-[#F7F0E5] text-ink'
                  : 'border-ink/20 bg-white hover:bg-paper'
              }`}
            >
              <Waypoints size={14} aria-hidden="true" />
              Introduction Paths
            </button>
            <div className="group relative">
              <button
                type="button"
                onClick={() => setDetailMode((current) => !current)}
                aria-pressed={detailMode}
                className={`tour-graph-detail-toggle min-h-11 border px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-colors motion-reduce:transition-none ${
                  detailMode ? 'border-ink bg-ink text-white' : 'border-ink/20 bg-white hover:bg-paper'
                }`}
              >
                Detail Overlay
              </button>
              <div className="pointer-events-none absolute right-0 top-[calc(100%+8px)] z-20 hidden w-72 border border-ink/15 bg-[#F8F5EF] p-3 text-ink group-hover:block group-focus-within:block">
                <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-subtle">Signal Overlay</div>
                <div className="space-y-2 text-xs text-subtle">
                  <div className="flex items-center gap-2">
                    <span className="h-5 w-5 rounded-full border-[3px] border-[#171717] bg-[#DCD7CF]" />
                    <span>75-100: strongest relationship signal</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-4 w-4 rounded-full border-[3px] border-[#4C6A69] bg-[#DDE6E5]" />
                    <span>55-74: warm and active</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full border-[2px] border-[#8B877D] bg-[#ECE8E1]" />
                    <span>35-54: lighter relationship signal</span>
                  </div>
                  <div className="mt-2 border-t border-ink/10 pt-2 font-mono text-[10px] uppercase tracking-widest">
                    Size blends strength, response rate, and contact recency
                  </div>
                </div>
              </div>
            </div>
            {focusIndustry && (
              <button
                onClick={() => setFocusIndustry(null)}
                className="min-h-11 border border-ink/20 bg-white px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-colors hover:bg-paper motion-reduce:transition-none"
              >
                Clear Focus
              </button>
            )}
          </div>
        </div>

        <div className="tour-graph-clusters flex flex-wrap gap-2">
          {analysis.clusterStats.map((cluster) => (
            <button
              key={cluster.key}
              type="button"
              onClick={() => setFocusIndustry((current) => current === cluster.key ? null : cluster.key)}
              aria-pressed={focusIndustry === cluster.key}
              className={`inline-flex min-h-11 items-center gap-2 border px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-colors motion-reduce:transition-none ${
                focusIndustry === cluster.key ? 'border-ink bg-accent text-ink' : 'border-ink/20 bg-white hover:bg-paper'
              }`}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: INDUSTRY_COLORS[cluster.key].color }} />
              {cluster.label}
            </button>
          ))}
        </div>
      </div>

      {introductionMode && (
        <section
          id="introduction-path-finder"
          aria-labelledby="introduction-path-title"
          className="overflow-hidden rounded-card border border-[#8C7A65]/40 bg-[#F8F5EF]"
        >
          <div className="border-b border-[#8C7A65]/25 bg-[#EEE7DC] p-5 md:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-2xl">
                <div className="mb-2 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-[#6E604F]">
                  <Waypoints size={14} aria-hidden="true" />
                  Evidence-only introduction intelligence
                  <span className="border border-[#617672]/30 bg-[#F0F3EC] px-2 py-1 text-[#405856]">
                    Deterministic
                  </span>
                </div>
                <h2 id="introduction-path-title" className="font-serif text-3xl font-black italic">
                  Find the warmest truthful route.
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-relaxed text-subtle">
                  Paths use recorded relationships and explicit connection edges only. Shared company,
                  school, industry, and other inferred graph neighbors never become introduction claims.
                </p>
              </div>
              <div className="flex max-w-sm items-start gap-2 border border-[#8C7A65]/25 bg-white/70 p-3 text-xs leading-relaxed text-subtle">
                <ShieldAlert size={16} className="mt-0.5 shrink-0 text-[#76562F]" aria-hidden="true" />
                <span>
                  Missing willingness, workload, fatigue, or direction stays visibly unknown and is
                  scored conservatively until you record it.
                </span>
              </div>
            </div>
          </div>

          <IntroductionEdgeEditor uid={user!.uid} contacts={contacts} />

          <div className="grid gap-6 p-5 md:p-6 lg:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.6fr)]">
            <div>
              <label
                htmlFor="introduction-target-search"
                className="mb-2 block font-mono text-[10px] uppercase tracking-widest text-subtle"
              >
                Search for a target
              </label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle"
                  size={16}
                  aria-hidden="true"
                />
                <Input
                  ref={introductionSearchRef}
                  id="introduction-target-search"
                  type="search"
                  value={introductionSearch}
                  onChange={(event) => {
                    setIntroductionSearch(event.target.value);
                    if (
                      introductionTarget &&
                      lower(event.target.value) !== lower(introductionTarget.name)
                    ) {
                      setIntroductionTargetId(null);
                      setSelectedIntroductionPathId(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setIntroductionSearch('');
                      setIntroductionTargetId(null);
                      setSelectedIntroductionPathId(null);
                    }
                  }}
                  placeholder="Name, company, role, or city"
                  className="min-h-11 bg-white pl-10"
                  aria-describedby="introduction-search-help"
                />
              </div>
              <p id="introduction-search-help" className="mt-2 text-xs leading-relaxed text-subtle">
                Choose an existing contact. A contact being nearby on the graph is not, by itself,
                evidence of an introduction route.
              </p>

              {(!introductionTarget ||
                lower(introductionSearch) !== lower(introductionTarget.name)) && (
                <div className="mt-3" aria-label="Matching introduction targets">
                  {introductionCandidates.length > 0 ? (
                    <ul className="max-h-72 space-y-2 overflow-y-auto" role="list">
                      {introductionCandidates.map((contact) => (
                        <li key={contact.id}>
                          <button
                            type="button"
                            onClick={() => selectIntroductionTarget(contact)}
                            className="min-h-11 w-full border border-ink/10 bg-white p-3 text-left transition-colors hover:border-[#8C7A65]/60 hover:bg-[#F7F0E5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#617672] motion-reduce:transition-none"
                          >
                            <span className="block font-semibold">{contact.name}</span>
                            <span className="mt-1 block font-mono text-[9px] uppercase tracking-widest text-subtle">
                              {[contact.role, contact.company].filter(Boolean).join(' · ') || 'Contact record'}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="border border-ink/10 bg-white p-3 text-sm text-subtle">
                      No contacts match that search.
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4 border border-ink/10 bg-white/70 p-3 text-xs leading-relaxed text-subtle">
                <div className="mb-1 flex items-center gap-2 font-mono text-[9px] uppercase tracking-widest text-ink">
                  <CheckCircle2 size={13} aria-hidden="true" />
                  Ranking boundary
                </div>
                {introductionEvidence.edges.filter((edge) => edge.fromId !== 'me').length} explicit
                contact-to-contact edge{introductionEvidence.edges.filter((edge) => edge.fromId !== 'me').length === 1 ? '' : 's'} currently
                have enough evidence to rank. {introductionEvidence.gaps.length} edge or
                relationship gap{introductionEvidence.gaps.length === 1 ? '' : 's'} remain unranked.
              </div>
            </div>

            <div aria-live="polite" aria-atomic="false">
              {!introductionTarget ? (
                <div className="flex min-h-64 items-center justify-center border border-dashed border-[#8C7A65]/40 bg-white/60 p-8 text-center">
                  <div className="max-w-md">
                    <Waypoints size={28} className="mx-auto mb-3 text-[#8C7A65]" aria-hidden="true" />
                    <h3 className="font-serif text-2xl font-bold italic">Select the person you want to reach.</h3>
                    <p className="mt-2 text-sm leading-relaxed text-subtle">
                      Cirqle will rank only paths it can trace through evidence-backed relationship records.
                    </p>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="mb-4 flex flex-col gap-3 border border-ink/10 bg-white p-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="font-mono text-[9px] uppercase tracking-widest text-subtle">Target</div>
                      <h3 className="mt-1 font-serif text-3xl font-black italic">
                        {introductionTarget.name}
                      </h3>
                      <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-subtle">
                        {[introductionTarget.role, introductionTarget.company].filter(Boolean).join(' · ') || 'Contact record'}
                      </p>
                    </div>
                    <div className="max-w-xs text-xs leading-relaxed text-subtle sm:text-right">
                      {introductionDirectRelationship ? (
                        <>
                          You also have a direct, dated relationship record. It is not mislabeled as a
                          warm introduction; the routes below require an intermediary.
                        </>
                      ) : (
                        <>
                          No dated direct relationship evidence is available. That gap is kept separate
                          from any intermediary route.
                        </>
                      )}
                    </div>
                  </div>

                  {introductionRanking.paths.length > 0 ? (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h3 className="font-serif text-2xl font-bold">Warmest recorded paths</h3>
                          <p className="mt-1 text-xs text-subtle">
                            Ranked by the weakest edge, then the path average and hop count.
                          </p>
                        </div>
                        <span className="font-mono text-[9px] uppercase tracking-widest text-subtle">
                          {introductionRanking.paths.length} route{introductionRanking.paths.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      {introductionRanking.paths.map((path) => (
                        <IntroductionPathCard
                          key={path.id}
                          path={path}
                          evidenceByEdgeId={introductionEvidence.evidenceByEdgeId}
                          selected={activeIntroductionPath?.id === path.id}
                          onSelect={() => setSelectedIntroductionPathId(path.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="border border-[#9A7447]/35 bg-[#F7F0E5] p-5">
                      <div className="flex items-start gap-3">
                        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[#76562F]" aria-hidden="true" />
                        <div>
                          <h3 className="font-serif text-xl font-bold">No defensible warm path yet.</h3>
                          <p className="mt-1 text-sm leading-relaxed text-subtle">
                            Cirqle found no route through a recorded intermediary with enough dated
                            evidence to rank. It will not turn visual proximity or a shared employer into
                            a relationship claim.
                          </p>
                        </div>
                      </div>

                      {(introductionTargetGaps.length > 0 || introductionExcludedDetails.length > 0) && (
                        <div className="mt-4 space-y-2">
                          {introductionTargetGaps.map((gap) => (
                            <div key={gap.id} className="border border-[#9A7447]/25 bg-white/70 p-3 text-xs leading-relaxed">
                              <span className="font-semibold">{gap.label}:</span> {gap.detail}
                            </div>
                          ))}
                          {introductionExcludedDetails.map((excluded) => (
                            <div key={excluded.id} className="border border-[#7D5B52]/25 bg-white/70 p-3 text-xs leading-relaxed">
                              <span className="font-semibold">{excluded.label}:</span>{' '}
                              {excluded.reasons.join('; ')}.
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1.45fr)_360px]">
        <section className="self-start bg-white border border-ink/15 rounded-card overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-ink/15 bg-[#F8F5EF] p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 id="live-network-title" className="font-serif text-2xl italic font-bold">Live Network Surface</h2>
              <p className="font-mono text-[10px] uppercase tracking-widest text-subtle mt-1">
                Clean graph surface with optional relationship signal detail
              </p>
            </div>
            <div className="flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-widest text-subtle">
              <span>{analysis.nodes.length} nodes</span>
              <span>{analysis.links.length} links</span>
              {activeIntroductionPath && (
                <span className="text-[#76562F]">Copper rings mark the focused path</span>
              )}
            </div>
          </div>

          <p id="network-graph-description" className="sr-only">
            Interactive visual network graph. Use the keyboard contact directory after the graph
            to select a person without using the canvas.
          </p>
          <div
            ref={containerRef}
            role="group"
            aria-labelledby="live-network-title"
            aria-describedby="network-graph-description"
            className="tour-graph-node relative h-[400px] overflow-hidden bg-paper md:h-[460px]"
          >
            <div className="absolute inset-0 bg-[#F5F0E8]" />
            <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'linear-gradient(rgba(26,26,26,0.24) 1px, transparent 1px), linear-gradient(90deg, rgba(26,26,26,0.24) 1px, transparent 1px)', backgroundSize: '80px 80px' }} />
            <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: 'radial-gradient(rgba(26,26,26,0.3) 0.7px, transparent 0.7px)', backgroundSize: '18px 18px' }} />

            {contacts.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-ink/70">
                <div>
                  <p className="font-serif text-3xl italic font-bold mb-3">Your network is still empty.</p>
                  <p className="font-mono text-xs uppercase tracking-widest">Seed test data or add contacts in the directory to bring the graph to life.</p>
                </div>
              </div>
            ) : (
              <ForceGraph2D
                ref={graphRef}
                width={dimensions.width}
                height={dimensions.height}
                graphData={graphData}
                backgroundColor="rgba(0,0,0,0)"
                d3AlphaDecay={0.025}
                d3VelocityDecay={0.38}
                cooldownTicks={Infinity}
                nodeCanvasObject={nodeCanvasObject as any}
                nodePointerAreaPaint={(node: GraphNodeDatum, color: string, context: CanvasRenderingContext2D) => {
                  context.fillStyle = color;
                  context.beginPath();
                  context.arc(node.x || 0, node.y || 0, node.radius + 8, 0, Math.PI * 2);
                  context.fill();
                }}
                /* Painted by hand rather than via linkColor/linkWidth/
                   linkLineDash, because the entrance assembly needs each link
                   to *extend* from its source toward its target rather than
                   just fade in. The colour/width/dash rules below are the same
                   ones those three props carried, including the eased hover
                   highlight; once assembly finishes `lt` is a constant 1 and
                   this draws the full line exactly as before. */
                linkCanvasObject={(link: GraphLinkDatum, context: CanvasRenderingContext2D) => {
                  const lt = linkAssemblyT(link);
                  if (lt <= 0.001) return;

                  const src = link.source as any;
                  const tgt = link.target as any;
                  if (typeof src?.x !== 'number' || typeof tgt?.x !== 'number') return;

                  const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
                  const targetId = typeof link.target === 'string' ? link.target : link.target.id;
                  const hoverId = hoverIdRef.current;
                  const hp = hoverProgressRef.current;
                  const introductionPathLink = isActiveIntroductionLink(link);

                  let base = link.kind === 'backbone' ? 0.24 : link.kind === 'membership' ? 0.13 : 0.18;
                  const faded = isLinkFaded(link);
                  if (introductionPathLink) base = 0.82;
                  else if (faded) base = 0.07;
                  if (hoverId) {
                    const touches = sourceId === hoverId || targetId === hoverId;
                    base = touches ? base * (1 - hp) + 0.42 * hp : base * (1 - 0.85 * hp);
                  }

                  let width = link.weight;
                  if (introductionPathLink) width = Math.max(3.2, link.weight + 1.4);
                  else if (faded) width = 0.5;
                  else if (hoverId && (sourceId === hoverId || targetId === hoverId)) {
                    width = link.weight + 1.4 * hp;
                  }

                  context.save();
                  context.strokeStyle = introductionPathLink
                    ? `rgba(140,122,101,${base.toFixed(3)})`
                    : `rgba(26,26,26,${base.toFixed(3)})`;
                  context.lineWidth = width;
                  if (link.kind === 'explicit') context.setLineDash([5, 4]);
                  context.beginPath();
                  context.moveTo(src.x, src.y);
                  context.lineTo(src.x + (tgt.x - src.x) * lt, src.y + (tgt.y - src.y) * lt);
                  context.stroke();
                  context.restore();
                }}
                onNodeHover={handleNodeHover}
                onRenderFramePre={advanceHoverFrame}
                warmupTicks={0}
                onNodeClick={(node) => {
                  const datum = node as GraphNodeDatum;
                  if (datum.kind === 'industry') {
                    setFocusIndustry((current) => current === datum.industryKey ? null : datum.industryKey || null);
                    setSelectedNodeId(null);
                    return;
                  }
                  if (datum.kind !== 'contact') return;
                  setSelectedNodeId(datum.id);
                }}
                onNodeDrag={() => {
                  graphRef.current?.d3AlphaTarget?.(0.08);
                }}
                onNodeDragEnd={(node) => {
                  const datum = node as GraphNodeDatum;
                  graphRef.current?.d3AlphaTarget?.(0);
                  if (datum.kind === 'me') {
                    datum.fx = 0;
                    datum.fy = 0;
                    return;
                  }
                  datum.fx = undefined;
                  datum.fy = undefined;
                  if (typeof datum.x === 'number') datum.targetX = datum.x;
                  if (typeof datum.y === 'number') datum.targetY = datum.y;
                }}
                onBackgroundClick={() => setSelectedNodeId(null)}
              />
            )}

            {/* Hover tooltip — name + tier before committing to a click.
                Positioned each frame from the node's live screen coords. */}
            {hoverNode && (
              <div ref={tooltipRef} className="pointer-events-none absolute left-0 top-0 z-20 will-change-transform">
                <div className="animate-fade-in max-w-[230px] rounded-card border border-ink/15 bg-white px-3 py-2 shadow-float motion-reduce:animate-none">
                  <div className="flex items-center gap-2">
                    <span className="font-serif text-sm font-bold leading-tight">{hoverNode.name}</span>
                    {hoverNode.tier && <TierBadge tier={hoverNode.tier} className="!px-1.5 !py-0.5 !text-[8px]" />}
                  </div>
                  {hoverNode.subtitle && (
                    <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-muted">{hoverNode.subtitle}</p>
                  )}
                  {hoverNode.kind === 'contact' && (
                    <p className="mt-1.5 font-mono text-[9px] uppercase tracking-widest text-brand">Click to inspect</p>
                  )}
                </div>
              </div>
            )}

          </div>
          {contacts.length > 0 && (
            <details className="border-t border-ink/15 bg-[#F8F5EF] p-4">
              <summary className="min-h-11 cursor-pointer py-3 font-mono text-[10px] uppercase tracking-widest text-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#617672]">
                Keyboard &amp; screen-reader contact directory
              </summary>
              <p className="mb-3 text-xs leading-relaxed text-subtle">
                The canvas is a visual overview. These controls expose the same contact nodes to
                keyboard and screen-reader users.
              </p>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="list">
                {contacts
                  .slice()
                  .sort((left, right) => left.name.localeCompare(right.name))
                  .map((contact) => {
                    const insight = analysis.insights[contact.id];
                    return (
                      <li key={contact.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedNodeId(contact.id)}
                          aria-pressed={selectedNodeId === contact.id}
                          className="min-h-11 w-full border border-ink/10 bg-white p-3 text-left transition-colors hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#617672] motion-reduce:transition-none"
                        >
                          <span className="block font-semibold">{contact.name}</span>
                          <span className="mt-1 block text-xs text-subtle">
                            {[contact.role, contact.company].filter(Boolean).join(' · ') || 'Contact'}
                            {insight ? ` · Relationship ${Math.round(insight.score)}/100` : ''}
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </details>
          )}
        </section>

        <aside className="space-y-4">
          {selectedNode && selectedNode.kind === 'contact' && selectedInsight ? (
            <div className="bg-white border border-ink/15 rounded-card p-5">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-subtle mb-1">Selected Contact</p>
                  <h2 className="font-serif text-3xl italic font-bold">{selectedNode.name}</h2>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-subtle mt-2">{selectedNode.subtitle}</p>
                </div>
                <span
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-ink/20 text-sm font-bold text-ink"
                  style={{ backgroundColor: selectedNode.color }}
                  aria-hidden="true"
                >
                  {selectedNode.initials}
                </span>
              </div>

              <div className="mb-4 bg-paper/50 border border-ink/10 p-4">
                <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-subtle mb-2">
                  <span>Relationship Strength</span>
                  <span className="flex items-center gap-1.5">
                    {selectedInsight.pinned && <Pin size={10} className="text-brand" aria-hidden="true" />}
                    {Math.round(selectedInsight.score)}/100
                  </span>
                </div>
                <div
                  className="h-2 border border-ink/10 bg-white"
                  role="progressbar"
                  aria-label={`${selectedNode.name} relationship strength`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(selectedInsight.score)}
                >
                  <div
                    className="h-full"
                    style={{
                      width: `${selectedInsight.score}%`,
                      background: `linear-gradient(90deg, ${selectedNode.color}, #617672)`
                    }}
                  />
                </div>
                {/* The number alone was the complaint that started the health
                    work — "72" tells you nothing you can act on. Now that the
                    graph shares the scorer, it can show the same one-line
                    explanation the contact record does. */}
                <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted">
                  {selectedInsight.healthDetail}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="border border-ink/10 bg-white p-3">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-subtle mb-1">Last touch</div>
                  <div className="font-semibold">{formatDays(selectedInsight.lastTouchDays)}</div>
                </div>
                <div className="border border-ink/10 bg-white p-3">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-subtle mb-1">Response rate</div>
                  <div className="font-semibold">{Math.round(selectedInsight.responseRate * 100)}%</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 mb-4">
                <Button type="button" onClick={() => navigate(`/app/directory/${selectedNode.id}`)}>
                  View Full Profile
                </Button>
                <Button type="button" variant="outline" onClick={() => navigate(`/app/directory/${selectedNode.id}`)}>
                  Draft Outreach
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => selectedNode.contact && openIntroductionModeFor(selectedNode.contact)}
                >
                  Find Warm Path
                </Button>
              </div>

              <div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-subtle mb-2">Nearby In This Lane</div>
                <div className="space-y-2">
                  {selectedNeighbors.length > 0 ? (
                    selectedNeighbors.map((neighbor) => (
                      <button
                        key={neighbor.id}
                        type="button"
                        onClick={() => setSelectedNodeId(neighbor.id)}
                        className="min-h-11 w-full border border-ink/10 bg-paper/40 p-3 text-left transition-colors hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#617672] motion-reduce:transition-none"
                      >
                        <div className="font-semibold">{neighbor.name}</div>
                        <div className="font-mono text-[10px] uppercase tracking-widest text-subtle mt-1">{neighbor.subtitle}</div>
                      </button>
                    ))
                  ) : (
                    <div className="border border-ink/10 bg-paper/40 p-3 text-sm text-subtle">
                      No adjacent contacts are standing out for this lane yet.
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white border border-ink/15 rounded-card p-5">
              <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-subtle">
                <Network size={14} />
                Cluster Intelligence
              </div>
              <h2 className="font-serif text-3xl italic font-bold mb-2">{activeCluster?.label || 'Network Overview'}</h2>
              {activeCluster ? (
                <>
                  <p className="text-sm leading-relaxed text-subtle mb-4">
                    {activeCluster.count} contacts sit in this cluster. The average relationship score is {Math.round(activeCluster.averageStrength)}, and {activeCluster.staleCount} are drifting cold.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="border border-ink/10 bg-paper/40 p-3">
                      <div className="font-mono text-[10px] uppercase tracking-widest text-subtle mb-1">Contacts</div>
                      <div className="font-semibold text-xl">{activeCluster.count}</div>
                    </div>
                    <div className="border border-ink/10 bg-paper/40 p-3">
                      <div className="font-mono text-[10px] uppercase tracking-widest text-subtle mb-1">Response rate</div>
                      <div className="font-semibold text-xl">{Math.round(activeCluster.responseRate * 100)}%</div>
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-sm leading-relaxed text-subtle">Once you add more contacts, this panel will summarize cluster quality and coverage.</p>
              )}
            </div>
          )}

          <div className="bg-white border border-ink/15 rounded-card p-5">
            <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-subtle">
              <Link2 size={14} />
              Network Opportunities
            </div>
            <div className="space-y-3">
              {analysis.gapItems.length > 0 ? (
                analysis.gapItems.slice(0, 3).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => item.industryKey && setFocusIndustry(item.industryKey)}
                    className="min-h-11 w-full border border-ink/10 bg-paper/40 p-3 text-left transition-colors hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#617672] motion-reduce:transition-none"
                  >
                    <div className="font-semibold mb-1">{item.title}</div>
                    <p className="text-sm leading-relaxed text-subtle mb-2">{item.detail}</p>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">{item.action}</div>
                  </button>
                ))
              ) : (
                <div className="border border-ink/10 bg-paper/40 p-3 text-sm text-subtle">
                  Coverage looks balanced right now across the main clusters.
                </div>
              )}
            </div>
          </div>

          <div className="bg-white border border-ink/15 rounded-card p-5">
            <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-subtle">
              <Search size={14} />
              How To Read It
            </div>
            <div className="space-y-2 text-sm leading-relaxed text-subtle">
              <p>You sit in the middle. Each colored hub is an industry lane in your network.</p>
              <p>Contacts are arranged around their lane, so the structure shows where your coverage actually lives.</p>
              <p>Click a hub to isolate that lane, or click a person to open their detail card.</p>
            </div>
          </div>

          <div className="bg-white border border-ink/15 rounded-card p-5">
            <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-subtle">
              <AlertTriangle size={14} />
              Live Alerts
            </div>
            <div className="space-y-3">
              {analysis.alerts.length > 0 ? (
                analysis.alerts.map((alert) => (
                  <div key={alert.id} className={`border p-3 ${toneClasses(alert.tone)}`}>
                    <div className="font-mono text-[10px] uppercase tracking-widest mb-1">{alert.title}</div>
                    <p className="text-sm leading-relaxed">{alert.detail}</p>
                  </div>
                ))
              ) : (
                <div className="border border-ink/10 bg-paper/40 p-3 text-sm text-subtle">
                  No urgent network alerts right now.
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
