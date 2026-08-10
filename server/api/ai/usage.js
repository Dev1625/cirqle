import {
  AuthError,
  verifyActiveBearerFirebaseToken,
} from '../_lib/firebase-admin.js';
import { getSafeRequestId } from '../_lib/http.js';
import {
  createLiteLLMClient,
  hashLiteLLMKey,
  LiteLLMRequestError,
} from '../_lib/litellm.js';
import {
  BUDGET_DURATION,
  BUDGET_LIMIT_USD,
  deriveManagedVirtualKey,
} from '../_lib/provisioning.js';
import { getAIFeatureUsageDescriptor } from '../_lib/ai-feature-policy.js';
import { getExplicitLiteLLMConfig } from '../_lib/litellm-config.js';

function setResponseHeaders(res, requestId) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Vary', 'Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Request-Id', requestId);
}

function sendError(res, status, code, requestId) {
  return res.status(status).json({ error: code, requestId });
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function keyDetails(payload) {
  return payload?.info || payload?.key_info || payload?.key || payload || {};
}

function aggregateLogs(payload) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : [];
  const features = {};
  let requestCount = 0;
  let successfulRequests = 0;
  let failedRequests = 0;
  let totalTokens = 0;

  for (const row of rows) {
    requestCount += 1;
    totalTokens += number(row.total_tokens ?? row.usage?.total_tokens);
    const status = String(
      row.status || row.request_status || row.status_code || '',
    ).toLowerCase();
    if (
      status.includes('fail') ||
      status.includes('error') ||
      number(row.status_code) >= 400
    ) {
      failedRequests += 1;
    } else {
      successfulRequests += 1;
    }

    const feature =
      row.metadata?.cirqle_feature ||
      row.request_tags?.cirqle_feature ||
      row.call_type ||
      'unattributed';
    const safeFeature =
      typeof feature === 'string' && feature.length <= 64
        ? feature
        : 'unattributed';
    const descriptor = getAIFeatureUsageDescriptor(safeFeature);
    const current = features[safeFeature] || {
      requests: 0,
      spendUsd: 0,
      tokens: 0,
      label: descriptor.label,
      group: descriptor.group,
    };
    current.requests += 1;
    current.spendUsd += number(row.spend);
    current.tokens += number(row.total_tokens ?? row.usage?.total_tokens);
    features[safeFeature] = current;
  }

  return {
    requestCount,
    successfulRequests,
    failedRequests,
    totalTokens,
    features,
  };
}

function spendRows(payload) {
  return Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : [];
}

function spendPageHasMore(payload, page, pageSize, rowCount) {
  if (payload?.has_more === true || payload?.hasMore === true) return true;
  if (Number(payload?.total_pages) > page) return true;
  if (Number(payload?.next_page) > page) return true;
  return rowCount >= pageSize;
}

function spendRowBelongsToIdentity(row, identity, keyHash) {
  if (!row || typeof row !== 'object') return false;
  const userIds = [
    row.user_id,
    row.userId,
    row.metadata?.user_api_key_user_id,
    row.metadata?.user_id,
    row.request_tags?.user_id,
  ].filter((value) => typeof value === 'string' && value);
  if (userIds.some((value) => value === identity.uid)) return true;

  if (!keyHash) return false;
  const keyHashes = [
    row.api_key_hash,
    row.key_hash,
    row.metadata?.user_api_key_hash,
    row.metadata?.api_key_hash,
    row.request_tags?.api_key_hash,
  ].filter((value) => typeof value === 'string' && value);
  return keyHashes.some((value) => value === keyHash);
}

/**
 * `/spend/logs/v2` declares start_date/end_date as strings and documents
 * "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD". A full ISO-8601 timestamp is neither,
 * so send the documented shape rather than whatever Date.toISOString produces.
 */
function spendLogDate(value) {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

// LiteLLM declares page_size as `Query(default=50, ge=1, le=100)`. Anything
// above 100 fails request validation with a 422 before the handler runs, which
// took the whole usage panel down rather than just truncating a page.
export const MAX_SPEND_LOG_PAGE_SIZE = 100;

export async function fetchSpendLogPages({
  client,
  identity,
  start,
  end,
  pageSize = MAX_SPEND_LOG_PAGE_SIZE,
  maxPages = 10,
  maxReadMs = 2_500,
  now = () => Date.now(),
  keyHash = null,
}) {
  const rows = [];
  const startedAt = now();
  let truncated = false;
  let pagesRead = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1 && now() - startedAt >= maxReadMs) {
      truncated = true;
      break;
    }
    const requestedPageSize = Math.min(
      Math.max(1, Math.floor(pageSize)),
      MAX_SPEND_LOG_PAGE_SIZE,
    );
    const query = new URLSearchParams({
      user_id: identity.uid,
      start_date: spendLogDate(start),
      end_date: spendLogDate(end),
      page: String(page),
      page_size: String(requestedPageSize),
    });
    const payload = await client.request(`/spend/logs/v2?${query}`);
    const untrustedPageRows = spendRows(payload);
    const pageRows = untrustedPageRows.filter((row) =>
      spendRowBelongsToIdentity(row, identity, keyHash),
    );
    rows.push(...pageRows);
    pagesRead += 1;
    const hasMore = spendPageHasMore(
      payload,
      page,
      requestedPageSize,
      untrustedPageRows.length,
    );
    if (!hasMore) break;
    if (page === maxPages) truncated = true;
  }

  return Object.freeze({ rows, pagesRead, truncated });
}

export function createAIUsageHandler({
  env = process.env,
  logger = console,
  verifyIdentity = verifyActiveBearerFirebaseToken,
  liteLLMClientFactory,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  maxLogPages = 10,
  maxLogReadMs = 2_500,
} = {}) {
  return async function aiUsageHandler(req, res) {
    const requestId = getSafeRequestId(req);
    setResponseHeaders(res, requestId);

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
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
      return sendError(res, 503, 'authentication_unavailable', requestId);
    }

    let config;
    try {
      config = getExplicitLiteLLMConfig(env, {
        requireMasterKey: true,
        errorCode: 'usage_not_configured',
      });
    } catch {
      return sendError(res, 503, 'usage_unavailable', requestId);
    }
    const client =
      liteLLMClientFactory?.({
        baseUrl: config.baseUrl,
        masterKey: config.masterKey,
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

    try {
      const rawKey = deriveManagedVirtualKey(
        identity.uid,
        config.derivationSecret,
      );
      const keyHash = hashLiteLLMKey(rawKey);
      const keyInfoPayload = await client.getKey(keyHash);
      if (!keyInfoPayload) {
        return sendError(res, 404, 'ai-not-provisioned', requestId);
      }

      const end = new Date(now());
      const start = new Date(end.getTime() - 31 * 24 * 60 * 60 * 1000);
      const logResult = await fetchSpendLogPages({
        client,
        identity,
        start,
        end,
        maxPages: maxLogPages,
        maxReadMs: maxLogReadMs,
        now,
        keyHash,
      });
      const info = keyDetails(keyInfoPayload);
      const spendUsd = number(info.spend ?? info.current_spend);
      const limitUsd = number(info.max_budget, BUDGET_LIMIT_USD);
      const percentage = limitUsd > 0 ? (spendUsd / limitUsd) * 100 : 0;
      const resetAt =
        info.budget_reset_at ||
        info.budget_reset_at_utc ||
        info.expires ||
        null;

      return res.status(200).json({
        requestId,
        period: {
          spendUsd,
          limitUsd,
          percentage: Math.min(100, Math.max(0, percentage)),
          duration: info.budget_duration || BUDGET_DURATION,
          resetAt,
        },
        ...aggregateLogs(logResult.rows),
        detail: {
          complete: !logResult.truncated,
          truncated: logResult.truncated,
          pagesRead: logResult.pagesRead,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
        },
      });
    } catch (error) {
      logger.error?.('[ai-usage] unavailable', {
        requestId,
        gatewayStatus:
          error instanceof LiteLLMRequestError ? error.status : null,
      });
      return sendError(res, 502, 'usage_unavailable', requestId);
    }
  };
}

export default createAIUsageHandler();
