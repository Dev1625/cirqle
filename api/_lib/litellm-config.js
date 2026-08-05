import { normalizeLiteLLMBaseUrl } from './http.js';

function configurationError(code) {
  const error = new Error('LiteLLM server configuration is incomplete.');
  error.code = code;
  return error;
}

/**
 * Resolve only explicit server-side LiteLLM configuration.
 *
 * There is deliberately no production URL default, VITE_* compatibility
 * fallback, or master-key-as-derivation-secret fallback. A preview or
 * misconfigured deployment must fail closed instead of spending against an
 * unintended gateway or changing deterministic per-user credentials during a
 * master-key rotation.
 */
export function getExplicitLiteLLMConfig(
  env,
  {
    requireMasterKey = false,
    errorCode = 'litellm_not_configured',
  } = {},
) {
  const gatewayUrl = env?.LITELLM_GATEWAY_URL?.trim();
  const derivationSecret =
    env?.LITELLM_KEY_DERIVATION_SECRET?.trim();
  const masterKey = env?.LITELLM_MASTER_KEY?.trim() || null;

  if (
    !gatewayUrl ||
    !derivationSecret ||
    derivationSecret.length < 16 ||
    (requireMasterKey && !masterKey) ||
    (masterKey && derivationSecret === masterKey)
  ) {
    throw configurationError(errorCode);
  }

  let baseUrl;
  try {
    baseUrl = normalizeLiteLLMBaseUrl(gatewayUrl);
  } catch {
    throw configurationError(errorCode);
  }

  return {
    baseUrl,
    derivationSecret,
    ...(requireMasterKey ? { masterKey } : {}),
  };
}
