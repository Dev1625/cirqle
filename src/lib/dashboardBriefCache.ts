const CACHE_PREFIX = 'cirqle:dashboard-brief:v1:';
const LEGACY_CACHE_PREFIX = 'ai_brief_';
const MAX_ENCODED_BRIEF_LENGTH = 100_000;

export const DASHBOARD_BRIEF_CACHE_TTL_MS = 30 * 60 * 1000;

type StorageLike = Pick<
  Storage,
  'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'
>;

interface CachedDashboardBrief {
  version: 1;
  uid: string;
  storedAt: number;
  expiresAt: number;
  encodedBrief: string;
}

interface CacheOptions {
  now?: number;
  sessionStorage?: StorageLike | null;
  localStorage?: StorageLike | null;
}

function browserStorage(kind: 'sessionStorage' | 'localStorage') {
  if (typeof window === 'undefined') return null;
  try {
    return window[kind];
  } catch {
    return null;
  }
}

function cacheKey(uid: string) {
  return `${CACHE_PREFIX}${uid}`;
}

function storageKeys(storage: StorageLike | null): string[] {
  if (!storage) return [];
  try {
    return Array.from({ length: storage.length }, (_, index) =>
      storage.key(index),
    ).filter((key): key is string => typeof key === 'string');
  } catch {
    return [];
  }
}

function safeRemove(storage: StorageLike | null, key: string) {
  try {
    storage?.removeItem(key);
  } catch {
    // Privacy modes can disable browser storage. The in-memory UI still works.
  }
}

function stores(options: CacheOptions) {
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

function purgeLegacyPersistentBriefs(local: StorageLike | null) {
  for (const key of storageKeys(local)) {
    if (key.startsWith(LEGACY_CACHE_PREFIX)) safeRemove(local, key);
  }
}

export function readDashboardBriefCache(
  uid: string,
  options: CacheOptions = {},
): string | null {
  const { session } = stores(options);
  const key = cacheKey(uid);
  let raw: string | null = null;
  try {
    raw = session?.getItem(key) || null;
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const cached = JSON.parse(raw) as Partial<CachedDashboardBrief>;
    const now = options.now ?? Date.now();
    const valid =
      cached.version === 1 &&
      cached.uid === uid &&
      typeof cached.storedAt === 'number' &&
      cached.storedAt <= now &&
      typeof cached.expiresAt === 'number' &&
      cached.expiresAt > now &&
      cached.expiresAt - cached.storedAt <= DASHBOARD_BRIEF_CACHE_TTL_MS &&
      typeof cached.encodedBrief === 'string' &&
      cached.encodedBrief.length > 0 &&
      cached.encodedBrief.length <= MAX_ENCODED_BRIEF_LENGTH;
    if (valid) return cached.encodedBrief!;
  } catch {
    // Invalid cache data is removed below.
  }

  safeRemove(session, key);
  return null;
}

export function writeDashboardBriefCache(
  uid: string,
  encodedBrief: string,
  options: CacheOptions = {},
): boolean {
  if (
    !uid ||
    !encodedBrief ||
    encodedBrief.length > MAX_ENCODED_BRIEF_LENGTH
  ) {
    return false;
  }

  const { session } = stores(options);
  if (!session) return false;
  const storedAt = options.now ?? Date.now();
  const cached: CachedDashboardBrief = {
    version: 1,
    uid,
    storedAt,
    expiresAt: storedAt + DASHBOARD_BRIEF_CACHE_TTL_MS,
    encodedBrief,
  };
  try {
    session.setItem(cacheKey(uid), JSON.stringify(cached));
    return true;
  } catch {
    return false;
  }
}

export function clearDashboardBriefCache(
  uid: string,
  options: CacheOptions = {},
) {
  const { session, local } = stores(options);
  safeRemove(session, cacheKey(uid));
  // Remove values written by older builds without ever reading their content.
  safeRemove(local, `ai_brief_${uid}`);
  safeRemove(local, `ai_brief_time_${uid}`);
}

/**
 * Run whenever auth state becomes known. A tab may be reused by multiple
 * people, so only the active user's unexpired entry may survive.
 */
export function purgeDashboardBriefCaches(
  activeUid: string | null,
  options: CacheOptions = {},
) {
  const { session, local } = stores(options);
  const activeKey = activeUid ? cacheKey(activeUid) : null;

  for (const key of storageKeys(session)) {
    if (key.startsWith(CACHE_PREFIX) && key !== activeKey) {
      safeRemove(session, key);
    }
  }
  if (activeUid) {
    readDashboardBriefCache(activeUid, {
      now: options.now,
      sessionStorage: session,
      localStorage: local,
    });
  }

  purgeLegacyPersistentBriefs(local);
}

export function clearAllDashboardBriefCaches(options: CacheOptions = {}) {
  const { session, local } = stores(options);
  for (const key of storageKeys(session)) {
    if (key.startsWith(CACHE_PREFIX)) safeRemove(session, key);
  }
  purgeLegacyPersistentBriefs(local);
}
