/**
 * Controlled production release for Firestore Security Rules.
 *
 * It deliberately refuses dirty/non-main releases and requires the production
 * project id to be typed as a confirmation. A successful deploy is followed
 * by an independent API read-back so console or target drift cannot hide.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ID = 'cirqle-9dd06';
const CONFIRMATION = `--confirm-production=${PROJECT_ID}`;
const PROTECTED_FILES = [
  '.firebaserc',
  '.gitignore',
  '.github/workflows/security-policy.yml',
  'firebase.json',
  'firebase.test.json',
  'firestore.rules',
  'package.json',
  'vercel.json',
  'scripts/release-firestore-rules.mjs',
  'tests/firestore-rules.test.mjs',
  'tests/security-config.test.mjs',
  'scripts/verify-deployed-firestore-rules.mjs',
];

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || '');
    process.exit(result.status || 1);
  }
  return result.stdout.trim();
}

if (!process.argv.includes(CONFIRMATION)) {
  console.error('Production confirmation is required.');
  console.error(
    `Run: npm run release:firestore-rules -- ${CONFIRMATION}`,
  );
  process.exit(1);
}

const branch = output('git', ['branch', '--show-current']);
if (branch !== 'main') {
  console.error(
    `Refusing to deploy production rules from "${branch || 'detached HEAD'}".`,
  );
  console.error('Merge the reviewed change to main first.');
  process.exit(1);
}

const dirty = output('git', [
  'status',
  '--porcelain',
  '--',
  ...PROTECTED_FILES,
]);
if (dirty) {
  console.error('Refusing to deploy uncommitted security policy files:');
  console.error(dirty);
  process.exit(1);
}

run('npx', [
  'firebase',
  'deploy',
  '--only',
  'firestore:rules',
  '--project',
  PROJECT_ID,
]);
run(process.execPath, ['scripts/verify-deployed-firestore-rules.mjs']);

console.log(
  `\nPASS: ${PROJECT_ID} rules deployed, read back, and verified.`,
);
