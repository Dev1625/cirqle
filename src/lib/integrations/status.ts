import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../config/firebase';
import { GOOGLE_SCOPES, googleClientId, integrationsApiBase, isMock } from './config';

/**
 * Connection state for the external integrations, and the incremental-auth
 * entry point.
 *
 * Two things are deliberately absent from this file and from Firestore:
 * the OAuth client secret and the refresh token. Both live server-side only.
 * A refresh token in a client-readable document is a standing key to
 * someone's inbox that survives every password change — the client is told
 * *that* a connection exists and when it was last synced, never what it is.
 *
 * `users/{uid}/integrations/{provider}` therefore holds status metadata only.
 */

export type Provider = 'calendar' | 'gmail';

export interface IntegrationStatus {
  provider: Provider;
  connected: boolean;
  mode: 'mock' | 'live';
  email: string | null;
  connectedAt: Date | null;
  lastSyncedAt: Date | null;
  /**
   * Google expires refresh tokens for apps in "testing" publishing status
   * after 7 days. This is expected behaviour, not a bug — surfaced in the UI
   * so a weekly reconnect reads as a known limitation rather than a fault.
   */
  expiresAt: Date | null;
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value?.toDate) return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Firestore reads can hang rather than reject — a wedged WebChannel leaves
 * getDoc pending indefinitely, with no error to catch. Unbounded, that left
 * the Connections rows rendering "Connect" forever, which looks exactly like
 * a healthy disconnected state, so a broken read was indistinguishable from
 * a deliberate one. Every read here is bounded and failures are surfaced.
 */
export class StatusUnavailableError extends Error {
  constructor(message = 'Could not read the connection status.') {
    super(message);
    this.name = 'StatusUnavailableError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new StatusUnavailableError()), ms);
    promise.then(
      (v) => { window.clearTimeout(timer); resolve(v); },
      (e) => { window.clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * 15s, not the 8s this originally shipped with.
 *
 * Measured against a throttled connection (3000ms RTT, 10kbps) a legitimate
 * single-doc read completes in ~7.0s. An 8s bound left barely a second of
 * headroom, so a user on a genuinely bad connection would have been shown a
 * "Retry" for a read that was about to succeed — trading a rare hang for a
 * common false alarm.
 *
 * This is a backstop against a read that never settles at all, not a latency
 * budget: the honest "Checking…" state is what covers slowness, so the bound
 * can afford to be generous.
 */
const STATUS_READ_TIMEOUT_MS = 15000;

export async function readStatus(uid: string, provider: Provider): Promise<IntegrationStatus> {
  const snap = await withTimeout(
    getDoc(doc(db, `users/${uid}/integrations/${provider}`)),
    STATUS_READ_TIMEOUT_MS
  );
  const data = snap.exists() ? (snap.data() as any) : {};
  return {
    provider,
    connected: Boolean(data.connected),
    mode: data.mode === 'live' ? 'live' : 'mock',
    email: data.email || null,
    connectedAt: toDate(data.connectedAt),
    lastSyncedAt: toDate(data.lastSyncedAt),
    expiresAt: toDate(data.expiresAt),
  };
}

export async function markSynced(uid: string, provider: Provider): Promise<void> {
  await setDoc(
    doc(db, `users/${uid}/integrations/${provider}`),
    { lastSyncedAt: serverTimestamp() },
    { merge: true }
  );
}

/**
 * Mock connect. Fully interactive: the UI genuinely moves to a connected
 * state, persists it, and drives real (synthetic) data — it is not a disabled
 * button with a tooltip. The 7-day expiry is simulated too, so the reconnect
 * affordance is exercised in mock mode rather than discovered in production.
 */
export async function connectMock(uid: string, provider: Provider, email: string): Promise<void> {
  const now = new Date();
  await setDoc(
    doc(db, `users/${uid}/integrations/${provider}`),
    {
      provider,
      connected: true,
      mode: 'mock',
      email,
      connectedAt: now,
      lastSyncedAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function disconnect(uid: string, provider: Provider): Promise<void> {
  await setDoc(
    doc(db, `users/${uid}/integrations/${provider}`),
    { connected: false, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

/**
 * Incremental authorisation — additional scopes granted on top of the Google
 * Sign-In the user already completed, not a second login.
 *
 * `include_granted_scopes=true` is what makes it incremental: Google merges
 * the new scope into the existing grant instead of replacing it, so
 * connecting Gmail does not silently revoke Calendar.
 *
 * The code lands on the Cloud Function, which does the token exchange and
 * stores the refresh token server-side. The browser never handles it.
 */
export function buildConsentUrl(params: { uid: string; provider: Provider; loginHint?: string | null }): string {
  const clientId = googleClientId();
  if (!clientId) throw new Error('VITE_GOOGLE_CLIENT_ID is not set — see MANUAL_SETUP.md.');

  const redirectUri = `${window.location.origin}${integrationsApiBase()}/oauth/callback`;
  const scopes = GOOGLE_SCOPES[params.provider].join(' ');

  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    include_granted_scopes: 'true',
    access_type: 'offline',
    // 'consent' is required to be issued a refresh token on a re-grant;
    // without it Google returns only an access token for an already-consented
    // user and the server has nothing durable to store.
    prompt: 'consent',
    state: JSON.stringify({ uid: params.uid, provider: params.provider }),
    ...(params.loginHint ? { login_hint: params.loginHint } : {}),
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`;
}

export async function beginConnect(params: {
  uid: string;
  provider: Provider;
  email?: string | null;
}): Promise<'mock' | 'redirecting'> {
  if (isMock()) {
    await connectMock(params.uid, params.provider, params.email || 'you@example.com');
    return 'mock';
  }
  window.location.href = buildConsentUrl({ uid: params.uid, provider: params.provider, loginHint: params.email });
  return 'redirecting';
}

/** True when a live connection has aged past Google's testing-mode window. */
export function needsReconnect(status: IntegrationStatus): boolean {
  if (!status.connected || !status.expiresAt) return false;
  return status.expiresAt.getTime() < Date.now();
}
