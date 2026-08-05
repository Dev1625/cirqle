import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { readPositiveKilobyteBudget } from './bundle-budget-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const manifestPath = path.join(dist, '.vite', 'manifest.json');

if (!fs.existsSync(manifestPath)) {
  console.error('Bundle manifest is missing. Run the production build first.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const entries = Object.values(manifest);
const byFile = new Map(entries.map((entry) => [entry.file, entry]));
const initialFiles = new Set();

function visit(file) {
  if (!file || initialFiles.has(file)) return;
  initialFiles.add(file);
  const entry = byFile.get(file);
  for (const imported of entry?.imports || []) {
    const importedEntry = manifest[imported];
    if (importedEntry) visit(importedEntry.file);
  }
  for (const css of entry?.css || []) initialFiles.add(css);
}

for (const entry of entries.filter((candidate) => candidate.isEntry)) {
  visit(entry.file);
}

function size(file) {
  const bytes = fs.readFileSync(path.join(dist, file));
  return { raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength };
}

const assets = [
  ...new Set(
    entries.flatMap((entry) => [
      entry.file,
      ...(entry.css || []),
      ...(entry.assets || []),
    ]),
  ),
]
  .filter((file) => fs.existsSync(path.join(dist, file)))
  .map((file) => ({ file, ...size(file) }));

const kb = (bytes) => (bytes / 1024).toFixed(1);
const initial = assets.filter((asset) => initialFiles.has(asset.file));
const initialGzip = initial.reduce((total, asset) => total + asset.gzip, 0);
let initialBudget;
let routeChunkBudget;
let pdfWorkerBudget;
try {
  initialBudget = readPositiveKilobyteBudget(
    process.env,
    'CIRQLE_INITIAL_GZIP_KB',
    320,
  );
  routeChunkBudget = readPositiveKilobyteBudget(
    process.env,
    'CIRQLE_ROUTE_CHUNK_GZIP_KB',
    315,
  );
  pdfWorkerBudget = readPositiveKilobyteBudget(
    process.env,
    'CIRQLE_PDF_WORKER_GZIP_KB',
    750,
  );
} catch (error) {
  console.error(`Bundle budget configuration error: ${error.message}`);
  process.exit(1);
}

const failures = [];
if (initialGzip > initialBudget) {
  failures.push(
    `Initial route is ${kb(initialGzip)} kB gzip; budget is ${kb(initialBudget)} kB.`,
  );
}

for (const asset of assets.filter((item) => item.file.endsWith('.js'))) {
  const isPdfWorker = /pdf\.worker/i.test(asset.file);
  const limit = isPdfWorker ? pdfWorkerBudget : routeChunkBudget;
  if (asset.gzip > limit) {
    failures.push(
      `${asset.file} is ${kb(asset.gzip)} kB gzip; budget is ${kb(limit)} kB.`,
    );
  }
}

console.log(
  `Initial route: ${kb(initialGzip)} kB gzip across ${initial.length} assets`,
);
for (const asset of assets
  .filter((item) => item.file.endsWith('.js'))
  .sort((a, b) => b.gzip - a.gzip)
  .slice(0, 8)) {
  console.log(
    `  ${asset.file}: ${kb(asset.raw)} kB raw / ${kb(asset.gzip)} kB gzip`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`BUDGET  ${failure}`);
  process.exit(1);
}

console.log('Bundle budgets passed.');
