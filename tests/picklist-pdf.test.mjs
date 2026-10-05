import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { generatePicklistPdf } from "../lib/picklist-pdf.ts";
import { PRINTABLE_FIELD_LIMITS, validateImportRows } from "../lib/import-validation.ts";

function extractDecodedOperators(bytes) {
  const buffer = Buffer.from(bytes);
  const source = buffer.toString("latin1");
  const decodedStreams = [];
  let cursor = 0;

  while ((cursor = source.indexOf("stream\n", cursor)) !== -1) {
    const streamStart = cursor + "stream\n".length;
    const streamEnd = source.indexOf("\nendstream", streamStart);
    if (streamEnd === -1) break;

    const dictionaryStart = source.lastIndexOf("<<", cursor);
    const dictionary = source.slice(Math.max(0, dictionaryStart), cursor);
    const raw = buffer.subarray(streamStart, streamEnd);
    try {
      const decoded = dictionary.includes("/FlateDecode") ? inflateSync(raw) : raw;
      decodedStreams.push(decoded.toString("latin1"));
    } catch {
      // Fonts and other binary streams are irrelevant to these content assertions.
    }
    cursor = streamEnd + "\nendstream".length;
  }

  return decodedStreams.join("\n");
}

function extractDrawnText(bytes) {
  const drawn = [];
  for (const match of extractDecodedOperators(bytes).matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
    drawn.push(Buffer.from(match[1], "hex").toString("latin1"));
  }
  return drawn.join("\n");
}

async function assertMasterPageCount(bytes, expected) {
  const document = await PDFDocument.load(bytes);
  const pages = document.getPages().map((page) => {
    assert.deepEqual(page.getSize(), { width: 612, height: 792 });
    const contents = page.node.Contents();
    const streams = contents instanceof PDFRawStream ? [contents]
      : contents.asArray().map((ref) => document.context.lookup(ref, PDFRawStream));
    const operators = streams.map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1")).join("\n");
    return [...operators.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
      .map((match) => Buffer.from(match[1], "hex").toString("latin1")).join("\n");
  });
  const masters = pages.filter((text) => text.includes("CART MASTER LABEL"));
  if (expected !== undefined) assert.equal(masters.length, expected, "each cart's source rows have the expected number of master labels");
  assert.equal(masters.length, pages.length, "every page is a master label, without appended packing logs");
  assert.doesNotMatch(pages.join("\n"), /PACKING DETAIL|See detail/i);
  return { pages, masters };
}

function assertFilePagination(pages) {
  pages.forEach((text, index) => assert.ok(text.includes(`File: ${index + 1} Of ${pages.length}`), `file page ${index + 1} of ${pages.length}`));
}

function line(overrides = {}) {
  return {
    id: "line-1", batchId: "batch-1", plant: "01", zone: "R", areaType: "onsite",
    shipCategory: "AA", loadNumber: "", trainNumber: "TE309771", picklistNumber: "PL-1001",
    cartNumber: "1", cartId: "SH059R21", palletId: "PAL-1", sequence: "1",
    cartBarcode: "CFCART-01-SH059R21",
    partNumber: "46674-30B-A000-", description: "LEVER ASSY, SELECT", color: "NE900L",
    quantity: 30, aiagSerial: "AIAG-1001", masterBarcode: "Z101AATE30977101",
    movementBarcode: "AE1TE309771X5AA", caseCode: "SHXX-R01", outgoingSerial: "01-2607-AA-010",
    cartSequenceNumber: "1 / 4", fromLot: "202607-0141", toLot: "202607-0142",
    programId: "ODG303R", totalCarts: 4, pymtc: "01/T/30B/AE5/NE900L", checksheetNumber: "",
    model: "T-30B-AE5", cartType: "SH", scheduledDispatchDate: "07/08/26",
    scheduledDispatchTime: "06:23", deliveryLocation: "G070R4", detailDeliveryLocation: "DETAIL-RACK", containerPosition: "A1",
    containerType: "C", pickingLocation: "A10", mcid: "MCID101", chassisNumber: "",
    orderNumber: "", batchNumber: "", loadingSequence: "", status: "pending", verifiedAt: null,
    ...overrides,
  };
}

test("generates a Letter train master label per cart without a packing appendix", async () => {
  const result = await generatePicklistPdf([
    line(),
    line({ id: "line-2", sequence: "2", containerPosition: "B1", aiagSerial: "AIAG-1002" }),
  ]);
  assert.match(result.filename, /^train-TE309771-/);
  assert.equal(new TextDecoder().decode(result.bytes.slice(0, 5)), "%PDF-");
  const { masters } = await assertMasterPageCount(result.bytes, 1);

  const text = extractDrawnText(result.bytes);
  assert.match(text, /ODG303R/);
  assert.match(text, /Date: \d{2}\/\d{2}\/\d{2}/);
  assert.match(text, /Time: \d{2}:\d{2}:\d{2} CT/);
  assert.match(text, /Case code:/i);
  assert.match(text, /SHXX-R01/);
  assert.match(text, /Cart Seq\. :/);
  assert.match(text, /FROM Lot#/);
  assert.match(text, /TO Lot#/);
  assert.match(text, /Model \/ Type \/ Ops \/ Color \/ Interior color/);
  assert.match(text, /Dispatch Date&Time/);
  assert.match(text, /Del\.\/Loc\./);
  assert.match(text, /Del\.\/Zone:/);
  assert.match(text, /Pick\/Loc\./);
  assert.match(text, /A10/);
  assert.match(text, /DETAIL-RACK/);
  assert.match(text, /Z101AATE30977101/);
  assert.match(text, /AE1TE309771X5AA/);
  assert.doesNotMatch(masters[0], /PPA CART|CFCART-01-SH059R21/);
  assert.match(text, /Page: 1/);
  assert.match(text, /Page: 1 Of 1/);
  const operators = extractDecodedOperators(result.bytes);
  assert.doesNotMatch(operators, /0\.9 0\.91 0\.92 rg/);
  assert.doesNotMatch(operators, /0\.76 0\.78 0\.8 RG/);
});

test("prints in pack sequence order with packing status and no allocation logs", async () => {
  const result = await generatePicklistPdf([
    line({ id: "demand-a", sourceLineId: "DEMAND-A", sequence: "1", packSequence: "20", partNumber: "SECOND-PART", option: "SUNROOF", vehicleColor: "VEHICLE-BLUE", interiorColor: "BLACK", exteriorColor: "BLUE" }),
    line({ id: "demand-b", sourceLineId: "DEMAND-B", sequence: "2", packSequence: "2", partNumber: "FIRST-PART", quantity: 30, fulfilledQuantity: 12, status: "active", option: "SUNROOF", vehicleColor: "VEHICLE-BLUE", interiorColor: "BLACK", exteriorColor: "BLUE",
      allocations: [
        { id: "allocation-1", inventoryItemId: "stock-1", serial: "CONTAINER-ONE", quantity: 5, packedAt: "2026-09-23", packedBy: "OP" },
        { id: "allocation-2", inventoryItemId: "stock-2", serial: "CONTAINER-TWO", quantity: 7, packedAt: "2026-09-23", packedBy: "OP" },
      ] }),
  ]);
  const text = extractDrawnText(result.bytes);
  assert.ok(text.indexOf("FIRST-PART") < text.indexOf("SECOND-PART"));
  for (const printed of ["SUNROOF", "VEHICLE-BLUE", "Exterior color: BLUE", "PART", "30 EA"]) assert.ok(text.includes(printed), printed);
  assert.doesNotMatch(text, /CONTAINER-ONE|CONTAINER-TWO|DEMAND-B|PACKING DETAIL/);
  await assertMasterPageCount(result.bytes, 1);
});

test("large allocation histories do not add pages or serial logs to a label", async () => {
  const allocations = Array.from({ length: 65 }, (_, index) => ({ id: `a-${index}`, inventoryItemId: `i-${index}`, serial: `SERIAL-${index}-` + "X".repeat(150), quantity: 1, packedAt: "2026-09-23", packedBy: "OP" }));
  const result = await generatePicklistPdf([line({ quantity: 100, fulfilledQuantity: 65, status: "active", allocations })]);
  const text = extractDrawnText(result.bytes).replaceAll("\n", "");
  await assertMasterPageCount(result.bytes, 1);
  assert.ok(text.includes("100 EA"));
  assert.ok(text.includes("PART"));
  for (const allocation of allocations) assert.ok(!text.includes(allocation.serial), allocation.id);
});

test("uses explicit ODG header fields before generated checksheet fallbacks", async () => {
  const result = await generatePicklistPdf([line({
    programId: "CUSTOM303",
    cartSequenceNumber: "1",
    totalCarts: 4,
    masterBarcode: "",
    checksheetNumber: "CHECK-ONSITE-01",
  })]);
  const text = extractDrawnText(result.bytes);
  assert.match(text, /CUSTOM303/);
  assert.match(text, /1 \/ 4/);
  assert.match(text, /CHECK-ONSITE-01/);
});

test("generates the documented train master payload from canonical components", async () => {
  const result = await generatePicklistPdf([
    line({ zone: "5", masterBarcode: "", movementBarcode: "" }),
  ]);
  const text = extractDrawnText(result.bytes);
  assert.match(text, /Z101AATE30977101/);
  assert.match(text, /AE1TE309771X5AA/);
});

test("generates a paged trailer-load PDF with load and picklist/checksheet payloads", async () => {
  const rows = Array.from({ length: 21 }, (_, index) => line({
    id: `line-${index + 1}`, areaType: "offsite", trainNumber: "", loadNumber: "268954",
    picklistNumber: "Z101AHTE31016201", masterBarcode: "", movementBarcode: "",
    chassisNumber: "CHASSIS-77", orderNumber: "09653867", batchNumber: "167064",
    loadingSequence: "6", fromLot: "1-2607-128-1", toLot: "1-2607-128-1",
    pymtc: "EXPLICIT/P/Y/M/T/C", checksheetNumber: "CHECK-16201", containerTotal: 99,
    sequence: String(index + 1), containerPosition: String(index + 1),
  }));
  const result = await generatePicklistPdf(rows);
  assert.match(result.filename, /^load-268954-/);
  assert.equal(new TextDecoder().decode(result.bytes.slice(0, 5)), "%PDF-");
  const { masters } = await assertMasterPageCount(result.bytes);
  assert.ok(masters.length >= 3, "all 21 source rows fit on readable master labels");

  const text = extractDrawnText(result.bytes);
  assert.match(text, /CART MASTER LABEL/);
  assert.match(text, /Chassis:/);
  assert.match(text, /Load#/);
  assert.match(text, /CHASSIS-77/);
  assert.match(text, /Batch:\s*167064/);
  assert.match(text, /FROM Lot#/);
  assert.match(text, /1-2607-128-1/);
  assert.match(text, /Loading sequence:\s*6/);
  assert.match(text, /P\/Y\/M\/T\/C/);
  assert.match(text, /EXPLICIT\/P\/Y\/M\/T\/C/);
  assert.match(text, /LEVER ASSY, SELECT/);
  assert.equal(text.match(/Container total: 99/g)?.length, rows.length);
  const masterText = masters.join("\n");
  assert.equal(masterText.match(/46674-30B-A000-/g)?.length, rows.length, "all 21 part rows print on the master labels");
  assert.match(text, /268954/);
  assert.match(masterText, /CHECK-16201/);
  assert.doesNotMatch(masterText, /PPA CART|CFCART-01-SH059R21/);
  masters.forEach((page, index) => assert.ok(page.includes(`Page: ${index + 1} Of ${masters.length}`)));
  const operators = extractDecodedOperators(result.bytes);
  assert.doesNotMatch(operators, /0\.9 0\.91 0\.92 rg/);
  assert.doesNotMatch(operators, /0\.76 0\.78 0\.8 RG/);
});

test("prints each offsite cart on its own master label without internal cart aliases", async () => {
  const result = await generatePicklistPdf([
    line({
      id: "offsite-1", areaType: "offsite", trainNumber: "", loadNumber: "268954",
      cartNumber: "1", cartId: "LOAD-CART-1", cartBarcode: "CFCART-LOAD-001",
    }),
    line({
      id: "offsite-2", areaType: "offsite", trainNumber: "", loadNumber: "268954",
      cartNumber: "2", cartId: "LOAD-CART-2", cartBarcode: "CFCART-LOAD-002",
    }),
  ]);
  const { masters } = await assertMasterPageCount(result.bytes, 2);
  assert.doesNotMatch(masters.join("\n"), /PPA CART|CFCART-LOAD-00[12]/);
  assert.match(masters[0], /LOAD-CART-1/);
  assert.doesNotMatch(masters[0], /LOAD-CART-2/);
  assert.match(masters[1], /LOAD-CART-2/);
  assert.doesNotMatch(masters[1], /LOAD-CART-1/);
});

test("combines every train picklist and cart into one movement PDF", async () => {
  const result = await generatePicklistPdf([
    line({
      id: "train-pl2-cart1", picklistNumber: "PL-2", cartNumber: "1", cartId: "TRAIN-CART-1",
      cartBarcode: "CFCART-TRAIN-001", partNumber: "PART-PL2-C1", aiagSerial: "AIAG-PL2-C1",
    }),
    line({
      id: "train-pl2-cart2", picklistNumber: "PL-2", cartNumber: "2", cartId: "TRAIN-CART-2",
      cartBarcode: "CFCART-TRAIN-002", partNumber: "PART-PL2-C2", aiagSerial: "AIAG-PL2-C2",
    }),
    line({
      id: "train-pl10-cart1", picklistNumber: "PL-10", cartNumber: "1", cartId: "TRAIN-CART-3",
      cartBarcode: "CFCART-TRAIN-003", partNumber: "PART-PL10-C1", aiagSerial: "AIAG-PL10-C1",
    }),
  ], { scope: "movement" });

  assert.equal(result.filename, "train-TE309771-all-checksheets.pdf");
  const { pages } = await assertMasterPageCount(result.bytes, 3);
  const text = extractDrawnText(result.bytes);
  for (const expected of [
    "PART-PL2-C1", "PART-PL2-C2", "PART-PL10-C1",
    "TRAIN-CART-1", "TRAIN-CART-2", "TRAIN-CART-3",
  ]) {
    assert.match(text, new RegExp(expected));
  }
  assert.ok(text.indexOf("PART-PL2-C1") < text.indexOf("PART-PL10-C1"));
  assertFilePagination(pages);
});

test("combines every load picklist and cart into one movement PDF", async () => {
  const result = await generatePicklistPdf([
    line({
      id: "load-pl2", areaType: "offsite", trainNumber: "", loadNumber: "268954",
      picklistNumber: "LOAD-PL-2", checksheetNumber: "CHECK-LOAD-2", masterBarcode: "", movementBarcode: "",
      cartNumber: "1", cartId: "LOAD-CART-1", cartBarcode: "CFCART-LOAD-001", partNumber: "LOAD-PART-2",
    }),
    line({
      id: "load-pl10", areaType: "offsite", trainNumber: "", loadNumber: "268954",
      picklistNumber: "LOAD-PL-10", checksheetNumber: "CHECK-LOAD-10", masterBarcode: "", movementBarcode: "",
      cartNumber: "2", cartId: "LOAD-CART-2", cartBarcode: "CFCART-LOAD-002", partNumber: "LOAD-PART-10",
    }),
  ], { scope: "movement" });

  assert.equal(result.filename, "load-268954-all-checksheets.pdf");
  const { pages } = await assertMasterPageCount(result.bytes, 2);
  const text = extractDrawnText(result.bytes);
  assert.match(text, /CHECK-LOAD-2/);
  assert.match(text, /CHECK-LOAD-10/);
  assert.match(text, /LOAD-PART-2/);
  assert.match(text, /LOAD-PART-10/);
  assertFilePagination(pages);
});

test("supports a single bundle of exactly 100 train master labels", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    return line({
      id: `bulk-${number}`,
      picklistNumber: `PL-${String(Math.floor(index / 10) + 1).padStart(2, "0")}`,
      cartNumber: number,
      cartId: `BULK-CART-${number}`,
      cartBarcode: `CFCART-BULK-${number}`,
      partNumber: `BULK-PART-${number}`,
      aiagSerial: `BULK-AIAG-${number}`,
    });
  });
  const result = await generatePicklistPdf(rows, { scope: "movement" });

  assert.equal(new TextDecoder().decode(result.bytes.slice(0, 5)), "%PDF-");
  const { pages, masters } = await assertMasterPageCount(result.bytes, 100);
  const text = extractDrawnText(result.bytes);
  assert.doesNotMatch(masters.join("\n"), /PPA CART|CFCART-BULK-/);
  assert.match(text, /BULK-PART-001/);
  assert.match(text, /BULK-PART-050/);
  assert.match(text, /BULK-PART-100/);
  rows.forEach((row, index) => {
    assert.ok(masters[index].includes(row.partNumber), `master label ${index + 1} includes its part`);
    assert.ok(masters[index].includes(row.cartId), `master label ${index + 1} includes its cart ID`);
  });
  assertFilePagination(pages);
});

test("rejects a combined PDF that crosses movement boundaries", async () => {
  await assert.rejects(
    generatePicklistPdf([
      line({ id: "train-a", trainNumber: "TRAIN-A" }),
      line({ id: "train-b", trainNumber: "TRAIN-B" }),
    ], { scope: "movement" }),
    /exactly one load or train/,
  );
});

test("rejects missing barcode semantics instead of substituting unrelated identifiers", async () => {
  await assert.rejects(
    generatePicklistPdf([line({ plant: "1", masterBarcode: "" })]),
    /Cart master barcode is required/,
  );
  await assert.rejects(
    generatePicklistPdf([line({ zone: "RACK-A", movementBarcode: "" })]),
    /Movement barcode is required/,
  );
  await assert.rejects(
    generatePicklistPdf([line({
      areaType: "offsite", trainNumber: "", loadNumber: "268954", picklistNumber: "",
    })]),
    /Picklist \/ checksheet barcode is required/,
  );
});

test("prints TRAIN and LOAD master labels without an internal cart barcode", async () => {
  for (const areaType of ["onsite", "offsite"]) {
    const source = line({ areaType, loadNumber: areaType === "offsite" ? "268954" : "", cartBarcode: "" });
    const result = await generatePicklistPdf([source]);
    const { masters } = await assertMasterPageCount(result.bytes, 1);
    assert.ok(masters[0].includes(source.masterBarcode), `${areaType} retains the master barcode`);
    assert.ok(masters[0].includes(source.movementBarcode), `${areaType} retains the movement barcode`);
    assert.doesNotMatch(masters[0], /PPA CART/);
  }
});

test("prints the largest permitted quantity in full on a trailer picklist", async () => {
  const result = await generatePicklistPdf([line({
    areaType: "offsite", trainNumber: "", loadNumber: "268954", quantity: 2_147_483_647,
  })]);
  assert.match(extractDrawnText(result.bytes), /2147483647/);
});

test("keeps the cart sequence consistent across pages with different part sequences", async () => {
  const result = await generatePicklistPdf(Array.from({ length: 8 }, (_, index) => line({
    id: `continued-${index}`, cartNumber: "3", cartSequenceNumber: "", totalCarts: 4,
    sequence: String(10 + index),
  })));
  const { masters } = await assertMasterPageCount(result.bytes, 2);
  for (const text of masters) {
    assert.match(text, /3 \/ 4/);
    assert.doesNotMatch(text, /10 \/ 4|17 \/ 4/);
  }
});

test("refuses to omit invalid rows or print unsafe quantities", async () => {
  await assert.rejects(generatePicklistPdf([line(), line({ areaType: "unknown" })]), /Every PDF row/);
  await assert.rejects(generatePicklistPdf([line({ quantity: 2_147_483_648 })]), /positive whole-number/);
});

function longestPrintableLine(areaType) {
  const fields = Object.fromEntries(Object.entries(PRINTABLE_FIELD_LIMITS).map(([field, maximum]) => {
    const prefix = `${field.toUpperCase()}-`;
    return [field, `${prefix}${"X".repeat(maximum - prefix.length - 1)}Z`];
  }));
  const row = line({ ...fields, areaType, loadNumber: areaType === "offsite" ? "1234567890" : "",
    cartSequenceNumber: "1234567890/123456789", totalCarts: 4, mcid: "", quantity: 2_147_483_647,
    picklistNumber: "PL-" + "X".repeat(25), checksheetNumber: "CHK-" + "X".repeat(24),
    masterBarcode: "M".repeat(28), movementBarcode: "V".repeat(32), chassisNumber: "C".repeat(32),
    description: "Description may be abbreviated ".repeat(8),
  });
  validateImportRows([row]);
  return row;
}

test("prints maximum supported identifiers completely across both layouts", async () => {
  for (const areaType of ["onsite", "offsite"]) {
    const row = longestPrintableLine(areaType);
    const result = await generatePicklistPdf([row]);
    const text = extractDrawnText(result.bytes).replaceAll("\n", "");
    const common = ["plant", "zone", "programId", "partNumber", "color", "containerPosition", "containerType", "pickingLocation", "cartNumber", "cartId", "palletId", "picklistNumber", "packSequence", "option"];
    const specific = areaType === "onsite"
      ? ["trainNumber", "caseCode", "fromLot", "toLot", "model", "outgoingSerial", "cartSequenceNumber", "cartType", "scheduledDispatchDate", "scheduledDispatchTime", "deliveryLocation", "detailDeliveryLocation"]
      : ["chassisNumber", "orderNumber", "batchNumber", "loadingSequence", "pymtc", "fromLot", "toLot"];
    for (const field of [...common, ...specific]) assert.ok(text.includes(row[field]), `${areaType} ${field} must print in full`);
    if (areaType === "onsite") assert.ok(!text.includes("..."));
  }
});

test("prints maximum MCID identifiers and rejects overlong legacy identities", async () => {
  for (const areaType of ["onsite", "offsite"]) {
    const row = longestPrintableLine(areaType);
    row.mcid = "MCID-" + "X".repeat(29);
    const result = await generatePicklistPdf([row]);
    assert.ok(extractDrawnText(result.bytes).replaceAll("\n", "").includes(row.mcid));
    for (const field of ["partNumber", "trainNumber", "cartId", "detailDeliveryLocation"]) {
      await assert.rejects(generatePicklistPdf([{ ...row, [field]: "X".repeat(100) }]), /printable limit/);
    }
  }
});

test("inventory serial output is not substituted into the paperwork MCID field", async () => {
  for (const areaType of ["onsite", "offsite"]) {
    const row = line({ areaType, loadNumber: areaType === "offsite" ? "LOAD-123" : "", mcid: "", aiagSerial: "CONTAINER-SERIAL-NOT-MCID" });
    const result = await generatePicklistPdf([row]);
    const { masters } = await assertMasterPageCount(result.bytes, 1);
    assert.ok(!masters[0].includes(row.aiagSerial), "a fulfillment serial must not populate the master label's MCID field");
  }
});

test("preserves all model segments in the printed product code", async () => {
  const row = line({ areaType: "offsite", loadNumber: "1234567890", pymtc: "", model: "PLANT/YEAR/MODEL/TYPE/COLOR/VARIANT" });
  const result = await generatePicklistPdf([row]);
  assert.ok(extractDrawnText(result.bytes).includes(row.model));
});
