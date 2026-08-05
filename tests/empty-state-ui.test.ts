import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function expectInOrder(value: string, patterns: RegExp[]): void {
  let cursor = -1;
  patterns.forEach((pattern) => {
    const match = pattern.exec(value.slice(cursor + 1));
    assert.ok(match, `Expected ${pattern} after source offset ${cursor}.`);
    cursor += match.index + 1;
  });
}

test('shared empty state supports concise and guided variants with accessible naming', () => {
  const value = source('../src/components/ui/EmptyState.tsx');
  assert.match(value, /line\?: string/);
  assert.match(value, /title\?: string/);
  assert.match(value, /aria-labelledby=\{title \? headingId : undefined\}/);
  assert.match(value, /aria-describedby=\{descriptionId\}/);
  assert.match(value, /role=\{status \? 'status' : undefined\}/);
});

test('directory distinguishes loading, read failure, true empty, recovery-only, and filtered no-results', () => {
  const value = source('../src/pages/Directory.tsx');
  expectInOrder(value, [
    /!contactsLoaded \? \(/,
    /directoryLoadError \? \(/,
    /activeContacts\.length === 0 && contacts\.length === 0 \? \(/,
    /activeContacts\.length === 0 \? \(/,
    /filteredContacts\.length === 0 \? \(/,
  ]);
  assert.match(value, /Clear search and filters/);
  assert.match(value, /role="link"/);
  assert.match(value, /onKeyDown=\{\(event\)/);
});

test('tracker distinguishes unavailable, loading, true empty, filtered no-results, and caught-up queue', () => {
  const value = source('../src/pages/Tracker.tsx');
  expectInOrder(value, [
    /trackerLoadError \? \(/,
    /!trackerLoaded \? \(/,
    /outreaches\.length === 0 \? \(/,
    /displayData\.length === 0 \? \(/,
  ]);
  assert.match(value, /title="You’re caught up\."/);
  assert.match(
    value,
    /disabled=\{!trackerLoaded \|\| Boolean\(trackerLoadError\) \|\| displayData\.length === 0\}/,
  );
});

test('dashboard does not report zero queue metrics before its records load', () => {
  const value = source('../src/pages/Dashboard.tsx');
  assert.match(
    value,
    /label="Items" value=\{dashboardLoaded \? queueItems\.length : '—'\}/,
  );
  assert.match(value, /title="Build the network your queue will protect\."/);
  assert.match(value, /title="You’re caught up\."/);
  assert.match(value, /role="alert"/);
});
