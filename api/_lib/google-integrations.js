import { createGoogleIntegrationHandlers } from '../../functions/integrations.js';
import { getAccountAdminServices } from './account-admin.js';
import { verifyActiveBearerFirebaseToken } from './firebase-admin.js';

/**
 * One dependency-injected handler set shared by all Vercel integration routes.
 * Firebase ID tokens are verified with revocation checking by the existing
 * server-only helper; Google credentials never enter a browser bundle.
 */
export const googleIntegrationHandlers = createGoogleIntegrationHandlers({
  verifyIdentity: verifyActiveBearerFirebaseToken,
  adminServicesFactory: getAccountAdminServices,
});
