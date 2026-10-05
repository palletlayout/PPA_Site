import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { neutralizeSpreadsheetFormula, serializeCsvCell } from "../lib/csv.ts";

test("neutralizes spreadsheet formulas, including prefixes hidden by whitespace", () => {
  for (const value of [
    "=1+1",
    "+SUM(A1:A2)",
    "-2+3",
    "@SUM(A1:A2)",
    "  =HYPERLINK(\"https://example.test\")",
    "\t@malicious",
    "\uFEFF+cmd",
  ]) {
    assert.equal(neutralizeSpreadsheetFormula(value), `'${value}`);
  }
});

test("leaves ordinary values alone and applies standard CSV escaping", () => {
  assert.equal(neutralizeSpreadsheetFormula("P-1971064A"), "P-1971064A");
  assert.equal(neutralizeSpreadsheetFormula("'=-already-text"), "'=-already-text");
  assert.equal(serializeCsvCell(null), "");
  assert.equal(serializeCsvCell(30), "30");
  assert.equal(serializeCsvCell("plain text"), "plain text");
  assert.equal(serializeCsvCell('value, with "quotes"'), '"value, with ""quotes"""');
  assert.equal(serializeCsvCell("=SUM(1,2)"), '"\'=SUM(1,2)"');
  assert.equal(serializeCsvCell("\r=1+1"), '"\'\r=1+1"');
});

test("scanned-demand export uses the guarded CSV cell serializer", async () => {
  const route = await readFile(new URL("../app/api/scans/export/route.ts", import.meta.url), "utf8");
  assert.match(route, /import \{ serializeCsvCell \} from "@\/lib\/csv"/);
  assert.match(route, /EXPORT_COLUMNS\.map\(\(\[, label\]\) => serializeCsvCell\(label\)\)/);
  assert.match(route, /serializeCsvCell\(row\[key\]\)/);
  assert.doesNotMatch(route, /function csvValue/);
});
