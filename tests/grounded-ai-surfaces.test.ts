import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBriefSources,
  composeFallbackBrief,
  type BriefContext,
} from '../src/lib/briefing';
import { cardDraftSources } from '../src/lib/cardAI';
import { commitmentExtractionSources, type Commitment } from '../src/lib/commitments';
import { revivalDraftSources } from '../src/lib/digest';
import { buildDirectorySearchSources } from '../src/lib/nlSearch';
import {
  buildPrioritySources,
  decodePriorityBrief,
  encodePriorityBrief,
  type PriorityBrief,
} from '../src/lib/priorityBrief';
import {
  isGroundedInRequiredSources,
  unsupportedClaimCategories,
  validateGroundedEnvelope,
} from '../src/lib/grounding';

test('deterministic hallucination gate blocks recurrent unsupported claim classes', () => {
  const contactOnly = [
    {
      id: 'contact-c1',
      kind: 'contact' as const,
      label: 'Contact · Maya',
      text: 'Maya works at Northstar.',
    },
  ];
  assert.deepEqual(
    unsupportedClaimCategories(
      'Great speaking with you. I attached the deck after seeing your recent announcement.',
      contactOnly
    ),
    ['attachment', 'shared-history', 'recent-news']
  );
  assert.deepEqual(
    unsupportedClaimCategories('I attached the deck we discussed.', [
      ...contactOnly,
      {
        id: 'note-n1',
        kind: 'note' as const,
        label: 'Saved note',
        text: 'We discussed the deck in a meeting and I promised to attach it.',
      },
    ]),
    []
  );
});

test('templates and prior AI drafts never become factual evidence', () => {
  const constraints = [
    {
      id: 'template-follow-up',
      kind: 'user-input' as const,
      label: 'Template',
      text: 'I attached the deck we discussed after your recent announcement.',
      factual: false,
    },
  ];
  assert.deepEqual(
    unsupportedClaimCategories(
      'I attached the deck we discussed after your recent announcement.',
      constraints,
    ),
    ['attachment', 'shared-history', 'recent-news'],
  );
});

test('runtime grounding rejects uncited, invented, duplicate, and constraint-only citations', () => {
  const sources = [
    {
      id: 'contact-c1',
      kind: 'contact' as const,
      label: 'Contact · Maya',
      text: 'Maya works at Northstar.',
    },
    {
      id: 'template-follow-up',
      kind: 'user-input' as const,
      label: 'Template',
      text: 'I attached the deck.',
      factual: false,
    },
  ];
  assert.deepEqual(
    validateGroundedEnvelope(
      {
        result: 'Maya works at Northstar.',
        usedSourceIds: ['contact-c1'],
        unsupportedAssumptions: [],
      },
      sources,
    ),
    {
      result: 'Maya works at Northstar.',
      usedSourceIds: ['contact-c1'],
      unsupportedAssumptions: [],
    },
  );
  assert.throws(
    () =>
      validateGroundedEnvelope(
        {
          result: 'Maya works at Northstar.',
          usedSourceIds: [],
          unsupportedAssumptions: [],
        },
        sources,
      ),
    /without a valid evidence citation/,
  );
  assert.throws(
    () =>
      validateGroundedEnvelope(
        {
          result: 'Maya works at Northstar.',
          usedSourceIds: ['contact-c1'],
        },
        sources,
      ),
    /required format/,
  );
  assert.throws(
    () =>
      validateGroundedEnvelope(
        {
          result: 'I attached the deck.',
          usedSourceIds: ['template-follow-up'],
          unsupportedAssumptions: [],
        },
        sources,
      ),
    /non-factual evidence citation/,
  );
  assert.throws(
    () =>
      validateGroundedEnvelope(
        {
          result: 'Maya works at Northstar.',
          usedSourceIds: ['contact-c1', 'contact-c1'],
          unsupportedAssumptions: [],
        },
        sources,
      ),
    /invalid or non-factual evidence citation/,
  );
  assert.throws(
    () =>
      validateGroundedEnvelope(
        {
          result: 'Maya works at Northstar.',
          usedSourceIds: ['invented-source'],
          unsupportedAssumptions: [],
          hidden: 'extra model field',
        },
        sources,
      ),
    /required format/,
  );
});

test('feature-level grounding requires its primary evidence source', () => {
  assert.equal(
    isGroundedInRequiredSources(
      {
        usedSourceIds: ['pasted-reply', 'outreach-o1'],
        unsupportedAssumptions: [],
      },
      ['pasted-reply'],
    ),
    true,
  );
  assert.equal(
    isGroundedInRequiredSources(
      {
        usedSourceIds: ['outreach-o1'],
        unsupportedAssumptions: [],
      },
      ['pasted-reply'],
    ),
    false,
  );
  assert.equal(
    isGroundedInRequiredSources(
      {
        usedSourceIds: ['pasted-reply'],
        unsupportedAssumptions: ['The contact sounded enthusiastic.'],
      },
      ['pasted-reply'],
    ),
    false,
  );
});

test('directory search treats the query as evidence data and caps the context packet', () => {
  const contacts = Array.from({ length: 75 }, (_, index) => ({
    id: `${index}`,
    name: `Person ${index}`,
    role: index === 70 ? 'Private equity marketing lead' : 'Engineer',
  }));
  const sources = buildDirectorySearchSources(
    'Who knows private equity marketing?',
    contacts
  );

  assert.equal(sources[0].id, 'search-query');
  assert.equal(sources.length, 60);
  assert.ok(sources.some((source) => source.id === 'contact-70'));
  assert.ok(sources.every((source) => source.text.length > 0));
});

test('priority brief sources use raw tracker fields and omit legacy AI summaries', () => {
  const sources = buildPrioritySources(
    [{ id: 'c1', name: 'Maya', company: 'Northstar' }],
    [
      {
        id: 'o1',
        contactId: 'c1',
        status: 'Opened in Mail Client',
        nextAction: 'Confirm whether it was sent',
        aiSummary: 'Invented summary that must not become evidence',
        sentAt: new Date('2026-07-28T12:00:00Z'),
      },
    ]
  );

  assert.deepEqual(sources.map((source) => source.id), ['contact-c1', 'outreach-o1']);
  assert.doesNotMatch(JSON.stringify(sources), /Invented summary/);
  assert.match(sources[1].text, /Opened in Mail Client/);
});

test('legacy dashboard caches are rejected while grounded caches round-trip', () => {
  assert.equal(decodePriorityBrief('- Follow up with Maya'), null);
  const brief: PriorityBrief = {
    text: '- Confirm whether Maya replied.',
    grounding: {
      usedSourceIds: ['contact-c1', 'outreach-o1'],
      unsupportedAssumptions: [],
      sourceLabels: {
        'contact-c1': 'Contact · Maya',
        'outreach-o1': 'Tracker item · Jul 28',
      },
      generatedAt: '2026-07-29T00:00:00.000Z',
    },
  };
  assert.deepEqual(decodePriorityBrief(encodePriorityBrief(brief)), brief);
});

test('commitment extraction points to the exact saved note and contact', () => {
  const sources = commitmentExtractionSources({
    text: 'I will send the deck on Friday.',
    contactName: 'Maya',
    contactId: 'c1',
    sourceType: 'voice',
    sourceId: 'n1',
  });

  assert.deepEqual(sources.map((source) => source.id), ['contact-c1', 'note-n1']);
  assert.equal(sources[1].label, 'Voice memo');
});

test('meeting briefing uses raw notes and outreach, never their generated summaries', () => {
  const commitment: Commitment = {
    id: 'k1',
    contactId: 'c1',
    contactName: 'Maya',
    text: 'Send the deck',
    dueHint: 'Friday',
    owedBy: 'you',
    status: 'open',
    sourceType: 'note',
    sourceId: 'n1',
    createdAt: new Date('2026-07-27T00:00:00Z'),
    aiGrounding: null,
  };
  const context: BriefContext = {
    contact: { id: 'c1', name: 'Maya', company: 'Northstar' },
    notes: [
      {
        id: 'n1',
        content: 'Maya asked for the deck.',
        aiSummary: 'Invented attachment claim',
        createdAt: new Date('2026-07-27T00:00:00Z'),
      },
      {
        id: 'malformed-sensitive',
        content: 'Private board succession plan must never leave the vault.',
        sensitive: true,
        aiAllowed: false,
        createdAt: new Date('2026-07-29T00:00:00Z'),
      },
      {
        id: 'privacy-blocked',
        content: 'A normal-looking note excluded by the source privacy policy.',
        sensitive: false,
        aiAllowed: false,
        createdAt: new Date('2026-07-28T12:00:00Z'),
      },
    ],
    outreaches: [
      {
        id: 'o1',
        subject: 'Deck timing',
        body: 'I can send it Friday.',
        aiSummary: 'Invented recent announcement',
        sentAt: new Date('2026-07-28T00:00:00Z'),
      },
    ],
    commitments: [commitment],
    facts: [],
    health: {
      score: 74,
      trend: 'steady',
      pinned: false,
      lastTouchDays: 1,
      neverContacted: false,
      reasons: [],
      summary: '74 and steady — last contact 1 day ago.',
      detail: 'Steady — last contact 1 day ago.',
    },
  };

  const sources = buildBriefSources(context, 'Coffee with Maya');
  assert.ok(sources.some((source) => source.id === 'note-n1'));
  assert.ok(sources.some((source) => source.id === 'outreach-o1'));
  assert.ok(sources.some((source) => source.id === 'commitment-k1'));
  assert.ok(sources.some((source) => source.id === 'network-health-c1'));
  assert.doesNotMatch(JSON.stringify(sources), /Invented/);
  assert.doesNotMatch(JSON.stringify(sources), /succession plan/);
  assert.doesNotMatch(JSON.stringify(sources), /source privacy policy/);
  const fallback = composeFallbackBrief(context);
  assert.match(fallback, /Maya asked for the deck/);
  assert.doesNotMatch(fallback, /succession plan|source privacy policy/);
});

test('revival sources never expose the never-contacted sentinel as elapsed time', () => {
  const sources = revivalDraftSources({
    contactId: 'c1',
    contactName: 'Maya',
    company: 'Northstar',
    role: 'Partner',
    reason: 'Never actually contacted.',
    lastTouchDays: 999,
    neverContacted: true,
    senderName: 'Dev',
  });
  const health = JSON.parse(
    sources.find((source) => source.id === 'network-health-c1')!.text
  );
  assert.equal(health.lastTouchDays, null);
  assert.equal(health.neverContacted, true);
});

test('card drafts expose only non-empty profile source IDs', () => {
  const sources = cardDraftSources({
    name: 'Dev',
    role: '',
    company: null,
    bio: 'I build private relationship software.',
    targetIndustries: [],
  });
  assert.deepEqual(sources.map((source) => source.id), ['profile-name', 'profile-bio']);
});
