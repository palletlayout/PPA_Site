import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { parseInventorySpreadsheet, validateInventoryRows } from "../lib/inventory-import.ts";
import { parseDemandSpreadsheet } from "../lib/spreadsheet-import.ts";

const bytes = (value) => new TextEncoder().encode(value).buffer;
const parse = (csv) => parseInventorySpreadsheet(bytes(csv), "inventory.csv");
const row = { aiagSerial: "000123", partNumber: "P123", color: "", quantity: 30, unitOfMeasure: "EA", supplierId: "", receiptKind: "received" };

test("inventory preserves plain identifiers and accepts blank or absent color", async () => {
  assert.deepEqual(await parse("Serial Number,Part Number,Quantity\n000123,P123,30"), [row]);
  assert.deepEqual(await parse("Serial Number,Part Number,Color,Quantity\n000123,P123,,30"), [row]);
  assert.equal((await parse("Serial Number,Part Number,Quantity\n1S123,P123,30"))[0].aiagSerial, "1S123");
});

test("source inventory contract reads container quantities and ignores unused source metadata", async () => {
  const [imported] = await parse("Container Unique Serial Number,Part Number,Part Color,Container Quantity,Plant Code,Supplier Number,ASN Number,ASN Part Quantity,Unit of Measurement,Weight,Container consumed status,Consumed quantity\n000123,P123,GRAY,30,PLANT,SUP-IGNORED,ASN-1,999,IGNORED,25 pounds,not consumed,0");
  assert.equal(imported.aiagSerial, "000123");
  assert.equal(imported.partNumber, "P123");
  assert.equal(imported.color, "GRAY");
  assert.equal(imported.quantity, 30);
  assert.equal(imported.supplierId, "");
  assert.equal(imported.unitOfMeasure, "EA");
  assert.equal(imported.weight, undefined);
  for (const status of ["Consumed", "partially consumed"]) {
    await assert.rejects(parse(`Container Unique Serial Number,Part Number,Container Quantity,Container consumed status\nS1,P123,30,${status}`), /marked consumed/);
  }
});

test("explicit barcode columns strip one field prefix and preserve identifier zeroes", async () => {
  assert.deepEqual(await parse("Serial Barcode,Part Barcode,Color Barcode,Quantity Barcode\n1S000123,PP123,2P,Q030"), [row]);
  await assert.rejects(parse("Serial Barcode,Part Number,Quantity\nP000123,P123,30"), /expected barcode prefix/);
});

test("inventory prevents duplicate serials even when their case differs", async () => {
  await assert.rejects(parse("Serial Number,Part Number,Quantity\nAbc,P123,30\nABC,P123,30"), /repeats Serial Number/);
  assert.throws(() => validateInventoryRows([row, row]), /repeats Serial Number/);
});

test("supplier identity scopes duplicate serials and measured units survive imports", async () => {
  const rows = await parse("Serial Number,Part Number,Quantity,UOM,Supplier ID\nSAME,PART,0.125,KG,SUP-1\nSAME,PART,0.125,KG,SUP-2");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].unitOfMeasure, "KG");
  assert.equal(rows[0].quantity, 0.125);
  assert.equal(rows[1].supplierId, "SUP-2");
  assert.throws(() => validateInventoryRows([rows[0], { ...rows[0], supplierId: "sup-1" }]), /same supplier/);
});

test("optional pallet identifiers accept inventory aliases and preserve text exactly", async () => {
  for (const header of ["Pallet ID", "Pallet Number", "Pallet No.", "Pallet Identifier", "Pallet"]) {
    const [imported] = await parse(`Serial Number,Part Number,Quantity,${header}\n000123,P123,30,000AbC`);
    assert.equal(imported.palletId, "000AbC", header);
  }
  assert.deepEqual(await parse("Serial Number,Part Number,Quantity,Pallet ID\n000123,P123,30,"), [row]);
  assert.equal(validateInventoryRows([{ ...row, palletId: "  000AbC  " }])[0].palletId, "000AbC");
  assert.throws(() => validateInventoryRows([{ ...row, palletId: "X".repeat(181) }]), /Pallet ID exceeds/);
  assert.throws(() => validateInventoryRows([{ ...row, palletId: "PAL\u0000LET" }]), /control characters/);
  assert.throws(() => validateInventoryRows([{ ...row, palletId: 9_007_199_254_740_992 }]), /safe precision/);
  await assert.rejects(parse("Serial Number,Part Number,Quantity,Pallet ID,Pallet Number\n000123,P123,30,PAL-1,PAL-2"), /conflicting columns for palletId/);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ "Serial Number": "000123", "Part Number": "P123", Quantity: 30, "Pallet ID": "000AbC" }]), "Inventory");
  const [excelRow] = await parseInventorySpreadsheet(XLSX.write(workbook, { type: "array", bookType: "xlsx" }), "inventory.xlsx");
  assert.equal(excelRow.palletId, "000AbC");
});

test("ASN flags preserve expected stock separately from confirmed receipts", async () => {
  const rows = await parse("Serial Number,Part Number,Quantity,ASN Flag\nS1,PART,2,Y\nS2,PART,2,N");
  assert.deepEqual(rows.map((item) => item.receiptKind), ["expected", "received"]);
  assert.equal((await parse("Serial Number,Part Number,Quantity,Receipt Kind\nS1,PART,2,expected"))[0].receiptKind, "expected");
  await assert.rejects(parse("Serial Number,Part Number,Quantity,ASN Flag,Receipt Kind\nS1,PART,2,Y,received"), /conflicts with ASN Flag/);
  await assert.rejects(parse("Serial Number,Part Number,Quantity,ASN Flag\nS1,PART,2,MAYBE"), /ASN Flag must/);
});

test("inventory validates quantities, metadata, precision and controls", () => {
  for (const quantity of [0, -1, "1.5", "1e3", "1,2", "2147483648", true]) {
    assert.throws(() => validateInventoryRows([{ ...row, quantity }]), /positive whole-number|must be text/);
  }
  assert.throws(() => validateInventoryRows([{ ...row, aiagSerial: 9_007_199_254_740_992 }]), /safe precision/);
  assert.throws(() => validateInventoryRows([{ ...row, aiagSerial: "ONE\nTWO" }]), /control characters/);
  assert.throws(() => validateInventoryRows([{ ...row, partNumber: "A".repeat(513) }]), /512-character/);
  assert.throws(() => validateInventoryRows([{ ...row, aiagSerial: "A".repeat(511) }]), /510-character barcode/);
  assert.throws(() => validateInventoryRows([{ ...row, color: "A".repeat(511) }]), /510-character barcode/);
  assert.throws(() => validateInventoryRows([{ ...row, partNumber: "A".repeat(512) }]), /511-character barcode/);
  for (const receiveDate of ["2026-02-30", "9/15/2026", "not a date"]) {
    assert.throws(() => validateInventoryRows([{ ...row, receiveDate }]), /valid YYYY-MM-DD/);
  }
  assert.throws(() => validateInventoryRows([{ ...row, weight: "-1" }]), /non-negative decimal/);
  assert.deepEqual(validateInventoryRows([{ ...row, weight: "1.25", unitCost: "0", receiveDate: "2026-09-15" }]),
    [{ ...row, weight: 1.25, unitCost: 0, receiveDate: "2026-09-15" }]);
});

test("inventory rejects ambiguous columns and importing consumed stock as available", async () => {
  await assert.rejects(parse("Serial Number,Serial-Number,Part Number,Quantity\nA,B,P123,30"), /Ambiguous duplicate/);
  await assert.rejects(parse("Serial Number,Serial,Part Number,Quantity\nA,B,P123,30"), /conflicting columns/);
  await assert.rejects(parse("Serial Number,Part Number,Quantity,Consumed Flag\nA,P123,30,Y"), /marked consumed/);
  await assert.rejects(parse("Serial Number,Part Number,Quantity,Consumed Quantity\nA,P123,30,1"), /marked consumed/);
  assert.equal((await parse("Serial Number,Part Number,Quantity,Consumed Flag,Consumed Quantity\nA,P123,30,N,0")).length, 1);
});

test("inventory XLSX reader shares demand archive, formula and file limits", async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet([{ "Serial Number": "000123", "Part Number": "P123", Quantity: 30 }]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Inventory");
  const data = () => XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true });
  assert.deepEqual(await parseInventorySpreadsheet(data(), "inventory.xlsx"), [row]);
  sheet.C2.f = "10+20";
  await assert.rejects(parseInventorySpreadsheet(data()), /contains a formula/);
  await assert.rejects(parseInventorySpreadsheet(new ArrayBuffer(5 * 1024 * 1024 + 1)), /5 MB/);
  await assert.rejects(parseInventorySpreadsheet(bytes("x"), "inventory.exe"), /CSV, XLSX, or XLS/);
});

test("download examples have matching whole containers and blank demand fulfillment outputs", async () => {
  const demandCsv = await readFile(new URL("../public/cartflow-demo-pick-list.csv", import.meta.url), "utf8");
  const inventoryCsv = await readFile(new URL("../public/ppa-demo-inventory.csv", import.meta.url), "utf8");
  const demand = await parseDemandSpreadsheet(bytes(demandCsv));
  const inventory = await parse(inventoryCsv);
  assert.match(demandCsv.split("\n")[0], /Fulfilled Quantity,Inventory Serial Number/);
  assert.doesNotMatch(demandCsv.split("\n")[0], /AIAG Serial Number/);
  assert.equal(demand.length, 10);
  assert.equal(inventory.length, demand.length);
  assert.match(inventoryCsv.split("\n")[0], /Pallet ID/);
  assert.equal(inventory[0].palletId, "PAL-0001");
  demand.forEach((line, index) => {
    assert.equal(line.aiagSerial, "");
    assert.deepEqual([line.partNumber, line.color, line.quantity], [inventory[index].partNumber, inventory[index].color, inventory[index].quantity]);
  });
});
