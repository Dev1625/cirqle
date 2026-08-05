import {
  factsForAI,
  type FactSourceType,
  type TemporalFact,
} from './factLedgerCore';

export const CONTACT_RECOVERY_WINDOW_DAYS = 30;

export const CONTACT_PROFILE_FIELDS = [
  'name',
  'email',
  'phone',
  'company',
  'role',
  'location',
  'linkedinUrl',
  'summary',
  'relationshipTier',
  'industry',
  'subIndustry',
  'school',
  'seniority',
  'connectionSource',
  'whyTheyMatter',
  'tags',
] as const;

export type ContactProfileField = (typeof CONTACT_PROFILE_FIELDS)[number];
export type ContactLifecycleStatus = 'active' | 'archived' | 'deleted';

/**
 * Parses a date-only form value as a local calendar day at noon.
 *
 * `new Date('YYYY-MM-DD')` is UTC by specification, which displays as the
 * previous day in timezones west of UTC. Noon also avoids DST transition
 * edges while preserving the day the user selected.
 */
export function localDateFromISODate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(year, month - 1, day, 12, 0, 0, 0);

  if (
    Number.isNaN(result.getTime()) ||
    result.getFullYear() !== year ||
    result.getMonth() !== month - 1 ||
    result.getDate() !== day
  ) {
    return null;
  }

  return result;
}

export interface ContactProfile {
  name: string;
  email: string;
  phone: string;
  company: string;
  role: string;
  location: string;
  linkedinUrl: string;
  summary: string;
  relationshipTier: 'Cold' | 'Warm' | 'Strong';
  industry: string;
  subIndustry: string;
  school: string;
  seniority: string;
  connectionSource: string;
  whyTheyMatter: string;
  tags: string[];
}

export interface ManagedContact extends ContactProfile {
  id: string;
  profileRevision: number;
  lifecycleStatus?: ContactLifecycleStatus;
  archivedAt?: Date | null;
  deletedAt?: Date | null;
  purgeEligibleAt?: Date | null;
  restoredAt?: Date | null;
  aiAllowed?: boolean;
  aiAllowedBeforeLifecycle?: boolean | null;
  mergedIntoContactId?: string | null;
  contactMergeOperationId?: string | null;
}

function contactDate(value: unknown): Date | null {
  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  if (!value) return null;
  const parsed = new Date(value as string | number | Date);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function managedContactFromRecord(
  id: string,
  value: Record<string, unknown>,
): ManagedContact {
  return {
    id,
    ...contactProfileFromRecord(value),
    profileRevision:
      Number.isSafeInteger(value.profileRevision) &&
      Number(value.profileRevision) >= 0
        ? Number(value.profileRevision)
        : 0,
    lifecycleStatus:
      value.lifecycleStatus === 'archived' ||
      value.lifecycleStatus === 'deleted'
        ? value.lifecycleStatus
        : 'active',
    archivedAt: contactDate(value.archivedAt),
    deletedAt: contactDate(value.deletedAt),
    purgeEligibleAt: contactDate(value.purgeEligibleAt),
    restoredAt: contactDate(value.restoredAt),
    aiAllowed: value.aiAllowed !== false,
    aiAllowedBeforeLifecycle:
      typeof value.aiAllowedBeforeLifecycle === 'boolean'
        ? value.aiAllowedBeforeLifecycle
        : null,
    mergedIntoContactId:
      typeof value.mergedIntoContactId === 'string'
        ? value.mergedIntoContactId
        : null,
    contactMergeOperationId:
      typeof value.contactMergeOperationId === 'string'
        ? value.contactMergeOperationId
        : null,
  };
}

export interface ContactProfileValidation {
  valid: boolean;
  errors: Partial<Record<ContactProfileField, string>>;
}

export class ContactProfileValidationError extends Error {
  readonly errors: ContactProfileValidation['errors'];

  constructor(errors: ContactProfileValidation['errors']) {
    super('The contact profile contains invalid fields.');
    this.name = 'ContactProfileValidationError';
    this.errors = errors;
  }
}

const FIELD_LIMITS: Record<Exclude<ContactProfileField, 'tags'>, number> = {
  name: 160,
  email: 320,
  phone: 80,
  company: 200,
  role: 200,
  location: 200,
  linkedinUrl: 2_048,
  summary: 4_000,
  relationshipTier: 16,
  industry: 160,
  subIndustry: 160,
  school: 200,
  seniority: 120,
  connectionSource: 240,
  whyTheyMatter: 2_000,
};

const PROFILE_DEFAULTS: ContactProfile = {
  name: '',
  email: '',
  phone: '',
  company: '',
  role: '',
  location: '',
  linkedinUrl: '',
  summary: '',
  relationshipTier: 'Cold',
  industry: '',
  subIndustry: '',
  school: '',
  seniority: '',
  connectionSource: '',
  whyTheyMatter: '',
  tags: [],
};

function cleanText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
}

function cleanMultilineText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .join('\n')
    .trim();
}

export function normalizeEmail(value: unknown): string {
  const email = cleanText(value).toLocaleLowerCase();
  if (!email || email.length > FIELD_LIMITS.email) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

export function normalizeHttpsUrl(value: unknown): string {
  const candidate = cleanText(value);
  if (!candidate || candidate.length > FIELD_LIMITS.linkedinUrl) return '';
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password
    ) {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

export function buildMailtoUrl(
  emailValue: unknown,
  subjectValue: unknown,
  bodyValue: unknown,
): string | null {
  const email = normalizeEmail(emailValue);
  if (!email) return null;
  const subject = String(subjectValue ?? '').replace(/[\r\n\u0000]/g, ' ');
  const body = String(bodyValue ?? '').replace(/\u0000/g, '');
  const query = new URLSearchParams({
    subject: subject.slice(0, 2_000),
    body: body.slice(0, 50_000),
  });
  return `mailto:${encodeURIComponent(email)}?${query.toString()}`;
}

function normalizeIdentityText(value: unknown): string {
  return cleanText(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizePersonName(value: unknown): string {
  return normalizeIdentityText(value);
}

export function normalizeCompanyName(value: unknown): string {
  // Deliberately retain legal suffixes. "Acme" and "Acme Ventures" may be
  // related, but treating them as identical would create unsafe merge noise.
  return normalizeIdentityText(value);
}

export function normalizeTags(value: unknown): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[;,|]/)
      : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of source) {
    const tag = cleanText(raw).slice(0, 80);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === 40) break;
  }
  return tags;
}

export function sanitizeContactProfile(
  value: Partial<Record<ContactProfileField, unknown>>,
): ContactProfile {
  const relationshipTier =
    value.relationshipTier === 'Warm' || value.relationshipTier === 'Strong'
      ? value.relationshipTier
      : 'Cold';
  const profile: ContactProfile = {
    ...PROFILE_DEFAULTS,
    name: cleanText(value.name),
    email: cleanText(value.email).toLocaleLowerCase(),
    phone: cleanText(value.phone),
    company: cleanText(value.company),
    role: cleanText(value.role),
    location: cleanText(value.location),
    linkedinUrl: cleanText(value.linkedinUrl),
    summary: cleanMultilineText(value.summary),
    relationshipTier,
    industry: cleanText(value.industry),
    subIndustry: cleanText(value.subIndustry),
    school: cleanText(value.school),
    seniority: cleanText(value.seniority),
    connectionSource: cleanText(value.connectionSource),
    whyTheyMatter: cleanMultilineText(value.whyTheyMatter),
    tags: normalizeTags(value.tags),
  };
  const validation = validateContactProfile(profile);
  if (!validation.valid) throw new ContactProfileValidationError(validation.errors);
  return profile;
}

export function contactProfileFromRecord(
  value: Partial<Record<ContactProfileField, unknown>>,
): ContactProfile {
  try {
    return sanitizeContactProfile(value);
  } catch {
    // Existing/imported records can predate the editor's validation. Reading
    // them must remain possible; the editor surfaces errors before the next
    // save instead of crashing the contact page.
    return {
      ...PROFILE_DEFAULTS,
      ...Object.fromEntries(
        CONTACT_PROFILE_FIELDS.filter((field) => field !== 'tags').map(
          (field) => [
            field,
            field === 'summary' || field === 'whyTheyMatter'
              ? cleanMultilineText(value[field])
              : cleanText(value[field]),
          ],
        ),
      ),
      relationshipTier:
        value.relationshipTier === 'Warm' || value.relationshipTier === 'Strong'
          ? value.relationshipTier
          : 'Cold',
      tags: normalizeTags(value.tags),
      email: normalizeEmail(value.email),
      linkedinUrl: normalizeHttpsUrl(value.linkedinUrl),
    } as ContactProfile;
  }
}

export function validateContactProfile(
  profile: ContactProfile,
): ContactProfileValidation {
  const errors: ContactProfileValidation['errors'] = {};
  if (!profile.name) errors.name = 'Name is required.';
  for (const field of CONTACT_PROFILE_FIELDS) {
    if (field === 'tags') continue;
    const limit = FIELD_LIMITS[field];
    if (profile[field].length > limit) {
      errors[field] = `Use ${limit.toLocaleString()} characters or fewer.`;
    }
  }
  if (profile.email && !normalizeEmail(profile.email)) {
    errors.email = 'Enter a complete email address.';
  }
  if (profile.linkedinUrl) {
    try {
      const url = new URL(profile.linkedinUrl);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password
      ) {
        errors.linkedinUrl =
          'Use a secure https:// URL without embedded credentials.';
      }
    } catch {
      errors.linkedinUrl = 'Enter a complete https:// URL.';
    }
  }
  if (!['Cold', 'Warm', 'Strong'].includes(profile.relationshipTier)) {
    errors.relationshipTier = 'Choose Cold, Warm, or Strong.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export type DuplicateMatchKind = 'email' | 'name-company';

export interface DuplicateDetection {
  contactId: string;
  isCandidate: boolean;
  safeToSuggestMerge: boolean;
  confidence: 'high' | 'medium' | 'low' | 'none';
  matchedBy: DuplicateMatchKind[];
  warnings: string[];
}

export function detectDuplicate(
  incoming: Pick<ManagedContact, 'id' | 'name' | 'company' | 'email'>,
  existing: Pick<ManagedContact, 'id' | 'name' | 'company' | 'email'>,
): DuplicateDetection {
  const result: DuplicateDetection = {
    contactId: existing.id,
    isCandidate: false,
    safeToSuggestMerge: false,
    confidence: 'none',
    matchedBy: [],
    warnings: [],
  };
  if (!incoming.id || incoming.id === existing.id) return result;

  const incomingEmail = normalizeEmail(incoming.email);
  const existingEmail = normalizeEmail(existing.email);
  const emailMatches =
    Boolean(incomingEmail) &&
    Boolean(existingEmail) &&
    incomingEmail === existingEmail;
  const emailsConflict =
    Boolean(incomingEmail) &&
    Boolean(existingEmail) &&
    incomingEmail !== existingEmail;

  const nameMatches =
    Boolean(normalizePersonName(incoming.name)) &&
    normalizePersonName(incoming.name) === normalizePersonName(existing.name);
  const companyMatches =
    Boolean(normalizeCompanyName(incoming.company)) &&
    normalizeCompanyName(incoming.company) ===
      normalizeCompanyName(existing.company);

  if (emailMatches) result.matchedBy.push('email');
  if (nameMatches && companyMatches) result.matchedBy.push('name-company');
  result.isCandidate = result.matchedBy.length > 0;

  if (emailsConflict && result.matchedBy.includes('name-company')) {
    result.warnings.push(
      'The names and companies match, but the email addresses differ.',
    );
  }
  if (emailMatches) {
    result.confidence = 'high';
    result.safeToSuggestMerge = true;
  } else if (nameMatches && companyMatches && !emailsConflict) {
    result.confidence = 'medium';
    result.safeToSuggestMerge = true;
  } else if (result.isCandidate) {
    result.confidence = 'low';
  }
  return result;
}

export function findDuplicateCandidates(
  incoming: Pick<ManagedContact, 'id' | 'name' | 'company' | 'email'>,
  existing: Array<
    Pick<
      ManagedContact,
      'id' | 'name' | 'company' | 'email' | 'lifecycleStatus'
    >
  >,
): DuplicateDetection[] {
  const confidenceOrder = { high: 3, medium: 2, low: 1, none: 0 };
  return existing
    .filter((contact) => contact.lifecycleStatus !== 'deleted')
    .map((contact) => detectDuplicate(incoming, contact))
    .filter((match) => match.isCandidate)
    .sort(
      (left, right) =>
        confidenceOrder[right.confidence] - confidenceOrder[left.confidence],
    );
}

export interface ContactLifecycleState {
  lifecycleStatus?: ContactLifecycleStatus;
  archivedAt?: Date | null;
  deletedAt?: Date | null;
  purgeEligibleAt?: Date | null;
  restoredAt?: Date | null;
  aiAllowed?: boolean;
  aiAllowedBeforeLifecycle?: boolean | null;
  mergedIntoContactId?: string | null;
}

export type ContactLifecycleAction = 'archive' | 'restore' | 'delete';

export function contactLifecycleStatus(
  state: ContactLifecycleState,
): ContactLifecycleStatus {
  return state.lifecycleStatus || 'active';
}

export function nextContactLifecycle(
  state: ContactLifecycleState,
  action: ContactLifecycleAction,
  at: Date,
  recoveryWindowDays = CONTACT_RECOVERY_WINDOW_DAYS,
): ContactLifecycleState {
  const status = contactLifecycleStatus(state);
  const rememberedAI =
    state.aiAllowedBeforeLifecycle ?? state.aiAllowed !== false;

  if (action === 'archive') {
    if (status === 'deleted') {
      throw new Error('Restore this contact before archiving it.');
    }
    if (status === 'archived') return { ...state };
    return {
      ...state,
      lifecycleStatus: 'archived',
      archivedAt: new Date(at),
      restoredAt: null,
      aiAllowedBeforeLifecycle: rememberedAI,
      aiAllowed: false,
    };
  }

  if (action === 'delete') {
    if (status === 'deleted') return { ...state };
    const purgeEligibleAt = new Date(at);
    purgeEligibleAt.setUTCDate(purgeEligibleAt.getUTCDate() + recoveryWindowDays);
    return {
      ...state,
      lifecycleStatus: 'deleted',
      deletedAt: new Date(at),
      purgeEligibleAt,
      aiAllowedBeforeLifecycle: rememberedAI,
      aiAllowed: false,
    };
  }

  if (status === 'active') return { ...state };
  if (
    status === 'deleted' &&
    state.purgeEligibleAt &&
    at.getTime() >= state.purgeEligibleAt.getTime()
  ) {
    throw new Error('The recovery window has expired.');
  }
  return {
    ...state,
    lifecycleStatus: 'active',
    archivedAt: null,
    deletedAt: null,
    purgeEligibleAt: null,
    restoredAt: new Date(at),
    aiAllowed: rememberedAI,
    aiAllowedBeforeLifecycle: null,
    mergedIntoContactId: null,
  };
}

export function isContactPurgeEligible(
  state: ContactLifecycleState,
  at: Date,
): boolean {
  return (
    contactLifecycleStatus(state) === 'deleted' &&
    Boolean(state.purgeEligibleAt) &&
    at.getTime() >= (state.purgeEligibleAt?.getTime() || Number.POSITIVE_INFINITY)
  );
}

export function isContactAIEligible(
  state: ContactLifecycleState,
): boolean {
  return (
    contactLifecycleStatus(state) === 'active' &&
    state.aiAllowed !== false &&
    !state.mergedIntoContactId
  );
}

export function contactFactsForAI(
  contact: ContactLifecycleState,
  facts: TemporalFact[],
): TemporalFact[] {
  return isContactAIEligible(contact) ? factsForAI(facts) : [];
}

export interface JobHistoryEntry {
  id: string;
  role: string;
  company: string;
  location: string;
  startedAt: Date | null;
  endedAt: Date | null;
  current: boolean;
  sourceType: 'profile' | 'profile-backfill' | 'import' | 'user-correction';
  sourceId: string | null;
  correctionOf: string | null;
  supersededBy: string | null;
  recordedAt: Date;
}

export interface PlannedJobHistoryEntry
  extends Omit<JobHistoryEntry, 'id' | 'supersededBy'> {
  localId: string;
  supersededBy: null;
}

export interface JobHistoryPlan {
  changed: boolean;
  closeEntryIds: string[];
  additions: PlannedJobHistoryEntry[];
}

function jobKey(
  value: Pick<ContactProfile, 'company' | 'role'>,
): string {
  return `${normalizeCompanyName(value.company)}|${normalizeIdentityText(value.role)}`;
}

function hasJob(value: Pick<ContactProfile, 'company' | 'role'>): boolean {
  return Boolean(cleanText(value.company) || cleanText(value.role));
}

export function planJobHistoryChange(params: {
  contactId: string;
  previous: Pick<ContactProfile, 'company' | 'role' | 'location'>;
  next: Pick<ContactProfile, 'company' | 'role' | 'location'>;
  history: JobHistoryEntry[];
  changedAt: Date;
}): JobHistoryPlan {
  if (jobKey(params.previous) === jobKey(params.next)) {
    return { changed: false, closeEntryIds: [], additions: [] };
  }

  const currentEntries = params.history.filter((entry) => entry.current);
  const additions: PlannedJobHistoryEntry[] = [];
  if (currentEntries.length === 0 && hasJob(params.previous)) {
    additions.push({
      localId: 'previous-job-backfill',
      role: cleanText(params.previous.role),
      company: cleanText(params.previous.company),
      location: cleanText(params.previous.location),
      startedAt: null,
      endedAt: new Date(params.changedAt),
      current: false,
      sourceType: 'profile-backfill',
      sourceId: params.contactId,
      correctionOf: null,
      supersededBy: null,
      recordedAt: new Date(params.changedAt),
    });
  }
  if (hasJob(params.next)) {
    additions.push({
      localId: 'next-current-job',
      role: cleanText(params.next.role),
      company: cleanText(params.next.company),
      location: cleanText(params.next.location),
      startedAt: new Date(params.changedAt),
      endedAt: null,
      current: true,
      sourceType: 'user-correction',
      sourceId: params.contactId,
      correctionOf: currentEntries[0]?.id || null,
      supersededBy: null,
      recordedAt: new Date(params.changedAt),
    });
  }
  return {
    changed: true,
    closeEntryIds: currentEntries.map((entry) => entry.id),
    additions,
  };
}

export type MergeStrategy = 'primary' | 'duplicate' | 'combine' | 'custom';

export interface ContactMergeChoice {
  field: ContactProfileField;
  strategy: MergeStrategy;
  customValue?: string | string[];
}

export interface ContactMergeConflict {
  field: ContactProfileField;
  primaryValue: string | string[];
  duplicateValue: string | string[];
  allowedStrategies: MergeStrategy[];
}

export interface ContactMergeAnalysis {
  conflicts: ContactMergeConflict[];
  automaticallyResolved: ContactProfileField[];
}

export interface ContactMergeDecision {
  field: ContactProfileField;
  primaryValue: string | string[];
  duplicateValue: string | string[];
  finalValue: string | string[];
  strategy: MergeStrategy | 'same' | 'only-value';
}

export interface ResolvedContactMerge {
  profile: ContactProfile;
  decisions: ContactMergeDecision[];
}

function comparableProfileValue(
  field: ContactProfileField,
  value: string | string[],
): string {
  if (field === 'tags') {
    return [...(value as string[])]
      .map((tag) => tag.toLocaleLowerCase())
      .sort()
      .join('|');
  }
  if (field === 'email') return normalizeEmail(value);
  if (field === 'name') return normalizePersonName(value);
  if (field === 'company') return normalizeCompanyName(value);
  return cleanText(value).toLocaleLowerCase();
}

function isEmptyProfileValue(value: string | string[]): boolean {
  return Array.isArray(value) ? value.length === 0 : !cleanText(value);
}

export function analyzeContactMerge(
  primary: ContactProfile,
  duplicate: ContactProfile,
): ContactMergeAnalysis {
  const conflicts: ContactMergeConflict[] = [];
  const automaticallyResolved: ContactProfileField[] = [];
  for (const field of CONTACT_PROFILE_FIELDS) {
    const left = primary[field];
    const right = duplicate[field];
    const same =
      comparableProfileValue(field, left) === comparableProfileValue(field, right);
    if (same || isEmptyProfileValue(left) || isEmptyProfileValue(right)) {
      automaticallyResolved.push(field);
      continue;
    }
    conflicts.push({
      field,
      primaryValue: left,
      duplicateValue: right,
      allowedStrategies:
        field === 'tags'
          ? ['primary', 'duplicate', 'combine', 'custom']
          : ['primary', 'duplicate', 'custom'],
    });
  }
  return { conflicts, automaticallyResolved };
}

export class UnresolvedContactMergeError extends Error {
  readonly fields: ContactProfileField[];

  constructor(fields: ContactProfileField[]) {
    super(`Choose a value for: ${fields.join(', ')}.`);
    this.name = 'UnresolvedContactMergeError';
    this.fields = fields;
  }
}

export function resolveContactMerge(
  primary: ContactProfile,
  duplicate: ContactProfile,
  choices: ContactMergeChoice[],
): ResolvedContactMerge {
  const choiceByField = new Map(choices.map((choice) => [choice.field, choice]));
  const analysis = analyzeContactMerge(primary, duplicate);
  const unresolved = analysis.conflicts
    .map((conflict) => conflict.field)
    .filter((field) => !choiceByField.has(field));
  if (unresolved.length) throw new UnresolvedContactMergeError(unresolved);

  const rawProfile: Partial<Record<ContactProfileField, unknown>> = {};
  const decisions: ContactMergeDecision[] = [];
  for (const field of CONTACT_PROFILE_FIELDS) {
    const primaryValue = primary[field];
    const duplicateValue = duplicate[field];
    const same =
      comparableProfileValue(field, primaryValue) ===
      comparableProfileValue(field, duplicateValue);
    let strategy: ContactMergeDecision['strategy'];
    let finalValue: string | string[];
    if (same) {
      strategy = 'same';
      finalValue = primaryValue;
    } else if (isEmptyProfileValue(primaryValue)) {
      strategy = 'only-value';
      finalValue = duplicateValue;
    } else if (isEmptyProfileValue(duplicateValue)) {
      strategy = 'only-value';
      finalValue = primaryValue;
    } else {
      const choice = choiceByField.get(field);
      if (!choice) throw new UnresolvedContactMergeError([field]);
      strategy = choice.strategy;
      if (choice.strategy === 'primary') finalValue = primaryValue;
      else if (choice.strategy === 'duplicate') finalValue = duplicateValue;
      else if (choice.strategy === 'combine') {
        if (field !== 'tags') {
          throw new Error(`The ${field} field cannot be combined.`);
        }
        finalValue = normalizeTags([
          ...(primaryValue as string[]),
          ...(duplicateValue as string[]),
        ]);
      } else {
        finalValue =
          field === 'tags'
            ? normalizeTags(choice.customValue)
            : cleanText(choice.customValue);
      }
    }
    rawProfile[field] = finalValue;
    decisions.push({
      field,
      primaryValue,
      duplicateValue,
      finalValue,
      strategy,
    });
  }
  return {
    profile: sanitizeContactProfile(rawProfile),
    decisions,
  };
}

export type ContactReferenceKind =
  | 'note'
  | 'outreach'
  | 'commitment'
  | 'thread'
  | 'voice-enrichment'
  | 'connection'
  | 'fact'
  | 'job-history';

export type ContactPurgeReferenceKind =
  | ContactReferenceKind
  | 'contact-event'
  | 'commitment-feedback';

export interface ContactReferenceRecord {
  kind: ContactReferenceKind;
  id: string;
  sourcePath: string;
  contactId: string;
  data: Record<string, unknown>;
}

export interface ContactReferenceMigration {
  kind: ContactReferenceKind;
  sourcePath: string;
  targetPath: string;
  action: 'update' | 'copy';
  patch: Record<string, unknown>;
  preserveSource: boolean;
}

function collisionSafeId(
  id: string,
  fromContactId: string,
  reservedIds: Set<string>,
): string {
  if (!reservedIds.has(id)) {
    reservedIds.add(id);
    return id;
  }
  const suffix = normalizeIdentityText(fromContactId).replace(/\s/g, '').slice(0, 10);
  let candidate = `${id}--merged-${suffix || 'contact'}`;
  let sequence = 2;
  while (reservedIds.has(candidate)) {
    candidate = `${id}--merged-${suffix || 'contact'}-${sequence}`;
    sequence += 1;
  }
  reservedIds.add(candidate);
  return candidate;
}

export function planContactReferenceMigration(params: {
  uid: string;
  fromContactId: string;
  toContactId: string;
  toContactName: string;
  operationId: string;
  records: ContactReferenceRecord[];
  reservedFactIds?: Iterable<string>;
  reservedJobHistoryIds?: Iterable<string>;
}): ContactReferenceMigration[] {
  if (!params.uid || !params.fromContactId || !params.toContactId) {
    throw new Error('A user, source contact, and destination contact are required.');
  }
  if (params.fromContactId === params.toContactId) {
    throw new Error('A contact cannot be merged into itself.');
  }
  const factIds = new Set(params.reservedFactIds || []);
  const jobIds = new Set(params.reservedJobHistoryIds || []);
  const eligibleRecords = params.records.filter(
    (record) => record.contactId === params.fromContactId,
  );
  const factTargetIds = new Map<string, string>();
  const jobTargetIds = new Map<string, string>();
  for (const record of eligibleRecords) {
    if (record.kind === 'fact') {
      factTargetIds.set(
        record.id,
        collisionSafeId(record.id, params.fromContactId, factIds),
      );
    } else if (record.kind === 'job-history') {
      jobTargetIds.set(
        record.id,
        collisionSafeId(record.id, params.fromContactId, jobIds),
      );
    }
  }
  const migrations: ContactReferenceMigration[] = [];
  for (const record of eligibleRecords) {
    const provenance = {
      contactMergeOperationId: params.operationId,
      migratedFromContactId: params.fromContactId,
      migratedFromContactName:
        typeof record.data.contactName === 'string'
          ? record.data.contactName
          : null,
      migratedFromHadContactName: Object.prototype.hasOwnProperty.call(
        record.data,
        'contactName',
      ),
    };
    if (record.kind === 'fact' || record.kind === 'job-history') {
      const collectionName =
        record.kind === 'fact' ? 'facts' : 'jobHistory';
      const idMap =
        record.kind === 'fact' ? factTargetIds : jobTargetIds;
      const targetId = idMap.get(record.id) as string;
      const correctionOf =
        typeof record.data.correctionOf === 'string'
          ? idMap.get(record.data.correctionOf) ||
            record.data.correctionOf
          : null;
      const supersededBy =
        typeof record.data.supersededBy === 'string'
          ? idMap.get(record.data.supersededBy) ||
            record.data.supersededBy
          : null;
      const sourceId =
        record.kind === 'fact' &&
        record.data.sourceType === 'user-correction' &&
        typeof record.data.sourceId === 'string'
          ? factTargetIds.get(record.data.sourceId) ||
            record.data.sourceId
          : record.data.sourceId ?? null;
      migrations.push({
        kind: record.kind,
        sourcePath: record.sourcePath,
        targetPath: `users/${params.uid}/contacts/${params.toContactId}/${collectionName}/${targetId}`,
        action: 'copy',
        patch: {
          ...record.data,
          correctionOf,
          supersededBy,
          sourceId,
          ...provenance,
          migratedFromPath: record.sourcePath,
          originalHistoryLinks: {
            correctionOf: record.data.correctionOf ?? null,
            supersededBy: record.data.supersededBy ?? null,
            sourceId: record.data.sourceId ?? null,
          },
        },
        // A merge is recoverable for 30 days, so nested source history is
        // retained on the soft-deleted duplicate until permanent purge.
        preserveSource: true,
      });
      continue;
    }
    migrations.push({
      kind: record.kind,
      sourcePath: record.sourcePath,
      targetPath: record.sourcePath,
      action: 'update',
      patch: {
        contactId: params.toContactId,
        contactName: params.toContactName,
        ...provenance,
      },
      preserveSource: true,
    });
  }
  return migrations;
}

export interface PermanentPurgePlan {
  contactId: string;
  eligible: boolean;
  eligibleAt: Date | null;
  collectionPaths: string[];
  relatedCollections: ContactPurgeReferenceKind[];
  requiresServerExecution: true;
}

export function buildPermanentPurgePlan(
  uid: string,
  contact: Pick<ManagedContact, 'id' | 'lifecycleStatus' | 'purgeEligibleAt'>,
  at: Date,
): PermanentPurgePlan {
  const eligible = isContactPurgeEligible(contact, at);
  return {
    contactId: contact.id,
    eligible,
    eligibleAt: contact.purgeEligibleAt || null,
    collectionPaths: [
      `users/${uid}/contacts/${contact.id}/facts`,
      `users/${uid}/contacts/${contact.id}/jobHistory`,
      `users/${uid}/contacts/${contact.id}`,
    ],
    relatedCollections: [
      'note',
      'outreach',
      'commitment',
      'commitment-feedback',
      'thread',
      'voice-enrichment',
      'connection',
      'contact-event',
    ],
    // Recursive deletion belongs behind an authenticated server endpoint. A
    // browser should never attempt an unbounded delete with partial batches.
    requiresServerExecution: true,
  };
}

export interface ImmutableContactEvent {
  id: string;
  contactId: string;
  type:
    | 'profile-updated'
    | 'archived'
    | 'restored'
    | 'soft-deleted'
    | 'merge-started'
    | 'merge-completed'
    | 'purge-requested';
  actorUid: string;
  occurredAt: Date;
  sourceType: FactSourceType | 'contact-management';
  sourceId: string | null;
  payload: Record<string, unknown>;
}
