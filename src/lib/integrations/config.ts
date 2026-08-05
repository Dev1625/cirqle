/**
 * Integration mode gating.
 *
 * Every external-credential feature in this pass ships in mock mode by
 * default and stays fully interactive there — the same shape the codebase
 * already uses for the Firebase emulator (VITE_USE_FIREBASE_EMULATOR) and for
 * the AI gateway's absent-key fallback in lib/gemini.ts.
 *
 * The rule: mock mode is never a "connect to see this" dead end. It returns
 * realistic data, the UI is fully demoable, and every surface running on it
 * wears a PreviewBadge so a demo can't be mistaken for a live connection.
 *
 * Flipping to live is documented step-by-step in MANUAL_SETUP.md at the repo
 * root. Nothing here reads a secret: the OAuth client *secret* and refresh
 * tokens live server-side only (see lib/integrations/gmail.ts for why that is
 * a hard requirement rather than a preference).
 */

export type IntegrationMode = 'mock' | 'live';

function readEnv(key: string): string | undefined {
  const value = (import.meta as any).env?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Live mode requires an explicit opt-in and an explicit same-origin API base.
 * Google client credentials are server-only and must never be compiled into
 * this bundle. A half-configured deployment remains in preview mode.
 */
export function integrationMode(): IntegrationMode {
  const declared = readEnv('VITE_INTEGRATIONS_MODE');
  const apiBase = configuredIntegrationsApiBase();
  if (declared === 'live' && apiBase) return 'live';
  return 'mock';
}

export function isMock(): boolean {
  return integrationMode() === 'mock';
}

function configuredIntegrationsApiBase(): string | undefined {
  const value = readEnv('VITE_INTEGRATIONS_API_BASE')?.trim();
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('..') ||
    /[?#]/.test(value)
  ) {
    return undefined;
  }
  return value.replace(/\/+$/, '');
}

/**
 * Same-origin Vercel API base that mediates token exchange and Google calls.
 * The browser never holds a refresh token, so it never calls Google directly
 * for anything beyond the initial consent redirect.
 */
export function integrationsApiBase(): string {
  const configured = configuredIntegrationsApiBase();
  if (configured) return configured;
  if (readEnv('VITE_INTEGRATIONS_MODE') === 'live') {
    throw new Error(
      'Live integrations require a same-origin VITE_INTEGRATIONS_API_BASE.',
    );
  }
  return '/api/integrations';
}

/** Transactional email provider for the dormant digest (feature 9). */
export function emailMode(): IntegrationMode {
  const declared = readEnv('VITE_EMAIL_MODE');
  const key = readEnv('VITE_EMAIL_FROM');
  if (declared === 'live' && key) return 'live';
  return 'mock';
}

/**
 * Google scopes, deliberately narrow.
 *
 * calendar.events.readonly — nothing in this pass writes to a calendar.
 *
 * gmail.send + gmail.metadata rather than gmail.readonly: the app only ever
 * needs to check the state of threads *it created*. A blanket inbox-read
 * scope would be a worse privacy story and a slower, more expensive Google
 * verification path later. See MANUAL_SETUP.md for the full reasoning.
 */
