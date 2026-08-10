import { getSafeRequestId } from '../api/_lib/http.js';
import {
  SUPPORTED_SCOPES,
  getOAuthConfig,
} from '../api/_lib/oauth.js';

/**
 * OAuth discovery documents, served at the domain root.
 *
 * These live outside server/api/ and get their own Vercel entry because they
 * are reached at /.well-known/..., not /api/..., so the shared dispatcher's
 * path parsing cannot route them. vercel.json rewrites both paths here and
 * distinguishes them with a `doc` query parameter.
 *
 * Generated rather than checked in as static files: the issuer is
 * configurable, and a stale hard-coded URL would break the login flow in a way
 * that is very hard to read from the client's error message.
 */

const DOCUMENTS = Object.freeze({
  // RFC 9728. The MCP specification requires this and requires it to name at
  // least one authorization server.
  'protected-resource': (config) => ({
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
    resource_documentation: `${config.issuer}/`,
  }),
  // RFC 8414.
  'authorization-server': (config) => ({
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/api/oauth/authorize`,
    token_endpoint: `${config.issuer}/api/oauth/token`,
    registration_endpoint: `${config.issuer}/api/oauth/register`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only. Advertising 'plain' would let a client opt out of the one
    // protection standing between an intercepted code and an access token.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    resource_indicators_supported: true,
  }),
});

export function createWellKnownHandler({ env = process.env } = {}) {
  return async function wellKnownHandler(req, res) {
    const requestId = getSafeRequestId(req);
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const url = String(req.url || '');
    const doc = /oauth-authorization-server|doc=authorization-server/.test(url)
      ? 'authorization-server'
      : /oauth-protected-resource|doc=protected-resource/.test(url)
        ? 'protected-resource'
        : null;
    const build = doc ? DOCUMENTS[doc] : null;
    if (!build) return res.status(404).json({ error: 'not_found' });

    let config;
    try {
      config = getOAuthConfig(env);
    } catch {
      // Discovery is public, so it must never leak why it is unavailable.
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }

    // Public and stable; a short cache keeps clients from re-fetching on every
    // reconnect without making a rotation take a day to propagate.
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(build(config));
  };
}

export default createWellKnownHandler();
