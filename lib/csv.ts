const SPREADSHEET_FORMULA_PREFIX = /^[\s\u0000-\u001F\u007F-\u009F]*[=+\-@]/u;

/**
 * Keeps spreadsheet applications from interpreting exported data as a formula.
 * The apostrophe is the conventional spreadsheet text marker and is added before
 * any leading whitespace so a hidden formula prefix cannot bypass the guard.
 */
export function neutralizeSpreadsheetFormula(value: string) {
  return SPREADSHEET_FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

/** Serializes one value as a comma-delimited CSV cell. */
export function serializeCsvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  const safeText = neutralizeSpreadsheetFormula(text);
  return /[",\r\n]/.test(safeText) ? `"${safeText.replace(/"/g, '""')}"` : safeText;
}
