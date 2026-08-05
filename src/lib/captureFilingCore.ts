export const MAX_CAPTURE_CONTACT_MATCHES = 10;

export function normalizeCaptureEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function captureContactDocumentId(
  email: unknown,
): Promise<string | null> {
  const normalized = normalizeCaptureEmail(email);
  if (!normalized) return null;
  return `capture-email-${(await sha256Hex(normalized)).slice(0, 40)}`;
}

export async function captureRecordDocumentId(
  cardId: string,
  captureId: string,
): Promise<string> {
  return `capture-${(
    await sha256Hex(`${cardId}\u0000${captureId}`)
  ).slice(0, 40)}`;
}

export async function captureFactDocumentId(
  cardId: string,
  captureId: string,
): Promise<string> {
  return `capture-evidence-${(
    await sha256Hex(`${cardId}\u0000${captureId}`)
  ).slice(0, 40)}`;
}

export function contactCanReceiveCapture(
  data: Record<string, unknown> | null | undefined,
): boolean {
  if (!data) return false;
  if (data.purgeFence != null) return false;
  if (data.lifecycleStatus === 'deleted') return false;
  if (
    typeof data.mergedIntoContactId === 'string' &&
    data.mergedIntoContactId.trim()
  ) {
    return false;
  }
  return true;
}

export interface CaptureContactCandidate {
  id: string;
  data: Record<string, unknown>;
}

export function chooseExistingCaptureContact(
  candidates: CaptureContactCandidate[],
  email: unknown,
): CaptureContactCandidate | null {
  const normalizedEmail = normalizeCaptureEmail(email);
  if (!normalizedEmail) return null;
  return (
    [...candidates]
      .filter(
        (candidate) =>
          contactCanReceiveCapture(candidate.data) &&
          normalizeCaptureEmail(
            candidate.data.normalizedEmail ?? candidate.data.email,
          ) === normalizedEmail,
      )
      .sort((left, right) => left.id.localeCompare(right.id))[0] || null
  );
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function normalizedChannel(value: unknown): 'qr' | 'nfc' | 'link' | 'direct' {
  return value === 'qr' ||
    value === 'nfc' ||
    value === 'link' ||
    value === 'direct'
    ? value
    : 'direct';
}

function channelLabel(channel: CaptureEvidence['channel']): string {
  if (channel === 'qr') return 'QR code';
  if (channel === 'nfc') return 'NFC card';
  if (channel === 'link') return 'shared link';
  return 'public card page';
}

export interface CaptureEvidence {
  schemaVersion: 1;
  sourceType: 'public-card';
  sourceId: string;
  cardId: string;
  contactId: string;
  visitorName: string;
  visitorEmail: string | null;
  visitorCompany: string | null;
  note: string | null;
  capturedAt: Date;
  channel: 'qr' | 'nfc' | 'link' | 'direct';
  channelEvidence: 'client-url-marker' | 'unmarked-url';
  channelVerified: false;
  consentToFollowUp: boolean;
  consentRecordedAt: Date | null;
  privacyNoticeVersion: string | null;
  eventSessionId: string | null;
  eventName: string | null;
  eventSource: 'manual' | 'calendar' | null;
  deduplicatedIntoExistingContact: boolean;
}

export function buildCaptureEvidence(params: {
  cardId: string;
  captureId: string;
  contactId: string;
  data: Record<string, unknown>;
  capturedAt: Date;
  deduplicated: boolean;
}): CaptureEvidence {
  const channel = normalizedChannel(params.data.captureChannel);
  const consentToFollowUp = params.data.consentToFollowUp === true;
  return Object.freeze({
    schemaVersion: 1,
    sourceType: 'public-card',
    sourceId: params.captureId,
    cardId: params.cardId,
    contactId: params.contactId,
    visitorName: cleanText(params.data.visitorName, 120) || 'Unknown',
    visitorEmail: normalizeCaptureEmail(params.data.visitorEmail),
    visitorCompany: cleanText(params.data.visitorCompany, 200),
    note: cleanText(params.data.note, 500),
    capturedAt: params.capturedAt,
    channel,
    channelEvidence:
      channel === 'direct' ? 'unmarked-url' : 'client-url-marker',
    channelVerified: false,
    consentToFollowUp,
    consentRecordedAt: consentToFollowUp ? params.capturedAt : null,
    privacyNoticeVersion: cleanText(
      params.data.privacyNoticeVersion,
      80,
    ),
    eventSessionId: cleanText(params.data.eventSessionId, 120),
    eventName: cleanText(params.data.eventName, 160),
    eventSource:
      params.data.eventSource === 'calendar'
        ? 'calendar'
        : params.data.eventSource === 'manual'
          ? 'manual'
          : null,
    deduplicatedIntoExistingContact: params.deduplicated,
  });
}

export function captureEvidenceSummary(evidence: CaptureEvidence): string {
  const parts = [
    `Captured via ${channelLabel(evidence.channel)}`,
    evidence.channelEvidence === 'client-url-marker'
      ? 'channel came from the issued URL marker; hardware was not verified'
      : 'channel came from an unmarked direct URL; hardware was not verified',
    evidence.consentToFollowUp
      ? `follow-up consent granted${
          evidence.privacyNoticeVersion
            ? ` under privacy notice ${evidence.privacyNoticeVersion}`
            : ''
        }`
      : `follow-up consent not granted${
          evidence.privacyNoticeVersion
            ? ` under privacy notice ${evidence.privacyNoticeVersion}`
            : ''
        }`,
    evidence.eventName
      ? `event ${evidence.eventName}${
          evidence.eventSessionId
            ? ` (session ${evidence.eventSessionId})`
            : ''
        }${evidence.eventSource ? `, source ${evidence.eventSource}` : ''}`
      : 'no event session recorded',
    `source capture ${evidence.sourceId}`,
  ];
  return parts.join('; ');
}
