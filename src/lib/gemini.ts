import { GoogleGenAI } from "@google/genai";
import { instrumentGenAI, type AiFeatureKey } from "./aiDebug";

let aiClient: GoogleGenAI | null = null;
let lastApiKey: string | null = null;

/**
 * Resolves the LiteLLM gateway base URL the SDK talks to. Exported so Dev Mode
 * can display the endpoint every AI feature is actually pointed at, rather
 * than the user having to infer it from env files.
 */
export function getGatewayUrl(): string {
  let gatewayUrl = import.meta.env.VITE_GATEWAY_URL || "http://localhost:4000";
  if (gatewayUrl.endsWith('/')) {
    gatewayUrl = gatewayUrl.slice(0, -1);
  }
  // LiteLLM requires Gemini SDK requests to route through the '/gemini' prefix
  if (!gatewayUrl.endsWith('/gemini')) {
    gatewayUrl = `${gatewayUrl}/gemini`;
  }
  return gatewayUrl;
}

/** Where the key in play came from — surfaced in Dev Mode, never the key itself. */
export function getApiKeySource(): 'user proxy key' | 'env' | 'placeholder' {
  if (typeof window !== "undefined" && localStorage.getItem("CIRQLE_USER_PROXY_KEY")) {
    return 'user proxy key';
  }
  if (import.meta.env.VITE_GEMINI_API_KEY) return 'env';
  return 'placeholder';
}

/**
 * Returns an instance of the GoogleGenAI client configured to route requests
 * through the LiteLLM API proxy gateway.
 *
 * @param feature  Which AI feature is calling. Used only for instrumentation —
 *                 it tags the call in the Dev Mode log so a request can be
 *                 traced back to the button that caused it.
 * @param userApiKey Optional individual trackable user-specific API key.
 *                   If not provided, falls back to localStorage or
 *                   import.meta.env.VITE_GEMINI_API_KEY.
 */
export function getGemini(feature: AiFeatureKey, userApiKey?: string): GoogleGenAI {
  // Dynamically ingest user-specific key, falling back to localStorage or environment variable
  const apiKey = userApiKey ||
                 (typeof window !== "undefined" ? localStorage.getItem("CIRQLE_USER_PROXY_KEY") : null) ||
                 import.meta.env.VITE_GEMINI_API_KEY ||
                 "sk-placeholder-key-please-configure-vite-gemini-api-key";

  // target the newly exposed LiteLLM gateway instead of standard Google endpoints
  const gatewayUrl = getGatewayUrl();

  // Re-initialize client if it does not exist or if the API key has changed
  if (!aiClient || lastApiKey !== apiKey) {
    aiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        baseUrl: gatewayUrl
      }
    });
    lastApiKey = apiKey;
  }

  // The underlying client stays cached and shared; only the thin logging
  // wrapper is per-call, since the feature tag differs between call sites.
  return instrumentGenAI(aiClient, feature, gatewayUrl);
}
