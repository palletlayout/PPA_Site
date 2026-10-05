import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as XLSX from "xlsx";
import { validateImportRows } from "../lib/import-validation.ts";
import { mapDemandRecords, parseDemandSpreadsheet } from "../lib/spreadsheet-import.ts";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demand-header-template.json", import.meta.url), "utf8"));

function records() {
  return fixture.rows.map((cells) => Object.fromEntries(fixture.headers.map((header, index) => [header, cells[index]])));
}

function workbookBuffer(sheet) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Demand");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true });
}

const metadataHeaders = {
  containerSequence: "Container sequence",
  fromModel: "From Model",
  fromType: "From Type ",
  fromOption: "From Option",
  fromColor: "From Color",
  fromInteriorColor: "From Interior Color",
  fromUnits: "From Units",
  toModel: "To  Model",
  toType: "To Type ",
  toOption: "To Option",
  toColor: "To Color",
  toInteriorColor: "To Interior Color",
  toUnits: "To Units",
};

test("the supplied 37 demand headers map TRAIN and LOAD without a Loading Sequence column", () => {
  assert.equal(fixture.headers.length, 37);
  assert.equal(fixture.headers.includes("Loading Sequence"), false);
  const [train, secondLine, load] = mapDemandRecords(records());
  assert.equal(train.areaType, "onsite");
  assert.equal(train.trainNumber, "000007");
  assert.equal(train.loadNumber, "");
  assert.equal(load.areaType, "offsite");
  assert.equal(load.loadNumber, "000008");
  assert.equal(load.trainNumber, "");
  assert.equal(load.loadingSequence, "");
  assert.equal(load.quantity, 1.125);
  assert.equal(load.unitOfMeasure, "KG");
  assert.equal(secondLine.picklistNumber, train.picklistNumber);
  assert.deepEqual(
    Object.fromEntries([
      "picklistNumber", "sequence", "partNumber", "color", "quantity", "unitOfMeasure",
      "plant", "zone", "shipCategory", "checksheetNumber", "masterBarcode", "movementBarcode",
      "cartSequenceNumber", "cartType", "cartId", "deliveryLocation", "scheduledDispatchDate",
      "scheduledDispatchTime", "containerSequence", "containerPosition", "containerType", "fromLot", "toLot",
    ].map((field) => [field, train[field]])),
    {
      picklistNumber: "000001", sequence: "001", partNumber: "000123-PART", color: "PART-BLUE",
      quantity: 15, unitOfMeasure: "EA", plant: "01", zone: "Z", shipCategory: "SC1",
      checksheetNumber: "000001", masterBarcode: "000001", movementBarcode: "000007",
      cartSequenceNumber: "01", cartType: "AH", cartId: "000022", deliveryLocation: "DLVLC1",
      scheduledDispatchDate: "10012026", scheduledDispatchTime: "0101", containerSequence: "0001",
      containerPosition: "A1", containerType: "C0", fromLot: "000111", toLot: "000222",
    },
  );
});

test("from/to vehicle metadata remains row-specific and does not replace demand or outbound fields", () => {
  const source = records();
  const mapped = mapDemandRecords(source);
  for (const [index, row] of mapped.entries()) {
    for (const [field, header] of Object.entries(metadataHeaders)) {
      assert.equal(row[field], source[index][header], `row ${index + 2} preserves ${header}`);
      assert.equal(typeof row[field], "string", `${header} stays text`);
    }
    assert.equal(row.model, "");
    assert.equal(row.option, "");
    assert.equal(row.vehicleColor, "");
    assert.equal(row.interiorColor, "");
    assert.equal(row.exteriorColor, "");
    assert.equal(row.cartType, source[index]["Cart Type"]);
    assert.equal(row.color, source[index]["Part Colour"]);
    assert.equal(row.quantity, Number(source[index]["Final Required Quantity"]));
    assert.equal(row.aiagSerial, "");
  }
  assert.notEqual(mapped[0].fromType, mapped[1].fromType);
  assert.notEqual(mapped[0].toUnits, mapped[1].toUnits);
  assert.equal(mapped[0].cartId, mapped[1].cartId);
  assert.deepEqual(validateImportRows(mapped), mapped, "validating parsed rows again loses no metadata");
});

test("real XLSX parsing accepts exact supplied headers and retains string identifiers and delivery values", async () => {
  const sheet = XLSX.utils.aoa_to_sheet([fixture.headers, ...fixture.rows]);
  const parsed = await parseDemandSpreadsheet(workbookBuffer(sheet));
  assert.deepEqual(parsed, mapDemandRecords(records()));
  assert.deepEqual(parsed.map((row) => row.containerSequence), ["0001", "0002", "0003"]);
  assert.deepEqual(parsed.map((row) => row.scheduledDispatchTime), ["0101", "0101", "0202"]);
  assert.deepEqual(parsed.map((row) => row.fromUnits), ["0030", "0031", "0032"]);
});

test("formatted XLSX identifiers, sequence, date and time retain their displayed leading zeroes", async () => {
  const sheet = XLSX.utils.aoa_to_sheet([fixture.headers, fixture.rows[0]]);
  const values = {
    "Picklist Number": [1, "000000"], "Container Packing Sequence": [1, "000"],
    "Train/Load Number": [7, "000000"], Plant: [1, "00"], "Checksheet Number": [1, "000000"],
    "Master Barcode": [1, "000000"], "Movement Barcode": [7, "000000"],
    "Cart Sequence Number": [1, "00"], "Cart ID": [22, "000000"],
    "Delivery date": [10012026, "00000000"], "Delivery Time": [101, "0000"],
    "Container sequence": [1, "0000"], "From Lot number": [111, "000000"],
    "From Units": [30, "0000"], "To Lot number": [222, "000000"], "To Units": [40, "0000"],
  };
  for (const [header, [value, format]] of Object.entries(values)) {
    const address = XLSX.utils.encode_cell({ r: 1, c: fixture.headers.indexOf(header) });
    sheet[address] = { t: "n", v: value, z: format };
  }
  const [parsed] = await parseDemandSpreadsheet(workbookBuffer(sheet));
  assert.deepEqual(parsed, mapDemandRecords([records()[0]])[0]);
});

test("header case, excess spaces and column order do not change supplied demand mappings", async () => {
  const order = fixture.headers.map((_, index) => index).reverse();
  const headers = order.map((index) => `  ${fixture.headers[index].toUpperCase().replaceAll(" ", "   ")}  `);
  const cells = fixture.rows.map((row) => order.map((index) => row[index]));
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...cells]);
  assert.deepEqual(await parseDemandSpreadsheet(workbookBuffer(sheet)), mapDemandRecords(records()));
});

test("from/to metadata can be blank or textual without becoming a demand quantity", () => {
  const blank = { ...records()[0] };
  for (const header of Object.values(metadataHeaders)) blank[header] = "";
  const [blankRow] = mapDemandRecords([blank]);
  for (const field of Object.keys(metadataHeaders)) assert.equal(blankRow[field], "");
  const [textUnits] = mapDemandRecords([{ ...records()[0], "From Units": "ALL", "To Units": "0000" }]);
  assert.equal(textUnits.fromUnits, "ALL");
  assert.equal(textUnits.toUnits, "0000");
  assert.equal(textUnits.quantity, 15);
  assert.equal(textUnits.unitOfMeasure, "EA");
});

test("delivery date and time reject conflicting aliases instead of dropping one value", () => {
  const base = records()[0];
  for (const [sourceHeader, alias, value] of [
    ["Delivery date", "Shipping date", "10022026"],
    ["Delivery date", "Scheduled Dispatch Date", "10022026"],
    ["Delivery Time", "Shipping Time", "0202"],
    ["Delivery Time", "Scheduled Dispatch Time", "0202"],
  ]) {
    assert.throws(() => mapDemandRecords([{ ...base, [alias]: value }]), /conflicting columns/);
    assert.deepEqual(mapDemandRecords([{ ...base, [alias]: base[sourceHeader] }]), mapDemandRecords([base]));
    assert.deepEqual(mapDemandRecords([{ ...base, [alias]: "" }]), mapDemandRecords([base]));
  }
});

test("accepting row-specific from/to values preserves existing picklist header consistency checks", () => {
  for (const [header, value] of [
    ["Cart ID", "OTHER-CART"], ["Cart Type", "OTHER"], ["Delivery Location", "OTHER-DOCK"],
    ["Delivery date", "10022026"], ["Delivery Time", "0202"], ["From Lot number", "OTHER-LOT"],
  ]) {
    const [first, second] = records();
    assert.throws(() => mapDemandRecords([first, { ...second, [header]: value }]), /conflicts with another row for picklist/);
  }
});

test("picklist conflicts identify the field, both values and the first matching spreadsheet row", () => {
  const [first, second] = records();
  const original = { ...first, "Movement Barcode": "AE3TP00001XSGS" };
  const another = { ...second, "Movement Barcode": "AE3TP00001XSGS" };
  const conflicting = { ...second, "Container Packing Sequence": "003", "Movement Barcode": "AE3TP00002XSGS" };
  assert.throws(() => mapDemandRecords([original, another, conflicting]), (error) => {
    assert.match(error.message, /Row 4 conflicts/);
    assert.match(error.message, /Movement Barcode: row 4 has "AE3TP00002XSGS"; row 2 has "AE3TP00001XSGS"/);
    assert.doesNotMatch(error.message, /row 3 has/);
    return true;
  });
  assert.throws(() => mapDemandRecords([first, { ...second, "Cart ID": "OTHER-CART", "Cart Type": "OTHER-TYPE" }]), (error) => {
    assert.match(error.message, /Cart ID: row 3 has "OTHER-CART"/);
    assert.match(error.message, /Cart Type: row 3 has "OTHER-TYPE"/);
    return true;
  });
});
