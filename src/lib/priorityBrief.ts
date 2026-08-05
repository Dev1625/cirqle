import {
  generateGroundedText,
  groundingDisplay,
  type GroundedResult,
  type GroundedSource,
  type GroundingDisplay,
} from './grounding';
import { isContactAIEligible } from './contactManagementCore';

export interface PriorityBrief {
  text: string;
  grounding: GroundingDisplay;
}

function timestampMs(value: any): number {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestampIso(value: any): string | null {
  const milliseconds = timestampMs(value);
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}

export function buildPrioritySources(
  contacts: any[],
  outreaches: any[],
  limit = 15
): GroundedSource[] {
  const eligibleContacts = contacts.filter(isContactAIEligible);
  const eligibleContactIds = new Set(
    eligibleContacts.map((contact) => contact.id).filter(Boolean),
  );
  const recent = [...outreaches]
    .filter((outreach) => eligibleContactIds.has(outreach.contactId))
    .sort((a, b) => timestampMs(b.sentAt || b.createdAt) - timestampMs(a.sentAt || a.createdAt))
    .slice(0, limit);
  const contactIds = new Set(recent.map((outreach) => outreach.contactId).filter(Boolean));

  const contactSources: GroundedSource[] = eligibleContacts
    .filter((contact) => contact.id && contactIds.has(contact.id))
    .map((contact) => ({
      id: `contact-${contact.id}`,
      kind: 'contact',
      label: `Contact · ${contact.name || 'Unnamed'}`,
      text: JSON.stringify({
        name: contact.name || null,
        company: contact.company || null,
        role: contact.role || null,
        relationshipTier: contact.relationshipTier || null,
        whyTheyMatter: contact.whyTheyMatter || null,
      }),
    }));

  const outreachSources: GroundedSource[] = recent
    .filter((outreach) => outreach.id)
    .map((outreach) => ({
      id: `outreach-${outreach.id}`,
      kind: outreach.responseReceived === 'Yes' ? 'reply' : 'outreach',
      label: `Tracker item · ${timestampIso(outreach.sentAt || outreach.createdAt) || 'undated'}`,
      observedAt: timestampIso(outreach.sentAt || outreach.createdAt),
      text: JSON.stringify({
        contactId: outreach.contactId || null,
        subject: outreach.subject || null,
        channel: outreach.channel || outreach.type || null,
        trackerStatus: outreach.status || null,
        nextAction: outreach.nextAction || null,
        responseReceived: outreach.responseReceived || null,
        responseSnippet: outreach.responseSnippet || null,
        deliveryVerification: outreach.deliveryVerification || null,
      }),
    }));

  return [...contactSources, ...outreachSources];
}

export async function generateWeeklyPriorities(
  contacts: any[],
  outreaches: any[],
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<{ grounded: GroundedResult<string>; sources: GroundedSource[] }> {
  const sources = buildPrioritySources(contacts, outreaches);
  const grounded = await generateGroundedText({
    task: `Write a very short "This Week's Priorities" brief from the saved CRM evidence. Use at most three bullet points. Focus on concrete follow-ups, thanks, replies, and overdue actions.`,
    sources,
    rules: [
      'Treat trackerStatus as a user-managed workflow label, not proof an email was sent, delivered, opened, or answered.',
      'Only say a reply happened when responseReceived or a reply source explicitly says so.',
      'Name a person only when their contact source is present.',
      'Do not suggest a specific relationship history, attachment, news event, or company development unless a source explicitly records it.',
      'If the saved records are too thin for three useful priorities, return fewer bullets.',
    ],
    options: {
      tier: 'reasoning',
      timeoutMs,
      maxTokens: 500,
      feature: 'dashboard-weekly-priorities',
      signal,
    },
  });
  if (
    grounded.result.trim() &&
    !grounded.usedSourceIds.some((id) => id.startsWith('outreach-'))
  ) {
    throw new Error('The priorities brief did not cite a tracker item.');
  }
  return { grounded, sources };
}

export function toPriorityBrief(
  grounded: GroundedResult<string>,
  sources: GroundedSource[]
): PriorityBrief {
  return {
    text: grounded.result.trim(),
    grounding: groundingDisplay(grounded, sources),
  };
}

export function encodePriorityBrief(value: PriorityBrief): string {
  return JSON.stringify({ version: 1, ...value });
}

export function decodePriorityBrief(value: string | null): PriorityBrief | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (
      parsed?.version !== 1 ||
      typeof parsed.text !== 'string' ||
      !Array.isArray(parsed.grounding?.usedSourceIds) ||
      !Array.isArray(parsed.grounding?.unsupportedAssumptions) ||
      typeof parsed.grounding?.sourceLabels !== 'object' ||
      typeof parsed.grounding?.generatedAt !== 'string'
    ) {
      return null;
    }
    return { text: parsed.text, grounding: parsed.grounding };
  } catch {
    // Legacy caches stored only raw model text. Regenerate so every displayed
    // result has source IDs instead of presenting unverifiable old output.
    return null;
  }
}
