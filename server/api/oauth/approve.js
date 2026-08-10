import {
  AccountAuthenticationError,
  getAccountAdminServices,
  verifyActiveAccountIdentity,
} from '../_lib/account-admin.js';
import { AccountSecurityError } from '../_lib/account-security.js';
import { getSafeRequestId } from '../_lib/http.js';
import {
  OAuthError,
  assertRedirectUriAllowed,
  createAuthorizationCode,
  getClient,
  getOAuthConfig,
  normalizeScope,
} from '../_lib/oauth.js';

/**
 * Turns a signed-in Firebase session into an authorization code.
 *
 * Called by the consent screen once the owner has signed in and pressed
 * Connect. Authentication is the app's existing Firebase session, so this
 * endpoint never handles a password and inherits the verification gate and
 * session-revocation checks that verifyActiveAccountIdentity already applies.
 *
 * Every parameter is re-validated here. The consent screen is a web page and
 * its query string is attacker-controllable, so nothing it forwards may be
 * trusted just because /api/oauth/authorize checked it a moment ago.
 */
export function createOAuthApproveHandler({
  env = process.env,
  logger = console,
  verifyIdentity = verifyActiveAccountIdentity,
  adminServicesFactory = getAccountAdminServices,
  now = () => new Date(),
} = {}) {
  return async function oauthApproveHandler(req, res) {
    const requestId = getSafeRequestId(req);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Request-Id', requestId);

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'invalid_request' });
    }

    let config;
    try {
      config = getOAuthConfig(env);
    } catch {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }

    let identity;
    try {
      identity = await verifyIdentity(req, { env });
    } catch (error) {
      if (
        error instanceof AccountAuthenticationError ||
        error instanceof AccountSecurityError ||
        error?.code === 'unauthorized'
      ) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }

    // Only a verified owner can hand an agent access to their network.
    if (identity.emailVerified === false) {
      return res.status(403).json({ error: 'email_verification_required' });
    }

    const body = req.body || {};
    try {
      const { db } = adminServicesFactory(env);
      const client = await getClient({ db, clientId: body.client_id });
      const redirectUri = assertRedirectUriAllowed(client, body.redirect_uri);
      const scope = normalizeScope(body.scope);

      if (body.resource && String(body.resource).replace(/\/+$/, '') !== config.resource) {
        throw new OAuthError({
          code: 'invalid_target',
          message: 'That resource is not served by this authorization server.',
        });
      }

      const code = await createAuthorizationCode({
        db,
        uid: identity.uid,
        clientId: client.clientId,
        redirectUri,
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method || 'S256',
        scope,
        resource: body.resource || config.resource,
        now: now(),
      });

      // The browser performs the redirect, so the code never appears in a
      // Location header this endpoint controls.
      return res.status(200).json({ code, redirect_uri: redirectUri });
    } catch (error) {
      if (error instanceof OAuthError) {
        return res
          .status(error.status)
          .json({ error: error.code, error_description: error.message });
      }
      logger.error?.('[oauth-approve] failed', { requestId });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  };
}

export default createOAuthApproveHandler();
