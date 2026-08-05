import {
  generateGroundedJSON,
  type GroundedResult,
  type GroundedSource,
} from './grounding';
import { isContactAIEligible } from './contactManagementCore';
import { rankRelationshipsLocally } from './moat/localRelationshipIndex';

export interface DirectorySearchResult {
  explanation: string;
  contactSourceIds: string[];
}

export function buildDirectorySearchSources(
  query: string,
  contacts: any[],
  contactLimit = 59
): GroundedSource[] {
  const ranked = rankRelationshipsLocally(
    query,
    contacts.filter(isContactAIEligible),
  ).map((entry) => entry.contact);

  const contactSources: GroundedSource[] = ranked
    .filter((contact) => contact.id)
    .slice(0, contactLimit)
    .map((contact) => ({
      id: `contact-${contact.id}`,
      kind: 'contact',
      label: `Contact · ${contact.name || 'Unnamed'}`,
      text: JSON.stringify({
        name: contact.name || null,
        company: contact.company || null,
        role: contact.role || null,
        tags: Array.isArray(contact.tags) ? contact.tags : [],
        summary: contact.summary || null,
        industry: contact.industry || null,
        subIndustry: contact.subIndustry || null,
        school: contact.school || null,
        location: contact.location || null,
      }),
    }));

  return [
    {
      id: 'search-query',
      kind: 'user-input',
      label: 'Your search',
      text: query.trim().slice(0, 500),
    },
    ...contactSources,
  ];
}

export async function searchGroundedDirectory(
  query: string,
  contacts: any[],
  signal?: AbortSignal,
): Promise<{ grounded: GroundedResult<DirectorySearchResult>; sources: GroundedSource[] }> {
  const sources = buildDirectorySearchSources(query, contacts);
  const allowedContactIds = new Set(
    sources.filter((source) => source.kind === 'contact').map((source) => source.id)
  );
  const grounded = await generateGroundedJSON<DirectorySearchResult>({
    task: 'Answer the saved directory search. Select the most relevant contacts and explain the match in one or two short sentences.',
    resultSchema: `{
      "explanation": "one or two sentences based only on selected contact records",
      "contactSourceIds": ["exact contact source id, for example contact-abc123"]
    }`,
    sources,
    rules: [
      'The search-query source is a request, not evidence about any person.',
      'Return at most eight contact source IDs.',
      'Include every selected contact source ID in usedSourceIds.',
      'Do not infer skills, relationships, availability, influence, or willingness to help unless the contact record explicitly states them.',
      'Do not use outside knowledge about a person, school, employer, industry, or company.',
    ],
    options: {
      tier: 'reasoning',
      maxTokens: 800,
      feature: 'global-natural-language-search',
      signal,
    },
  });
  if (!grounded.usedSourceIds.includes('search-query')) {
    throw new Error('The directory search did not cite your query.');
  }

  const cited = new Set(grounded.usedSourceIds);
  const requested = Array.isArray(grounded.result?.contactSourceIds)
    ? grounded.result.contactSourceIds
    : [];
  const accepted = [...new Set(requested)]
    .filter((id) => allowedContactIds.has(id) && cited.has(id))
    .slice(0, 8);
  const uncitedCount = requested.filter(
    (id) => allowedContactIds.has(id) && !cited.has(id)
  ).length;

  return {
    sources,
    grounded: {
      ...grounded,
      result: {
        explanation:
          typeof grounded.result?.explanation === 'string'
            ? grounded.result.explanation.trim().slice(0, 1200)
            : '',
        contactSourceIds: accepted,
      },
      unsupportedAssumptions:
        uncitedCount > 0
          ? [
              ...grounded.unsupportedAssumptions,
              `${uncitedCount} suggested contact${uncitedCount === 1 ? ' was' : 's were'} omitted because the model did not cite the saved record.`,
            ]
          : grounded.unsupportedAssumptions,
    },
  };
}
