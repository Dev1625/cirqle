import assert from 'node:assert/strict';
import test from 'node:test';

import {
  escapeCSVCell,
  neutralizeSpreadsheetFormula,
  serializeCSV,
} from '../src/lib/csvExport';

test('CSV serializer escapes quotes, commas, and multiline text', () => {
  assert.equal(
    serializeCSV([
      ['Name', 'Notes'],
      ['Maya, Chen', 'She said "hello"\nNext line'],
    ]),
    '"Name","Notes"\r\n"Maya, Chen","She said ""hello""\nNext line"',
  );
});

test('CSV serializer neutralizes spreadsheet formula injection', () => {
  for (const value of [
    '=HYPERLINK("https://evil.test")',
    '+cmd|calc',
    '-2+3',
    '@SUM(A1:A2)',
    ' \t=1+1',
  ]) {
    assert.equal(neutralizeSpreadsheetFormula(value).startsWith("'"), true);
    assert.equal(escapeCSVCell(value).startsWith('"\'') , true);
  }
  assert.equal(neutralizeSpreadsheetFormula('ordinary text'), 'ordinary text');
});
