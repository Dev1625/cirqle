import { getAccountAdminServices } from '../api/_lib/account-admin.js';
import { ContactIngestError } from '../api/_lib/contact-ingest.js';
import { ContactProfileError } from '../api/_lib/contact-profile.js';
import { getSafeRequestId } from '../api/_lib/http.js';
import {
  McpToolError,
  callMcpTool,
  listMcpTools,
} from '../api/_lib/mcp-tools.js';
import {
  getOAuthConfig,
  verifyAccessToken,
} from '../api/_lib/oauth.js';
import {
  ProvisioningRateLimitError,
  createProvisioningRateLimiter,
} from '../api/_lib/rate-limit.js';

/**
 * Model Context Protocol endpoint, stateless Streamable HTTP.
 *
 * The protocol surface is small — initialize, ping, tools/list, tools/call, and
 * the initialized notification — so it is implemented directly rather than
 * through @modelcontextprotocol/sdk. The SDK pulls seventeen transitive
 * dependencies (express, hono, cors, eventsource…) into a serverless bundle for
 * that handful of methods, and CI fails the build on any high-severity advisory
 * in the tree. Fewer moving parts is the safer trade here.
 *
 * Stateless by design: one request, one response, no session to persist. Vercel
 * functions do not survive between calls, so an SSE session would be a lie.
 *
 * Authentication is a Cirqle OAuth access token and nothing else. Identity
 * still originates in Firebase — the consent screen is the app's own login —
 * but this endpoint only accepts tokens its own authorization server issued,
 * as the specification requires.
 */

const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const SERVER_INFO = Object.freeze({
  name: 'cirqle',
  title: 'Cirqle CRM',
  version: '1.0.0',
});

const INSTRUCTIONS = [
  'Cirqle is a personal relationship CRM. Always call search_contacts before',
  'adding anyone, so an existing record is updated instead of duplicated.',
  'Record only what the supplied text actually says — never fill fields from',
  'outside knowledge about a person or their employer. Everything you write is',
  'tagged as agent-written and the owner can revoke an entire import at once.',
  'Use log_meeting for durable meeting notes and summaries. Use log_interaction',
  'to mirror outreach sent outside Cirqle, including email sent by this agent.',
].join(' ');

// JSON-RPC 2.0 reserved codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function setHeaders(res, requestId) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Vary', 'Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Request-Id', requestId);
}

function rpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Tool results are reported as JSON inside a text block with `isError`, not as
 * a JSON-RPC error. A failed tool call is a normal outcome the model should see
 * and react to; a JSON-RPC error means the protocol itself broke.
 */
function toolContent(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function toolFailure(message, code) {
  return {
    ...toolContent({ error: code, message }),
    isError: true,
  };
}

function negotiateVersion(requested) {
  if (typeof requested !== 'string' || !requested) {
    return LATEST_PROTOCOL_VERSION;
  }
  // Spec: echo the client's version when supported, otherwise answer with our
  // latest and let the client decide whether it can continue.
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

/**
 * Which agent is writing, for the provenance label the owner sees.
 *
 * `clientInfo` arrives on `initialize`, but a stateless server has no session
 * to remember it in by the time a tool is called. The User-Agent is the only
 * per-request signal available, and it is untrusted input — it is sanitised
 * again in contact-ingest before it becomes part of a source id.
 */
function clientName(req) {
  const header = req?.headers?.['user-agent'];
  const name = typeof header === 'string' ? header.trim().slice(0, 80) : '';
  return name || 'unknown-agent';
}

/**
 * Where clients discover the authorization server. Derived from the configured
 * issuer, falling back to the canonical origin so a 401 can always point
 * somewhere even when OAuth itself is unconfigured.
 */
function resourceMetadataUrl(env) {
  const issuer = (
    env?.MCP_OAUTH_ISSUER || 'https://cirqle-taupe.vercel.app'
  )
    .trim()
    .replace(/\/+$/, '');
  return `${issuer}/.well-known/oauth-protected-resource`;
}

function bearerToken(req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(.+)$/i.exec(String(value || '').trim());
  return match ? match[1].trim() : null;
}

/**
 * Identify the caller.
 *
 * A Cirqle OAuth access token, and nothing else. The token is audience-bound
 * to this server, so one minted for any other resource is refused — which the
 * MCP specification requires and is what stops this endpoint being used as a
 * confused deputy.
 *
 * Firebase ID tokens were accepted while the authorization server was being
 * built, because nothing else could reach this endpoint. That path is gone now
 * that OAuth is proven: the spec is explicit that a server must not accept
 * tokens its own authorization server did not issue, and two ways in is one
 * more than anything needs.
 *
 * Verification is purely local, so authenticating costs no network round trip.
 */
async function identifyCaller({ req, env, now }) {
  const token = bearerToken(req);
  if (!token) {
    const error = new Error('Authentication required.');
    error.code = 'invalid_token';
    throw error;
  }
  const config = getOAuthConfig(env);
  const claims = verifyAccessToken({ config, token, now: now() });
  return {
    uid: claims.sub,
    authTime: claims.iat,
    scope: claims.scope || '',
  };
}

export function createMcpHandler({
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
      limit: 120,
      windowSeconds: 60,
    });

  return async function mcpHandler(req, res) {
    const requestId = getSafeRequestId(req);
    setHeaders(res, requestId);

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res
        .status(405)
        .json(rpcError(null, INVALID_REQUEST, 'Use POST for MCP requests.'));
    }

    let identity;
    try {
      identity = await identifyCaller({ req, env, now });
    } catch (error) {
      // Every rejection here is an authentication failure now that OAuth is
      // the only way in; a missing signing secret is the one exception.
      if (error?.code !== 'server_error') {
        // RFC 9728 section 5.1: the 401 must point at the protected-resource
        // metadata document. This is the entire discovery path — a client that
        // gets a bare realm has no way to find the authorization server, which
        // is why the connector UIs could not use this before.
        const metadata = `${resourceMetadataUrl(env)}`;
        res.setHeader(
          'WWW-Authenticate',
          `Bearer resource_metadata="${metadata}"`,
        );
        return res
          .status(401)
          .json(rpcError(null, INVALID_REQUEST, 'Authentication required.'));
      }
      logger.error?.('[mcp] authentication_unavailable', { requestId });
      return res
        .status(503)
        .json(
          rpcError(null, INTERNAL_ERROR, 'Authentication is unavailable.'),
        );
    }

    const message = req.body;
    if (!message || typeof message !== 'object') {
      return res
        .status(400)
        .json(rpcError(null, PARSE_ERROR, 'Expected a JSON-RPC object.'));
    }
    // Batching was removed from the spec in 2025-06-18 and this server never
    // supported it; rejecting explicitly beats half-handling an array.
    if (Array.isArray(message)) {
      return res
        .status(400)
        .json(rpcError(null, INVALID_REQUEST, 'Batched requests are not supported.'));
    }
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return res
        .status(400)
        .json(rpcError(message.id, INVALID_REQUEST, 'Malformed JSON-RPC.'));
    }

    const { id, method, params } = message;
    // A notification has no id and takes no response body.
    const isNotification = id === undefined || id === null;

    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return res.status(202).end();
    }
    if (isNotification) return res.status(202).end();

    try {
      if (method === 'initialize') {
        return res.status(200).json(
          rpcResult(id, {
            protocolVersion: negotiateVersion(params?.protocolVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          }),
        );
      }

      if (method === 'ping') {
        return res.status(200).json(rpcResult(id, {}));
      }

      if (method === 'tools/list') {
        return res.status(200).json(rpcResult(id, { tools: listMcpTools() }));
      }

      if (method === 'tools/call') {
        const name = params?.name;
        if (typeof name !== 'string' || !name) {
          return res
            .status(200)
            .json(rpcError(id, INVALID_PARAMS, 'A tool name is required.'));
        }

        try {
          await limiter.check(`mcp:${identity.uid}`);
        } catch (error) {
          if (error instanceof ProvisioningRateLimitError) {
            res.setHeader('Retry-After', String(error.retryAfter));
            return res
              .status(200)
              .json(
                rpcResult(
                  id,
                  toolFailure(
                    'Too many tool calls. Slow down and retry shortly.',
                    'rate_limited',
                  ),
                ),
              );
          }
          throw error;
        }

        const { db } = adminServicesFactory(env);
        try {
          const result = await callMcpTool({
            name,
            args: params?.arguments || {},
            db,
            uid: identity.uid,
            authTime: identity.authTime,
            client: clientName(req),
            now: now(),
          });
          return res.status(200).json(rpcResult(id, toolContent(result)));
        } catch (error) {
          const known =
            error instanceof McpToolError ||
            error instanceof ContactIngestError ||
            error instanceof ContactProfileError;
          if (!known) {
            logger.error?.('[mcp] tool_failed', {
              requestId,
              tool: name,
              errorCode: error?.code || 'unknown',
            });
          }
          return res.status(200).json(
            rpcResult(
              id,
              toolFailure(
                known ? error.message : 'That tool call could not be completed.',
                known ? error.code : 'tool_failed',
              ),
            ),
          );
        }
      }

      return res
        .status(200)
        .json(rpcError(id, METHOD_NOT_FOUND, `Unknown method: ${method}`));
    } catch (error) {
      logger.error?.('[mcp] unexpected_failure', {
        requestId,
        method,
        errorCode: error?.code || 'unknown',
      });
      return res
        .status(200)
        .json(rpcError(id, INTERNAL_ERROR, 'The request could not be handled.'));
    }
  };
}

export const __testing = Object.freeze({
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  negotiateVersion,
});

export default createMcpHandler();
