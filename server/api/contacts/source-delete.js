import { createHash } from 'node:crypto';

import {
  AccountAuthenticationError,
  getAccountAdminServices,
  verifyActiveAccountIdentity,
} from '../_lib/account-admin.js';
import { AccountSecurityError } from '../_lib/account-security.js';
import {
  ContactSourceDeleteError,
  deleteContactNoteSource,
  normalizeContactSourceDeleteRequest,
} from '../_lib/contact-source-delete.js';
import { getSafeRequestId } from '../_lib/http.js';
import {
  createProvisioningRateLimiter,
  ProvisioningRateLimitError,
} from '../_lib/rate-limit.js';

const MAX_BODY_BYTES = 4 * 1_024;

function setHeaders(res, requestId) {
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

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw new ContactSourceDeleteError();
    }
    try {
      body = JSON.parse(body);
    } catch {
      throw new ContactSourceDeleteError();
    }
  }
  const serialized = JSON.stringify(body);
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES
  ) {
    throw new ContactSourceDeleteError();
  }
  return normalizeContactSourceDeleteRequest(body);
}

function subjectHash(uid) {
  return createHash('sha256').update(uid).digest('hex').slice(0, 16);
}

export function createContactSourceDeleteHandler({
  verifyIdentity = verifyActiveAccountIdentity,
  removeSource,
  adminServicesFactory = getAccountAdminServices,
  limiter = null,
  env = process.env,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const requestLimiter =
    limiter ||
    createProvisioningRateLimiter({
      env,
      fetchImpl,
      logger,
      limit: 30,
      windowSeconds: 60,
    });

  return async function contactSourceDeleteHandler(req, res) {
    const requestId = getSafeRequestId(req);
    setHeaders(res, requestId);
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
      if (error instanceof AccountSecurityError) {
        return sendError(
          res,
          error.status,
          error.code,
          error.message,
          requestId,
        );
      }
      if (
        error instanceof AccountAuthenticationError ||
        error?.code === 'unauthorized'
      ) {
        return sendError(
          res,
          401,
          'unauthorized',
          'Authentication required.',
          requestId,
        );
      }
      return sendError(
        res,
        503,
        'authentication_unavailable',
        'Authentication is temporarily unavailable.',
        requestId,
      );
    }

    if (!identity.email || identity.emailVerified !== true) {
      return sendError(
        res,
        403,
        'email_verification_required',
        'Verify your email before changing CRM data.',
        requestId,
      );
    }

    try {
      await requestLimiter.check(`contact-source-delete:${identity.uid}`);
      const input = parseBody(req);
      const result = removeSource
        ? await removeSource({ uid: identity.uid, ...input })
        : await deleteContactNoteSource({
            db: adminServicesFactory().db,
            uid: identity.uid,
            ...input,
          });
      return res.status(200).json({ ...result, requestId });
    } catch (error) {
      if (error instanceof ProvisioningRateLimitError) {
        res.setHeader(
          'Retry-After',
          String(Math.max(1, error.retryAfterSeconds || 60)),
        );
        return sendError(
          res,
          error.status,
          error.code,
          error.message,
          requestId,
        );
      }
      if (error instanceof ContactSourceDeleteError) {
        return sendError(
          res,
          error.status,
          error.code,
          error.message,
          requestId,
        );
      }
      logger?.error?.('[contact-source-delete] failed', {
        requestId,
        subject: subjectHash(identity.uid),
        errorCode:
          typeof error?.code === 'string'
            ? error.code.slice(0, 80)
            : 'unknown',
      });
      return sendError(
        res,
        503,
        'source_delete_unavailable',
        'The note could not be removed. It is safe to retry.',
        requestId,
      );
    }
  };
}

export default createContactSourceDeleteHandler();
