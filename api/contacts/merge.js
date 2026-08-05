import { createHash } from 'node:crypto';

import {
  AccountAuthenticationError,
  getAccountAdminServices,
  verifyActiveAccountIdentity,
} from '../_lib/account-admin.js';
import { AccountSecurityError } from '../_lib/account-security.js';
import {
  ContactMergeError,
  executeAdminContactMerge,
  normalizeContactMergeRequest,
} from '../_lib/contact-merge.js';
import { getSafeRequestId } from '../_lib/http.js';

const MAX_BODY_BYTES = 64 * 1_024;

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

function subjectHash(uid) {
  return createHash('sha256').update(uid).digest('hex').slice(0, 16);
}

function safeErrorCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9._/-]{1,80}$/.test(code) ? code : 'unknown';
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw new ContactMergeError();
    }
    try {
      body = JSON.parse(body);
    } catch {
      throw new ContactMergeError();
    }
  } else {
    let serialized;
    try {
      serialized = JSON.stringify(body);
    } catch {
      throw new ContactMergeError();
    }
    if (
      typeof serialized !== 'string' ||
      Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES
    ) {
      throw new ContactMergeError();
    }
  }
  return normalizeContactMergeRequest(body);
}

export function createContactMergeHandler({
  verifyIdentity = verifyActiveAccountIdentity,
  mergeContact,
  adminServicesFactory = getAccountAdminServices,
  now = () => new Date(),
  logger = console,
} = {}) {
  return async function contactMergeHandler(req, res) {
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

    let input;
    try {
      input = parseBody(req);
    } catch (error) {
      const known =
        error instanceof ContactMergeError
          ? error
          : new ContactMergeError();
      return sendError(
        res,
        known.status,
        known.code,
        known.message,
        requestId,
      );
    }

    try {
      const result = mergeContact
        ? await mergeContact({
            uid: identity.uid,
            authTime: identity.authTime,
            input,
            now: now(),
          })
        : await executeAdminContactMerge({
            db: adminServicesFactory().db,
            uid: identity.uid,
            authTime: identity.authTime,
            input,
            now: now(),
          });
      return res.status(200).json({ ...result, requestId });
    } catch (error) {
      if (error instanceof ContactMergeError) {
        return sendError(
          res,
          error.status,
          error.code,
          error.message,
          requestId,
        );
      }
      logger?.error?.('[contact-merge] transaction failed', {
        requestId,
        subject: subjectHash(identity.uid),
        errorCode: safeErrorCode(error?.code),
      });
      return sendError(
        res,
        503,
        'contact_merge_unavailable',
        'The contacts could not be merged. It is safe to retry.',
        requestId,
      );
    }
  };
}

export default createContactMergeHandler();
