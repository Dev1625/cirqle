import { getAccountAdminServices } from '../_lib/account-admin.js';
import { getSafeRequestId } from '../_lib/http.js';
import {
  OAuthError,
  assertRedirectUriAllowed,
  getClient,
  getOAuthConfig,
  normalizeScope,
} from '../_lib/oauth.js';

/**
 * The authorization endpoint.
 *
 * This does not render consent itself — it validates the request and hands off
 * to the app's own /oauth/consent screen, which reuses the existing Firebase
 * login. That keeps sign-in on one code path with the verification gate and
 * breached-password checks already attached, instead of growing a second
 * password surface here.
 *
 * Validation happens BEFORE the redirect. An unregistered redirect_uri or
 * unknown client must produce an error page, never a redirect to the supplied
 * URI, or this endpoint becomes an open redirector.
 */
export function createOAuthAuthorizeHandler({
  env = process.env,
  logger = console,
  adminServicesFactory = getAccountAdminServices,
} = {}) {
  return async function oauthAuthorizeHandler(req, res) {
    const requestId = getSafeRequestId(req);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Request-Id', requestId);

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'invalid_request' });
    }

    let config;
    try {
      config = getOAuthConfig(env);
    } catch {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }

    const query = new URL(req.url, config.issuer).searchParams;
    const clientId = query.get('client_id') || '';
    const redirectUri = query.get('redirect_uri') || '';
    const responseType = query.get('response_type') || '';
    const codeChallenge = query.get('code_challenge') || '';
    const codeChallengeMethod = query.get('code_challenge_method') || '';
    const state = query.get('state') || '';
    const resource = query.get('resource') || '';

    try {
      const { db } = adminServicesFactory(env);
      const client = await getClient({ db, clientId });
      // Throws before any redirect is issued.
      const verifiedRedirect = assertRedirectUriAllowed(client, redirectUri);

      if (responseType !== 'code') {
        throw new OAuthError({
          code: 'unsupported_response_type',
          message: 'Only the authorization code flow is supported.',
        });
      }
      if (!codeChallenge || codeChallengeMethod !== 'S256') {
        throw new OAuthError({
          code: 'invalid_request',
          message: 'A S256 code_challenge is required.',
        });
      }
      const scope = normalizeScope(query.get('scope'));

      // The client asked for a token for a specific resource; if it names one,
      // it has to be this server. Accepting a foreign value would let us mint a
      // token an attacker intends to replay elsewhere.
      if (resource && resource.replace(/\/+$/, '') !== config.resource) {
        throw new OAuthError({
          code: 'invalid_target',
          message: 'That resource is not served by this authorization server.',
        });
      }

      const consent = new URL('/oauth/consent', config.issuer);
      consent.searchParams.set('client_id', clientId);
      consent.searchParams.set('client_name', client.clientName || 'MCP client');
      consent.searchParams.set('redirect_uri', verifiedRedirect);
      consent.searchParams.set('code_challenge', codeChallenge);
      consent.searchParams.set('code_challenge_method', codeChallengeMethod);
      consent.searchParams.set('scope', scope);
      if (state) consent.searchParams.set('state', state);
      if (resource) consent.searchParams.set('resource', resource);

      res.setHeader('Location', consent.toString());
      return res.status(302).end();
    } catch (error) {
      if (error instanceof OAuthError) {
        // Rendered here rather than redirected: at this point the redirect
        // target is either unknown or untrusted.
        return res.status(error.status).json({
          error: error.code,
          error_description: error.message,
        });
      }
      logger.error?.('[oauth-authorize] failed', { requestId });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  };
}

export default createOAuthAuthorizeHandler();
