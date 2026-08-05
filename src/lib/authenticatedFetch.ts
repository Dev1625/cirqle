import { auth } from '../config/firebase';

export class AuthenticationRequiredError extends Error {
  constructor(message = 'Please sign in again to continue.') {
    super(message);
    this.name = 'AuthenticationRequiredError';
  }
}

/**
 * Calls a first-party API with the current Firebase ID token.
 *
 * Firebase ID tokens are short-lived and automatically refreshed by the SDK.
 * A single 401 triggers one forced refresh so a long-lived tab can recover
 * without teaching every product feature its own authentication retry logic.
 */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  forceRefresh = false,
): Promise<Response> {
  const user = auth.currentUser;
  if (!user) throw new AuthenticationRequiredError();

  const token = await user.getIdToken(forceRefresh);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(input, { ...init, headers });
  if (response.status === 401 && !forceRefresh) {
    return authenticatedFetch(input, init, true);
  }
  if (
    (response.status === 401 && forceRefresh) ||
    response.status === 410
  ) {
    // A forced refresh preserves Firebase auth_time, so a durable revocation
    // marker will still reject it. Clear the local Firebase session instead
    // of leaving the app in a retry loop with a known-invalid account state.
    await auth.signOut().catch(() => undefined);
  }
  return response;
}
