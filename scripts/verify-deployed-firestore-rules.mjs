/**
 * Compare the active production Firestore release with firestore.rules.
 *
 * Authentication follows the Firebase CLI: a local `firebase login` session
 * works for developers, while CI uses Application Default Credentials.
 * Output intentionally includes hashes and resource names only, never source
 * content or credentials.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const firebaseAuth = require('firebase-tools/lib/auth');
const { requireAuth } = require('firebase-tools/lib/requireAuth');
const firebaseApi = require('firebase-tools/lib/apiv2');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ID = 'cirqle-9dd06';
const RELEASE_NAME = 'cloud.firestore';
const LOCAL_RULES_FILE = 'firestore.rules';
const API_ROOT = 'https://firebaserules.googleapis.com/v1';

function canonicalize(content) {
  return content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n*$/, '\n');
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function authenticatedToken() {
  const account = firebaseAuth.getProjectDefaultAccount(ROOT)
    || firebaseAuth.getGlobalDefaultAccount();
  const options = {
    project: PROJECT_ID,
    projectRoot: ROOT,
    ...(account || {}),
  };
  await requireAuth(options);
  return firebaseApi.getAccessToken();
}

async function getJson(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      `Firebase Rules API returned HTTP ${response.status} for ${url}.`,
    );
  }
  return response.json();
}

try {
  const local = canonicalize(
    fs.readFileSync(path.join(ROOT, LOCAL_RULES_FILE), 'utf8'),
  );
  const token = await authenticatedToken();
  const release = await getJson(
    `${API_ROOT}/projects/${PROJECT_ID}/releases/${RELEASE_NAME}`,
    token,
  );

  const expectedPrefix = `projects/${PROJECT_ID}/rulesets/`;
  if (!release.rulesetName?.startsWith(expectedPrefix)) {
    throw new Error(
      `Active release references an unexpected ruleset: ${release.rulesetName}`,
    );
  }

  const ruleset = await getJson(
    `${API_ROOT}/${release.rulesetName}`,
    token,
  );
  const deployedFile = ruleset.source?.files?.find(
    ({ name }) => name === LOCAL_RULES_FILE,
  );
  if (!deployedFile || typeof deployedFile.content !== 'string') {
    throw new Error(
      `Active ruleset does not contain ${LOCAL_RULES_FILE}.`,
    );
  }

  const deployed = canonicalize(deployedFile.content);
  const localHash = digest(local);
  const deployedHash = digest(deployed);

  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Release: ${release.name}`);
  console.log(`Ruleset: ${release.rulesetName}`);
  console.log(`Local SHA-256:    ${localHash}`);
  console.log(`Deployed SHA-256: ${deployedHash}`);

  if (localHash !== deployedHash) {
    console.error(
      '\nDRIFT DETECTED: production Firestore rules differ from the repository.',
    );
    console.error(
      'Do not edit the Rules console. Review, commit, and run the controlled rules release.',
    );
    process.exit(1);
  }

  console.log('\nPASS: deployed Firestore rules match firestore.rules exactly.');
} catch (error) {
  console.error(`\nRules drift verification failed: ${error.message}`);
  process.exit(1);
}
