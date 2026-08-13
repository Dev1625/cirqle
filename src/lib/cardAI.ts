import type { CardConfig } from './card';
import {
  generateGroundedJSON,
  groundingDisplay,
  type GroundedSource,
  type GroundingDisplay,
} from './grounding';

/**
 * AI-drafted card copy from what Cirqle already knows about the owner.
 * Every output carries the profile source IDs it actually cited.
 */

export interface CardDraft {
  intro: string;
  accent: string;
  layout: 'compact' | 'expanded';
}

export interface GeneratedCardDraft {
  draft: CardDraft;
  grounding: GroundingDisplay;
}

/** Deterministic fallback offered explicitly when generation is unavailable. */
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
    const sentences = bio.split(/(?<=[.!?])\s+/).filter(Boolean);
    const take = sentences.slice(0, 2).join(' ');
    if (take.length <= 220) return take;
    return `${take.slice(0, 217).trimEnd()}…`;
  }

  if (role && company) return `${role} at ${company}. Always up for a conversation about the work.`;
  if (role) return `${role}. Always up for a conversation about the work.`;
  if (company) return `At ${company}. Always up for a conversation about the work.`;
  return 'Good to meet you — here are my details.';
}

export function cardDraftSources(profile: {
  name?: string | null;
  role?: string | null;
  company?: string | null;
  bio?: string | null;
  resumeText?: string | null;
  targetIndustries?: string[] | null;
}): GroundedSource[] {
  const candidates: GroundedSource[] = [
    {
      id: 'profile-name',
      kind: 'profile',
      label: 'Profile name',
      text: profile.name || '',
    },
    {
      id: 'profile-role',
      kind: 'profile',
      label: 'Profile role',
      text: profile.role || '',
    },
    {
      id: 'profile-company',
      kind: 'profile',
      label: 'Profile company',
      text: profile.company || '',
    },
    {
      id: 'profile-bio',
      kind: 'profile',
      label: 'Profile bio and goals',
      text: profile.bio || '',
    },
    {
      id: 'profile-resume',
      kind: 'profile',
      label: 'Resume excerpt',
      text: (profile.resumeText || '').slice(0, 3_000),
    },
    {
      id: 'profile-target-industries',
      kind: 'profile',
      label: 'Target industries',
      text: Array.isArray(profile.targetIndustries)
        ? profile.targetIndustries.join(', ')
        : '',
    },
  ];
  return candidates.filter((source) => source.text.trim());
}

export async function generateCardDraft(profile: {
  name?: string | null;
  role?: string | null;
  company?: string | null;
  bio?: string | null;
  resumeText?: string | null;
  targetIndustries?: string[] | null;
  signal?: AbortSignal;
}): Promise<GeneratedCardDraft> {
  const sources = cardDraftSources(profile);
  if (!sources.some((source) => source.id !== 'profile-name')) {
    throw new Error('Add a role, company, bio, resume, or target industry before generating.');
  }

  const grounded = await generateGroundedJSON<{
    intro?: string;
    accent?: string;
    layout?: string;
  }>({
    task: 'Draft the intro line and visual defaults for a digital business card that opens immediately after someone meets the owner.',
    resultSchema:
      '{"intro": "1-2 first-person sentences, maximum 220 characters", "accent": "oxblood | slate | moss | brass | clay | ink", "layout": "compact | expanded"}',
    sources,
    rules: [
      'Use first person, plain and direct language with no marketing voice, buzzwords, or "passionate about".',
      'Say only what the owner actually does or explicitly wants to discuss.',
      'Do not repeat the owner name, role, or company verbatim because those fields appear above the intro.',
      'Never add credentials, clients, achievements, interests, availability, or current work that the profile does not state.',
      'Choose compact when evidence is thin and expanded only when the saved profile has substantive detail.',
    ],
    options: {
      tier: 'draft',
      // Card drafting is a quality-model task. Let it finish and leave the
      // visible Cancel action in charge instead of imposing the generic
      // twenty-second browser deadline.
      timeoutMs: null,
      maxTokens: 450,
      feature: 'digital-card-draft',
      signal: profile.signal,
    },
  });

  const allowedAccents = ['oxblood', 'slate', 'moss', 'brass', 'clay', 'ink'];
  const accent = allowedAccents.includes(grounded.result?.accent || '')
    ? (grounded.result.accent as string)
    : 'oxblood';
  const layout = grounded.result?.layout === 'compact' ? 'compact' : 'expanded';
  const intro = (grounded.result?.intro || '').trim();
  if (!intro) throw new Error('The model did not produce a grounded intro.');
  if (!grounded.usedSourceIds.some((id) => id !== 'profile-name')) {
    throw new Error('The card draft did not cite substantive profile details.');
  }

  return {
    draft: { intro: intro.slice(0, 240), accent, layout },
    grounding: groundingDisplay(grounded, sources),
  };
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
