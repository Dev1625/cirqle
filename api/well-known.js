import wellKnownHandler from '../server/oauth/well-known.js';

/**
 * Serves /.well-known/oauth-protected-resource and
 * /.well-known/oauth-authorization-server. Its own entry because those paths do
 * not start with /api/, so the shared dispatcher cannot route them.
 */
export default wellKnownHandler;
