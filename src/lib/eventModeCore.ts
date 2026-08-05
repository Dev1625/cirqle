export type EventSessionSource = 'manual' | 'calendar';
export type EventSessionStatus = 'active' | 'completed';
export type EventCaptureChannel =
  | 'nfc'
  | 'qr'
  | 'shared-link'
  | 'public-card'
  | 'unknown';
export type EventConsentState =
  | 'follow-up-consented'
  | 'consented-no-channel'
  | 'no-follow-up-consent';

export interface EventSessionIdentity {
  sessionId: string;
  eventName: string;
  source: EventSessionSource;
  status: EventSessionStatus;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface EventCaptureProvenance {
  channel: EventCaptureChannel;
  label: string;
  confidence: 'recorded' | 'inferred' | 'unknown';
  evidence: 'client-url-marker' | 'unmarked-url' | 'legacy-record';
  verifiedHardware: false;
  /** The private source record. It is only returned in the organizer view. */
  sourceId: string | null;
  capturedAt: Date | null;
}

export interface EventContactInput {
  id: string;
  name?: unknown;
  company?: unknown;
  email?: unknown;
  consentToFollowUp?: unknown;
  capturedAt?: unknown;
  capturedVia?: unknown;
  captureChannel?: unknown;
  captureProvenance?: unknown;
}

export interface EventRecapContact {
  id: string;
  name: string;
  company: string | null;
  hasFollowUpChannel: boolean;
  consentState: EventConsentState;
  outreachAllowed: boolean;
  provenance: EventCaptureProvenance;
}

export type EventNextActionKind =
  | 'follow-up'
  | 'confirm-channel'
  | 'review-only';

export interface EventNextAction {
  id: string;
  contactId: string;
  contactName: string;
  kind: EventNextActionKind;
  priority: 'now' | 'soon' | 'when-relevant';
  dueAt: Date | null;
  outreachAllowed: boolean;
  label: string;
  reason: string;
}

export interface DeterministicEventRecap {
  session: EventSessionIdentity;
  eventSessionId: string;
  eventName: string;
  contactCount: number;
  consentedCount: number;
  suggestedFollowUps: number;
  contacts: EventRecapContact[];
  nextActions: EventNextAction[];
  channelCounts: Record<EventCaptureChannel, number>;
  headline: string;
  generatedWithoutAI: true;
}

export interface OrganizerEventMap {
  scope: 'organizer';
  totalAttendees: number;
  nodes: Array<{
    id: string;
    label: string;
    kind: 'organizer' | 'attendee';
    company: string | null;
    private: true;
  }>;
  edges: Array<{
    from: string;
    to: string;
    relationship: 'event-capture';
    private: true;
  }>;
  disclaimer: string;
}

export interface PrivacySafeEventMap {
  scope: 'attendee' | 'public';
  totalAttendees: number;
  cohorts: Array<{ label: string; attendeeCount: number }>;
  suppressedAttendees: number;
  disclaimer: string;
}

export type EventAudienceMap = OrganizerEventMap | PrivacySafeEventMap;

const FOLLOW_UP_WINDOW_MS = 48 * 60 * 60 * 1000;
const PUBLIC_COHORT_MINIMUM = 3;

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(value.getTime());
  }
  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    return date instanceof Date && Number.isFinite(date.getTime())
      ? new Date(date.getTime())
      : null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function normalizeChannel(value: unknown): EventCaptureChannel {
  const channel = cleanText(value, 80)?.toLowerCase() || '';
  if (channel === 'nfc' || channel === 'nfc-card' || channel === 'physical-card') {
    return 'nfc';
  }
  if (channel === 'qr' || channel === 'qr-code') return 'qr';
  if (
    channel === 'shared-link' ||
    channel === 'link' ||
    channel === 'copied-link'
  ) {
    return 'shared-link';
  }
  if (channel === 'public-card' || channel === 'card-page') {
    return 'public-card';
  }
  if (channel === 'direct') return 'public-card';
  return 'unknown';
}

const CHANNEL_LABEL: Record<EventCaptureChannel, string> = {
  nfc: 'NFC card',
  qr: 'QR code',
  'shared-link': 'Shared link',
  'public-card': 'Public card page',
  unknown: 'Public card (channel not recorded)',
};

export function createEventSessionIdentity(input: {
  sessionId: string;
  eventName: string;
  source?: EventSessionSource | null;
  active?: boolean;
  startedAt?: unknown;
  endedAt?: unknown;
}): EventSessionIdentity {
  const sessionId = cleanText(input.sessionId, 120);
  const eventName = cleanText(input.eventName, 160);
  if (!sessionId) throw new Error('An event session id is required.');
  if (!eventName) throw new Error('An event name is required.');

  const active = input.active === true;
  return {
    sessionId,
    eventName,
    source: input.source === 'calendar' ? 'calendar' : 'manual',
    status: active ? 'active' : 'completed',
    startedAt: asDate(input.startedAt),
    endedAt: active ? null : asDate(input.endedAt),
  };
}

export function captureProvenanceFor(
  contact: EventContactInput,
): EventCaptureProvenance {
  const nested =
    contact.captureProvenance &&
    typeof contact.captureProvenance === 'object'
      ? (contact.captureProvenance as Record<string, unknown>)
      : {};
  const recorded =
    contact.captureChannel ??
    nested.channel ??
    nested.captureChannel ??
    contact.capturedVia;
  const channel = normalizeChannel(recorded);
  const evidence =
    nested.channelEvidence === 'client-url-marker'
      ? 'client-url-marker'
      : nested.channelEvidence === 'unmarked-url' || recorded === 'direct'
        ? 'unmarked-url'
        : 'legacy-record';

  return {
    channel,
    label: CHANNEL_LABEL[channel],
    confidence: recorded
      ? channel === 'unknown'
        ? 'inferred'
        : 'recorded'
      : 'unknown',
    evidence,
    verifiedHardware: false,
    sourceId: cleanText(nested.sourceId, 200),
    capturedAt: asDate(contact.capturedAt ?? nested.capturedAt),
  };
}

function consentStateFor(contact: EventContactInput): EventConsentState {
  if (contact.consentToFollowUp !== true) return 'no-follow-up-consent';
  return cleanText(contact.email, 320)
    ? 'follow-up-consented'
    : 'consented-no-channel';
}

function actionFor(contact: EventRecapContact): EventNextAction {
  const capturedAt = contact.provenance.capturedAt;
  if (contact.consentState === 'follow-up-consented') {
    return {
      id: `${contact.id}:follow-up`,
      contactId: contact.id,
      contactName: contact.name,
      kind: 'follow-up',
      priority: 'now',
      dueAt: capturedAt
        ? new Date(capturedAt.getTime() + FOLLOW_UP_WINDOW_MS)
        : null,
      outreachAllowed: true,
      label: `Follow up with ${contact.name}`,
      reason:
        'They explicitly allowed a follow-up and shared a contact channel.',
    };
  }
  if (contact.consentState === 'consented-no-channel') {
    return {
      id: `${contact.id}:confirm-channel`,
      contactId: contact.id,
      contactName: contact.name,
      kind: 'confirm-channel',
      priority: 'soon',
      dueAt: null,
      outreachAllowed: false,
      label: `Confirm a channel with ${contact.name}`,
      reason:
        'They allowed a follow-up but did not share a usable contact channel.',
    };
  }
  return {
    id: `${contact.id}:review-only`,
    contactId: contact.id,
    contactName: contact.name,
    kind: 'review-only',
    priority: 'when-relevant',
    dueAt: null,
    outreachAllowed: false,
    label: `Keep ${contact.name} as private event context`,
    reason:
      'No follow-up consent was recorded, so this record must not create outreach.',
  };
}

const PRIORITY_ORDER: Record<EventNextAction['priority'], number> = {
  now: 0,
  soon: 1,
  'when-relevant': 2,
};

export function buildDeterministicEventRecap(input: {
  session: EventSessionIdentity;
  contacts: EventContactInput[];
}): DeterministicEventRecap {
  const contacts = input.contacts
    .map((contact, index): EventRecapContact => {
      const id = cleanText(contact.id, 200) || `event-contact-${index + 1}`;
      const consentState = consentStateFor(contact);
      return {
        id,
        name: cleanText(contact.name, 120) || 'Unknown attendee',
        company: cleanText(contact.company, 200),
        hasFollowUpChannel: Boolean(cleanText(contact.email, 320)),
        consentState,
        outreachAllowed: consentState === 'follow-up-consented',
        provenance: captureProvenanceFor(contact),
      };
    })
    .sort((left, right) => {
      const leftTime = left.provenance.capturedAt?.getTime() ?? Infinity;
      const rightTime = right.provenance.capturedAt?.getTime() ?? Infinity;
      return (
        leftTime - rightTime ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
      );
    });

  const nextActions = contacts
    .map(actionFor)
    .sort(
      (left, right) =>
        PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
        (left.dueAt?.getTime() ?? Infinity) -
          (right.dueAt?.getTime() ?? Infinity) ||
        left.contactName.localeCompare(right.contactName),
    );
  const channelCounts: Record<EventCaptureChannel, number> = {
    nfc: 0,
    qr: 0,
    'shared-link': 0,
    'public-card': 0,
    unknown: 0,
  };
  for (const contact of contacts) {
    channelCounts[contact.provenance.channel] += 1;
  }

  const consentedCount = contacts.filter(
    (contact) => contact.consentState !== 'no-follow-up-consent',
  ).length;
  const suggestedFollowUps = contacts.filter(
    (contact) => contact.outreachAllowed,
  ).length;
  const headline =
    contacts.length === 0
      ? `No captures at ${input.session.eventName} yet.`
      : `${input.session.eventName}: ${contacts.length} new contact${
          contacts.length === 1 ? '' : 's'
        }, ${suggestedFollowUps} consented follow-up${
          suggestedFollowUps === 1 ? '' : 's'
        }.`;

  return {
    session: input.session,
    eventSessionId: input.session.sessionId,
    eventName: input.session.eventName,
    contactCount: contacts.length,
    consentedCount,
    suggestedFollowUps,
    contacts,
    nextActions,
    channelCounts,
    headline,
    generatedWithoutAI: true,
  };
}

/**
 * The organizer view is private and may name the owner's contacts. Attendee
 * and public views are aggregate-only. Company cohorts smaller than three are
 * suppressed so a one-person company cannot identify an attendee by itself.
 */
export function buildEventAudienceMap(
  recap: DeterministicEventRecap,
  scope: 'organizer',
  organizerLabel?: string,
): OrganizerEventMap;
export function buildEventAudienceMap(
  recap: DeterministicEventRecap,
  scope: 'attendee' | 'public',
  organizerLabel?: string,
): PrivacySafeEventMap;
export function buildEventAudienceMap(
  recap: DeterministicEventRecap,
  scope: 'organizer' | 'attendee' | 'public',
  organizerLabel = 'You',
): EventAudienceMap {
  if (scope === 'organizer') {
    const organizerId = `organizer:${recap.eventSessionId}`;
    return {
      scope,
      totalAttendees: recap.contactCount,
      nodes: [
        {
          id: organizerId,
          label: cleanText(organizerLabel, 120) || 'You',
          kind: 'organizer',
          company: null,
          private: true,
        },
        ...recap.contacts.map((contact) => ({
          id: `attendee:${contact.id}`,
          label: contact.name,
          kind: 'attendee' as const,
          company: contact.company,
          private: true as const,
        })),
      ],
      edges: recap.contacts.map((contact) => ({
        from: organizerId,
        to: `attendee:${contact.id}`,
        relationship: 'event-capture' as const,
        private: true as const,
      })),
      disclaimer:
        'Organizer-only map. Contact names and source records never appear on the public card.',
    };
  }

  const counts = new Map<string, number>();
  for (const contact of recap.contacts) {
    if (!contact.company) continue;
    counts.set(contact.company, (counts.get(contact.company) || 0) + 1);
  }
  const cohorts = [...counts]
    .filter(([, count]) => count >= PUBLIC_COHORT_MINIMUM)
    .map(([company, attendeeCount]) => ({
      label: `${company} cohort`,
      attendeeCount,
    }))
    .sort(
      (left, right) =>
        right.attendeeCount - left.attendeeCount ||
        left.label.localeCompare(right.label),
    );
  const represented = cohorts.reduce(
    (total, cohort) => total + cohort.attendeeCount,
    0,
  );

  return {
    scope,
    totalAttendees: recap.contactCount,
    cohorts,
    suppressedAttendees: recap.contactCount - represented,
    disclaimer:
      'Aggregate-only event map. It contains no contact names, ids, email addresses, source ids, or individual edges.',
  };
}
