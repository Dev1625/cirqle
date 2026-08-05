import { createHash } from 'node:crypto';

export const MAX_CAPTURE_CONTACT_MATCHES = 10;

export function normalizeCaptureEmail(value) {
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

export function captureContactDocumentId(email) {
  const normalized = normalizeCaptureEmail(email);
  if (!normalized) return null;
  return `capture-email-${createHash('sha256')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, 40)}`;
}

export function captureRecordDocumentId(cardId, captureId) {
  return `capture-${createHash('sha256')
    .update(`${String(cardId || '')}\u0000${String(captureId || '')}`, 'utf8')
    .digest('hex')
    .slice(0, 40)}`;
}

export function captureFactDocumentId(cardId, captureId) {
  return `capture-evidence-${createHash('sha256')
    .update(`${String(cardId || '')}\u0000${String(captureId || '')}`, 'utf8')
    .digest('hex')
    .slice(0, 40)}`;
}

export function contactCanReceiveCapture(data) {
  if (!data || typeof data !== 'object') return false;
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

export function chooseExistingCaptureContact(documents, email) {
  const normalizedEmail = normalizeCaptureEmail(email);
  if (!normalizedEmail) return null;
  return (
    [...documents]
      .filter(
        (document) =>
          document?.exists &&
          contactCanReceiveCapture(document.data?.()) &&
          normalizeCaptureEmail(
            document.data?.()?.normalizedEmail ??
              document.data?.()?.email,
          ) === normalizedEmail,
      )
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ||
    null
  );
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function captureChannel(value) {
  return ['qr', 'nfc', 'link', 'direct'].includes(value) ? value : 'direct';
}

function channelLabel(channel) {
  if (channel === 'qr') return 'QR code';
  if (channel === 'nfc') return 'NFC card';
  if (channel === 'link') return 'shared link';
  return 'public card page';
}

export function buildCaptureEvidence({
  cardId,
  captureId,
  contactId,
  data,
  capturedAt,
  deduplicated,
}) {
  const channel = captureChannel(data?.captureChannel);
  const consentToFollowUp = data?.consentToFollowUp === true;
  const privacyNoticeVersion = cleanText(data?.privacyNoticeVersion, 80);
  const eventSessionId = cleanText(data?.eventSessionId, 120);
  const eventName = cleanText(data?.eventName, 160);
  const eventSource =
    data?.eventSource === 'calendar'
      ? 'calendar'
      : data?.eventSource === 'manual'
        ? 'manual'
        : null;
  const evidence =
    channel === 'direct' ? 'unmarked-url' : 'client-url-marker';

  return Object.freeze({
    schemaVersion: 1,
    sourceType: 'public-card',
    sourceId: String(captureId),
    cardId: String(cardId),
    contactId: String(contactId),
    visitorName: cleanText(data?.visitorName, 120) || 'Unknown',
    visitorEmail: normalizeCaptureEmail(data?.visitorEmail),
    visitorCompany: cleanText(data?.visitorCompany, 200),
    note: cleanText(data?.note, 500),
    capturedAt,
    channel,
    channelEvidence: evidence,
    channelVerified: false,
    consentToFollowUp,
    consentRecordedAt: consentToFollowUp ? capturedAt : null,
    privacyNoticeVersion,
    eventSessionId,
    eventName,
    eventSource,
    deduplicatedIntoExistingContact: deduplicated === true,
  });
}

export function captureEvidenceSummary(evidence) {
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
