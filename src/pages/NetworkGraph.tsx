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
  Flame,
  Link2,
  Network,
  Radar,
  Search,
  Users
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { db } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { TierBadge } from '../components/ui/TierBadge';
import { AccentRule } from '../components/ui/AccentRule';

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
    const meetingCount = contactOutreaches.filter((outreach) => outreach.meetingHeld).length;
    const referralCount = contactOutreaches.filter((outreach) => outreach.referralGenerated).length;
    const tier = getTier(contact.relationshipTier);
    const interactionCount = contactNotes.length + contactOutreaches.length;
    const lastTouchDays = daysSince(lastTouch);
    const responseRate = contactOutreaches.length > 0 ? responseCount / contactOutreaches.length : 0;
    const score = clamp(
      18
        + (tier === 'Strong' ? 34 : tier === 'Warm' ? 25 : tier === 'Dormant' ? 10 : 16)
        + interactionCount * 4.5
        + responseCount * 4
        + meetingCount * 5
        + referralCount * 8
        - (lastTouchDays > 120 ? 18 : lastTouchDays > 60 ? 9 : 0),
      10,
      100
    );

    insights[contact.id] = {
      score,
      radius: clamp(9 + score * 0.14, 10, 24),
      lastTouch,
      lastTouchDays,
      responseRate,
      outreachCount: contactOutreaches.length,
      notesCount: contactNotes.length,
      recentPulse: lastTouchDays <= 7,
      seniorityBucket: getSeniorityBucket(contact),
      locationBucket: getLocationBucket(contact.location),
      hasReferral: referralCount > 0
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

export default function NetworkGraph() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [profile, setProfile] = useState<any>(null);
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [outreaches, setOutreaches] = useState<OutreachRecord[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [searchText, setSearchText] = useState('');
  const [focusIndustry, setFocusIndustry] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState(false);
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
          setContacts(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as ContactRecord)));
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
        setConnections(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as ConnectionRecord)));
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

  const isNodeFaded = (node: GraphNodeDatum) => {
    if (node.kind === 'contact' || node.kind === 'industry') {
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
        <div className="border border-red-300 bg-red-50 p-4 font-mono text-xs leading-relaxed text-red-800">
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
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" size={16} />
            <Input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Search firms, names, tags, cities..."
              className="pl-10 bg-paper/40"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="group relative">
              <button
                onClick={() => setDetailMode((current) => !current)}
                className={`tour-graph-detail-toggle font-mono text-[10px] uppercase tracking-widest border px-3 py-2 transition-colors ${
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
                className="font-mono text-[10px] uppercase tracking-widest border border-ink/20 px-3 py-2 bg-white hover:bg-paper transition-colors"
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
              onClick={() => setFocusIndustry((current) => current === cluster.key ? null : cluster.key)}
              className={`inline-flex items-center gap-2 border px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-colors ${
                focusIndustry === cluster.key ? 'border-ink bg-accent text-ink' : 'border-ink/20 bg-white hover:bg-paper'
              }`}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: INDUSTRY_COLORS[cluster.key].color }} />
              {cluster.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1.45fr)_360px]">
        <section className="self-start bg-white border border-ink/15 rounded-card overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-ink/15 bg-[#F8F5EF] p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-serif text-2xl italic font-bold">Live Network Surface</h2>
              <p className="font-mono text-[10px] uppercase tracking-widest text-subtle mt-1">
                Clean graph surface with optional relationship signal detail
              </p>
            </div>
            <div className="flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-widest text-subtle">
              <span>{analysis.nodes.length} nodes</span>
              <span>{analysis.links.length} links</span>
            </div>
          </div>

          <div ref={containerRef} className="tour-graph-node relative h-[400px] md:h-[460px] bg-paper overflow-hidden">
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

                  let base = link.kind === 'backbone' ? 0.24 : link.kind === 'membership' ? 0.13 : 0.18;
                  const faded = isLinkFaded(link);
                  if (faded) base = 0.07;
                  if (hoverId) {
                    const touches = sourceId === hoverId || targetId === hoverId;
                    base = touches ? base * (1 - hp) + 0.42 * hp : base * (1 - 0.85 * hp);
                  }

                  let width = link.weight;
                  if (faded) width = 0.5;
                  else if (hoverId && (sourceId === hoverId || targetId === hoverId)) {
                    width = link.weight + 1.4 * hp;
                  }

                  context.save();
                  context.strokeStyle = `rgba(26,26,26,${base.toFixed(3)})`;
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
                <div className="animate-fade-in bg-white border border-ink/15 rounded-card shadow-float px-3 py-2 max-w-[230px]">
                  <div className="flex items-center gap-2">
                    <span className="font-serif text-sm font-bold leading-tight">{hoverNode.name}</span>
                    {hoverNode.tier && <TierBadge tier={hoverNode.tier} className="!px-1.5 !py-0.5 !text-[8px]" />}
                  </div>
                  {hoverNode.subtitle && (
                    <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-muted">{hoverNode.subtitle}</p>
                  )}
                  {hoverNode.kind === 'contact' && (
                    <p className="mt-1.5 font-mono text-[9px] uppercase tracking-widest text-brand">Click to open</p>
                  )}
                </div>
              </div>
            )}

          </div>
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
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold text-white"
                  style={{ backgroundColor: selectedNode.color }}
                >
                  {selectedNode.initials}
                </span>
              </div>

              <div className="mb-4 bg-paper/50 border border-ink/10 p-4">
                <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-subtle mb-2">
                  <span>Relationship Strength</span>
                  <span>{Math.round(selectedInsight.score)}/100</span>
                </div>
                <div className="h-2 bg-white border border-ink/10">
                  <div
                    className="h-full"
                    style={{
                      width: `${selectedInsight.score}%`,
                      background: `linear-gradient(90deg, ${selectedNode.color}, #617672)`
                    }}
                  />
                </div>
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
              </div>

              <div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-subtle mb-2">Nearby In This Lane</div>
                <div className="space-y-2">
                  {selectedNeighbors.length > 0 ? (
                    selectedNeighbors.map((neighbor) => (
                      <button
                        key={neighbor.id}
                        onClick={() => setSelectedNodeId(neighbor.id)}
                        className="w-full border border-ink/10 bg-paper/40 p-3 text-left hover:bg-paper transition-colors"
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
                    onClick={() => item.industryKey && setFocusIndustry(item.industryKey)}
                    className="w-full border border-ink/10 bg-paper/40 p-3 text-left hover:bg-paper transition-colors"
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
