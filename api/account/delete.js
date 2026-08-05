import {
  AccountAuthenticationError,
  createAccountDeletionReceiptRepository,
  deleteOAuthIdentity,
  deletePrivateUserData,
  deletePublicCards,
  getAccountAdminServices,
  requireRecentAuthentication,
  verifyAccountIdentity,
} from '../_lib/account-admin.js';
import {
  beginAccountDeletion,
  completeAccountDeletion,
} from '../_lib/account-security.js';
import {
  ACCOUNT_DELETION_STEPS,
  deleteLiteLLMIdentity,
  runAccountDeletion,
} from '../_lib/account-lifecycle.js';
import { getSafeRequestId } from '../_lib/http.js';
import { LEGACY_AI_KEY_FIELDS } from '../_lib/legacy-key-scrub.js';

const ACCOUNT_DELETION_JOB_SCHEMA_VERSION = 1;
const ACCOUNT_DELETION_SERVICE_STEPS = Object.freeze([
  ['aiIdentity', 'deleteLiteLLMIdentity'],
  ['oauthIdentity', 'deleteOAuthIdentity'],
  ['publicCards', 'deletePublicCards'],
  ['privateData', 'deletePrivateUserData'],
  ['firebaseAuth', 'deleteAuthUser'],
]);

function sanitizeFailureCode(error) {
  return typeof error?.code === 'string' && error.code
    ? error.code.slice(0, 80)
    : 'unknown';
}

function getDeletionJob(snapshot) {
  const raw = snapshot.exists
    ? snapshot.data()?.deletionJob || {}
    : {};
  const completedSteps = ACCOUNT_DELETION_STEPS.filter((step) =>
    Array.isArray(raw.completedSteps)
      ? raw.completedSteps.includes(step)
      : false,
  );
  return {
    schemaVersion: ACCOUNT_DELETION_JOB_SCHEMA_VERSION,
    status:
      typeof raw.status === 'string' ? raw.status : 'pending',
    currentStep: ACCOUNT_DELETION_STEPS.includes(raw.currentStep)
      ? raw.currentStep
      : null,
    completedSteps,
    lastFailureCode:
      typeof raw.lastFailureCode === 'string'
        ? raw.lastFailureCode.slice(0, 80)
        : null,
  };
}

function getProgressTimestamp(now) {
  const candidate = now();
  const timestamp =
    candidate instanceof Date
      ? new Date(candidate.getTime())
      : new Date(candidate);
  return Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
}

/**
 * Persists deletion progress on the existing non-public account lock. The
 * state contains only fixed step names and a sanitized failure code: no
 * profile data, provider response, email, token, or API key is copied into
 * the durable job.
 *
 * Each destructive service remains idempotent. A step is skipped only after
 * its successful completion was recorded transactionally. Before Firebase
 * Auth is removed, the job is durably marked `committing`, leaving an
 * operator-reconcilable marker for the only cross-service crash boundary.
 */
export function createDurableAccountDeletionServices({
  db,
  uid,
  services,
  now = () => new Date(),
  logger = console,
}) {
  const progressRef = db.doc(`_accountSecurity/${uid}`);

  async function updateJob(mutator) {
    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(progressRef);
      const current = getDeletionJob(snapshot);
      const result = mutator(current);
      if (result?.job) {
        transaction.set(
          progressRef,
          {
            deletionJob: {
              ...result.job,
              schemaVersion: ACCOUNT_DELETION_JOB_SCHEMA_VERSION,
              updatedAt: getProgressTimestamp(now),
            },
          },
          { merge: true },
        );
      }
      return result?.value;
    });
  }

  async function markStepStarted(step) {
    return updateJob((current) => {
      if (current.completedSteps.includes(step)) {
        return { value: false };
      }
      return {
        value: true,
        job: {
          ...current,
          status:
            step === 'firebaseAuth' ? 'committing' : 'running',
          currentStep: step,
          lastFailureCode: null,
        },
      };
    });
  }

  async function markStepCompleted(step) {
    return updateJob((current) => {
      const completedSteps = ACCOUNT_DELETION_STEPS.filter(
        (candidate) =>
          current.completedSteps.includes(candidate) ||
          candidate === step,
      );
      return {
        job: {
          ...current,
          status:
            completedSteps.length === ACCOUNT_DELETION_STEPS.length
              ? 'steps-completed'
              : current.currentStep &&
                  current.currentStep !== step
                ? current.status
                : 'running',
          currentStep:
            current.currentStep === step
              ? null
              : current.currentStep,
          completedSteps,
          lastFailureCode: null,
        },
      };
    });
  }

  async function markStepIncomplete(step, error) {
    return updateJob((current) => {
      if (current.completedSteps.includes(step)) return {};
      // A concurrent retry may already be executing a later step. Its marker
      // is more useful than this stale attempt's failure and must not be
      // replaced—especially once Auth has entered `committing`.
      if (current.currentStep && current.currentStep !== step) {
        return {};
      }
      return {
        job: {
          ...current,
          status: 'incomplete',
          currentStep: step,
          lastFailureCode: sanitizeFailureCode(error),
        },
      };
    });
  }

  async function runStep(step, operation, input) {
    const shouldRun = await markStepStarted(step);
    if (!shouldRun) return;

    try {
      await operation(input);
    } catch (error) {
      await markStepIncomplete(step, error).catch(() => {
        logger?.warn?.('[account-delete] progress update unavailable', {
          step,
          phase: 'failure',
        });
      });
      throw error;
    }

    if (step === 'firebaseAuth' && services.finalizeAccountLock) {
      // Keep the durable job in `committing` until the terminal account lock
      // has been written. If the process stops after Auth deletion, the
      // non-expiring lock and this marker make the orphaned finalization
      // unambiguous and safe to reconcile.
      return;
    }

    try {
      await markStepCompleted(step);
    } catch (error) {
      if (step === 'firebaseAuth') {
        // A custom workflow without an account-lock finalizer must not turn a
        // successful Auth deletion into an error on a progress-only write.
        logger?.warn?.('[account-delete] progress update unavailable', {
          step,
          phase: 'completion',
        });
        return;
      }
      throw error;
    }
  }

  const durableServices = { ...services };
  for (const [step, serviceName] of ACCOUNT_DELETION_SERVICE_STEPS) {
    const operation = services[serviceName];
    durableServices[serviceName] = (input) =>
      runStep(step, operation, input);
  }

  if (services.finalizeAccountLock) {
    durableServices.finalizeAccountLock = async (input) => {
      await services.finalizeAccountLock(input);
      await updateJob((current) => ({
        job: {
          ...current,
          status: 'completed',
          currentStep: null,
          completedSteps: [...ACCOUNT_DELETION_STEPS],
          lastFailureCode: null,
        },
      })).catch(() => {
        // The terminal account tombstone is authoritative. Never turn a
        // completed deletion into an error because its supplemental progress
        // marker could not be refreshed.
        logger?.warn?.('[account-delete] progress update unavailable', {
          step: 'accountLock',
          phase: 'completion',
        });
      });
    };
  }

  return durableServices;
}

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

export function createDeleteAccountHandler({
  env = process.env,
  verifyIdentity = verifyAccountIdentity,
  assertRecent = requireRecentAuthentication,
  deleteAccount,
  beginDeletion,
  completeDeletion,
  adminServicesFactory = getAccountAdminServices,
  runDeletion = runAccountDeletion,
  deleteLiteLLM = deleteLiteLLMIdentity,
  beginAccountLock = beginAccountDeletion,
  completeAccountLock = completeAccountDeletion,
  durableServicesFactory = createDurableAccountDeletionServices,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  return async function deleteAccountHandler(req, res) {
    const requestId = getSafeRequestId(req);
    setHeaders(res, requestId);

    if (req.method !== 'DELETE') {
      res.setHeader('Allow', 'DELETE');
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
    if (req.body?.confirmation !== 'DELETE') {
      return sendError(
        res,
        400,
        'confirmation_required',
        'Type DELETE to confirm permanent account deletion.',
        requestId,
      );
    }

    try {
      let deletionResult = null;
      if (deleteAccount) {
        if (beginDeletion) {
          await beginDeletion({
            uid: identity.uid,
            identity,
          });
        }
        deletionResult = await deleteAccount(identity);
        if (completeDeletion) {
          await completeDeletion({
            uid: identity.uid,
            identity,
          });
        }
      } else {
        const { auth, db } = adminServicesFactory();
        await beginAccountLock({ db, uid: identity.uid });
        const userSnapshot = await db.doc(`users/${identity.uid}`).get();
        const legacyApiKeys = userSnapshot.exists
          ? [
              ...new Set(
                LEGACY_AI_KEY_FIELDS.map(
                  (field) => userSnapshot.data()?.[field],
                ).filter(
                  (value) => typeof value === 'string' && value,
                ),
              ),
            ]
          : [];

        const services = durableServicesFactory({
          db,
          uid: identity.uid,
          logger,
          services: {
            deleteLiteLLMIdentity: (input) =>
              deleteLiteLLM({
                ...input,
                env,
                fetchImpl,
                logger,
              }),
            deleteOAuthIdentity: (input) =>
              deleteOAuthIdentity({
                ...input,
                db,
                fetchImpl,
                env,
              }),
            deletePublicCards: (input) =>
              deletePublicCards({ ...input, db }),
            deletePrivateUserData: (input) =>
              deletePrivateUserData({ ...input, db }),
            finalizeAccountLock: (input) =>
              completeAccountLock({ ...input, db }),
            deleteAuthUser: (uid) => auth.deleteUser(uid),
          },
        });

        deletionResult = await runDeletion({
          identity,
          legacyApiKeys,
          receiptRepository:
            createAccountDeletionReceiptRepository(db),
          services,
        });
      }

      return res.status(200).json({
        deleted: true,
        accountLockStatus:
          deletionResult?.accountLockStatus || 'not-managed',
        receipt:
          deletionResult?.receiptId
            ? {
                id: deletionResult.receiptId,
                status: deletionResult.receiptStatus,
                accountLockStatus:
                  deletionResult.accountLockStatus || 'not-managed',
              }
            : null,
      });
    } catch (error) {
      // Intentionally exclude UID, provider messages, token values, and stack
      // traces. Firebase Auth remains intact because it is the final step.
      logger?.error?.('[account-delete] cleanup incomplete', {
        requestId,
        errorCode: error?.code || 'unknown',
      });
      return res.status(503).json({
        error: {
          code: 'account_deletion_incomplete',
          message:
            'Account deletion could not finish. The account is locked, and it is safe to try deletion again.',
        },
        receipt: error?.deletionReceipt || null,
        requestId,
      });
    }
  };
}

export default createDeleteAccountHandler();
