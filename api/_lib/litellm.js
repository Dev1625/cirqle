import { createHash } from 'node:crypto';

import { normalizeLiteLLMBaseUrl } from './http.js';

const DEFAULT_TIMEOUT_MS = 12_000;

export class LiteLLMRequestError extends Error {
  constructor({
    message = 'The LiteLLM gateway request failed.',
    code = 'litellm_request_failed',
    status = null,
  } = {}) {
    super(message);
    this.name = 'LiteLLMRequestError';
    this.code = code;
    this.status = status;
  }
}

export function hashLiteLLMKey(apiKey) {
  return createHash('sha256').update(apiKey).digest('hex');
}

function safeLog(logger, level, event, details) {
  const method =
    logger && typeof logger[level] === 'function'
      ? logger[level].bind(logger)
      : null;
  method?.(`[litellm] ${event}`, details);
}

export function createLiteLLMClient({
  baseUrl,
  masterKey,
  requestId,
  fetchImpl = globalThis.fetch,
  logger = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A fetch implementation is required.');
  }
  if (!masterKey) {
    throw new TypeError('A LiteLLM master key is required.');
  }

  const normalizedBaseUrl = normalizeLiteLLMBaseUrl(baseUrl);

  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const url = new URL(path, `${normalizedBaseUrl}/`);

    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${masterKey}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Do not read or log provider/gateway response bodies. They can include
        // credentials, upstream payload excerpts, and implementation details.
        try {
          await response.body?.cancel();
        } catch {
          // The status is sufficient; cancellation is best-effort.
        }
        throw new LiteLLMRequestError({
          code: 'litellm_http_error',
          status: response.status,
        });
      }

      if (response.status === 204) return null;

      try {
        return await response.json();
      } catch {
        throw new LiteLLMRequestError({
          code: 'litellm_invalid_response',
          status: response.status,
        });
      }
    } catch (error) {
      if (error instanceof LiteLLMRequestError) throw error;

      safeLog(logger, 'error', 'network_failure', {
        requestId,
        route: url.pathname,
        timedOut: controller.signal.aborted,
      });
      throw new LiteLLMRequestError({
        code: controller.signal.aborted
          ? 'litellm_timeout'
          : 'litellm_unavailable',
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getOrNull(path) {
    try {
      return await request(path);
    } catch (error) {
      if (error instanceof LiteLLMRequestError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  return Object.freeze({
    request,
    getUser(userId) {
      return getOrNull(`/user/info?user_id=${encodeURIComponent(userId)}`);
    },
    createUser(payload) {
      return request('/user/new', { method: 'POST', body: payload });
    },
    updateUser(payload) {
      return request('/user/update', { method: 'POST', body: payload });
    },
    getKey(keyHash) {
      // A SHA-256 token hash is intentionally used in the query string. Raw
      // virtual keys must never land in proxy/access-log URLs.
      return getOrNull(`/key/info?key=${encodeURIComponent(keyHash)}`);
    },
    createKey(payload) {
      return request('/key/generate', { method: 'POST', body: payload });
    },
    updateKey(payload) {
      return request('/key/update', { method: 'POST', body: payload });
    },
    listUserKeys(userId) {
      const query = new URLSearchParams({
        user_id: userId,
        return_full_object: 'true',
      });
      return request(`/key/list?${query}`);
    },
    deleteKeys(keys) {
      return request('/key/delete', {
        method: 'POST',
        body: { keys },
      });
    },
  });
}
