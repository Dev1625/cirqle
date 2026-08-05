import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED_ADVISORY =
  'https://github.com/advisories/GHSA-qwww-vcr4-c8h2';
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const RSC_IMPORT =
  /(?:from\s+|import\s*\()\s*['"](?:react-router\/(?:rsc|dom)|@react-router\/(?:dev|node|serve))|unstable_(?:RSC|Server)|RSCHydratedRouter|RSCStaticRouter/;

function npmAudit() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error(
      'Run this audit gate through `npm run audit:runtime`.',
    );
  }
  try {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [npmCli, 'audit', '--omit=dev', '--json'],
        {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
  } catch (error) {
    if (typeof error.stdout !== 'string') throw error;
    return JSON.parse(error.stdout);
  }
}

function walkSources(directory, files = []) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walkSources(path, files);
    } else if (SOURCE_EXTENSIONS.has(extname(path))) {
      files.push(path);
    }
  }
  return files;
}

function assertNoRSCMode() {
  const packageJson = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8'),
  );
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  for (const packageName of [
    '@react-router/dev',
    '@react-router/node',
    '@react-router/serve',
  ]) {
    if (dependencies[packageName]) {
      throw new Error(
        `Scoped React Router exception is invalid: ${packageName} enables server/RSC mode.`,
      );
    }
  }

  const configText = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
  if (/react-router|react-server|rsc/i.test(configText)) {
    throw new Error(
      'Scoped React Router exception is invalid: build configuration references server/RSC mode.',
    );
  }

  for (const file of walkSources(join(ROOT, 'src'))) {
    if (RSC_IMPORT.test(readFileSync(file, 'utf8'))) {
      throw new Error(
        `Scoped React Router exception is invalid: RSC API found in ${relative(ROOT, file)}.`,
      );
    }
  }
}

function getAdvisoryUrls(entry, vulnerabilities, visited = new Set()) {
  const urls = new Set();
  for (const via of entry.via || []) {
    if (typeof via === 'string') {
      if (visited.has(via)) continue;
      visited.add(via);
      for (const nested of getAdvisoryUrls(
        vulnerabilities[via] || { via: [] },
        vulnerabilities,
        visited,
      )) {
        urls.add(nested);
      }
    } else if (typeof via?.url === 'string') {
      urls.add(via.url);
    }
  }
  return urls;
}

const audit = npmAudit();
const vulnerabilities = audit.vulnerabilities || {};
const unexpected = [];

for (const [name, entry] of Object.entries(vulnerabilities)) {
  const urls = getAdvisoryUrls(entry, vulnerabilities);
  if (
    !['react-router', 'react-router-dom'].includes(name) ||
    urls.size !== 1 ||
    !urls.has(ALLOWED_ADVISORY)
  ) {
    unexpected.push(name);
  }
}

if (unexpected.length) {
  throw new Error(
    `Unexpected production dependency vulnerabilities: ${unexpected.join(', ')}`,
  );
}

if (Object.keys(vulnerabilities).length) {
  assertNoRSCMode();
  console.log(
    'Runtime audit gate passed with one scoped React Router RSC-only advisory; this Vite BrowserRouter app does not enable RSC APIs.',
  );
} else {
  console.log('Runtime dependency audit is clean.');
}
