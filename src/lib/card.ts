import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { db, getFirebaseAppCheckToken } from '../config/firebase';
import type { GroundingDisplay } from './grounding';
import {
  hasCardValidationErrors,
  validateCardConfig,
} from './cardValidation';
export {
  clearStoredVisitorName,
  getStoredVisitorName,
  storeVisitorName,
} from './publicCardVisitor';

/**
 * The public card's software half, shared by NFC, QR, and copied links.
 *
 * A physical NFC tag is just a chip that opens a URL, so everything a real
 * card would need already exists once /c/:cardId does. Provisioning hardware
 * later is a write-the-URL-to-the-tag step with no further software work.
 *
 * The asymmetry is the point. A paper business card is a one-way transfer:
 * they keep your details, you keep nothing. Here, saving the contact writes a
 * capture back to the *owner's* account, pre-filled with timestamp and — when
 * Calendar is connected, real or mock — where they probably were. The owner
 * gets a filed contact back, not just a vCard on someone else's phone.
 */

export type CardLayout = 'compact' | 'expanded';
export type CardMode = 'ai' | 'custom' | 'ported';

/**
 * Accent presets are drawn from palette that already exists in the app — the
 * oxblood brand token and the NetworkGraph industry lanes (DESIGN.md §2).
 * No new colours were introduced for this feature; a card can look different
 * from the app without looking like a different product.
 */
export const CARD_ACCENTS: { id: string; label: string; hex: string }[] = [
  { id: 'oxblood', label: 'Oxblood', hex: '#7A2331' },
  { id: 'slate', label: 'Slate', hex: '#56606A' },
  { id: 'moss', label: 'Moss', hex: '#66715F' },
  { id: 'brass', label: 'Brass', hex: '#9A7447' },
  { id: 'clay', label: 'Clay', hex: '#7D5B52' },
  { id: 'ink', label: 'Ink', hex: '#1A1A1A' },
];

export function accentHex(accentId?: string | null): string {
  return CARD_ACCENTS.find((a) => a.id === accentId)?.hex || CARD_ACCENTS[0].hex;
}

export interface CardConfig {
  mode: CardMode;
  accent: string;
  layout: CardLayout;
  name: string;
  role: string;
  company: string;
  intro: string;
  /** Optional external page to surface when mode === 'ported'. */
  portedUrl?: string | null;
  links: { label: string; url: string }[];
  email?: string | null;
  published: boolean;
}

export interface PublicCard extends CardConfig {
  cardId: string;
  ownerUid: string;
}

export const DEFAULT_CARD: CardConfig = {
  mode: 'ai',
  accent: 'oxblood',
  layout: 'expanded',
  name: '',
  role: '',
  company: '',
  intro: '',
  portedUrl: null,
  links: [],
  email: null,
  published: false,
};

/**
 * Card ids are short, unambiguous and non-sequential. Ambiguous glyphs
 * (0/O, 1/I/l) are excluded because this id gets read aloud, typed off a QR
 * failure, and printed at small size on a physical card.
 */
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function generateCardId(length = 10): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return out;
}

/**
 * A distribution-path marker, not proof of hardware. Someone can copy any
 * URL, so the value says which owner-issued URL opened the card and nothing
 * stronger.
 */
export type CardCaptureChannel = 'qr' | 'nfc' | 'link' | 'direct';

export function cardUrl(
  cardId: string,
  captureChannel?: CardCaptureChannel,
): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const base = `${origin}/c/${cardId}`;
  return captureChannel
    ? `${base}?via=${encodeURIComponent(captureChannel)}`
    : base;
}

// ── Owner side ────────────────────────────────────────────────────────────

/**
 * Publishes the card to the public `cards/{cardId}` collection.
 *
 * This denormalises the owner's profile on purpose: the public page must be
 * readable with no auth and without exposing users/{uid}, which is
 * owner-only. Only the fields the owner explicitly put on their card are
 * copied across — never the whole profile document.
 */
export async function publishCard(
  uid: string,
  cardId: string,
  config: CardConfig,
  privateAIGrounding: GroundingDisplay | null = null,
): Promise<void> {
  const payload: Record<string, any> = {
    cardId,
    ownerUid: uid,
    mode: config.mode,
    accent: config.accent,
    layout: config.layout,
    name: config.name || '',
    role: config.role || '',
    company: config.company || '',
    intro: config.intro || '',
    portedUrl: config.portedUrl || null,
    links: config.links || [],
    email: config.email || null,
    published: true,
    updatedAt: serverTimestamp(),
  };

  await setDoc(doc(db, `cards/${cardId}`), payload, { merge: true });
  await updateDoc(doc(db, `users/${uid}`), {
    cardId,
    card: { ...config, published: true },
    // This stays on the owner-only profile. The public card receives only the
    // explicit schema above and never exposes request/model/source metadata.
    cardAIGrounding: privateAIGrounding,
    updatedAt: serverTimestamp(),
  });
}

export async function unpublishCard(uid: string, cardId: string): Promise<void> {
  await setDoc(doc(db, `cards/${cardId}`), { published: false, updatedAt: serverTimestamp() }, { merge: true });
  await updateDoc(doc(db, `users/${uid}`), { 'card.published': false, updatedAt: serverTimestamp() });
}

// ── Public / viewer side ──────────────────────────────────────────────────

export function publicCardFromRecord(
  cardId: string,
  data: unknown,
): PublicCard | null {
  if (
    !/^[23456789abcdefghjkmnpqrstuvwxyz]{10}$/.test(cardId) ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (
    record.published !== true ||
    typeof record.ownerUid !== 'string' ||
    !record.ownerUid ||
    record.ownerUid.length > 128 ||
    !['ai', 'custom', 'ported'].includes(String(record.mode)) ||
    !['compact', 'expanded'].includes(String(record.layout)) ||
    !CARD_ACCENTS.some((accent) => accent.id === record.accent) ||
    typeof record.name !== 'string' ||
    typeof record.role !== 'string' ||
    typeof record.company !== 'string' ||
    typeof record.intro !== 'string' ||
    !(
      record.portedUrl == null ||
      typeof record.portedUrl === 'string'
    ) ||
    !(record.email == null || typeof record.email === 'string') ||
    !Array.isArray(record.links) ||
    record.links.some(
      (link) =>
        !link ||
        typeof link !== 'object' ||
        Array.isArray(link) ||
        typeof (link as Record<string, unknown>).label !== 'string' ||
        typeof (link as Record<string, unknown>).url !== 'string',
    )
  ) {
    return null;
  }
  const config: CardConfig = {
    mode: record.mode as CardMode,
    accent: record.accent as string,
    layout: record.layout as CardLayout,
    name: record.name,
    role: record.role,
    company: record.company,
    intro: record.intro,
    portedUrl: (record.portedUrl as string | null) || null,
    links: record.links as { label: string; url: string }[],
    email: (record.email as string | null) || null,
    published: true,
  };
  if (hasCardValidationErrors(validateCardConfig(config))) return null;
  return {
    cardId,
    ownerUid: record.ownerUid,
    ...config,
  };
}

export async function loadPublicCard(cardId: string): Promise<PublicCard | null> {
  const snap = await getDoc(doc(db, `cards/${cardId}`));
  return snap.exists()
    ? publicCardFromRecord(cardId, snap.data())
    : null;
}

export interface CaptureInput {
  cardId: string;
  visitorName: string;
  visitorEmail?: string | null;
  visitorCompany?: string | null;
  note?: string | null;
  consentToFollowUp?: boolean;
  website?: string;
  captureChannel?: CardCaptureChannel;
}

/**
 * Sent by an unauthenticated viewer through the public capture API. The server
 * applies App Check, throttling, and deduplication before an Admin SDK write.
 * Browser rules deny direct creation so those controls cannot be bypassed.
 */
export async function submitCapture(input: CaptureInput): Promise<void> {
  const appCheckToken = await getFirebaseAppCheckToken();
  const response = await fetch('/api/cards/capture', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(appCheckToken
        ? { 'X-Firebase-AppCheck': appCheckToken }
        : {}),
    },
    body: JSON.stringify({
      cardId: input.cardId,
      visitorName: input.visitorName,
      visitorEmail: input.visitorEmail || null,
      visitorCompany: input.visitorCompany || null,
      note: input.note || null,
      consentToFollowUp: input.consentToFollowUp === true,
      captureChannel: input.captureChannel || 'direct',
      website: input.website || '',
    }),
  });

  if (!response.ok) {
    let message = 'This card could not be saved right now.';
    try {
      const body = await response.json();
      if (typeof body?.error?.message === 'string') {
        message = body.error.message;
      }
    } catch {
      // Keep a stable public error instead of exposing an intermediary body.
    }
    throw new Error(message);
  }
}

// ── vCard ─────────────────────────────────────────────────────────────────

function escapeVCard(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n?|\n/g, '\\n');
}

export function buildVCard(card: PublicCard): string {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${escapeVCard(card.name)}`,
    card.company ? `ORG:${escapeVCard(card.company)}` : null,
    card.role ? `TITLE:${escapeVCard(card.role)}` : null,
    card.email ? `EMAIL;TYPE=INTERNET:${escapeVCard(card.email)}` : null,
    `URL:${cardUrl(card.cardId, 'link')}`,
    card.intro ? `NOTE:${escapeVCard(card.intro)}` : null,
    'END:VCARD',
  ].filter(Boolean);
  return lines.join('\r\n');
}

export function downloadVCard(card: PublicCard): void {
  const blob = new Blob([buildVCard(card)], { type: 'text/vcard;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${(card.name || 'contact').replace(/\s+/g, '-').toLowerCase()}.vcf`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
