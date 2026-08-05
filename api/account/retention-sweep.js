import { createHash } from 'node:crypto';

import {
  AccountAuthenticationError,
  getAccountAdminServices,
  requireRecentAuthentication,
  verifyActiveAccountIdentity,
} from '../_lib/account-admin.js';
import { AccountSecurityError } from '../_lib/account-security.js';
import { getSafeRequestId } from '../_lib/http.js';
import {
  SourceRetentionError,
  runAdminSourceRetentionSweep,
} from '../_lib/source-retention.js';

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

function parseBody(req) {
  if (req.body == null || req.body === '') return {};
  if (typeof req.body === 'object' && !Array.isArray(req.body)) {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.length <= 16_384) {
    try {
      const parsed = JSON.parse(req.body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // The stable invalid-request response is emitted below.
    }
  }
  throw new SourceRetentionError({
    code: 'retention_sweep_invalid',
    message: 'The retention sweep request is invalid.',
  });
}

export function createSourceRetentionSweepHandler({
  verifyIdentity = verifyActiveAccountIdentity,
  assertRecent = requireRecentAuthentication,
  sweepAccount,
  adminServicesFactory = getAccountAdminServices,
  now = () => new Date(),
  logger = console,
} = {}) {
  return async function sourceRetentionSweepHandler(req, res) {
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

    let body;
    try {
      body = parseBody(req);
    } catch (error) {
      return sendError(
        res,
        error.status || 400,
        error.code || 'retention_sweep_invalid',
        'The retention sweep request is invalid.',
        requestId,
      );
    }

    if (body.userId != null && body.userId !== identity.uid) {
      return sendError(
        res,
        403,
        'identity_mismatch',
        'The requested account does not match the signed-in user.',
        requestId,
      );
    }

    const dryRun = body.dryRun !== false;
    if (!dryRun) {
      if (body.confirmation !== 'APPLY RETENTION') {
        return sendError(
          res,
          400,
          'confirmation_required',
          'Confirm before permanently applying retention rules.',
          requestId,
        );
      }
      try {
        assertRecent(identity);
      } catch (error) {
        const recent = error?.code === 'recent_login_required';
        return sendError(
          res,
          recent ? 401 : 503,
          recent
            ? 'recent_login_required'
            : 'authentication_unavailable',
          recent
            ? 'Please verify your identity again to continue.'
            : 'Authentication is temporarily unavailable.',
          requestId,
        );
      }
    }

    try {
      const report = sweepAccount
        ? await sweepAccount({
            identity,
            dryRun,
            now: now(),
            cursor: body.cursor || null,
            maxDocuments: body.maxDocuments,
            pageSize: body.pageSize,
            batchSize: body.batchSize,
          })
        : await runAdminSourceRetentionSweep({
            db: adminServicesFactory().db,
            uid: identity.uid,
            dryRun,
            now: now(),
            cursor: body.cursor || null,
            maxDocuments: body.maxDocuments,
            pageSize: body.pageSize,
            batchSize: body.batchSize,
          });
      return res.status(200).json(report);
    } catch (error) {
      if (
        error instanceof SourceRetentionError &&
        Number(error.status) < 500
      ) {
        return sendError(
          res,
          error.status || 400,
          error.code,
          error.message,
          requestId,
        );
      }

      // No UID, paths, source ids, content, provider errors, or stacks.
      logger?.error?.('[source-retention] sweep failed', {
        requestId,
        subject: subjectHash(identity.uid),
        errorCode: error?.code || 'unknown',
      });
      return sendError(
        res,
        503,
        'retention_sweep_unavailable',
        dryRun
          ? 'The retention preview could not be prepared right now. Please try again.'
          : 'The retention sweep could not finish. It is safe to retry.',
        requestId,
      );
    }
  };
}

export default createSourceRetentionSweepHandler();
