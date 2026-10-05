import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { mapDemandRecords, parseDemandSpreadsheet } from "../lib/spreadsheet-import.ts";
import { MAX_IMPORT_ROWS } from "../lib/import-validation.ts";

function sourceRecord(overrides = {}) {
  return {
    "PR OGPLCD": "01",
    "R DVZONE": "R",
    Area: "Onsite",
    "Ship Category": "Production",
    "Load #": "",
    "Train #": "TE309771",
    Picklist: "Z101AHTE31014603",
    "Cart #": "1",
    "Cart ID": "SH059R21",
    "Pallet ID": "PAL-01",
    "PI CNTPSQ": "001",
    "PI MBPN": "46674-30B-A000-",
    "Part name": "Intercooler component",
    "Part Color": "NE900L",
    "PI QTY": "30",
    "AIAG Serial Number": "59524202-22694949",
    "Program ID": "ODG303R",
    "Total Carts": "4",
    "P/Y/M/T/C": "01/T/30B/AE5/NE900L",
    "Checksheet Number": "Z101AHTE31014603",
    "Movement Barcode": "AE1TE309771X5AA",
    "Container Total": "1",
    "PR DVLCTN": "HEADER-DOCK",
    "PI DVLCTN": "DETAIL-RACK",
    Container: "C",
    "Prod. bat": "167064",
    ...overrides,
  };
}

function commonRecord(overrides = {}) {
  const record = sourceRecord();
  delete record.Area;
  delete record["Train #"];
  delete record["Load #"];
  return { ...record, Type: "TRAIN", "Train/Load Number": "TE309771", ...overrides };
}

function orderRecord(overrides = {}) {
  return {
    "Demand ID": "DEMAND-0001", "Plant ID": "01", "Area code": "PR", "Trailer Type": "H",
    "Master Order Number": "LOAD-1", "Cart Master Label": "PICK-1", "Load Sequence": "1",
    "Batch number": "BATCH-1", Model: "MODEL", Type: "SEDAN", Option: "SUNROOF",
    Color: "VEHICLE-BLUE", "Interior Color": "INT-BLACK", "Exterior Color": "EXT-BLUE",
    "KD Lot Number – From": "LOT-1", "KD Lot Number – To": "LOT-2",
    "Pick Location": "RACK-1", "Container Type": "BOX", "Container Position": "A1", "MCID Code": "MCID-1",
    "Part Number": "PART-1", "Part Color": "PART-GRAY", "Order Quantity": "12", "Pack Sequence": "20",
    "Shipping Location": "DOCK-1", "Shipping date": "2026-10-01", "shipping Time": "10:30",
    "Container Unique Serial number": "", "Fulfilled Quantity": "", "Part Fulfill Status": "",
    ...overrides,
  };
}

test("order contract maps stable demand identity independently from packing and printable metadata", () => {
  const [row] = mapDemandRecords([orderRecord()]);
  assert.equal(row.sourceLineId, "DEMAND-0001");
  assert.equal(row.sequence, "DEMAND-0001");
  assert.equal(row.packSequence, "20");
  assert.equal(row.areaType, "offsite");
  assert.equal(row.loadNumber, "LOAD-1");
  assert.equal(row.picklistNumber, "PICK-1");
  assert.equal(row.cartType, "SEDAN");
  assert.equal(row.option, "SUNROOF");
  assert.equal(row.color, "PART-GRAY");
  assert.equal(row.vehicleColor, "VEHICLE-BLUE");
  assert.equal(row.interiorColor, "INT-BLACK");
  assert.equal(row.exteriorColor, "EXT-BLUE");
  assert.equal(row.fromLot, "LOT-1");
  assert.equal(row.toLot, "LOT-2");
  assert.equal(row.mcid, "MCID-1");
  assert.equal(row.pickingLocation, "RACK-1");
  assert.equal(row.deliveryLocation, "DOCK-1");
  assert.equal(row.scheduledDispatchDate, "2026-10-01");
  assert.equal(row.scheduledDispatchTime, "10:30");
  assert.equal(row.quantity, 12);
});

test("Demand IDs remain stable when rows and repeated packing sequences are reordered", () => {
  const records = [orderRecord(), orderRecord({ "Demand ID": "DEMAND-0002" })];
  const first = mapDemandRecords(records);
  const second = mapDemandRecords([...records].reverse());
  assert.deepEqual(first.map(row => [row.sourceLineId, row.sequence]), second.reverse().map(row => [row.sourceLineId, row.sequence]));
  assert.deepEqual(first.map(row => row.packSequence), ["20", "20"]);
  assert.throws(() => mapDemandRecords([records[0], records[0]]), /repeats Source Line ID/);
  assert.throws(() => mapDemandRecords([orderRecord({ "Demand ID": "" })]), /requires Demand ID/);
  assert.throws(() => mapDemandRecords([orderRecord({ "Train Number": "T1", "Load Number": "L1" })]), /one Train or Load/);
  const [longId] = mapDemandRecords([orderRecord({ "Demand ID": "EXTERNAL-" + "A".repeat(80) })]);
  assert.equal(longId.sequence, longId.sourceLineId);
});

test("order movement and picklist aliases preserve raw scan references", () => {
  const [separateMaster] = mapDemandRecords([orderRecord({ "Picklist Number": "CANONICAL-PICK", "Cart Master Label": "MASTER-ALIAS" })]);
  assert.equal(separateMaster.picklistNumber, "CANONICAL-PICK");
  assert.equal(separateMaster.masterBarcode, "MASTER-ALIAS");
  for (const movement of ["Load number", "Train Number", "Master Order Number"]) {
    for (const picklist of ["Checksheet Number", "Picklist Number", "Cart Master Label", "Order Number"]) {
      const record = orderRecord();
      delete record["Master Order Number"];
      delete record["Cart Master Label"];
      record[movement] = "MOVE-1";
      record[picklist] = "PICK-1";
      const [row] = mapDemandRecords([record]);
      assert.equal(row.trainNumber || row.loadNumber, "MOVE-1");
      assert.equal(row.picklistNumber, "PICK-1");
      assert.equal(row.masterBarcode, "PICK-1");
      assert.equal(row.movementBarcode, "MOVE-1");
    }
  }
});

test("print Type and vehicle Color never replace movement type or Part Color", () => {
  const [mixed] = mapDemandRecords([commonRecord({ "Movement Type": "TRAIN", Type: "SEDAN", Color: "BLUE" })]);
  assert.equal(mixed.cartType, "SEDAN");
  assert.equal(mixed.trainNumber, "TE309771");
  assert.equal(mixed.color, "NE900L");
  assert.equal(mixed.vehicleColor, "BLUE");
  assert.equal(mapDemandRecords([orderRecord({ Type: "LOAD" })])[0].cartType, "LOAD");
  const record = orderRecord();
  delete record["Part Color"];
  const [blankPart] = mapDemandRecords([record]);
  assert.equal(blankPart.color, "");
  assert.equal(blankPart.vehicleColor, "VEHICLE-BLUE");
});

test("order spreadsheets cannot supply packing results or container assignments", () => {
  for (const field of ["Container Unique Serial number", "Part Fulfill Status", "Picklist fulfill status", "Load/Train fulfillment status", "Filled data/time/user"]) {
    assert.throws(() => mapDemandRecords([orderRecord({ [field]: "PACKED" })]), /must be blank/);
  }
});

test("spreadsheet imports preserve blank optional header quantities separately from explicit zero", () => {
  for (const blank of [undefined, '', ' ']) {
    const [row] = mapDemandRecords([sourceRecord({ PR_PRDQTY: blank, PR_CRTTQY: blank })]);
    assert.equal(row.productionQuantity, undefined);
    assert.equal(row.cartMaxQuantity, undefined);
  }
  const [zero] = mapDemandRecords([sourceRecord({ PR_PRDQTY: '0', PR_CRTTQY: '0' })]);
  assert.equal(zero.productionQuantity, 0);
  assert.equal(zero.cartMaxQuantity, 0);
});

test("common movement headers support TRAIN and LOAD without Area", () => {
  const [train] = mapDemandRecords([commonRecord()]);
  assert.equal(train.areaType, "onsite");
  assert.equal(train.trainNumber, "TE309771");
  const [load] = mapDemandRecords([commonRecord({ Type: "load", "Train/Load Number": "LD9002", "Loading Sequence": "51" })]);
  assert.equal(load.areaType, "offsite");
  assert.equal(load.loadNumber, "LD9002");
  assert.equal(load.trainNumber, "");
  assert.equal(load.loadingSequence, "51");
  const [withoutLoadingSequence] = mapDemandRecords([commonRecord({ Type: "LOAD", "Train/Load Number": "LD9002" })]);
  assert.equal(withoutLoadingSequence.loadingSequence, "");
});

test("demand requires no serial assignment or color and ignores legacy expected serials", () => {
  const record = commonRecord();
  delete record["AIAG Serial Number"];
  delete record["Part Color"];
  const [row] = mapDemandRecords([{ ...record, "Fulfilled Quantity": "", "Inventory Serial Number": "" }]);
  assert.equal(row.aiagSerial, "");
  assert.equal(row.color, "");
  assert.equal(mapDemandRecords([commonRecord({ "AIAG Serial Number": "OLD-PRESELECTED-SERIAL" })])[0].aiagSerial, "");
});

test("demand fulfillment output columns cannot mark uploaded orders fulfilled", () => {
  for (const [header, value] of [["Inventory Serial Number", "SERIAL-1"], ["Fulfilled Quantity", 30]]) {
    assert.throws(() => mapDemandRecords([commonRecord({ [header]: value })]), /must be blank/);
  }
});

test("common movement headers reject missing values and conflicting legacy identifiers", () => {
  for (const [overrides, error] of [
    [{ Type: "BOAT" }, /Type must be TRAIN or LOAD/],
    [{ Type: "" }, /Type must be TRAIN or LOAD/],
    [{ "Train/Load Number": "" }, /requires Train\/Load Number/],
    [{ Area: "Offsite" }, /Type conflicts with Area/],
    [{ "Train #": "OTHER" }, /conflicts with legacy/],
    [{ "Load #": "LD9002" }, /conflicts with legacy/],
  ]) assert.throws(() => mapDemandRecords([commonRecord(overrides)]), error);
  const missing = commonRecord();
  delete missing.Type;
  assert.throws(() => mapDemandRecords([missing]), /requires both Type and Train\/Load Number/);
});

test("ODG303 printer field names map to the correct header and detail values", () => {
  const record = commonRecord();
  delete record["Part Color"];
  delete record["PI QTY"];
  delete record.Container;
  const [row] = mapDemandRecords([{ ...record, PI_PTCLR: "STD", PI_QTY: 30,
    PI_CNTTYP: "C", PI_CNTPTN: "A1", PI_PCLC: "F17", "PI_MCID#": "MC123",
    PR_CRTSEQ: "1", PR_CRTTYP: "SH", PR_CASECOD: "SHXX-R01" }]);
  assert.equal(row.color, "STD");
  assert.equal(row.quantity, 30);
  assert.equal(row.containerPosition, "A1");
  assert.equal(row.containerType, "C");
  assert.equal(row.pickingLocation, "F17");
  assert.equal(row.mcid, "MC123");
  assert.equal(row.cartSequenceNumber, "1");
  assert.equal(row.cartType, "SH");
  assert.equal(row.caseCode, "SHXX-R01");
  assert.equal(row.deliveryLocation, "HEADER-DOCK");
  assert.equal(row.detailDeliveryLocation, "DETAIL-RACK");
});

test("maps ODG-style headings and preserves supplemental checksheet fields", () => {
  const [row] = mapDemandRecords([sourceRecord()]);

  assert.equal(row.plant, "01");
  assert.equal(row.zone, "R");
  assert.equal(row.sequence, "001");
  assert.equal(row.partNumber, "46674-30B-A000-");
  assert.equal(row.description, "Intercooler component");
  assert.equal(row.color, "NE900L");
  assert.equal(row.quantity, 30);
  assert.equal(row.programId, "ODG303R");
  assert.equal(row.totalCarts, 4);
  assert.equal(row.pymtc, "01/T/30B/AE5/NE900L");
  assert.equal(row.checksheetNumber, "Z101AHTE31014603");
  assert.equal(row.containerTotal, 1);
  assert.equal(row.deliveryLocation, "HEADER-DOCK");
  assert.equal(row.detailDeliveryLocation, "DETAIL-RACK");
  assert.equal(row.containerType, "C");
  assert.equal(row.batchNumber, "167064");
});

test("production quantity never substitutes for detail demand and header metadata stays distinct", () => {
  const record = sourceRecord({ PR_PRDQTY: "400", PR_CRTTQY: "60.50", PR_COLOR: "BLACK/BEIGE" });
  const [row] = mapDemandRecords([record]);
  assert.equal(row.quantity, 30);
  assert.equal(row.productionQuantity, 400);
  assert.equal(row.cartMaxQuantity, 60.5);
  assert.equal(row.vehicleColor, "BLACK/BEIGE");
  assert.equal(row.color, "NE900L");
  delete record["PI QTY"];
  assert.throws(() => mapDemandRecords([record]), /Missing required column: Quantity/);
  assert.throws(() => mapDemandRecords([{ ...record, "PR DQTY": "400" }]), /Missing required column: Quantity/);
});

test("common demand accepts one picklist identity with optional references, source identity and measured units", () => {
  const record = commonRecord({ "Source Line ID": "LINE-1", "Source Scope": "ERP", "Unit of Measure": "L", "PI QTY": "1.125", "Preferred Supplier ID": "SUP-1" });
  delete record["Cart #"];
  delete record["Cart ID"];
  delete record["Pallet ID"];
  const [row] = mapDemandRecords([record]);
  assert.equal(row.cartId, row.picklistNumber);
  assert.equal(row.cartNumber, "1");
  assert.equal(row.palletId, "");
  assert.equal(row.sourceLineId, "LINE-1");
  assert.equal(row.sourceScope, "ERP");
  assert.equal(row.preferredSupplierId, "SUP-1");
  assert.equal(row.quantity, 1.125);
  assert.equal(row.unitOfMeasure, "L");
  delete record.Picklist;
  assert.equal(mapDemandRecords([record])[0].picklistNumber, record["Checksheet Number"]);
});

test("rejects invalid optional whole-number fields instead of silently clearing them", () => {
  assert.throws(
    () => mapDemandRecords([sourceRecord({ "Total Carts": "not-a-number" })]),
    /Total Carts must be a non-negative whole number/,
  );
});

test("translates a production demand extract with repeated source headings", async () => {
  const csv = [
    "Production,Train num,Train Id,Checksheet,Prod.batch,Case code,Case,Part numb,Part Color,Delivery,Delivery,Order,MTC,MTC,MTC,Int,Exterior,Production,Optimum,Container,Part name,Plant,Zone,Area,Ship Category,Load #,Pallet ID,Part Sequence,AIAG Serial Number,Program ID,Master Barcode,Movement Barcode",
    "1,TE310100,000006935,Z101AHTE3101000006935,167064,BSXX-R01,1,7132130A,STD,H320R1,112,60,T30B,ALL,O,I,EXTCOLR,607012701,120,A1,COVER FR,01,H,Onsite,PR,,PAL-BSXX-R01,001,60701270-000001,ODG301R,Z101PRTE31010001,AE1TE310100XHPR",
    "1,TE310100,000006935,Z101AHTE3101000006935,167064,BSXX-R01,1,8033030B,STD,H320R1,112,20,T30B,ALL,O,I,EXTCOLR,607012701,120,A1,INTERNAL TRIM,01,H,Onsite,PR,,PAL-BSXX-R01,002,60701270-000002,ODG301R,Z101PRTE31010001,AE1TE310100XHPR",
  ].join("\n");
  const file = Buffer.from(csv);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const rows = await parseDemandSpreadsheet(buffer);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.quantity), [60, 20]);
  assert.equal(rows[0].trainNumber, "TE310100");
  assert.equal(rows[0].picklistNumber, "Z101AHTE3101000006935");
  assert.equal(rows[0].checksheetNumber, "Z101AHTE3101000006935");
  assert.equal(rows[0].cartNumber, "1");
  assert.equal(rows[0].cartId, "BSXX-R01");
  assert.equal(rows[0].caseCode, "BSXX-R01");
  assert.equal(rows[0].sequence, "001");
  assert.equal(rows[0].detailDeliveryLocation, "H320R1");
  assert.equal(rows[0].deliveryLocation, "");
  assert.equal(rows[0].batchNumber, "167064");
  assert.equal(rows[0].model, "T30B");
  assert.equal(rows[0].pymtc, "T30B/ALL/O/I/EXTCOLR");
  assert.equal(rows[0].containerType, "A1");
  assert.equal(rows[0].totalCarts, 1);

  // The similarly named production fields stay source-only until their
  // business meaning is confirmed; neither is silently treated as demand.
  assert.equal(rows[0].orderNumber, "");
  assert.equal(rows[0].outgoingSerial, "");
  assert.equal(rows[0].containerTotal, 0);
  assert.equal(rows[0].masterBarcode, "Z101PRTE31010001");
  assert.equal(rows[0].movementBarcode, "AE1TE310100XHPR");
});

test("automated ingestion accepts secured JSON and multipart spreadsheets", async () => {
  const route = await readFile(new URL("../app/api/integrations/demand/route.ts", import.meta.url), "utf8");
  const reader = await readFile(new URL("../lib/demand-import-request.ts", import.meta.url), "utf8");

  assert.match(route, /CARTFLOW_INGEST_TOKEN/);
  assert.match(route, /Invalid integration credential/);
  assert.match(route, /readDemandImportRequest\(request\)/);
  assert.match(reader, /multipart\/form-data/);
  assert.match(reader, /parseDemandSpreadsheet\(await file\.arrayBuffer\(\)\)/);
  assert.match(route, /replaceIntegrationImport\(\{/);
  assert.match(route, /idempotencyKey:.*cleanIdempotencyKey/);
  assert.match(route, /contentHash: await demandContentHash\(rows\)/);
});

test("rejects conflicting aliases and duplicate normalized headings", () => {
  assert.throws(() => mapDemandRecords([sourceRecord({ Quantity: "31" })]), /conflicting columns for Quantity/);
  assert.throws(() => mapDemandRecords([sourceRecord({ "PI-QTY": "31" })]), /Ambiguous duplicate column/);
  assert.equal(mapDemandRecords([sourceRecord({ Quantity: "30" })])[0].quantity, 30);
});

test("treats missing cells as empty and supports a missing unused movement column", () => {
  for (const missing of [null, undefined]) {
    assert.equal(mapDemandRecords([sourceRecord({ "AIAG Serial Number": missing })])[0].aiagSerial, "");
    const row = mapDemandRecords([sourceRecord({ "Part name": missing })])[0];
    assert.equal(row.description, "");
  }
  const record = sourceRecord();
  delete record["Load #"];
  assert.equal(mapDemandRecords([record])[0].loadNumber, "");
});

test("rejects malformed thousands separators instead of changing demand", () => {
  for (const quantity of ["1,2", "30,", "1.0", "0x10", "1e3", "2,147,483,648"]) {
    assert.throws(() => mapDemandRecords([sourceRecord({ "PI QTY": quantity })]), /positive whole number/);
  }
  assert.equal(mapDemandRecords([sourceRecord({ "PI QTY": "1,234" })])[0].quantity, 1234);
});

function workbookBuffer(sheet, compression = false) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Demand");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx", compression });
}

test("preserves leading zeroes in CSV identifiers before spreadsheet inference", async () => {
  const source = sourceRecord({ "AIAG Serial Number": "0000123456", "Pallet ID": "000321", "Cart ID": "000567" });
  const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet([source]));
  const rows = await parseDemandSpreadsheet(new TextEncoder().encode(csv).buffer);
  assert.equal(rows[0].aiagSerial, "");
  assert.equal(rows[0].cartId, "000567");
  assert.equal(rows[0].palletId, "000321");
});

test("rejects formulas, spreadsheet errors, and numeric identifiers with lost precision", async () => {
  for (const [replacement, expected] of [
    [{ t: "n", v: 30, f: "15+15" }, /contains a formula/],
    [{ t: "e", v: 7 }, /spreadsheet error/],
    [{ t: "n", v: 9_007_199_254_740_992 }, /safe precision/],
  ]) {
    const sheet = XLSX.utils.json_to_sheet([sourceRecord()]);
    sheet.P2 = replacement;
    await assert.rejects(parseDemandSpreadsheet(workbookBuffer(sheet)), expected);
  }
});

test("bounds worksheet files, dimensions, and cells before mapping", async () => {
  await assert.rejects(parseDemandSpreadsheet(new ArrayBuffer(5 * 1024 * 1024 + 1)), /5 MB/);
  const tooManyRows = XLSX.utils.aoa_to_sheet([["Demand ID"], ...Array(MAX_IMPORT_ROWS + 1).fill(["row"])]);
  await assert.rejects(parseDemandSpreadsheet(workbookBuffer(tooManyRows)), /10,000 rows/);
  const tooWide = XLSX.utils.aoa_to_sheet([Array.from({ length: 129 }, (_, i) => `Column ${i}`)]);
  await assert.rejects(parseDemandSpreadsheet(workbookBuffer(tooWide)), /128-column/);
  const tooLong = XLSX.utils.json_to_sheet([sourceRecord({ "Part name": "A".repeat(513) })]);
  await assert.rejects(parseDemandSpreadsheet(workbookBuffer(tooLong)), /512-character/);
});

test("rejects repeated quantity headings instead of silently discarding a column", async () => {
  const record = sourceRecord();
  const sheet = XLSX.utils.aoa_to_sheet([
    [...Object.keys(record), "PI QTY"],
    [...Object.values(record), "31"],
  ]);
  await assert.rejects(parseDemandSpreadsheet(workbookBuffer(sheet)), /Ambiguous duplicate column/);
});

test("rejects oversized ZIP expansion before inflating the workbook", async () => {
  const buffer = workbookBuffer(XLSX.utils.json_to_sheet([sourceRecord()]));
  const view = new DataView(buffer);
  const end = buffer.byteLength - 22;
  const directory = view.getUint32(end + 16, true);
  assert.equal(view.getUint32(directory, true), 0x02014b50);
  view.setUint32(directory + 24, 32 * 1024 * 1024 + 1, true);
  await assert.rejects(parseDemandSpreadsheet(buffer), /expanded workbook exceeds/);
});

test("validates actual ZIP expansion rather than trusting forged size metadata", async () => {
  const sheet = XLSX.utils.json_to_sheet([sourceRecord()]);
  assert.equal((await parseDemandSpreadsheet(workbookBuffer(sheet, true)))[0].quantity, 30);
  const buffer = workbookBuffer(sheet, true);
  const view = new DataView(buffer);
  const directory = view.getUint32(buffer.byteLength - 6, true);
  view.setUint32(directory + 24, 0, true);
  const local = view.getUint32(directory + 42, true);
  view.setUint32(local + 22, 0, true);
  await assert.rejects(parseDemandSpreadsheet(buffer), /ZIP size is invalid/);
});

test("rejects forged local allocation sizes before handing the workbook to SheetJS", async () => {
  const buffer = workbookBuffer(XLSX.utils.json_to_sheet([sourceRecord()]), true);
  const view = new DataView(buffer);
  view.setUint32(22, 0x7fffffff, true);
  await assert.rejects(parseDemandSpreadsheet(buffer), /ZIP size is invalid/);
});
