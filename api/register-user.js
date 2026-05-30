export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  const masterKey = process.env.LITELLM_MASTER_KEY;
  let gatewayUrl = process.env.VITE_GATEWAY_URL || 'https://litellm-production-2a63.up.railway.app';

  if (!masterKey) {
    return res.status(500).json({ error: 'LITELLM_MASTER_KEY is not configured on Vercel' });
  }

  if (gatewayUrl.endsWith('/')) {
    gatewayUrl = gatewayUrl.slice(0, -1);
  }
  if (gatewayUrl.endsWith('/gemini')) {
    gatewayUrl = gatewayUrl.slice(0, -7);
  }

  try {
    const response = await fetch(`${gatewayUrl}/key/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterKey}`
      },
      body: JSON.stringify({
        key_alias: `user_${userId}`,
        max_budget: 5.00,
        reset_value: 5.00,
        reset_period: "month",
        models: ["gemini-2.5-flash-lite", "gpt-5-mini"]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `LiteLLM error: ${errorText}` });
    }

    const data = await response.json();
    return res.status(200).json({ apiKey: data.key });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
