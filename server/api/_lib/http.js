import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function readHeader(req, name) {
  const headers = req?.headers;
  if (!headers) return undefined;

  if (typeof headers.get === 'function') {
    return headers.get(name) ?? undefined;
  }

  const lowerName = name.toLowerCase();
  const value =
    headers[lowerName] ??
    headers[name] ??
    Object.entries(headers).find(
      ([headerName]) => headerName.toLowerCase() === lowerName,
    )?.[1];

  return Array.isArray(value) ? value[0] : value;
}

export function sanitizeRequestId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return SAFE_REQUEST_ID.test(trimmed) ? trimmed : null;
}

export function getSafeRequestId(req) {
  return (
    sanitizeRequestId(readHeader(req, 'x-request-id')) ||
    sanitizeRequestId(readHeader(req, 'x-vercel-id')) ||
    randomUUID()
  );
}

/**
 * Vercel supplies and sanitizes this platform header at the edge. Do not use
 * client-controlled forwarding headers for security buckets.
 */
export function getTrustedClientIp(req) {
  const forwarded = readHeader(req, 'x-vercel-forwarded-for');
  if (typeof forwarded !== 'string') return 'unavailable';
  const candidate = forwarded.split(',')[0]?.trim();
  return candidate && isIP(candidate)
    ? candidate.toLowerCase()
    : 'unavailable';
}

export function normalizeLiteLLMBaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new TypeError('A LiteLLM base URL is required.');
  }

  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new TypeError('The LiteLLM base URL is invalid.');
  }

  const isLocalHttp =
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new TypeError('The LiteLLM base URL must use HTTPS.');
  }

  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');

  // Historical browser configs sometimes pointed at a provider compatibility
  // path or the OpenAI API prefix. Management endpoints live at proxy root.
  for (const suffix of ['/gemini', '/v1']) {
    if (url.pathname.toLowerCase().endsWith(suffix)) {
      url.pathname = url.pathname.slice(0, -suffix.length);
    }
  }

  return url.toString().replace(/\/$/, '');
}

export { readHeader };
