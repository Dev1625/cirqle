import {
  normalizeEmail,
  normalizeHttpsUrl,
  sanitizeContactProfile,
} from './contactManagementCore';

export type ImportedContact = {
  name: string;
  company: string;
  role: string;
  location: string;
  email: string;
  linkedinUrl: string;
  summary: string;
  relationshipTier: 'Cold' | 'Warm' | 'Strong';
  industry: string;
  subIndustry: string;
  tags: string[];
  school: string | null;
  seniority: string | null;
  connectionSource: string | null;
};

export type CsvImportLimits = {
  maxFileBytes: number;
  maxDataRows: number;
  maxColumns: number;
  maxCellCharacters: number;
  maxParsedCharacters: number;
  maxContacts: number;
  aiChunkSize: number;
  maxAiCalls: number;
};

export const CSV_IMPORT_LIMITS: Readonly<CsvImportLimits> = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxDataRows: 250,
  maxColumns: 50,
  maxCellCharacters: 2_000,
  maxParsedCharacters: 500_000,
  maxContacts: 250,
  aiChunkSize: 25,
  maxAiCalls: 10,
});

export class CsvImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvImportValidationError';
  }
}

export type CsvRowInput = {
  rowNumber: number;
  sourceId: string;
  values: Record<string, string>;
  normalizedValues: Record<string, string>;
};

export type CsvImportPlan = {
  rowCount: number;
  maximumContacts: number;
  aiChunkSize: number;
  maximumAiCalls: number;
};

function limitsWith(
  overrides?: Partial<CsvImportLimits>,
): CsvImportLimits {
  return { ...CSV_IMPORT_LIMITS, ...overrides };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

export function assertCsvFileSize(
  byteLength: number,
  overrides?: Partial<CsvImportLimits>,
): void {
  const { maxFileBytes } = limitsWith(overrides);
  positiveInteger(maxFileBytes, 'maxFileBytes');
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new CsvImportValidationError('Cirqle could not verify this file size.');
  }
  if (byteLength > maxFileBytes) {
    throw new CsvImportValidationError(
      `This CSV is larger than ${Math.floor(maxFileBytes / 1024 / 1024)} MB. Split it into smaller files before importing.`,
    );
  }
}

export function parseCsv(
  text: string,
  overrides?: Partial<CsvImportLimits>,
): string[][] {
  const limits = limitsWith(overrides);
  positiveInteger(limits.maxDataRows, 'maxDataRows');
  positiveInteger(limits.maxColumns, 'maxColumns');
  positiveInteger(limits.maxCellCharacters, 'maxCellCharacters');
  positiveInteger(limits.maxParsedCharacters, 'maxParsedCharacters');

  if (text.includes('\u0000')) {
    throw new CsvImportValidationError(
      'This CSV contains unsupported null characters.',
    );
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let parsedCharacters = 0;

  const append = (value: string) => {
    parsedCharacters += value.length;
    if (parsedCharacters > limits.maxParsedCharacters) {
      throw new CsvImportValidationError(
        `This CSV contains more than ${limits.maxParsedCharacters.toLocaleString()} characters of contact data. Split it into smaller files before importing.`,
      );
    }
    cell += value;
    if (cell.length > limits.maxCellCharacters) {
      throw new CsvImportValidationError(
        `A CSV cell exceeds the ${limits.maxCellCharacters.toLocaleString()} character limit.`,
      );
    }
  };

  const finishCell = () => {
    if (row.length >= limits.maxColumns) {
      throw new CsvImportValidationError(
        `A CSV row contains more than ${limits.maxColumns} columns.`,
      );
    }
    row.push(cell.trim());
    cell = '';
  };

  const finishRow = () => {
    finishCell();
    if (row.some((value) => value.trim())) {
      rows.push(row);
      if (rows.length > limits.maxDataRows + 1) {
        throw new CsvImportValidationError(
          `This CSV contains more than ${limits.maxDataRows} contact rows. Split it into smaller files before importing.`,
        );
      }
    }
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        append('"');
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === ',' && !inQuotes) {
      finishCell();
      continue;
    }

    if ((character === '\n' || character === '\r') && !inQuotes) {
      finishRow();
      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }
      continue;
    }

    append(character);
  }

  if (inQuotes) {
    throw new CsvImportValidationError(
      'This CSV has an unterminated quoted field.',
    );
  }

  if (row.length > 0 || cell.length > 0) {
    finishRow();
  }

  return rows;
}

export function normalizeCsvHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function uniqueHeader(
  header: string,
  headerIndex: number,
  seen: Map<string, number>,
): string {
  const base = header.trim() || `Column ${headerIndex + 1}`;
  const nextCount = (seen.get(base) || 0) + 1;
  seen.set(base, nextCount);
  return nextCount === 1 ? base : `${base} (${nextCount})`;
}

export function prepareCsvRows(rows: string[][]): CsvRowInput[] {
  const headerCounts = new Map<string, number>();
  const headers = (rows[0] || []).map((header, index) =>
    uniqueHeader(header, index, headerCounts),
  );

  return rows.slice(1).map((values, dataIndex) => {
    const input: CsvRowInput = {
      rowNumber: dataIndex + 2,
      sourceId: `csv-row-${dataIndex + 2}`,
      values: Object.create(null) as Record<string, string>,
      normalizedValues: Object.create(null) as Record<string, string>,
    };

    headers.forEach((header, headerIndex) => {
      const value = values[headerIndex] || '';
      input.values[header] = value;
      const normalizedHeader =
        normalizeCsvHeader(header) || `column ${headerIndex + 1}`;
      if (!input.normalizedValues[normalizedHeader] || value) {
        input.normalizedValues[normalizedHeader] = value;
      }
    });

    return input;
  });
}

export function buildCsvImportPlan(
  rows: string[][],
  overrides?: Partial<CsvImportLimits>,
): CsvImportPlan {
  const limits = limitsWith(overrides);
  positiveInteger(limits.maxContacts, 'maxContacts');
  positiveInteger(limits.aiChunkSize, 'aiChunkSize');
  positiveInteger(limits.maxAiCalls, 'maxAiCalls');

  const rowCount = Math.max(rows.length - 1, 0);
  if (rowCount > limits.maxContacts) {
    throw new CsvImportValidationError(
      `This CSV would import more than ${limits.maxContacts} contacts. Split it into smaller files before importing.`,
    );
  }

  const maximumAiCalls =
    rowCount === 0 ? 0 : Math.ceil(rowCount / limits.aiChunkSize);
  if (maximumAiCalls > limits.maxAiCalls) {
    throw new CsvImportValidationError(
      `This CSV would require more than ${limits.maxAiCalls} AI calls. Split it into smaller files before importing.`,
    );
  }

  return {
    rowCount,
    maximumContacts: Math.min(rowCount, limits.maxContacts),
    aiChunkSize: limits.aiChunkSize,
    maximumAiCalls,
  };
}

function pickValue(
  row: Record<string, string>,
  candidates: string[],
): string {
  for (const candidate of candidates) {
    if (row[candidate]) return row[candidate];
  }
  return '';
}

function parseTags(value: string): string[] {
  return value
    .split(/[|,;/]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function inferTier(
  rawTier: string,
  notes: string,
): ImportedContact['relationshipTier'] {
  const value = `${rawTier} ${notes}`.toLowerCase();
  if (value.includes('strong')) return 'Strong';
  if (value.includes('warm')) return 'Warm';
  return 'Cold';
}

function inferIndustry(
  company: string,
  role: string,
  notes: string,
): string {
  const haystack = `${company} ${role} ${notes}`.toLowerCase();
  if (haystack.includes('bank')) return 'Investment Banking';
  if (haystack.includes('consult')) return 'Consulting';
  if (haystack.includes('private equity') || /\bpe\b/.test(haystack)) {
    return 'Private Equity';
  }
  if (haystack.includes('venture') || /\bvc\b/.test(haystack)) {
    return 'Venture Capital';
  }
  if (haystack.includes('hedge')) return 'Hedge Fund';
  if (haystack.includes('health')) return 'Healthcare';
  if (
    haystack.includes('tech') ||
    haystack.includes('software') ||
    haystack.includes('product') ||
    haystack.includes('engineer')
  ) {
    return 'Tech';
  }
  return '';
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTier(
  value?: string | null,
): ImportedContact['relationshipTier'] {
  const text = (value || '').toLowerCase();
  if (text.includes('strong')) return 'Strong';
  if (text.includes('warm')) return 'Warm';
  return 'Cold';
}

export function normalizeImportedContact(
  value: unknown,
): ImportedContact | null {
  const candidate = value as Record<string, unknown> | null | undefined;
  const name = cleanString(candidate?.name);
  const company = cleanString(candidate?.company);
  const email = normalizeEmail(candidate?.email);
  const fallbackName = name || company || email;
  if (!fallbackName) return null;

  try {
    const safe = sanitizeContactProfile({
      name: fallbackName,
      company,
      role: cleanString(candidate?.role),
      location: cleanString(candidate?.location),
      email,
      linkedinUrl: normalizeHttpsUrl(candidate?.linkedinUrl),
      summary: cleanString(candidate?.summary),
      relationshipTier: normalizeTier(
        cleanString(candidate?.relationshipTier),
      ),
      industry:
        cleanString(candidate?.industry) ||
        inferIndustry(
          company,
          cleanString(candidate?.role),
          cleanString(candidate?.summary),
        ),
      subIndustry: cleanString(candidate?.subIndustry),
      tags: Array.isArray(candidate?.tags)
        ? candidate?.tags
        : parseTags(cleanString(candidate?.tags)),
      school: cleanString(candidate?.school),
      seniority: cleanString(candidate?.seniority),
      connectionSource: cleanString(candidate?.connectionSource),
    });

    return {
      name: safe.name,
      company: safe.company,
      role: safe.role,
      location: safe.location,
      email: safe.email,
      linkedinUrl: safe.linkedinUrl,
      summary: safe.summary,
      relationshipTier: safe.relationshipTier,
      industry: safe.industry,
      subIndustry: safe.subIndustry,
      tags: safe.tags,
      school: safe.school || null,
      seniority: safe.seniority || null,
      connectionSource: safe.connectionSource || null,
    };
  } catch {
    return null;
  }
}

export function buildImportedContact(
  row: Record<string, string>,
): ImportedContact | null {
  const firstName = pickValue(row, ['first name', 'firstname']);
  const lastName = pickValue(row, ['last name', 'lastname']);
  const fullName =
    pickValue(row, ['name', 'full name', 'fullname']) ||
    `${firstName} ${lastName}`.trim();
  const company = pickValue(row, ['company', 'current company']);
  const role = pickValue(row, ['position', 'title', 'role', 'headline']);
  const location = pickValue(row, ['location', 'address']);
  const email = pickValue(row, ['email', 'email address', 'emailaddress']);
  const linkedinUrl = pickValue(row, [
    'linkedin url',
    'linkedin',
    'profile url',
    'profile link',
    'url',
  ]);
  const summary = pickValue(row, [
    'summary',
    'notes',
    'description',
    'headline',
  ]);
  const industry = pickValue(row, ['industry']);
  const subIndustry = pickValue(row, ['sub industry', 'subindustry']);
  const school = pickValue(row, ['school', 'university', 'college']);
  const seniority = pickValue(row, ['seniority']);
  const connectionSource = pickValue(row, [
    'connection source',
    'source',
  ]);
  const rawTags = pickValue(row, ['tags', 'keywords']);
  const rawTier = pickValue(row, [
    'relationship tier',
    'tier',
    'relationship',
  ]);

  return normalizeImportedContact({
    name: fullName || company || email,
    company,
    role,
    location,
    email,
    linkedinUrl,
    summary,
    relationshipTier: inferTier(rawTier, summary),
    industry: industry || inferIndustry(company, role, summary),
    subIndustry,
    tags: parseTags(rawTags),
    school,
    seniority,
    connectionSource,
  });
}
