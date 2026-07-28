export default async function handler(req, res) {
  console.log("=== LiteLLM Key Generation Serverless Handler Started ===");
  
  if (req.method !== 'POST') {
    console.warn(`[Method Not Allowed] Received request method: ${req.method}`);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId } = req.body || {};
  console.log(`[Request Payload] Generating key for userId: ${userId}`);

  if (!userId) {
    console.error("[Bad Request] userId parameter is missing");
    return res.status(400).json({ error: 'Missing userId' });
  }

  const masterKey = process.env.LITELLM_MASTER_KEY;
  let gatewayUrl = process.env.VITE_GATEWAY_URL || 'https://litellm-production-2a63.up.railway.app';

  if (!masterKey) {
    console.error("[Config Error] LITELLM_MASTER_KEY environment variable is not defined on Vercel");
    return res.status(500).json({ error: 'LITELLM_MASTER_KEY is not configured on Vercel' });
  }

  if (gatewayUrl.endsWith('/')) {
    gatewayUrl = gatewayUrl.slice(0, -1);
  }
  if (gatewayUrl.endsWith('/gemini')) {
    gatewayUrl = gatewayUrl.slice(0, -7);
  }

  const requestUrl = `${gatewayUrl}/key/generate`;
  console.log(`[Proxy Call] Sending request to: ${requestUrl}`);

  const requestBody = {
    key_alias: `user_${userId}_${Math.floor(Date.now() / 1000)}`,
    // Associate the virtual key with the Firebase UID so LiteLLM can group
    // spend across multiple keys belonging to the same Cirqle account.
    user_id: userId,
    metadata: {
      app: "cirqle-web",
      firebase_uid: userId
    },
    tags: ["cirqle-web"],
    max_budget: 5.00,
    budget_duration: "30d",
    // Virtual keys are scoped to an explicit model allowlist. An alias missing
    // from this array is rejected at request time with a 401/403 that looks
    // like an auth problem rather than a config one — so this list MUST stay
    // in sync with src/lib/aiConfig.ts and litellm-proxy/config.yaml.
    models: [
      // Tiers the app actually asks for
      "deepseek-v4-flash",      // reasoning
      "deepseek-v4-pro",        // draft
      "gemini-2.5-flash-lite",  // fast
      // Retained so keys issued before the DeepSeek switch keep working
      "gemini-3-flash-preview",
      "gemini-flash",
      "gemini-3.1-pro-preview",
      "gpt-5-mini",
      "openai-mini"
    ]
  };

  try {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterKey}`
      },
      body: JSON.stringify(requestBody)
    });

    console.log(`[Proxy Response Status] HTTP ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Proxy Failure] Gateway rejected key creation. Response: ${errorText}`);
      return res.status(response.status).json({ 
        error: `LiteLLM error: ${errorText}`,
        details: `Gateway returned status ${response.status}`
      });
    }

    const data = await response.json();
    console.log(`[Success] Key generated successfully. Key hash suffix: ...${data.key?.slice(-6)}`);
    return res.status(200).json({ apiKey: data.key });
  } catch (error) {
    console.error("[Unexpected Exception] Failed to execute serverless fetch:", error);
    return res.status(500).json({ 
      error: error.message || 'Internal Server Error',
      stack: error.stack 
    });
  }
}
