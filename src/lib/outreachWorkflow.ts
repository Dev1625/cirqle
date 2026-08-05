import type { GroundedSource } from './grounding';
import type {
  OutreachDeliveryStatus,
  OutreachVerification,
} from './outreach';

export const OUTREACH_AI_FEATURES = {
  processReply: 'contact.reply.process',
  extractTags: 'contact.tags.extract',
  draftQuick: 'contact.outreach.draft.quick',
  draftPremium: 'contact.outreach.draft.premium',
} as const;

export const TEMPLATE_VARIABLES = [
  'contact_name',
  'first_name',
  'company',
  'role',
  'user_name',
  'user_role',
  'goal',
  'ask',
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export interface TemplateContext {
  contactName?: string | null;
  company?: string | null;
  role?: string | null;
  userName?: string | null;
  userRole?: string | null;
  goal?: string | null;
  ask?: string | null;
}

export interface RenderedTemplate {
  subject: string;
  body: string;
  unresolvedVariables: string[];
}

export interface DraftGroundingIssue {
  code:
    | 'unsupported-assumption'
    | 'invented-attachment'
    | 'invented-history'
    | 'invented-news';
  message: string;
}

export interface GroundedTagCandidate {
  label?: string | null;
  evidenceQuote?: string | null;
}

export interface OutreachRecordLike {
  id: string;
  subject?: string | null;
  status?: string | null;
  verification?: OutreachVerification | null;
  threadId?: string | null;
}

export interface DeliveryStateFields {
  status: OutreachDeliveryStatus;
  verification: OutreachVerification;
  responseReceived: 'No';
  threadId: string | null;
}

const VARIABLE_PATTERN = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const ATTACHMENT_PATTERN =
  /\b(attached|attachment|enclosed|one[- ]pager|deck|document|proposal|resume|file|please find attached)\b/i;
const ATTACHMENT_EVIDENCE_PATTERN =
  /\b(attach(?:ed|ment|ing)?|enclos(?:ed|ure)|(?:include|send)(?:d|ing)?\s+(?:the|a|an|my|our)?\s*(?:one[- ]pager|deck|document|proposal|resume|file))\b/i;
const HISTORY_CLAIM_PATTERN =
  /\b(as (?:we|you) discussed|when we (?:spoke|met)|our (?:last|recent) (?:call|conversation|meeting)|great (?:speaking|meeting|chatting|connecting|catching up) with you|following up on our)\b/i;
const HISTORY_EVIDENCE_PATTERN =
  /\b(spoke|met|meeting|call|conversation|discussed|replied|reply|responded)\b/i;
const NEWS_CLAIM_PATTERN =
  /\b(your recent|recently announced|saw (?:the|your)|read (?:the|your)|noticed your|came across (?:the|your)|heard about (?:the|your)|been following|congratulations on|exciting news)\b/i;
const NEWS_EVIDENCE_PATTERN =
  /\b(recent|announced|announcement|news|launched|launching|published|article|promotion|award)\b/i;

function cleanValue(value?: string | null): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return /^none|n\/a|not applicable$/i.test(trimmed) ? '' : trimmed;
}

function normalizeEvidenceText(value: string): string {
  return value
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function validatedGroundedTags(
  candidates: GroundedTagCandidate[] | null | undefined,
  evidence: string,
): string[] {
  const normalizedEvidence = normalizeEvidenceText(evidence);
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => {
      const quote = normalizeEvidenceText(candidate?.evidenceQuote || '');
      return quote.length >= 3 && normalizedEvidence.includes(quote);
    })
    // The persisted tag is built from the verified quote itself. A model may
    // suggest a prettier label, but it cannot smuggle a different fact into
    // that label after citing an unrelated sentence.
    .map((candidate) => {
      const quote = cleanValue(candidate.evidenceQuote)
        .replace(/\s+/g, ' ')
        .replace(/[.!?]+$/, '')
        .slice(0, 86);
      return quote ? `Mentioned: ${quote}`.slice(0, 100) : '';
    })
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 8);
}

export function templateValues(
  context: TemplateContext,
): Record<TemplateVariable, string> {
  const contactName = cleanValue(context.contactName);
  return {
    contact_name: contactName,
    first_name: contactName.split(/\s+/)[0] || '',
    company: cleanValue(context.company),
    role: cleanValue(context.role),
    user_name: cleanValue(context.userName),
    user_role: cleanValue(context.userRole),
    goal: cleanValue(context.goal),
    ask: cleanValue(context.ask),
  };
}

export function renderTemplate(
  template: { subject?: string | null; body?: string | null },
  context: TemplateContext,
): RenderedTemplate {
  const values = templateValues(context);
  const unresolved = new Set<string>();
  const interpolate = (value?: string | null) =>
    (value || '').replace(VARIABLE_PATTERN, (match, rawName: string) => {
      if (!(rawName in values)) {
        unresolved.add(rawName);
        return match;
      }
      const resolved = values[rawName as TemplateVariable];
      if (!resolved) {
        unresolved.add(rawName);
        return match;
      }
      return resolved;
    });

  return {
    subject: interpolate(template.subject),
    body: interpolate(template.body),
    unresolvedVariables: [...unresolved].sort(),
  };
}

export function unresolvedTemplateVariables(
  ...values: Array<string | null | undefined>
): string[] {
  const unresolved = new Set<string>();
  for (const value of values) {
    for (const match of (value || '').matchAll(VARIABLE_PATTERN)) {
      unresolved.add(match[1]);
    }
  }
  return [...unresolved].sort();
}

/**
 * Returns only a deliberately selected outreach. An empty or stale id never
 * falls back to "the latest" record, because that can mutate the wrong thread.
 */
export function selectReplyTarget<T extends OutreachRecordLike>(
  outreaches: T[],
  selectedId?: string | null,
): T | null {
  if (!selectedId) return null;
  return outreaches.find((outreach) => outreach.id === selectedId) || null;
}

/**
 * Deterministic final gate for the three hallucination classes observed in
 * production QA. The model's own disclosures are included, but risky claims
 * are also checked independently so silence from the model is not treated as
 * proof.
 */
export function reviewDraftGrounding(params: {
  draft: { subject?: string | null; body?: string | null };
  sources: GroundedSource[];
  unsupportedAssumptions?: string[];
}): DraftGroundingIssue[] {
  const draftText = `${params.draft.subject || ''}\n${params.draft.body || ''}`;
  // Templates constrain form and wording; they are not evidence that an
  // attachment, prior interaction, or news event actually exists.
  const evidenceText = params.sources
    .filter((source) => !source.id.startsWith('template-'))
    .map((source) => source.text)
    .join('\n');
  const issues: DraftGroundingIssue[] = [];

  for (const assumption of params.unsupportedAssumptions || []) {
    if (!assumption.trim()) continue;
    issues.push({
      code: 'unsupported-assumption',
      message: assumption.trim(),
    });
  }

  if (
    ATTACHMENT_PATTERN.test(draftText) &&
    !ATTACHMENT_EVIDENCE_PATTERN.test(evidenceText)
  ) {
    issues.push({
      code: 'invented-attachment',
      message:
        'The draft refers to an attachment or document that is not present in the selected evidence.',
    });
  }

  if (
    HISTORY_CLAIM_PATTERN.test(draftText) &&
    !HISTORY_EVIDENCE_PATTERN.test(evidenceText)
  ) {
    issues.push({
      code: 'invented-history',
      message:
        'The draft implies a prior conversation or meeting that is not present in the selected evidence.',
    });
  }

  if (
    NEWS_CLAIM_PATTERN.test(draftText) &&
    !NEWS_EVIDENCE_PATTERN.test(evidenceText)
  ) {
    issues.push({
      code: 'invented-news',
      message:
        'The draft refers to recent news or activity that is not present in the selected evidence.',
    });
  }

  return issues.filter(
    (issue, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.code === issue.code && candidate.message === issue.message,
      ) === index,
  );
}

export function openedInMailClientState(): DeliveryStateFields {
  return {
    status: 'Opened in Mail Client',
    verification: 'none',
    responseReceived: 'No',
    threadId: null,
  };
}

export function userConfirmedSendState(): DeliveryStateFields {
  return {
    status: 'Sent (User Confirmed)',
    verification: 'user-confirmed',
    responseReceived: 'No',
    threadId: null,
  };
}

export function providerVerifiedSendState(
  threadId: string,
): DeliveryStateFields {
  if (!threadId.trim()) {
    throw new Error('A provider-verified send requires a thread id.');
  }
  return {
    status: 'Sent (Provider Verified)',
    verification: 'provider-verified',
    responseReceived: 'No',
    threadId,
  };
}

export function deliveryProofLabel(record: OutreachRecordLike): string {
  if (
    record.verification === 'provider-verified' &&
    typeof record.threadId === 'string' &&
    record.threadId
  ) {
    return 'Provider verified';
  }
  if (record.verification === 'user-confirmed') return 'Confirmed by you';
  if (record.verification === 'preview-simulated') return 'Preview simulation';
  if (record.status === 'Opened in Mail Client') return 'Not confirmed sent';
  if (
    (!record.verification || record.verification === 'none') &&
    ['Sent', 'Awaiting Response'].includes(record.status || '')
  ) {
    return 'Legacy record · verification unknown';
  }
  if (record.status === 'Responded') {
    return 'Reply recorded · send proof unchanged';
  }
  return 'No delivery proof';
}
