import { createHash } from 'node:crypto';

import {
  AuthError,
  verifyActiveBearerFirebaseToken,
} from './_lib/firebase-admin.js';
import {
  getSafeRequestId,
  getTrustedClientIp,
} from './_lib/http.js';
import {
  createLiteLLMClient,
  LiteLLMRequestError,
} from './_lib/litellm.js';
import {
  createProvisioningRateLimiter,
  ProvisioningRateLimitError,
} from './_lib/rate-limit.js';
import {
  BUDGET_DURATION,
  BUDGET_LIMIT_USD,
  deriveManagedVirtualKey,
  PRODUCTION_MODEL_ALIASES,
  provisionLiteLLMIdentity,
} from './_lib/provisioning.js';
import { getExplicitLiteLLMConfig } from './_lib/litellm-config.js';
import { scrubLegacyAIKeyFields } from './_lib/legacy-key-scrub.js';

function setResponseHeaders(res, requestId) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Request-Id', requestId);
}

function sendError(res, status, code, message, requestId) {
  return res.status(status).json({
    error: { code, message },
    requestId,
  });
}

function safeSubjectHash(uid) {
  return createHash('sha256').update(uid).digest('hex').slice(0, 16);
}

function logSafe(logger, level, event, details) {
  const method =
    logger && typeof logger[level] === 'function'
      ? logger[level].bind(logger)
      : null;
  method?.(`[register-user] ${event}`, details);
}

function getGatewayConfig(env) {
  return getExplicitLiteLLMConfig(env, {
    requireMasterKey: true,
    errorCode: 'provisioning_not_configured',
  });
}

function dailyIssuanceLimit(env) {
  const configured = Number(env.CIRQLE_AI_NEW_KEYS_PER_DAY || 25);
  return Number.isInteger(configured) &&
    configured >= 1 &&
    configured <= 10_000
    ? configured
    : 25;
}

export function createRegisterUserHandler({
  env = process.env,
  logger = console,
  verifyIdentity = verifyActiveBearerFirebaseToken,
  liteLLMClientFactory,
  rateLimiter,
  issuanceLimiter,
  scrubLegacyKeys = scrubLegacyAIKeyFields,
  fetchImpl = globalThis.fetch,
} = {}) {
  const limiter =
    rateLimiter ||
    createProvisioningRateLimiter({
      env,
      fetchImpl,
      logger,
    });
  const newKeyLimiter =
    issuanceLimiter ||
    createProvisioningRateLimiter({
      env,
      fetchImpl,
      logger,
      limit: dailyIssuanceLimit(env),
      windowSeconds: 24 * 60 * 60,
    });

  return async function registerUserHandler(req, res) {
    const requestId = getSafeRequestId(req);
    setResponseHeaders(res, requestId);

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendError(
        res,
        405,
        'method_not_allowed',
        'Method not allowed.',
        requestId,
      );
    }

    let identity;
    try {
      identity = await verifyIdentity(req);
    } catch (error) {
      if (
        error?.code === 'session_revoked' ||
        error?.code === 'account_unavailable'
      ) {
        return sendError(
          res,
          Number(error.status) || 401,
          error.code,
          error.code === 'session_revoked'
            ? 'Please sign in again to continue.'
            : 'This account is not available.',
          requestId,
        );
      }
      if (error instanceof AuthError || error?.code === 'unauthorized') {
        logSafe(logger, 'warn', 'authentication_rejected', { requestId });
        return sendError(
          res,
          401,
          'unauthorized',
          'Authentication required.',
          requestId,
        );
      }

      logSafe(logger, 'error', 'authentication_unavailable', {
        requestId,
        errorCode: error?.code || 'unknown',
      });
      return sendError(
        res,
        503,
        'authentication_unavailable',
        'Authentication is temporarily unavailable.',
        requestId,
      );
    }

    // Kept only as a backwards-compatible guard for older clients. Identity
    // always comes from the verified token; a body can never choose the UID.
    const claimedUserId = req.body?.userId;
    if (claimedUserId != null && claimedUserId !== identity.uid) {
      logSafe(logger, 'warn', 'cross_user_claim_rejected', {
        requestId,
        subject: safeSubjectHash(identity.uid),
      });
      return sendError(
        res,
        403,
        'identity_mismatch',
        'The requested account does not match the signed-in user.',
        requestId,
      );
    }

    if (!identity.email || identity.emailVerified !== true) {
      return sendError(
        res,
        403,
        'email_verification_required',
        'Verify your email before enabling paid AI features.',
        requestId,
      );
    }

    try {
      const rates = await Promise.all([
        limiter.check(`uid:${identity.uid}`),
        limiter.check(`ip:${getTrustedClientIp(req)}`),
      ]);
      res.setHeader(
        'RateLimit-Limit',
        String(Math.min(...rates.map((rate) => rate.limit))),
      );
      res.setHeader(
        'RateLimit-Remaining',
        String(Math.min(...rates.map((rate) => rate.remaining))),
      );
      res.setHeader(
        'RateLimit-Reset',
        String(Math.max(...rates.map((rate) => rate.resetAt))),
      );
    } catch (error) {
      if (error instanceof ProvisioningRateLimitError) {
        res.setHeader('Retry-After', String(error.retryAfter));
        return sendError(
          res,
          429,
          'rate_limited',
          'Too many provisioning attempts. Please try again shortly.',
          requestId,
        );
      }
      // The limiter is designed to fail over internally. Treat an unexpected
      // limiter exception as a temporary service failure, not an auth bypass.
      logSafe(logger, 'error', 'rate_limiter_unavailable', { requestId });
      return sendError(
        res,
        503,
        'provisioning_unavailable',
        'AI setup is temporarily unavailable.',
        requestId,
      );
    }

    try {
      const config = getGatewayConfig(env);
      const client =
        liteLLMClientFactory?.({
          ...config,
          requestId,
          fetchImpl,
          logger,
        }) ||
        createLiteLLMClient({
          baseUrl: config.baseUrl,
          masterKey: config.masterKey,
          requestId,
          fetchImpl,
          logger,
        });

      const apiKey = deriveManagedVirtualKey(
        identity.uid,
        config.derivationSecret,
      );
      const result = await provisionLiteLLMIdentity({
        client,
        identity,
        apiKey,
        beforeCreate: () =>
          newKeyLimiter.check('new-managed-key:global:v1'),
      });
      await scrubLegacyKeys({
        uid: identity.uid,
        email: identity.email,
        env,
        client,
      });

      logSafe(logger, 'info', 'provisioning_succeeded', {
        requestId,
        subject: safeSubjectHash(identity.uid),
        reused: result.reused,
      });

      // The deterministic virtual key never crosses the server boundary.
      // `/api/ai/chat` derives the same key after verifying each request.
      return res.status(200).json({
        provisioned: true,
        reused: result.reused,
        models: [...PRODUCTION_MODEL_ALIASES],
        budget: {
          limitUsd: BUDGET_LIMIT_USD,
          duration: BUDGET_DURATION,
        },
      });
    } catch (error) {
      const subject = safeSubjectHash(identity.uid);

      if (error instanceof LiteLLMRequestError) {
        logSafe(logger, 'error', 'gateway_request_failed', {
          requestId,
          subject,
          gatewayStatus: error.status,
          errorCode: error.code,
        });
        return sendError(
          res,
          502,
          'provisioning_unavailable',
          'AI setup is temporarily unavailable.',
          requestId,
        );
      }

      if (error instanceof ProvisioningRateLimitError) {
        res.setHeader('Retry-After', String(error.retryAfter));
        logSafe(logger, 'warn', 'daily_issuance_limit_reached', {
          requestId,
          subject,
        });
        return sendError(
          res,
          429,
          'ai_enrollment_paused',
          'New AI access is temporarily paused. Please try again later.',
          requestId,
        );
      }

      if (
        error?.code === 'provisioning_not_configured' ||
        error?.code === 'legacy_key_scrub_failed' ||
        error?.code === 'distributed_rate_limit_unavailable'
      ) {
        logSafe(logger, 'error', 'configuration_missing', {
          requestId,
          subject,
        });
        return sendError(
          res,
          503,
          'provisioning_unavailable',
          'AI setup is temporarily unavailable.',
          requestId,
        );
      }

      logSafe(logger, 'error', 'unexpected_failure', {
        requestId,
        subject,
        errorCode: error?.code || 'unknown',
      });
      return sendError(
        res,
        500,
        'internal_error',
        'AI setup could not be completed.',
        requestId,
      );
    }
  };
}

export default createRegisterUserHandler();
