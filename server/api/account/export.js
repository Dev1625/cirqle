import { createHash } from 'node:crypto';
import { once } from 'node:events';

import {
  AccountAuthenticationError,
  getAccountAdminServices,
  requireRecentAuthentication,
  streamAccountExport,
  verifyActiveAccountIdentity,
} from '../_lib/account-admin.js';
import { AccountSecurityError } from '../_lib/account-security.js';
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

function subjectHash(uid) {
  return createHash('sha256').update(uid).digest('hex').slice(0, 16);
}

export function createAccountExportHandler({
  verifyIdentity = verifyActiveAccountIdentity,
  assertRecent = requireRecentAuthentication,
  exportAccount,
  adminServicesFactory = getAccountAdminServices,
  logger = console,
} = {}) {
  return async function accountExportHandler(req, res) {
    const requestId = getSafeRequestId(req);
    setHeaders(res, requestId);

    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
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
      const recent = error?.code === 'recent_login_required';
      if (
        recent ||
        error instanceof AccountAuthenticationError ||
        error?.code === 'unauthorized'
      ) {
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

    const claimedUserId =
      req.body && typeof req.body === 'object' ? req.body.userId : null;
    if (claimedUserId != null && claimedUserId !== identity.uid) {
      return sendError(
        res,
        403,
        'identity_mismatch',
        'The requested account does not match the signed-in user.',
        requestId,
      );
    }

    try {
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="cirqle-account-export-${date}.json"`,
      );
      res.setHeader('Content-Type', 'application/json; charset=utf-8');

      if (exportAccount) {
        const payload = await exportAccount(identity);
        return res.status(200).send(JSON.stringify(payload, null, 2));
      }

      const { db } = adminServicesFactory();
      let closed = false;
      const onClose = () => {
        closed = true;
      };
      res.once?.('close', onClose);
      res.status(200);
      await streamAccountExport({
        db,
        identity,
        shouldContinue: () => !closed,
        write: async (chunk) => {
          if (closed) {
            const error = new Error('Account export was cancelled.');
            error.code = 'export_cancelled';
            throw error;
          }
          if (res.write(chunk) === false) await once(res, 'drain');
        },
      });
      res.removeListener?.('close', onClose);
      res.end();
      return res;
    } catch (error) {
      logger?.error?.('[account-export] failed', {
        requestId,
        subject: subjectHash(identity.uid),
        errorCode: error?.code || 'unknown',
      });
      if (res.headersSent) {
        res.destroy?.();
        return res;
      }
      return sendError(
        res,
        503,
        'export_unavailable',
        'Your export could not be prepared right now. Please try again.',
        requestId,
      );
    }
  };
}

export default createAccountExportHandler();
