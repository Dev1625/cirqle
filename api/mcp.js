import mcpHandler from '../server/mcp/server.js';

/**
 * Its own Vercel entry rather than a route on the shared dispatcher, so
 * vercel.json can give it a longer maxDuration: a 50-contact upsert does one
 * transaction per contact and will not finish inside the default.
 */
export default mcpHandler;
