import { assessPassword, type PasswordAssessment } from './authSecurity';

const DEFAULT_ENDPOINT = '/api/security/password-range';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RANGE_BYTES = 256_000;
const MAX_RANGE_ROWS = 7_000;
const RANGE_ROW_PATTERN = /^([A-F0-9]{35}):(\d{1,12})$/;

export type PasswordBreachUnavailableReason =
  | 'disabled'
  | 'offline'
  | 'unsupported'
  | 'timeout'
  | 'cancelled'
  | 'service';

export type PasswordBreachResult =
  | Readonly<{ status: 'safe' }>
  | Readonly<{ status: 'breached'; prevalence: number }>
  | Readonly<{
      status: 'unavailable';
      reason: PasswordBreachUnavailableReason;
    }>;

export type PasswordBreachViewState =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'checking' }>
  | PasswordBreachResult;

export interface PasswordScreeningResult {
  accepted: boolean;
  assessment: PasswordAssessment;
  breach: PasswordBreachResult | null;
  reason: 'accepted' | 'local-requirements' | 'known-breach';
}

interface PasswordBreachOptions {
  fetchImpl?: typeof fetch;
  cryptoImpl?: Crypto;
  endpoint?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  enabled?: boolean;
  online?: () => boolean;
}

function breachCheckConfigured(): boolean {
  return (
    (import.meta as ImportMeta & {
      env?: Record<string, string | undefined>;
    }).env?.VITE_PASSWORD_BREACH_CHECK_DISABLED !== 'true'
  );
}

function onlineByDefault(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

async function sha1RangeParts(
  password: string,
  cryptoImpl: Crypto,
): Promise<{ prefix: string; suffix: string }> {
  if (!cryptoImpl?.subtle || typeof TextEncoder === 'undefined') {
    throw new TypeError('Web Crypto is unavailable.');
  }
  const encoded = new TextEncoder().encode(password);
  let digest;
  try {
    digest = await cryptoImpl.subtle.digest('SHA-1', encoded);
  } finally {
    encoded.fill(0);
  }
  const bytes = new Uint8Array(digest);
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  )
    .join('')
    .toUpperCase();
  bytes.fill(0);
  return { prefix: hex.slice(0, 5), suffix: hex.slice(5) };
}

function matchSuffix(
  rangeBody: string,
  targetSuffix: string,
): PasswordBreachResult {
  if (!rangeBody || rangeBody.length > MAX_RANGE_BYTES) {
    return { status: 'unavailable', reason: 'service' };
  }
  let validRows = 0;
  let matchedPrevalence = 0;
  for (const rawLine of rangeBody.split(/\r?\n/)) {
    if (!rawLine) continue;
    const match = RANGE_ROW_PATTERN.exec(rawLine.trim().toUpperCase());
    if (!match) {
      return { status: 'unavailable', reason: 'service' };
    }
    validRows += 1;
    if (validRows > MAX_RANGE_ROWS) {
      return { status: 'unavailable', reason: 'service' };
    }
    if (match[1] === targetSuffix) {
      const prevalence = Number(match[2]);
      matchedPrevalence = Math.max(matchedPrevalence, prevalence);
    }
  }
  if (matchedPrevalence > 0) {
    return { status: 'breached', prevalence: matchedPrevalence };
  }
  return validRows > 0
    ? { status: 'safe' }
    : { status: 'unavailable', reason: 'service' };
}

export async function checkPasswordBreach(
  password: string,
  {
    fetchImpl = globalThis.fetch,
    cryptoImpl = globalThis.crypto,
    endpoint = DEFAULT_ENDPOINT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    enabled = breachCheckConfigured(),
    online = onlineByDefault,
  }: PasswordBreachOptions = {},
): Promise<PasswordBreachResult> {
  if (!enabled) return { status: 'unavailable', reason: 'disabled' };
  if (!online()) return { status: 'unavailable', reason: 'offline' };
  if (
    typeof fetchImpl !== 'function' ||
    !cryptoImpl?.subtle ||
    typeof TextEncoder === 'undefined'
  ) {
    return { status: 'unavailable', reason: 'unsupported' };
  }
  if (signal?.aborted) {
    return { status: 'unavailable', reason: 'cancelled' };
  }

  let prefix;
  let suffix;
  try {
    ({ prefix, suffix } = await sha1RangeParts(password, cryptoImpl));
  } catch {
    return { status: 'unavailable', reason: 'unsupported' };
  }
  // A caller can cancel while Web Crypto is still hashing. Re-check before
  // any request is constructed so a stale password never emits even a prefix.
  if (signal?.aborted) {
    prefix = '';
    suffix = '';
    return { status: 'unavailable', reason: 'cancelled' };
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefix }),
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: 'unavailable', reason: 'service' };
    }
    return matchSuffix(await response.text(), suffix);
  } catch (error) {
    if (timedOut) return { status: 'unavailable', reason: 'timeout' };
    if (
      signal?.aborted ||
      (error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'AbortError')
    ) {
      return { status: 'unavailable', reason: 'cancelled' };
    }
    return { status: 'unavailable', reason: 'service' };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
    // Prefix and suffix are intentionally function-scoped and never returned,
    // persisted, included in an error, or written to application logs.
    prefix = '';
    suffix = '';
  }
}

export async function screenNewPassword(
  password: string,
  options: PasswordBreachOptions = {},
): Promise<PasswordScreeningResult> {
  const assessment = assessPassword(password);
  if (!assessment.isStrong) {
    return {
      accepted: false,
      assessment,
      breach: null,
      reason: 'local-requirements',
    };
  }
  const breach = await checkPasswordBreach(password, options);
  if (breach.status === 'breached') {
    return {
      accepted: false,
      assessment,
      breach,
      reason: 'known-breach',
    };
  }
  // Deliberate fail-open availability policy: Firebase signup and account
  // recovery remain usable when the optional corpus is offline. Cirqle's
  // existing local strength/common-password requirements still block weak
  // choices, and the UI clearly reports that the remote check was unavailable.
  return {
    accepted: true,
    assessment,
    breach,
    reason: 'accepted',
  };
}
