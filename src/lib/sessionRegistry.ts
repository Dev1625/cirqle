import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';

import { db } from '../config/firebase';

const SESSION_KEY = 'cirqle.session.id.v1';
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
let runtimeSessionId: string | null = null;

export interface KnownSession {
  id: string;
  deviceLabel: string;
  browser: string;
  platform: string;
  createdAt: Date | null;
  lastSeenAt: Date | null;
  current: boolean;
}

function validSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{20,80}$/.test(value)
  );
}

export function currentSessionId(): string {
  if (runtimeSessionId) return runtimeSessionId;
  try {
    const stored = window.sessionStorage.getItem(SESSION_KEY);
    if (validSessionId(stored)) {
      runtimeSessionId = stored;
      return stored;
    }
  } catch {
    // Privacy modes may disable sessionStorage. A memory-only ID is enough.
  }
  const generated = crypto.randomUUID().replace(/-/g, '');
  runtimeSessionId = generated;
  try {
    window.sessionStorage.setItem(SESSION_KEY, generated);
  } catch {
    // Memory-only session; no credential or personal data is lost.
  }
  return generated;
}

function browserLabel(userAgent: string): string {
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/Firefox\//.test(userAgent)) return 'Firefox';
  if (/CriOS\//.test(userAgent)) return 'Chrome on iOS';
  if (/Chrome\//.test(userAgent)) return 'Chrome';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return 'Web browser';
}

function platformLabel(userAgent: string, platform: string): string {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Windows/.test(userAgent) || /Win/.test(platform)) return 'Windows';
  if (/Mac OS|MacIntel/.test(`${userAgent} ${platform}`)) return 'macOS';
  if (/Linux/.test(`${userAgent} ${platform}`)) return 'Linux';
  return 'Unknown device';
}

export function describeCurrentDevice(
  userAgent = navigator.userAgent,
  platform = navigator.platform,
) {
  const browser = browserLabel(userAgent);
  const system = platformLabel(userAgent, platform);
  return Object.freeze({
    browser,
    platform: system,
    deviceLabel: `${browser} · ${system}`,
  });
}

function asDate(value: any): Date | null {
  if (value?.toDate) {
    try {
      return value.toDate();
    } catch {
      return null;
    }
  }
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function registerCurrentSession(uid: string): Promise<string> {
  const sessionId = currentSessionId();
  const sessionRef = doc(db, `users/${uid}/sessions/${sessionId}`);
  const existing = await getDoc(sessionRef);
  const device = describeCurrentDevice();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
  await setDoc(
    sessionRef,
    {
      userId: uid,
      sessionId,
      ...device,
      ...(existing.exists() ? {} : { createdAt: serverTimestamp() }),
      lastSeenAt: serverTimestamp(),
      expiresAt,
    },
    { merge: true },
  );
  return sessionId;
}

export async function listKnownSessions(uid: string): Promise<KnownSession[]> {
  const current = await registerCurrentSession(uid);
  const snapshot = await getDocs(collection(db, `users/${uid}/sessions`));
  const cutoff = Date.now() - SESSION_MAX_AGE_MS;
  const sessions: KnownSession[] = [];

  for (const document of snapshot.docs) {
    const data = document.data() as any;
    const lastSeenAt = asDate(data.lastSeenAt);
    if (lastSeenAt && lastSeenAt.getTime() < cutoff) {
      await deleteDoc(document.ref).catch(() => undefined);
      continue;
    }
    sessions.push({
      id: document.id,
      deviceLabel:
        typeof data.deviceLabel === 'string'
          ? data.deviceLabel
          : 'Unknown web session',
      browser:
        typeof data.browser === 'string' ? data.browser : 'Web browser',
      platform:
        typeof data.platform === 'string'
          ? data.platform
          : 'Unknown device',
      createdAt: asDate(data.createdAt),
      lastSeenAt,
      current: document.id === current,
    });
  }

  return sessions.sort(
    (left, right) =>
      Number(right.current) - Number(left.current) ||
      (right.lastSeenAt?.getTime() || 0) -
        (left.lastSeenAt?.getTime() || 0),
  );
}
