import { createHash } from 'node:crypto';

import { getAppCheck } from 'firebase-admin/app-check';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { getFirebaseAdminApp } from '../_lib/firebase-admin.js';
import {
  getSafeRequestId,
  getTrustedClientIp,
  readHeader,
} from '../_lib/http.js';
import {
  createProvisioningRateLimiter,
  ProvisioningRateLimitError,
} from '../_lib/rate-limit.js';

const CARD_ID = /^[23456789abcdefghjkmnpqrstuvwxyz]{10}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

class CaptureInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CaptureInputError';
    this.code = code;
  }
}

function cleanRequiredString(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw new CaptureInputError('invalid_capture', `${field} is required.`);
  }
  const cleaned = value.trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > maxLength) {
    throw new CaptureInputError(
      'invalid_capture',
      `${field} must be between 1 and ${maxLength} characters.`,
    );
  }
  return cleaned;
}

function cleanOptionalString(value, field, maxLength) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new CaptureInputError('invalid_capture', `${field} is invalid.`);
  }
  const cleaned = value.trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;
  if (cleaned.length > maxLength) {
    throw new CaptureInputError(
      'invalid_capture',
      `${field} must be ${maxLength} characters or fewer.`,
    );
  }
  return cleaned;
}

export function normalizeCaptureInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CaptureInputError('invalid_capture', 'Capture details are required.');
  }

  const cardId =
    typeof body.cardId === 'string' ? body.cardId.trim().toLowerCase() : '';
  if (!CARD_ID.test(cardId)) {
    throw new CaptureInputError('invalid_card', 'This card link is invalid.');
  }

  const rawVisitorEmail = cleanOptionalString(
    body.visitorEmail,
    'Email',
    200,
  );
  const visitorEmail = rawVisitorEmail
    ? rawVisitorEmail.normalize('NFKC').toLowerCase()
    : null;
  if (visitorEmail && !EMAIL.test(visitorEmail)) {
    throw new CaptureInputError('invalid_capture', 'Email is invalid.');
  }

  const captureChannel =
    body.captureChannel == null || body.captureChannel === ''
      ? 'direct'
      : body.captureChannel;
  if (!['qr', 'nfc', 'link', 'direct'].includes(captureChannel)) {
    throw new CaptureInputError(
      'invalid_capture',
      'Capture channel is invalid.',
    );
  }

  return Object.freeze({
    cardId,
    visitorName: cleanRequiredString(body.visitorName, 'Name', 120),
    visitorEmail,
    visitorCompany: cleanOptionalString(
      body.visitorCompany,
      'Company',
      200,
    ),
    note: cleanOptionalString(body.note, 'Note', 500),
    consentToFollowUp: body.consentToFollowUp === true,
    captureChannel,
    // A real visitor never sees or fills this field. Bots that blindly complete
    // every input receive a generic success without creating a record.
    trapped:
      typeof body.website === 'string' && body.website.trim().length > 0,
  });
}

function requestFingerprint(req) {
  const address = getTrustedClientIp(req);
  const agent = readHeader(req, 'user-agent') || 'unknown';
  return createHash('sha256')
    .update(`${address}|${agent}`)
    .digest('hex')
    .slice(0, 32);
}

function inputFingerprint(input, now) {
  const day = Math.floor(now.getTime() / DAY_MS);
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.cardId,
        input.visitorName.toLowerCase(),
        input.visitorEmail?.toLowerCase() || null,
        input.visitorCompany?.toLowerCase() || null,
        input.note || null,
        input.consentToFollowUp,
        day,
      ]),
    )
    .digest('hex');
}

function createCaptureLimiter({ env, fetchImpl, logger }) {
  const perVisitor = createProvisioningRateLimiter({
    env,
    fetchImpl,
    logger,
    limit: 8,
    windowSeconds: 60,
  });
  const perCard = createProvisioningRateLimiter({
    env,
    fetchImpl,
    logger,
    limit: 20,
    windowSeconds: 60,
  });

  return Object.freeze({
    async check({ cardId, visitor }) {
      const visitorRate = await perVisitor.check(`capture:visitor:${visitor}`);
      const cardRate = await perCard.check(`capture:card:${cardId}`);
      return {
        limit: Math.min(visitorRate.limit, cardRate.limit),
        remaining: Math.min(
          visitorRate.remaining,
          cardRate.remaining,
        ),
        resetAt: Math.max(visitorRate.resetAt, cardRate.resetAt),
      };
    },
  });
}

function defaultAdminServices(env) {
  const app = getFirebaseAdminApp(env);
  return {
    db: getFirestore(app),
    appCheck: getAppCheck(app),
  };
}

async function verifyAppCheckRequest({
  req,
  appCheck,
  enforced,
  logger,
  requestId,
}) {
  const token = readHeader(req, 'x-firebase-appcheck');
  if (!token) {
    if (enforced) throw new CaptureInputError(
      'app_check_required',
      'This request could not be verified.',
    );
    return false;
  }

  try {
    await appCheck.verifyToken(token);
    return true;
  } catch {
    if (enforced) {
      throw new CaptureInputError(
        'app_check_required',
        'This request could not be verified.',
      );
    }
    logger?.warn?.('[public-capture] app_check_monitor_rejected', {
      requestId,
    });
    return false;
  }
}

async function persistCapture({ db, input, now }) {
  const cardRef = db.collection('cards').doc(input.cardId);
  const guardId = inputFingerprint(input, now);
  const guardRef = db.collection('captureGuards').doc(guardId);
  const captureRef = cardRef.collection('captures').doc();

  return db.runTransaction(async (transaction) => {
    const [card, guard] = await Promise.all([
      transaction.get(cardRef),
      transaction.get(guardRef),
    ]);

    if (!card.exists || card.data()?.published !== true) {
      const error = new CaptureInputError(
        'card_unavailable',
        'This card is no longer accepting saves.',
      );
      error.status = 404;
      throw error;
    }

    const ownerUid = card.data()?.ownerUid;
    if (typeof ownerUid !== 'string' || !ownerUid) {
      const error = new CaptureInputError(
        'card_unavailable',
        'This card is no longer accepting saves.',
      );
      error.status = 404;
      throw error;
    }
    const [owner, security] = await Promise.all([
      transaction.get(db.collection('users').doc(ownerUid)),
      transaction.get(
        db.collection('_accountSecurity').doc(ownerUid),
      ),
    ]);
    if (
      !security.exists ||
      security.data()?.status !== 'active'
    ) {
      const error = new CaptureInputError(
        'card_unavailable',
        'This card is no longer accepting saves.',
      );
      error.status = 404;
      throw error;
    }
    const eventMode = owner.data()?.eventMode;
    const activeEvent =
      eventMode?.active === true && typeof eventMode.eventName === 'string'
        ? {
            id:
              typeof eventMode.sessionId === 'string'
                ? eventMode.sessionId
                : null,
            name: eventMode.eventName.slice(0, 160),
            source:
              eventMode.source === 'calendar' ? 'calendar' : 'manual',
          }
        : null;

    const expiresAt = guard.exists ? guard.data()?.expiresAt : null;
    if (
      guard.exists &&
      expiresAt?.toMillis?.() > now.getTime()
    ) {
      return { duplicate: true };
    }

    transaction.set(captureRef, {
      visitorName: input.visitorName,
      visitorEmail: input.visitorEmail,
      visitorCompany: input.visitorCompany,
      note: input.note,
      consentToFollowUp: input.consentToFollowUp,
      privacyNoticeVersion: '2026-07-29',
      eventSessionId: activeEvent?.id || null,
      eventName: activeEvent?.name || null,
      eventSource: activeEvent?.source || null,
      captureChannel: input.captureChannel,
      captureChannelEvidence:
        input.captureChannel === 'direct'
          ? 'unmarked-url'
          : 'client-url-marker',
      capturedAt: Timestamp.fromDate(now),
      processed: false,
    });
    transaction.set(guardRef, {
      cardIdHash: createHash('sha256')
        .update(input.cardId)
        .digest('hex')
        .slice(0, 24),
      createdAt: Timestamp.fromDate(now),
      expiresAt: Timestamp.fromDate(new Date(now.getTime() + DAY_MS)),
    });
    return { duplicate: false };
  });
}

function setHeaders(res, requestId) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Request-Id', requestId);
}

function sendError(res, status, code, message, requestId) {
  return res.status(status).json({
    error: { code, message },
    requestId,
  });
}

export function createPublicCaptureHandler({
  env = process.env,
  logger = console,
  fetchImpl = globalThis.fetch,
  adminServicesFactory = defaultAdminServices,
  limiter,
  persist = persistCapture,
  now = () => new Date(),
} = {}) {
  const captureLimiter =
    limiter || createCaptureLimiter({ env, fetchImpl, logger });

  return async function publicCaptureHandler(req, res) {
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

    let input;
    try {
      if (JSON.stringify(req.body || {}).length > 5_000) {
        throw new CaptureInputError(
          'invalid_capture',
          'Capture details are too large.',
        );
      }
      input = normalizeCaptureInput(req.body);
    } catch (error) {
      return sendError(
        res,
        400,
        error?.code || 'invalid_capture',
        error?.message || 'Capture details are invalid.',
        requestId,
      );
    }

    // A trapped bot receives the same outward success shape and learns
    // nothing about the abuse controls or the card owner.
    if (input.trapped) return res.status(202).json({ accepted: true });

    try {
      const rate = await captureLimiter.check({
        cardId: input.cardId,
        visitor: requestFingerprint(req),
      });
      res.setHeader('RateLimit-Limit', String(rate.limit));
      res.setHeader('RateLimit-Remaining', String(rate.remaining));
      res.setHeader('RateLimit-Reset', String(rate.resetAt));
    } catch (error) {
      if (error instanceof ProvisioningRateLimitError) {
        res.setHeader('Retry-After', String(error.retryAfter));
        return sendError(
          res,
          429,
          'rate_limited',
          'Too many saves. Please wait a moment and try again.',
          requestId,
        );
      }
      return sendError(
        res,
        503,
        'capture_unavailable',
        'This card cannot be saved right now.',
        requestId,
      );
    }

    try {
      const services = adminServicesFactory(env);
      await verifyAppCheckRequest({
        req,
        appCheck: services.appCheck,
        enforced: env.FIREBASE_APP_CHECK_ENFORCED === 'true',
        logger,
        requestId,
      });
      await persist({
        db: services.db,
        input,
        now: now(),
      });
      return res.status(202).json({ accepted: true });
    } catch (error) {
      if (error instanceof CaptureInputError) {
        const status =
          error.code === 'app_check_required'
            ? 401
            : error.status || 400;
        return sendError(
          res,
          status,
          error.code,
          error.message,
          requestId,
        );
      }
      logger?.error?.('[public-capture] persistence_failed', { requestId });
      return sendError(
        res,
        503,
        'capture_unavailable',
        'This card cannot be saved right now.',
        requestId,
      );
    }
  };
}

export default createPublicCaptureHandler();
