import { Nfc, Sparkles, Search, Network, Activity, Mail } from 'lucide-react';

/**
 * The six beats, in page order. The index of each entry is the story index a
 * section registers itself under, and the one the token's keyframes are built
 * from — so this array is the single ordering authority for the narrative.
 */
export const STORY_STAGES = [
  { key: 'tap', index: '01', label: 'Tap', icon: Nfc },
  { key: 'parse', index: '02', label: 'Parsed', icon: Sparkles },
  { key: 'ask', index: '03', label: 'Asked', icon: Search },
  { key: 'map', index: '04', label: 'Mapped', icon: Network },
  // "Queued", not "Warm": Warm is a tier name in the app's own taxonomy
  // (Strong / Warm / Cold / Dormant) and this beat's card reads Strong.
  { key: 'health', index: '05', label: 'Queued', icon: Activity },
  { key: 'draft', index: '06', label: 'Drafted', icon: Mail },
] as const;

export type StoryStage = (typeof STORY_STAGES)[number];
