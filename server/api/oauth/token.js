import { getAccountAdminServices } from '../_lib/account-admin.js';
import { getSafeRequestId } from '../_lib/http.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  OAuthError,
  getOAuthConfig,
  issueRefreshToken,
  redeemAuthorizationCode,
  rotateRefreshToken,
  signAccessToken,
} from '../_lib/oauth.js';

/**
 * The token endpoint: authorization_code and refresh_token grants.
 *
 * Clients here are public — no client secret exists — so the security rests on
 * PKCE for the code grant and on rotation for refresh tokens. Both are enforced
 * in oauth.js and neither is optional.
 */

function formBody(req) {
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  // Vercel leaves application/x-www-form-urlencoded as a string, and that is
  // the content type OAuth 2.1 requires at this endpoint.
  if (typeof body === 'string') {
    return Object.fromEntries(new URLSearchParams(body));
  }
  return {};
}

export function createOAuthTokenHandler({
  env = process.env,
  logger = console,
  adminServicesFactory = getAccountAdminServices,
  now = () => new Date(),
} = {}) {
  return async function oauthTokenHandler(req, res) {
    const requestId = getSafeRequestId(req);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
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

    const body = formBody(req);
    const grantType = String(body.grant_type || '');
    const clientId = String(body.client_id || '');
    const issuedAt = now();

    try {
      const { db } = adminServicesFactory(env);
      let uid;
      let scope;

      if (grantType === 'authorization_code') {
        const record = await redeemAuthorizationCode({
          db,
          code: String(body.code || ''),
          clientId,
          redirectUri: String(body.redirect_uri || ''),
          codeVerifier: String(body.code_verifier || ''),
          now: issuedAt,
        });
        uid = record.uid;
        scope = record.scope;
      } else if (grantType === 'refresh_token') {
        const record = await rotateRefreshToken({
          db,
          refreshToken: String(body.refresh_token || ''),
          clientId,
          now: issuedAt,
        });
        uid = record.uid;
        scope = record.scope;
      } else {
        throw new OAuthError({
          code: 'unsupported_grant_type',
          message: 'Use authorization_code or refresh_token.',
        });
      }

      const accessToken = signAccessToken({
        config,
        uid,
        clientId,
        scope,
        now: issuedAt,
      });
      // A fresh refresh token every time, including on refresh: OAuth 2.1
      // rotation for public clients.
      const refreshToken = await issueRefreshToken({
        db,
        uid,
        clientId,
        scope,
        now: issuedAt,
      });

      return res.status(200).json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refreshToken,
        scope,
      });
    } catch (error) {
      if (error instanceof OAuthError) {
        return res
          .status(error.status)
          .json({ error: error.code, error_description: error.message });
      }
      logger.error?.('[oauth-token] failed', {
        requestId,
        grantType: /^[a-z_]{1,40}$/.test(grantType) ? grantType : 'invalid',
      });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  };
}

export default createOAuthTokenHandler();
