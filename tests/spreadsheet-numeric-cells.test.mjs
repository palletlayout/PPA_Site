import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as XLSX from "xlsx";
import { parseInventorySpreadsheet } from "../lib/inventory-import.ts";
import { parseDemandSpreadsheet, parseSpreadsheetRecords } from "../lib/spreadsheet-import.ts";

/** Build a workbook whose first data row holds `cells`: [header, value, optional number format]. */
function workbookFrom(rows) {
  const header = rows[0].map(([name]) => name);
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows.map((cells) => cells.map(([, value]) => value))]);
  rows.forEach((cells, rowIndex) => cells.forEach(([, , format], column) => {
    if (format) sheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: column })].z = format;
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Demand");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}

async function readOne(cells) {
  const [record] = await parseSpreadsheetRecords(workbookFrom([cells]));
  return record;
}

test("long numeric identifiers import digit for digit, not as Excel's shortened display text", async () => {
  const record = await readOne([
    ["eleven", 12345678901], ["twelve", 123456789012], ["thirteen", 1234567890123],
    ["lineId", 20260926000123], ["fifteen", 123456789012345],
  ]);
  assert.equal(record.eleven, "12345678901");
  assert.equal(record.twelve, "123456789012");
  assert.equal(record.thirteen, "1234567890123");
  assert.equal(record.lineId, "20260926000123");
  assert.equal(record.fifteen, "123456789012345");
});

test("neighbouring numeric identifiers stay distinct", async () => {
  const [first, second] = await parseSpreadsheetRecords(workbookFrom([
    [["part", 1234567890123]], [["part", 1234567890124]],
  ]));
  assert.equal(first.part, "1234567890123");
  assert.equal(second.part, "1234567890124");
});

test("numeric quantities keep every stored decimal and do not pick up display rounding", async () => {
  const record = await readOne([
    ["precise", 1234567.123456], ["smallest", 0.000001], ["hidden", 2.5, "0"],
    ["noise", 0.1 + 0.2], ["negative", -12.5], ["zero", 0],
  ]);
  assert.equal(record.precise, "1234567.123456");
  assert.equal(record.smallest, "0.000001");
  assert.equal(record.hidden, "2.5", "a whole-number display format must not round the stored value");
  assert.equal(record.noise, "0.3");
  assert.equal(record.negative, "-12.5");
  assert.equal(record.zero, "0");
});

test("tiny values are spelled without exponent notation", async () => {
  const record = await readOne([["tiny", 0.0000001]]);
  assert.equal(record.tiny, "0.0000001");
});

test("scientific notation and rounded displays are replaced by the stored value", async () => {
  const record = await readOne([["scientific", 1234, "0.00E+00"], ["percent", 0.5, "0%"]]);
  assert.equal(record.scientific, "1234");
  assert.equal(record.percent, "0.5");
});

test("displays that do not lose the stored value keep their displayed text, exactly as before", async () => {
  const record = await readOne([
    ["padded", 12345, "0000000"], ["twoDecimals", 2.5, "0.00"],
    ["prefixed", 123, '"PL-"0000'], ["zip", 123456789, "00000-0000"],
    ["thousands", 1500, "#,##0"], ["currency", 1234.5, "$#,##0.00"], ["unit", 3.5, '0.0" KG"'],
    ["parentheses", -12.5, "0.0;(0.0)"],
  ]);
  assert.equal(record.padded, "0012345", "custom formats that pad identifiers are preserved");
  assert.equal(record.twoDecimals, "2.50");
  assert.equal(record.prefixed, "PL-0123", "a prefix a user sees in Excel is the identifier a barcode carries");
  assert.equal(record.zip, "12345-6789");
  assert.equal(record.thousands, "1,500");
  assert.equal(record.currency, "$1,234.50");
  assert.equal(record.unit, "3.5 KG");
  assert.equal(record.parentheses, "(12.5)");
});

test("date and time cells keep the text Excel displays", async () => {
  const record = await readOne([
    ["short", 46291, "m/d/yy"], ["iso", 46291, "yyyy-mm-dd"], ["time", 0.5, "h:mm"],
  ]);
  assert.equal(record.short, "9/26/26");
  assert.equal(record.iso, "2026-09-26");
  assert.equal(record.time, "12:00");
});

test("text cells are never reinterpreted, whatever they look like", async () => {
  const record = await readOne([
    ["leadingZeros", "0012345"], ["long", "1234567890123456789"], ["exponent", "1.23457E+12"],
  ]);
  assert.equal(record.leadingZeros, "0012345");
  assert.equal(record.long, "1234567890123456789");
  assert.equal(record.exponent, "1.23457E+12");
});

test("numbers beyond Excel's 15 digits are rejected because they may already be altered", async () => {
  await assert.rejects(readOne([["id", 1234567890123456]]), /Cell A2 holds 1234567890123456.*more than 15 digits.*Store long identifiers as text/);
  await assert.rejects(readOne([["id", 1234567890123456.5]]), /more than 15 digits/);
});

test("the 15-digit limit cannot be bypassed by a format that displays every digit", async () => {
  for (const format of ["0", "0000000000000000", "General"]) {
    await assert.rejects(readOne([["id", 1234567890123456, format]]), /more than 15 digits/, format);
  }
});

test("dates in regional Excel formats keep their displayed text, including the first such cell", async () => {
  // Format id 27 is a regional date format unknown to SheetJS's format table. Its first
  // cell arrives without a format string, and must not be read as the serial number 46291.
  const bytes = await readFile(new URL("./fixtures/regional-date-format-27.xlsx", import.meta.url));
  const [record] = await parseSpreadsheetRecords(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.deepEqual({ ...record }, { d1: "9/26/26", d2: "9/27/26", n: "5" });
});

test("CSV values, which arrive as text, are unchanged", async () => {
  const csv = new TextEncoder().encode('id,qty,note\n0012345,1234567890123,"1,500"\n');
  const [record] = await parseSpreadsheetRecords(csv.buffer);
  assert.deepEqual({ ...record }, { id: "0012345", qty: "1234567890123", note: "1,500" });
});

const demandColumns = (overrides = {}) => ({
  "PR OGPLCD": "01", "R DVZONE": "R", Area: "Onsite", "Ship Category": "Production",
  "Train #": "TE309771", Picklist: "Z101AHTE31014603", "Cart #": "1", "Cart ID": "SH059R21",
  "PI CNTPSQ": "001", "PI MBPN": "46674-30B-A000-", "PI QTY": "30", "Total Carts": "1",
  "Checksheet Number": "Z101AHTE31014603", "Movement Barcode": "AE1TE309771X5AA",
  "Container Total": "1", "Part Color": "NE900L", ...overrides,
});

function demandWorkbook(rows, formats = {}) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const headers = Object.keys(rows[0]);
  rows.forEach((row, rowIndex) => headers.forEach((header, column) => {
    if (formats[header]) sheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: column })].z = formats[header];
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Demand");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}

test("demand import keeps numeric part numbers distinct and exact", async () => {
  const rows = await parseDemandSpreadsheet(demandWorkbook([
    demandColumns({ "PI MBPN": 1234567890123, "PI CNTPSQ": "001" }),
    demandColumns({ "PI MBPN": 1234567890124, "PI CNTPSQ": "002" }),
  ]));
  assert.deepEqual(rows.map((row) => row.partNumber), ["1234567890123", "1234567890124"]);
});

test("demand import keeps a numeric Source Line ID exact", async () => {
  const rows = await parseDemandSpreadsheet(demandWorkbook([
    demandColumns({ "Source Line ID": 20260926000123 }),
    demandColumns({ "Source Line ID": 20260926000124, "PI CNTPSQ": "002" }),
  ]));
  assert.deepEqual(rows.map((row) => row.sourceLineId), ["20260926000123", "20260926000124"]);
});

test("demand import keeps a measured quantity's stored decimals", async () => {
  const [row] = await parseDemandSpreadsheet(demandWorkbook([
    demandColumns({ "PI QTY": 12345.678901, "Unit of Measure": "KG" }),
  ]));
  assert.equal(row.quantity, 12345.678901);
  assert.equal(row.unitOfMeasure, "KG");
});

test("demand import rejects a fractional quantity hidden by a whole-number display format", async () => {
  // Before this fix a stored 2.5 formatted as "0" was silently imported as 3 pieces.
  await assert.rejects(parseDemandSpreadsheet(demandWorkbook([demandColumns({ "PI QTY": 2.5 })], { "PI QTY": "0" })));
});

test("inventory import keeps numeric serials, suppliers and parts exact", async () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Serial Number", "Part Number", "Quantity", "Supplier ID"],
    [1234567890123, 1234567890125, 30, 9876543210987],
    [1234567890124, 1234567890125, 30, 9876543210987],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Inventory");
  const rows = await parseInventorySpreadsheet(XLSX.write(workbook, { type: "array", bookType: "xlsx" }), "inventory.xlsx");
  assert.deepEqual(rows.map((row) => row.aiagSerial), ["1234567890123", "1234567890124"]);
  assert.deepEqual(rows.map((row) => row.partNumber), ["1234567890125", "1234567890125"]);
  assert.deepEqual(rows.map((row) => row.supplierId), ["9876543210987", "9876543210987"]);
});
