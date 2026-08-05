import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveFirebaseConfig,
  type CirqleFirebaseConfig,
} from '../src/config/firebaseConfig';

const production: CirqleFirebaseConfig = {
  projectId: 'cirqle-9dd06',
  appId: '1:123:web:abc',
  apiKey: 'public-firebase-web-api-key',
  authDomain: 'cirqle-9dd06.firebaseapp.com',
};
const staging: CirqleFirebaseConfig = {
  projectId: 'cirqle-staging-1234',
  appId: '1:456:web:def',
  apiKey: 'public-staging-firebase-web-api-key',
  authDomain: 'cirqle-staging-1234.firebaseapp.com',
};

test('Vercel previews fail closed without an explicit isolated Firebase project', () => {
  assert.throws(
    () =>
      resolveFirebaseConfig({
        deploymentEnvironment: 'preview',
        overrideJSON: undefined,
        checkedInProductionConfig: production,
      }),
    /Preview is isolated/,
  );
  assert.throws(
    () =>
      resolveFirebaseConfig({
        deploymentEnvironment: 'preview',
        overrideJSON: JSON.stringify(production),
        checkedInProductionConfig: production,
      }),
    /Preview is isolated/,
  );
});

test('Vercel previews accept a valid non-production Firebase project', () => {
  assert.equal(
    resolveFirebaseConfig({
      deploymentEnvironment: 'preview',
      overrideJSON: JSON.stringify(staging),
      checkedInProductionConfig: production,
    }).projectId,
    staging.projectId,
  );
});

test('production refuses a staging override and local development stays compatible', () => {
  assert.throws(
    () =>
      resolveFirebaseConfig({
        deploymentEnvironment: 'production',
        overrideJSON: JSON.stringify(staging),
        checkedInProductionConfig: production,
      }),
    /production deployment/,
  );
  assert.equal(
    resolveFirebaseConfig({
      deploymentEnvironment: 'local',
      overrideJSON: undefined,
      checkedInProductionConfig: production,
    }).projectId,
    production.projectId,
  );
});
