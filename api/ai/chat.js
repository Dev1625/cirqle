import aiChatHandler from '../../server/api/ai/chat.js';

/**
 * Dedicated entry so long quality-model generations can use their own Vercel
 * duration without widening every route handled by the shared dispatcher.
 */
export default aiChatHandler;
