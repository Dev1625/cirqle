import { createHash } from 'node:crypto';

import {
  AccountAuthenticationError,
  getAccountAdminServices,
  requireRecentAuthentication,
  verifyActiveAccountIdentity,
} from '../_lib/account-admin.js';
import { AccountSecurityError } from '../_lib/account-security.js';
import {
  ContactMaintenanceError,
  runOwnerContactMaintenance,
} from '../_lib/contact-maintenance.js';
import { getSafeRequestId } from '../_lib/http.js';

const ALLOWED_BODY_FIELDS = new Set(['maxRequests', 'maxMutations']);

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
  if (req.body == null || req.body === '') return {};
  let body = req.body;
  if (typeof body === 'string' && body.length <= 8_192) {
    try {
      body = JSON.parse(body);
    } catch {
      throw new ContactMaintenanceError();
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ContactMaintenanceError();
  }
  if (Object.keys(body).some((field) => !ALLOWED_BODY_FIELDS.has(field))) {
    throw new ContactMaintenanceError({
      code: 'contact_maintenance_field_not_allowed',
      message:
        'Only bounded maintenance limits may be supplied. The signed-in account is always used.',
    });
  }
  return body;
}

export function createContactMaintenanceHandler({
  verifyIdentity = verifyActiveAccountIdentity,
  assertRecent = requireRecentAuthentication,
  runMaintenance,
  adminServicesFactory = getAccountAdminServices,
  now = () => new Date(),
  logger = console,
} = {}) {
  return async function contactMaintenanceHandler(req, res) {
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
      assertRecent(identity);
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
        error?.code === 'unauthorized' ||
        error?.code === 'recent_login_required'
      ) {
        const recent = error?.code === 'recent_login_required';
        return sendError(
          res,
          401,
          recent ? 'recent_login_required' : 'unauthorized',
          recent
            ? 'Please verify your identity again to continue.'
            : 'Authentication required.',
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

    let body;
    try {
      body = parseBody(req);
    } catch (error) {
      return sendError(
        res,
        error.status || 400,
        error.code || 'contact_maintenance_invalid',
        error.message || 'The contact-maintenance request is invalid.',
        requestId,
      );
    }

    try {
      const report = runMaintenance
        ? await runMaintenance({
            uid: identity.uid,
            now: now(),
            maxRequests: body.maxRequests,
            maxMutations: body.maxMutations,
          })
        : await runOwnerContactMaintenance({
            db: adminServicesFactory().db,
            uid: identity.uid,
            now: now(),
            maxRequests: body.maxRequests,
            maxMutations: body.maxMutations,
            logger,
          });
      if (
        report.retryableFailures > 0 &&
        report.completed === 0 &&
        report.deferred === 0
      ) {
        return sendError(
          res,
          503,
          'contact_maintenance_unavailable',
          'Contact maintenance could not finish. It is safe to retry.',
          requestId,
        );
      }
      return res.status(200).json(report);
    } catch (error) {
      if (error instanceof ContactMaintenanceError && error.status < 500) {
        return sendError(
          res,
          error.status,
          error.code,
          error.message,
          requestId,
        );
      }
      logger?.error?.('[contact-maintenance] owner run failed', {
        requestId,
        subject: subjectHash(identity.uid),
        errorCode: safeErrorCode(error?.code),
      });
      return sendError(
        res,
        503,
        'contact_maintenance_unavailable',
        'Contact maintenance could not finish. It is safe to retry.',
        requestId,
      );
    }
  };
}

export default createContactMaintenanceHandler();
