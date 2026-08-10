import { createHash } from 'node:crypto';

import {
  AuthError,
  verifyActiveBearerFirebaseToken,
} from '../_lib/firebase-admin.js';
import { getSafeRequestId } from '../_lib/http.js';
import {
  deriveManagedVirtualKey,
  PRODUCTION_MODEL_ALIASES,
} from '../_lib/provisioning.js';
import {
  FEATURE_TAG_PREFIX,
  getAIFeaturePolicy,
  TIER_TAG_PREFIX,
} from '../_lib/ai-feature-policy.js';
import { getExplicitLiteLLMConfig } from '../_lib/litellm-config.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PROMPT_CHARS = 60_000;
const MAX_OUTPUT_TOKENS = 4_000;

function setResponseHeaders(res, requestId) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Request-Id', requestId);
}

function sendError(res, status, code, requestId) {
  return res.status(status).json({ error: code, requestId });
}

function getConfig(env) {
  return getExplicitLiteLLMConfig(env, {
    errorCode: 'ai_not_configured',
  });
}

function normalizeRequest(body) {
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
    return { error: 'invalid_prompt' };
  }

  if (typeof body?.feature !== 'string' || !body.feature) {
    return { error: 'feature_required' };
  }
  const feature = body.feature;
  const policy = getAIFeaturePolicy(feature);
  if (!policy) {
    return { error: 'feature_not_allowed' };
  }

  const requestedModel =
    typeof body?.model === 'string' ? body.model.trim() : '';
  if (
    body?.model != null &&
    (!requestedModel || !PRODUCTION_MODEL_ALIASES.includes(requestedModel))
  ) {
    return { error: 'model_not_allowed' };
  }
  if (requestedModel && requestedModel !== policy.modelAlias) {
    return { error: 'model_feature_mismatch' };
  }

  const temperature = Number(
    body?.temperature ?? policy.defaultTemperature,
  );
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
    return { error: 'invalid_temperature' };
  }
  if (temperature > policy.maxTemperature) {
    return { error: 'temperature_exceeds_policy' };
  }

  const maxTokens =
    body?.maxTokens == null
      ? policy.defaultMaxTokens
      : Math.floor(Number(body.maxTokens));
  if (
    (!Number.isFinite(maxTokens) ||
      maxTokens < 1 ||
      maxTokens > MAX_OUTPUT_TOKENS)
  ) {
    return { error: 'invalid_max_tokens' };
  }
  if (maxTokens > policy.maxOutputTokens) {
    return { error: 'max_tokens_exceeds_policy' };
  }

  if (
    policy.synthetic &&
    (prompt !== policy.exactPrompt || body?.json === true)
  ) {
    return { error: 'invalid_synthetic_request' };
  }

  return {
    prompt,
    model: policy.modelAlias,
    temperature,
    sendsTemperature: policy.sendsTemperature,
    maxTokens,
    feature,
    tier: policy.tier,
    json: body?.json === true,
  };
}

function safeSubject(uid) {
  return createHash('sha256').update(uid).digest('hex').slice(0, 16);
}

export function createAIChatHandler({
  env = process.env,
  logger = console,
  verifyIdentity = verifyActiveBearerFirebaseToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return async function aiChatHandler(req, res) {
    const requestId = getSafeRequestId(req);
    setResponseHeaders(res, requestId);

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendError(res, 405, 'method_not_allowed', requestId);
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
          requestId,
        );
      }
      if (error instanceof AuthError || error?.code === 'unauthorized') {
        return sendError(res, 401, 'unauthorized', requestId);
      }
      logger.error?.('[ai-chat] authentication_unavailable', { requestId });
      return sendError(res, 503, 'authentication_unavailable', requestId);
    }

    if (!identity.email || identity.emailVerified !== true) {
      return sendError(
        res,
        403,
        'email_verification_required',
        requestId,
      );
    }

    const request = normalizeRequest(req.body);
    if (request.error) {
      return sendError(res, 400, request.error, requestId);
    }

    let config;
    try {
      config = getConfig(env);
    } catch {
      logger.error?.('[ai-chat] configuration_missing', { requestId });
      return sendError(res, 503, 'ai-not-provisioned', requestId);
    }

    const controller = new AbortController();
    let abortReason = null;
    const timeout = setTimeout(() => {
      abortReason = 'timeout';
      controller.abort();
    }, timeoutMs);
    const cancelForClosedClient = () => {
      if (!res.writableEnded) {
        abortReason = 'client';
        controller.abort();
      }
    };
    res.once?.('close', cancelForClosedClient);
    const apiKey = deriveManagedVirtualKey(
      identity.uid,
      config.derivationSecret,
    );

    try {
      const response = await fetchImpl(
        `${config.baseUrl}/v1/chat/completions`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-Request-Id': requestId,
          },
          body: JSON.stringify({
            model: request.model,
            messages: [{ role: 'user', content: request.prompt }],
            ...(request.sendsTemperature
              ? { temperature: request.temperature }
              : {}),
            ...(request.maxTokens
              ? { max_tokens: request.maxTokens }
              : {}),
            ...(request.json
              ? { response_format: { type: 'json_object' } }
              : {}),
            metadata: {
              cirqle_feature: request.feature,
              cirqle_tier: request.tier,
              cirqle_request_id: requestId,
              // LiteLLM filters spend-log metadata down to its own
              // SpendLogsMetadata allowlist, so the three keys above never
              // reach the spend log and per-feature usage read back as the
              // raw call type. `tags` is the supported passthrough: it is
              // persisted verbatim as request_tags. Keep both — the keys
              // above still travel with the live request.
              tags: [
                `${FEATURE_TAG_PREFIX}${request.feature}`,
                `${TIER_TAG_PREFIX}${request.tier}`,
              ],
            },
          }),
        },
      );

      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // Best-effort: never read provider error bodies.
        }
        logger.warn?.('[ai-chat] gateway_rejected', {
          requestId,
          subject: safeSubject(identity.uid),
          feature: request.feature,
          status: response.status,
        });

        if (response.status === 401) {
          return sendError(res, 503, 'ai-not-provisioned', requestId);
        }
        if (response.status === 402 || response.status === 403) {
          return sendError(res, 403, 'budget_or_model_denied', requestId);
        }
        if (response.status === 429) {
          return sendError(res, 429, 'rate_limited', requestId);
        }
        return sendError(res, 502, 'gateway_unavailable', requestId);
      }

      const payload = await response.json();
      const text = payload?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        return sendError(res, 502, 'invalid_model_response', requestId);
      }

      return res.status(200).json({
        text: text.trim(),
        requestId,
        feature: request.feature,
        model: request.model,
        tier: request.tier,
        usage: {
          promptTokens: Number(payload?.usage?.prompt_tokens) || 0,
          completionTokens: Number(payload?.usage?.completion_tokens) || 0,
          totalTokens: Number(payload?.usage?.total_tokens) || 0,
        },
      });
    } catch {
      if (abortReason === 'client') {
        logger.info?.('[ai-chat] client_cancelled', {
          requestId,
          subject: safeSubject(identity.uid),
          feature: request.feature,
        });
        if (res.writableEnded || res.destroyed) return;
        return sendError(res, 499, 'request_cancelled', requestId);
      }
      logger.error?.('[ai-chat] gateway_unavailable', {
        requestId,
        subject: safeSubject(identity.uid),
        feature: request.feature,
        timedOut: controller.signal.aborted,
      });
      return sendError(
        res,
        controller.signal.aborted ? 504 : 502,
        controller.signal.aborted ? 'gateway_timeout' : 'gateway_unavailable',
        requestId,
      );
    } finally {
      clearTimeout(timeout);
      res.removeListener?.('close', cancelForClosedClient);
    }
  };
}

export default createAIChatHandler();
