import { GoogleGenAI } from "@google/genai";

let aiClient: GoogleGenAI | null = null;
let lastApiKey: string | null = null;

/**
 * Returns an instance of the GoogleGenAI client configured to route requests
 * through the LiteLLM API proxy gateway.
 * 
 * @param userApiKey Optional individual trackable user-specific API key. 
 *                   If not provided, falls back to localStorage or import.meta.env.VITE_GEMINI_API_KEY.
 */
export function getGemini(userApiKey?: string): GoogleGenAI {
  // Dynamically ingest user-specific key, falling back to localStorage or environment variable
  const apiKey = userApiKey || 
                 (typeof window !== "undefined" ? localStorage.getItem("CIRQLE_USER_PROXY_KEY") : null) || 
                 import.meta.env.VITE_GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "API Key is not defined. Please log in or provide a trackable user API key."
    );
  }

  // target the newly exposed LiteLLM gateway instead of standard Google endpoints
  const gatewayUrl = import.meta.env.VITE_GATEWAY_URL || "http://localhost:4000";

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

  return aiClient;
}

