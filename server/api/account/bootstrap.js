import {
  AuthError,
  verifyBearerFirebaseToken,
} from '../_lib/firebase-admin.js';
import {
  AccountSecurityError,
  bootstrapVerifiedAccount,
} from '../_lib/account-security.js';
import { getAccountAdminServices } from '../_lib/account-admin.js';
import { getSafeRequestId } from '../_lib/http.js';

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

export function createAccountBootstrapHandler({
  verifyIdentity = verifyBearerFirebaseToken,
  adminServicesFactory = getAccountAdminServices,
  bootstrap = bootstrapVerifiedAccount,
  now = () => new Date(),
} = {}) {
  return async function accountBootstrapHandler(req, res) {
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
    if (
      req.body != null &&
      req.body !== '' &&
      (typeof req.body !== 'object' ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length > 0)
    ) {
      return sendError(
        res,
        400,
        'invalid_request',
        'The bootstrap request must not contain account fields.',
        requestId,
      );
    }

    let identity;
    try {
      identity = await verifyIdentity(req);
    } catch (error) {
      if (error instanceof AuthError || error?.code === 'unauthorized') {
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

    try {
      const result = await bootstrap({
        db: adminServicesFactory().db,
        identity,
        now: now(),
      });
      return res.status(200).json(result);
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
      return sendError(
        res,
        503,
        'account_bootstrap_unavailable',
        'Your account could not be prepared. It is safe to retry.',
        requestId,
      );
    }
  };
}

export default createAccountBootstrapHandler();
