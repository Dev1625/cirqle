import { getAccountAdminServices } from '../_lib/account-admin.js';
import { getSafeRequestId } from '../_lib/http.js';
import { OAuthError, registerClient } from '../_lib/oauth.js';
import {
  ProvisioningRateLimitError,
  createProvisioningRateLimiter,
} from '../_lib/rate-limit.js';

/**
 * Dynamic client registration (RFC 7591).
 *
 * Deliberately unauthenticated, as the spec intends: a client has no way to
 * obtain credentials before it has any. Registration on its own grants nothing
 * — a client id is useless until a human completes the consent screen — so the
 * exposure is limited to junk records, which the rate limit bounds.
 */
export function createOAuthRegisterHandler({
  env = process.env,
  logger = console,
  adminServicesFactory = getAccountAdminServices,
  rateLimiter,
  now = () => new Date(),
} = {}) {
  const limiter =
    rateLimiter ||
    createProvisioningRateLimiter({
      env,
      logger,
      limit: 10,
      windowSeconds: 3_600,
    });

  return async function oauthRegisterHandler(req, res) {
    const requestId = getSafeRequestId(req);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Request-Id', requestId);

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'invalid_request' });
    }

    try {
      // Keyed on the caller, not on a user: there is no user yet.
      await limiter.check(`oauth-register:${requestId.slice(0, 24)}`);
    } catch (error) {
      if (error instanceof ProvisioningRateLimitError) {
        res.setHeader('Retry-After', String(error.retryAfter));
        return res.status(429).json({ error: 'temporarily_unavailable' });
      }
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }

    try {
      const { db } = adminServicesFactory(env);
      const registered = await registerClient({
        db,
        body: req.body || {},
        now: now(),
      });
      return res.status(201).json(registered);
    } catch (error) {
      if (error instanceof OAuthError) {
        return res
          .status(error.status)
          .json({ error: error.code, error_description: error.message });
      }
      logger.error?.('[oauth-register] failed', { requestId });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  };
}

export default createOAuthRegisterHandler();
