import type { CardConfig } from './card';

export type CardField =
  | 'name'
  | 'role'
  | 'company'
  | 'intro'
  | 'email'
  | 'portedUrl'
  | 'links';

export type CardValidationErrors = Partial<Record<CardField, string>>;

const UNSAFE_PUBLIC_CONTROL = /[\u0000-\u001F\u007F]/;

export function isSafeHttpsUrl(value: string): boolean {
  if (!value || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      Boolean(url.hostname) &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

export function validateCardConfig(config: CardConfig): CardValidationErrors {
  const errors: CardValidationErrors = {};
  const name = config.name.trim();
  const role = config.role.trim();
  const company = config.company.trim();
  const intro = config.intro.trim();
  const email = config.email?.trim() || '';
  const portedUrl = config.portedUrl?.trim() || '';

  if (!name) errors.name = 'Add the name visitors should save.';
  else if (name.length > 120) errors.name = 'Name must be 120 characters or fewer.';
  else if (UNSAFE_PUBLIC_CONTROL.test(config.name)) {
    errors.name = 'Name cannot contain control characters or line breaks.';
  }
  if (role.length > 160) errors.role = 'Role must be 160 characters or fewer.';
  else if (UNSAFE_PUBLIC_CONTROL.test(config.role)) {
    errors.role = 'Role cannot contain control characters or line breaks.';
  }
  if (company.length > 160) {
    errors.company = 'Company must be 160 characters or fewer.';
  } else if (UNSAFE_PUBLIC_CONTROL.test(config.company)) {
    errors.company = 'Company cannot contain control characters or line breaks.';
  }
  if (intro.length > 240) errors.intro = 'Intro must be 240 characters or fewer.';
  else if (UNSAFE_PUBLIC_CONTROL.test(config.intro)) {
    errors.intro = 'Intro cannot contain control characters or line breaks.';
  }
  if (email.length > 320) {
    errors.email = 'Email must be 320 characters or fewer.';
  } else if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'Enter a valid contact email.';
  }

  if (config.mode === 'ported' && !portedUrl) {
    errors.portedUrl = 'Add the HTTPS page this card should open.';
  } else if (portedUrl && !isSafeHttpsUrl(portedUrl)) {
    errors.portedUrl = 'Use a full HTTPS URL without embedded credentials.';
  }

  if (!Array.isArray(config.links) || config.links.length > 6) {
    errors.links = 'A card can include up to six links.';
  } else if (
    config.links.some(
      (link) =>
        !link ||
        !link.label?.trim() ||
        link.label.trim().length > 80 ||
        UNSAFE_PUBLIC_CONTROL.test(link.label) ||
        !isSafeHttpsUrl(link.url?.trim() || ''),
    )
  ) {
    errors.links =
      'Every link needs a label of 80 characters or fewer and a full HTTPS URL.';
  }

  return errors;
}

export function hasCardValidationErrors(
  errors: CardValidationErrors,
): boolean {
  return Object.keys(errors).length > 0;
}
