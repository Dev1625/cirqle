import { generateJSON } from './ai';
import type { CardConfig } from './card';

/**
 * AI-drafted card copy from what Cirqle already knows about the owner.
 *
 * This is the default suggested route for a reason: the manual customiser is
 * a blank canvas, and a blank canvas is where card setup goes to die. Starting
 * from a draft the owner edits is far less friction than starting from an
 * empty intro field.
 */

export interface CardDraft {
  intro: string;
  accent: string;
  layout: 'compact' | 'expanded';
}

/**
 * Deterministic fallback used when the AI gateway is absent or fails.
 *
 * Worth stating plainly: this is not a silent substitution. The caller shows
 * the error state with a retry, and this is offered as an explicit "compose
 * without AI" choice. The user always knows which one they got.
 */
export function composeFallbackIntro(profile: {
  name?: string | null;
  role?: string | null;
  company?: string | null;
  bio?: string | null;
}): string {
  const role = (profile.role || '').trim();
  const company = (profile.company || '').trim();
  const bio = (profile.bio || '').trim();

  if (bio) {
    // First sentence or two of the bio, trimmed to card length.
    const sentences = bio.split(/(?<=[.!?])\s+/).filter(Boolean);
    const take = sentences.slice(0, 2).join(' ');
    if (take.length <= 220) return take;
    return take.slice(0, 217).trimEnd() + '…';
  }

  if (role && company) return `${role} at ${company}. Always up for a conversation about the work.`;
  if (role) return `${role}. Always up for a conversation about the work.`;
  if (company) return `At ${company}. Always up for a conversation about the work.`;
  return 'Good to meet you — here are my details.';
}

export async function generateCardDraft(profile: {
  name?: string | null;
  role?: string | null;
  company?: string | null;
  bio?: string | null;
  resumeText?: string | null;
  targetIndustries?: string[] | null;
}): Promise<CardDraft> {
  const prompt = `You are writing the intro line for someone's digital business card — the page that opens when a stranger taps their NFC card, usually seconds after shaking hands.

Their details:
- Name: ${profile.name || '(unknown)'}
- Role: ${profile.role || '(unknown)'}
- Company: ${profile.company || '(unknown)'}
- Bio / goals: ${profile.bio || '(none provided)'}
- Resume excerpt: ${(profile.resumeText || '(none provided)').slice(0, 1500)}

Write a single intro of 1-2 sentences, max 220 characters. Rules:
- First person, plain and direct. No marketing voice, no "passionate about", no buzzwords.
- Say what they actually do and what is worth talking to them about.
- Do not repeat their name, role or company verbatim — those are already printed above the intro.
- Dry and specific beats warm and generic.

Also pick an accent from exactly this list, matching their field: oxblood, slate, moss, brass, clay, ink.
And pick a layout: "compact" if their details are thin, "expanded" if there is enough substance to justify the space.

Return JSON exactly: {"intro": "...", "accent": "...", "layout": "..."}`;

  const raw = await generateJSON<{ intro?: string; accent?: string; layout?: string }>(prompt, {
    tier: 'draft',
  });

  const allowedAccents = ['oxblood', 'slate', 'moss', 'brass', 'clay', 'ink'];
  const accent = allowedAccents.includes(raw.accent || '') ? (raw.accent as string) : 'oxblood';
  const layout = raw.layout === 'compact' ? 'compact' : 'expanded';
  const intro = (raw.intro || '').trim() || composeFallbackIntro(profile);

  return { intro: intro.slice(0, 240), accent, layout };
}

/** Seeds a card config from the owner's profile, before any drafting. */
export function cardFromProfile(profile: any, base: CardConfig): CardConfig {
  return {
    ...base,
    name: profile?.name || base.name || '',
    role: profile?.role || base.role || '',
    company: profile?.company || base.company || '',
    email: profile?.email || base.email || null,
  };
}
