const VISITOR_SESSION_KEY = 'cirqle:public-card-visitor:v2';
const LEGACY_VISITOR_KEY = 'CIRQLE_CARD_VISITOR';
const MAX_VISITOR_NAME_LENGTH = 120;

export const PUBLIC_CARD_VISITOR_TTL_MS = 2 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface VisitorStorageOptions {
  now?: number;
  sessionStorage?: StorageLike | null;
  localStorage?: StorageLike | null;
}

interface StoredVisitor {
  version: 2;
  name: string;
  storedAt: number;
  expiresAt: number;
}

function browserStorage(kind: 'sessionStorage' | 'localStorage') {
  if (typeof window === 'undefined') return null;
  try {
    return window[kind];
  } catch {
    return null;
  }
}

function stores(options: VisitorStorageOptions) {
  return {
    session:
      options.sessionStorage === undefined
        ? browserStorage('sessionStorage')
        : options.sessionStorage,
    local:
      options.localStorage === undefined
        ? browserStorage('localStorage')
        : options.localStorage,
  };
}

function safeRemove(storage: StorageLike | null, key: string) {
  try {
    storage?.removeItem(key);
  } catch {
    // Private browsing may disable storage. The card still works in memory.
  }
}

function purgeLegacyVisitor(local: StorageLike | null) {
  // Older builds persisted a person's name across tabs and browser restarts.
  // Delete that value without reading or migrating its PII.
  safeRemove(local, LEGACY_VISITOR_KEY);
}

function cleanVisitorName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > MAX_VISITOR_NAME_LENGTH) return null;
  return cleaned;
}

export function getStoredVisitorName(
  options: VisitorStorageOptions = {},
): string | null {
  const { session, local } = stores(options);
  purgeLegacyVisitor(local);

  let raw: string | null = null;
  try {
    raw = session?.getItem(VISITOR_SESSION_KEY) || null;
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const stored = JSON.parse(raw) as Partial<StoredVisitor>;
    const now = options.now ?? Date.now();
    const cleaned = cleanVisitorName(stored.name);
    const valid =
      stored.version === 2 &&
      cleaned !== null &&
      cleaned === stored.name &&
      typeof stored.storedAt === 'number' &&
      stored.storedAt <= now &&
      typeof stored.expiresAt === 'number' &&
      stored.expiresAt > now &&
      stored.expiresAt - stored.storedAt <= PUBLIC_CARD_VISITOR_TTL_MS;
    if (valid) return cleaned;
  } catch {
    // Malformed or stale values are removed below.
  }

  safeRemove(session, VISITOR_SESSION_KEY);
  return null;
}

export function storeVisitorName(
  name: string,
  options: VisitorStorageOptions = {},
): boolean {
  const { session, local } = stores(options);
  purgeLegacyVisitor(local);
  const cleaned = cleanVisitorName(name);
  if (!cleaned || !session) {
    safeRemove(session, VISITOR_SESSION_KEY);
    return false;
  }

  const storedAt = options.now ?? Date.now();
  const value: StoredVisitor = {
    version: 2,
    name: cleaned,
    storedAt,
    expiresAt: storedAt + PUBLIC_CARD_VISITOR_TTL_MS,
  };
  try {
    session.setItem(VISITOR_SESSION_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredVisitorName(
  options: VisitorStorageOptions = {},
) {
  const { session, local } = stores(options);
  safeRemove(session, VISITOR_SESSION_KEY);
  purgeLegacyVisitor(local);
}
