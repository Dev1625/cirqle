const FORMULA_PREFIX = /^[\t\r ]*[=+\-@]/;

/**
 * Spreadsheet applications may execute cells beginning with formula markers.
 * Prefixing an apostrophe keeps exported CRM text literal when a CSV is
 * opened in Excel, Sheets, Numbers, or another formula-aware application.
 */
export function neutralizeSpreadsheetFormula(value: unknown): string {
  const text = value == null ? '' : String(value);
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

export function escapeCSVCell(value: unknown): string {
  const safe = neutralizeSpreadsheetFormula(value)
    .replace(/\r\n?/g, '\n')
    .replace(/"/g, '""');
  return `"${safe}"`;
}

export function serializeCSV(rows: unknown[][]): string {
  return rows
    .map((row) => row.map(escapeCSVCell).join(','))
    .join('\r\n');
}
