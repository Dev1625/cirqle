/**
 * A tenant-local sparse relationship index.
 *
 * It is intentionally rebuilt in memory from the signed-in user's contacts:
 * no shared vector store, external embedding API, cross-tenant corpus, or
 * persisted derived profile. The model sees only the bounded candidates this
 * deterministic index selects, and the normal grounding/privacy boundary
 * still applies afterward.
 */

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'for',
  'from',
  'has',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'who',
  'with',
]);

function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('ers')) return token.slice(0, -1);
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

export function relationshipFeatures(value: string): string[] {
  const tokens = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((token) => stem(token))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  const features = [...tokens];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    features.push(`${tokens[index]}::${tokens[index + 1]}`);
  }
  return features.slice(0, 400);
}

function contactCorpus(contact: any): string {
  const tags = Array.isArray(contact.tags) ? contact.tags.join(' ') : '';
  // Role, tags, and explicit summaries carry the most intent; repeating them
  // gives those first-party fields more sparse-vector weight without inventing
  // semantics from shared employers or schools.
  return [
    contact.name,
    contact.company,
    contact.role,
    contact.role,
    tags,
    tags,
    contact.summary,
    contact.summary,
    contact.industry,
    contact.subIndustry,
    contact.school,
    contact.location,
    contact.whyTheyMatter,
  ]
    .filter(Boolean)
    .join(' ');
}

function frequencies(features: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const feature of features) {
    counts.set(feature, (counts.get(feature) || 0) + 1);
  }
  return counts;
}

function vectorNorm(
  counts: Map<string, number>,
  idf: Map<string, number>,
): number {
  let total = 0;
  for (const [feature, count] of counts) {
    const weight = count * (idf.get(feature) || 0);
    total += weight * weight;
  }
  return Math.sqrt(total);
}

export interface LocalRelationshipMatch<T = any> {
  contact: T;
  score: number;
  matchedFeatures: string[];
}

export function rankRelationshipsLocally<T = any>(
  query: string,
  contacts: T[],
): LocalRelationshipMatch<T>[] {
  const queryCounts = frequencies(relationshipFeatures(query));
  const documents = contacts.map((contact) =>
    frequencies(relationshipFeatures(contactCorpus(contact))),
  );
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const feature of document.keys()) {
      documentFrequency.set(
        feature,
        (documentFrequency.get(feature) || 0) + 1,
      );
    }
  }
  const idf = new Map<string, number>();
  for (const feature of new Set([
    ...queryCounts.keys(),
    ...documentFrequency.keys(),
  ])) {
    idf.set(
      feature,
      Math.log(
        (documents.length + 1) /
          ((documentFrequency.get(feature) || 0) + 1),
      ) + 1,
    );
  }
  const queryNorm = vectorNorm(queryCounts, idf);

  return contacts
    .map((contact, index) => {
      const document = documents[index];
      const documentNorm = vectorNorm(document, idf);
      let dot = 0;
      const matchedFeatures: string[] = [];
      for (const [feature, queryCount] of queryCounts) {
        const documentCount = document.get(feature) || 0;
        if (!documentCount) continue;
        const inverseFrequency = idf.get(feature) || 0;
        dot +=
          queryCount *
          inverseFrequency *
          documentCount *
          inverseFrequency;
        matchedFeatures.push(feature);
      }
      return {
        contact,
        index,
        score:
          queryNorm && documentNorm ? dot / (queryNorm * documentNorm) : 0,
        matchedFeatures: matchedFeatures.slice(0, 8),
      };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ contact, score, matchedFeatures }) => ({
      contact,
      score,
      matchedFeatures,
    }));
}
