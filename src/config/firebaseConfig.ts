export interface CirqleFirebaseConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  measurementId?: string;
}

export type DeploymentEnvironment =
  | 'production'
  | 'preview'
  | 'development'
  | 'local';

function parseOverride(value: string | undefined): unknown {
  if (!value?.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('The Firebase deployment configuration is invalid.');
  }
}

function validateConfig(value: unknown): CirqleFirebaseConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The Firebase deployment configuration is missing.');
  }
  const config = value as Record<string, unknown>;
  for (const key of ['projectId', 'appId', 'apiKey', 'authDomain']) {
    if (
      typeof config[key] !== 'string' ||
      !String(config[key]).trim() ||
      String(config[key]).length > 500
    ) {
      throw new Error('The Firebase deployment configuration is invalid.');
    }
  }
  if (
    !/^[a-z0-9][a-z0-9-]{3,40}$/.test(String(config.projectId)) ||
    !String(config.authDomain).endsWith('.firebaseapp.com')
  ) {
    throw new Error('The Firebase deployment configuration is invalid.');
  }
  return { ...config } as unknown as CirqleFirebaseConfig;
}

/**
 * Preview deployments must opt into a non-production Firebase project. This
 * prevents a Vercel branch build from silently reading or writing real users.
 */
export function resolveFirebaseConfig(input: {
  deploymentEnvironment: string | undefined;
  overrideJSON: string | undefined;
  checkedInProductionConfig: CirqleFirebaseConfig;
}): CirqleFirebaseConfig {
  const production = validateConfig(input.checkedInProductionConfig);
  const environment =
    input.deploymentEnvironment === 'production' ||
    input.deploymentEnvironment === 'preview' ||
    input.deploymentEnvironment === 'development'
      ? input.deploymentEnvironment
      : 'local';
  const overrideValue = parseOverride(input.overrideJSON);
  const selected = overrideValue ? validateConfig(overrideValue) : production;

  if (environment === 'preview') {
    if (!overrideValue || selected.projectId === production.projectId) {
      throw new Error(
        'Preview is isolated: configure a non-production Firebase project before using this deployment.',
      );
    }
  }
  if (
    environment === 'production' &&
    selected.projectId !== production.projectId
  ) {
    throw new Error(
      'The production deployment must use the reviewed production Firebase project.',
    );
  }
  return selected;
}
