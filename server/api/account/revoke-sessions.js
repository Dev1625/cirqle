import {
  AccountAuthenticationError,
  getAccountAdminServices,
  requireRecentAuthentication,
  verifyActiveAccountIdentity,
} from '../_lib/account-admin.js';
import {
  AccountSecurityError,
  revokeAccountSessionsAt,
} from '../_lib/account-security.js';
import { getSafeRequestId } from '../_lib/http.js';
import { revokeAllRefreshTokens } from '../_lib/oauth.js';

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

export async function deleteRegisteredBrowserSessions(
  db,
  uid,
  { maxBatches = 10, batchSize = 200 } = {},
) {
  if (!db || typeof db.collection !== 'function') return 0;
  let deleted = 0;
  for (let index = 0; index < maxBatches; index += 1) {
    const snapshot = await db
      .collection(`users/${uid}/sessions`)
      .limit(batchSize)
      .get();
    if (snapshot.empty) break;
    const batch = db.batch();
    for (const document of snapshot.docs) batch.delete(document.ref);
    await batch.commit();
    deleted += snapshot.size;
    if (snapshot.size < batchSize) break;
  }
  return deleted;
}

export function createRevokeSessionsHandler({
  verifyIdentity = verifyActiveAccountIdentity,
  assertRecent = requireRecentAuthentication,
  revokeSessions,
  lockSessions,
  clearSessionRegistry,
  adminServicesFactory = getAccountAdminServices,
  revokeMcpTokens = revokeAllRefreshTokens,
  logger = console,
} = {}) {
  return async function revokeSessionsHandler(req, res) {
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

    if (req.body?.userId != null && req.body.userId !== identity.uid) {
      return sendError(
        res,
        403,
        'identity_mismatch',
        'The requested account does not match the signed-in user.',
        requestId,
      );
    }

    try {
      if (revokeSessions) {
        if (clearSessionRegistry) {
          await clearSessionRegistry(identity.uid);
        }
        if (lockSessions) {
          await lockSessions({
            uid: identity.uid,
            identity,
          });
        }
        await revokeSessions(identity.uid);
      } else {
        const services = adminServicesFactory();
        // Remove the non-security-critical activity registry before changing
        // authentication state. Once the durable marker advances, both rules
        // and normal APIs reject existing tokens; Firebase revocation is the
        // terminal operation and cannot be misreported because later cleanup
        // failed.
        await deleteRegisteredBrowserSessions(
          services.db,
          identity.uid,
        );
        await (lockSessions || revokeAccountSessionsAt)({
          db: services.db,
          uid: identity.uid,
        });
        // Connected MCP clients hold their own refresh tokens, which Firebase
        // revocation does not touch. Without this, "Sign out everywhere" would
        // quietly mean "everywhere except the AI" — the opposite of what
        // somebody reaching for this button expects.
        await revokeMcpTokens({ db: services.db, uid: identity.uid });
        await services.auth.revokeRefreshTokens(identity.uid);
      }
      return res.status(200).json({ revoked: true });
    } catch (error) {
      logger?.error?.('[account-sessions] revocation failed', {
        requestId,
        errorCode: error?.code || 'unknown',
      });
      return sendError(
        res,
        503,
        'session_revocation_unavailable',
        'Your other sessions could not be signed out right now.',
        requestId,
      );
    }
  };
}

export default createRevokeSessionsHandler();
