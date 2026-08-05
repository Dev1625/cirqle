import { createHash } from 'node:crypto';

import { getAccountAdminServices } from '../_lib/account-admin.js';
import { getSafeRequestId, readHeader } from '../_lib/http.js';
import {
  isAuthorizedCronRequest,
  runScheduledMaintenanceCycle,
} from '../_lib/scheduled-maintenance.js';

function setHeaders(res, requestId) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Request-Id', requestId);
}

function safeErrorCode(value) {
  const code = typeof value === 'string' ? value : '';
  return /^[A-Za-z0-9._/-]{1,80}$/.test(code)
    ? code
    : 'maintenance_failed';
}

function requestHash(requestId) {
  return createHash('sha256')
    .update(requestId)
    .digest('hex')
    .slice(0, 12);
}

export function createScheduledMaintenanceHandler({
  env = process.env,
  adminServicesFactory = getAccountAdminServices,
  runCycle = runScheduledMaintenanceCycle,
  now = () => new Date(),
  logger = console,
} = {}) {
  return async function scheduledMaintenanceHandler(req, res) {
    const requestId = getSafeRequestId(req);
    setHeaders(res, requestId);

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({
        error: { code: 'method_not_allowed', message: 'Method not allowed.' },
        requestId,
      });
    }

    if (
      !isAuthorizedCronRequest(
        readHeader(req, 'authorization'),
        env.CRON_SECRET,
      )
    ) {
      return res.status(401).json({
        error: { code: 'unauthorized', message: 'Authentication required.' },
        requestId,
      });
    }

    try {
      const { db } = adminServicesFactory(env);
      const report = await runCycle({ db, now: now(), logger });
      return res.status(200).json(report);
    } catch (error) {
      logger?.error?.('[scheduled-maintenance] cycle failed', {
        request: requestHash(requestId),
        errorCode: safeErrorCode(error?.code),
      });
      return res.status(503).json({
        error: {
          code: 'maintenance_unavailable',
          message:
            'Scheduled maintenance could not finish. It is safe to retry.',
        },
        requestId,
      });
    }
  };
}

export default createScheduledMaintenanceHandler();
