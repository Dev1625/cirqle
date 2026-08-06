import accountBootstrap from './api/account/bootstrap.js';
import accountDelete from './api/account/delete.js';
import accountExport from './api/account/export.js';
import accountRetentionSweep from './api/account/retention-sweep.js';
import accountRevokeSessions from './api/account/revoke-sessions.js';
import aiChat from './api/ai/chat.js';
import aiUsage from './api/ai/usage.js';
import cardCapture from './api/cards/capture.js';
import contactMaintenance from './api/contacts/maintenance.js';
import contactMerge from './api/contacts/merge.js';
import contactProfile from './api/contacts/profile.js';
import contactSourceDelete from './api/contacts/source-delete.js';
import scheduledMaintenance from './api/cron/maintenance.js';
import calendarUpcoming from './api/integrations/calendar/upcoming.js';
import integrationDisconnect from './api/integrations/disconnect.js';
import gmailPoll from './api/integrations/gmail/poll.js';
import gmailSend from './api/integrations/gmail/send.js';
import oauthCallback from './api/integrations/oauth/callback.js';
import oauthStart from './api/integrations/oauth/start.js';
import registerUser from './api/register-user.js';
import passwordRange from './api/security/password-range.js';
import cspTelemetry from './api/telemetry/csp.js';
import vitalsTelemetry from './api/telemetry/vitals.js';

/**
 * Vercel treats every JavaScript file below `api/` as a separately deployed
 * Serverless Function. One fixed entry point dispatches every rewritten API
 * miss here so public URLs remain stable without exposing helpers as accidental
 * endpoints. Four exact-route wrappers bypass this dispatcher only to preserve
 * their route-specific duration limits without bundling every handler again.
 */
const ROUTES = Object.freeze({
  'account/bootstrap': accountBootstrap,
  'account/delete': accountDelete,
  'account/export': accountExport,
  'account/retention-sweep': accountRetentionSweep,
  'account/revoke-sessions': accountRevokeSessions,
  'ai/chat': aiChat,
  'ai/usage': aiUsage,
  'cards/capture': cardCapture,
  'contacts/maintenance': contactMaintenance,
  'contacts/merge': contactMerge,
  'contacts/profile': contactProfile,
  'contacts/source-delete': contactSourceDelete,
  'cron/maintenance': scheduledMaintenance,
  'integrations/calendar/upcoming': calendarUpcoming,
  'integrations/disconnect': integrationDisconnect,
  'integrations/gmail/poll': gmailPoll,
  'integrations/gmail/send': gmailSend,
  'integrations/oauth/callback': oauthCallback,
  'integrations/oauth/start': oauthStart,
  'register-user': registerUser,
  'security/password-range': passwordRange,
  'telemetry/csp': cspTelemetry,
  'telemetry/vitals': vitalsTelemetry,
});

export const API_ROUTE_PATHS = Object.freeze(Object.keys(ROUTES));

function normalizedRoutePath(value) {
  if (typeof value !== 'string') return null;
  const routePath = value.replace(/\/+$/u, '');
  if (
    !routePath ||
    routePath.startsWith('/') ||
    routePath.includes('//') ||
    routePath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return null;
  }
  return routePath;
}

export function routePathFromRequest(req) {
  const rawUrl = typeof req?.url === 'string' ? req.url : '';
  const rawPath = rawUrl.split(/[?#]/u, 1)[0];
  if (
    !rawPath.startsWith('/api/') ||
    rawPath.includes('\\') ||
    /%2f|%5c/iu.test(rawPath)
  ) {
    return null;
  }

  let routePath;
  try {
    routePath = decodeURIComponent(rawPath.slice('/api/'.length));
  } catch {
    return null;
  }
  return normalizedRoutePath(routePath);
}

function sendNotFound(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(404).json({
    error: {
      code: 'not_found',
      message: 'API route not found.',
    },
  });
}

export function createApiDispatcher({ routes = ROUTES } = {}) {
  return async function apiDispatcher(req, res) {
    const routePath = routePathFromRequest(req);
    const handler = routePath
      ? Object.prototype.hasOwnProperty.call(routes, routePath)
        ? routes[routePath]
        : null
      : null;
    if (typeof handler !== 'function') return sendNotFound(res);
    return handler(req, res);
  };
}

export default createApiDispatcher();
