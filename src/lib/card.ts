import {
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  collection,
  getDocs,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../config/firebase';

/**
 * The NFC card's software half.
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

export function cardUrl(cardId: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/c/${cardId}`;
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
export async function publishCard(uid: string, cardId: string, config: CardConfig): Promise<void> {
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
    updatedAt: serverTimestamp(),
  });
}

export async function unpublishCard(uid: string, cardId: string): Promise<void> {
  await setDoc(doc(db, `cards/${cardId}`), { published: false, updatedAt: serverTimestamp() }, { merge: true });
  await updateDoc(doc(db, `users/${uid}`), { 'card.published': false, updatedAt: serverTimestamp() });
}

// ── Public / viewer side ──────────────────────────────────────────────────

export async function loadPublicCard(cardId: string): Promise<PublicCard | null> {
  const snap = await getDoc(doc(db, `cards/${cardId}`));
  if (!snap.exists()) return null;
  const data = snap.data() as any;
  if (data.published === false) return null;
  return {
    cardId,
    ownerUid: data.ownerUid,
    mode: data.mode || 'ai',
    accent: data.accent || 'oxblood',
    layout: data.layout || 'expanded',
    name: data.name || '',
    role: data.role || '',
    company: data.company || '',
    intro: data.intro || '',
    portedUrl: data.portedUrl || null,
    links: data.links || [],
    email: data.email || null,
    published: true,
  };
}

/**
 * First-visit tracking is a localStorage flag, deliberately — the brief asks
 * for a name, not an account. No cookie, no identifier sent anywhere, nothing
 * that follows the viewer off this page.
 */
const VISITOR_KEY = 'CIRQLE_CARD_VISITOR';

export function getStoredVisitorName(): string | null {
  try {
    return localStorage.getItem(VISITOR_KEY);
  } catch {
    return null;
  }
}

export function storeVisitorName(name: string): void {
  try {
    localStorage.setItem(VISITOR_KEY, name);
  } catch {
    /* private browsing — the dialog simply asks again next time */
  }
}

export interface CaptureInput {
  cardId: string;
  visitorName: string;
  visitorEmail?: string | null;
  visitorCompany?: string | null;
  note?: string | null;
}

/**
 * Written by an unauthenticated viewer. Firestore rules allow create-only on
 * this subcollection with a validated shape, and no public read — a stranger
 * can drop a card off, but cannot enumerate who else has.
 */
export async function submitCapture(input: CaptureInput): Promise<void> {
  await addDoc(collection(db, `cards/${input.cardId}/captures`), {
    visitorName: input.visitorName,
    visitorEmail: input.visitorEmail || null,
    visitorCompany: input.visitorCompany || null,
    note: input.note || null,
    capturedAt: serverTimestamp(),
    processed: false,
  });
}

// ── Reverse capture: captures → contacts in the owner's Directory ─────────

export interface PendingCapture {
  id: string;
  visitorName: string;
  visitorEmail: string | null;
  visitorCompany: string | null;
  note: string | null;
  capturedAt: Date | null;
}

export async function listPendingCaptures(cardId: string): Promise<PendingCapture[]> {
  const snap = await getDocs(query(collection(db, `cards/${cardId}/captures`), orderBy('capturedAt', 'asc')));
  return snap.docs.map((d) => {
    const data = d.data() as any;
    return {
      id: d.id,
      visitorName: data.visitorName || 'Unknown',
      visitorEmail: data.visitorEmail || null,
      visitorCompany: data.visitorCompany || null,
      note: data.note || null,
      capturedAt: data.capturedAt?.toDate ? data.capturedAt.toDate() : null,
    };
  });
}

/**
 * Drains pending captures into real contacts on the owner's next app load.
 *
 * Doing this client-side keeps the whole feature demoable with no Cloud
 * Function deployed. The production shape is a Firestore onCreate trigger
 * doing the same write server-side so the contact appears instantly rather
 * than on next load — noted in FEATURE_BUILD_REPORT.md as the upgrade path.
 */
export async function drainCaptures(params: {
  uid: string;
  cardId: string;
  eventName?: string | null;
  locationHint?: string | null;
}): Promise<number> {
  const pending = await listPendingCaptures(params.cardId);
  if (pending.length === 0) return 0;

  let created = 0;
  for (const capture of pending) {
    const when = capture.capturedAt || new Date();
    const contextBits = [
      `Tapped your card ${when.toLocaleDateString()} at ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
      params.eventName ? `at ${params.eventName}` : null,
      params.locationHint && !params.eventName ? `near ${params.locationHint}` : null,
    ].filter(Boolean);

    await addDoc(collection(db, `users/${params.uid}/contacts`), {
      userId: params.uid,
      name: capture.visitorName,
      company: capture.visitorCompany || null,
      role: null,
      industry: null,
      relationshipTier: 'Cold',
      summary: contextBits.join(' '),
      whyTheyMatter: capture.note || null,
      tags: params.eventName ? [params.eventName] : [],
      location: params.locationHint || null,
      email: capture.visitorEmail || null,
      linkedinUrl: null,
      subIndustry: null,
      lastContactedAt: when,
      seniority: null,
      school: null,
      connectionSource: 'NFC card',
      capturedVia: 'nfc-card',
      capturedAt: when,
      capturedEventName: params.eventName || null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await deleteDoc(doc(db, `cards/${params.cardId}/captures/${capture.id}`));
    created += 1;
  }

  return created;
}

// ── vCard ─────────────────────────────────────────────────────────────────

function escapeVCard(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function buildVCard(card: PublicCard): string {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${escapeVCard(card.name)}`,
    card.company ? `ORG:${escapeVCard(card.company)}` : null,
    card.role ? `TITLE:${escapeVCard(card.role)}` : null,
    card.email ? `EMAIL;TYPE=INTERNET:${escapeVCard(card.email)}` : null,
    `URL:${cardUrl(card.cardId)}`,
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
