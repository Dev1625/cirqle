import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  filterPaletteCommands,
  moveActiveIndex,
  moveTabIndex,
  type PaletteCommand,
} from '../src/lib/commandPalette';

const commands: PaletteCommand[] = [
  {
    id: 'new-contact',
    label: 'Create a contact',
    description: 'Open a blank contact record',
    category: 'Action',
    keywords: ['add', 'person'],
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Manage profile and security',
    category: 'Navigate',
  },
];

function relativeLuminance(hex: string): number {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4,
    );
  return (
    0.2126 * channels[0] +
    0.7152 * channels[1] +
    0.0722 * channels[2]
  );
}

function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const dark = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (light + 0.05) / (dark + 0.05);
}

test('command search matches labels, descriptions, categories, and keywords', () => {
  assert.deepEqual(
    filterPaletteCommands(commands, 'add person').map(({ id }) => id),
    ['new-contact'],
  );
  assert.deepEqual(
    filterPaletteCommands(commands, 'profile').map(({ id }) => id),
    ['settings'],
  );
  assert.deepEqual(
    filterPaletteCommands(commands, 'navigate').map(({ id }) => id),
    ['settings'],
  );
});

test('command search requires every typed term and preserves default order', () => {
  assert.deepEqual(
    filterPaletteCommands(commands, '').map(({ id }) => id),
    ['new-contact', 'settings'],
  );
  assert.deepEqual(filterPaletteCommands(commands, 'create security'), []);
});

test('palette arrows wrap and handle an empty list', () => {
  assert.equal(moveActiveIndex(0, -1, 2), 1);
  assert.equal(moveActiveIndex(1, 1, 2), 0);
  assert.equal(moveActiveIndex(0, 1, 0), -1);
});

test('tab navigation supports arrows, Home, and End', () => {
  assert.equal(moveTabIndex(0, 'ArrowLeft', 3), 2);
  assert.equal(moveTabIndex(2, 'ArrowRight', 3), 0);
  assert.equal(moveTabIndex(1, 'Home', 3), 0);
  assert.equal(moveTabIndex(1, 'End', 3), 2);
  assert.equal(moveTabIndex(1, 'Enter', 3), 1);
});

test('shared dialog keeps the required modal and focus-management contract', () => {
  const source = readFileSync(
    new URL('../src/components/ui/Dialog.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /previouslyFocused/);
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /event\.key === 'Escape'/);
});

test('reduced motion removes authored movement without a global timing kill', () => {
  const css = readFileSync(
    new URL('../src/index.css', import.meta.url),
    'utf8',
  );
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.marquee-track/);
  assert.doesNotMatch(
    css,
    /\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation-duration:\s*0\.00/m,
  );
});

test('app shell exposes skip navigation and the command menu shortcut', () => {
  const source = readFileSync(
    new URL('../src/layouts/AppLayout.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /href="#main-content"/);
  assert.match(source, /id="main-content"/);
  assert.match(source, /openCommandPalette/);
  assert.match(source, /Ctrl K/);
});

test('core readable and focus colors retain WCAG AA contrast', () => {
  assert.ok(contrastRatio('#5C5850', '#FFFFFF') >= 4.5);
  assert.ok(contrastRatio('#5C5850', '#F5F0E8') >= 4.5);
  assert.ok(contrastRatio('#414141', '#FFFFFF') >= 4.5);
  assert.ok(contrastRatio('#F5F0E8', '#7A2331') >= 4.5);
  assert.ok(contrastRatio('#7A2331', '#F5F0E8') >= 4.5);
});
