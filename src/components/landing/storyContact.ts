/**
 * STORY_CONTACT — the single person this landing page's narrative follows,
 * start to finish.
 *
 * Every story beat below the hero shows the same human being: they are the
 * card you tap in beat 1, the record the parser writes in beat 2, an answer
 * in beat 3, a findable node in beat 4, a health score in beat 5, and the
 * addressee of the drafted email in beat 6. Nothing on the page may invent a
 * second placeholder person — that is the whole point of the pass. The old
 * sample contacts (Priya Nair, Sarah Jenkins, Sarah Chen …) survive only as
 * *other* people in the directory, never as the subject of a beat.
 *
 * The email is deliberately the product address rather than a personal one:
 * this string is rendered on a public marketing page.
 */
export const STORY_CONTACT = {
  name: 'Devarshi Dalal',
  firstName: 'Devarshi',
  role: 'Founder & CEO',
  company: 'Cirqle',
  school: 'University of Michigan · Ross',
  location: 'Ann Arbor, MI',
  email: 'devarshi@cirqle.app',
  handle: 'cirqle.app/devarshi',

  /** What the AI parser lands on in beat 2, and the graph lane in beat 4. */
  industry: 'Venture',
  tags: ['Founder', 'Michigan Ross', 'AI · CRM'],

  /** Beat 5 — the relationship-health signal carried through to the queue. */
  health: 88,
  tier: 'Strong' as const,
  metAt: 'Ross Founders Night',
  metWhen: 'Tuesday',

  /** The raw scrap beat 2 parses, as it would arrive off an NFC tap. */
  rawCapture:
    'devarshi dalal — founder/ceo at cirqle, ross undergrad at michigan. ' +
    'met at ross founders night tues, building an ai personal crm, ann arbor',
} as const;

/** Initials for avatars and graph node labels. */
export const STORY_INITIALS = STORY_CONTACT.name
  .split(' ')
  .map((part) => part[0])
  .join('');
