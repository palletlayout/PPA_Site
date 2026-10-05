import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream } from "pdf-lib";
import { encodeCode128 } from "../lib/code128.ts";
import { generateInventoryLabelsPdf, InventoryLabelValidationError } from "../lib/inventory-label-pdf.ts";
import { detectDemandBarcode, normalizeScanValue } from "../lib/scan-values.ts";

const require = createRequire(import.meta.url);
const { Code128Reader, BitArray, BarcodeFormat } = createRequire(require.resolve("@zxing/browser"))("@zxing/library");

function item(overrides = {}) {
  return {
    id: "inventory-1", serial: "51606101-04120568", partNumber: "7972A-THR-A000",
    partMark: "", partLevel: "", color: "", quantity: 20, unitOfMeasure: "EA",
    supplierId: "", status: "available", consumedFlag: "N", consumedQuantity: 0,
    loadedQuantity: 0, dispatchedQuantity: 0, consumedAt: null, fulfilledDemandId: null,
    weight: null, unitCost: null, receiveDate: "2026-09-26", receivedAt: "2026-09-26T12:00:00Z",
    receivedBy: "Operator", isTest: false, ...overrides,
  };
}

async function pages(bytes) {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFRawStream ? [contents]
      : contents.asArray().map((ref) => document.context.lookup(ref, PDFRawStream));
    const operators = streams.map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1")).join("\n");
    const text = [...operators.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
      .map((match) => Buffer.from(match[1], "hex").toString("latin1"));
    const bars = [...operators.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re\s+f/g)]
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) }));
    return { size: page.getSize(), text, bars, operators };
  });
}

function assertBarcode(page, y, payload, box) {
  const bars = page.bars.filter((bar) => bar.y === y);
  const encoded = encodeCode128(payload);
  const moduleWidth = Math.min(2.5, box.width / encoded.totalModules);
  let cursor = box.x + (box.width - encoded.totalModules * moduleWidth) / 2;
  const expected = [];
  for (const run of encoded.runs) {
    if (run.isBar) expected.push({ x: cursor, width: run.modules * moduleWidth });
    cursor += run.modules * moduleWidth;
  }
  assert.equal(bars.length, expected.length, `Bar count for ${payload}`);
  assert.ok(moduleWidth >= 0.7, "Narrow module must remain printable at the physical page size");
  bars.forEach((bar, index) => {
    assert.ok(Math.abs(bar.x - expected[index].x) < 0.00001, `Bar ${index} position for ${payload}`);
    assert.ok(Math.abs(bar.width - expected[index].width) < 0.00001, `Bar ${index} width for ${payload}`);
    assert.equal(bar.height, box.height);
    assert.ok(bar.x >= box.x && bar.x + bar.width <= box.x + box.width);
  });
  assert.ok(bars[0].x - box.x >= 10 * moduleWidth - 0.00001, "Leading quiet zone");
  assert.ok(box.x + box.width - bars.at(-1).x - bars.at(-1).width >= 10 * moduleWidth - 0.00001, "Trailing quiet zone");
  // Decode the PDF's actual drawing operations independently of our encoder.
  const pixelsPerPoint = 4;
  const row = new BitArray(Math.ceil(box.width * pixelsPerPoint));
  for (const bar of bars) {
    const first = Math.ceil((bar.x - box.x) * pixelsPerPoint);
    const end = Math.ceil((bar.x + bar.width - box.x) * pixelsPerPoint);
    for (let pixel = first; pixel < end; pixel++) row.set(pixel);
  }
  const decoded = new Code128Reader().decodeRow(0, row);
  assert.equal(decoded.getBarcodeFormat(), BarcodeFormat.CODE_128);
  assert.equal(decoded.getText(), payload);
}

test("creates one landscape Letter label for every container without reordering or deduplicating serials", async () => {
  const first = Object.freeze(item({ supplierId: "SUPPLIER-A" }));
  const second = Object.freeze(item({ id: "inventory-2", supplierId: "SUPPLIER-B" }));
  const result = await generateInventoryLabelsPdf(Object.freeze([first, second]));
  assert.equal(result.filename, "inventory-labels.pdf");
  const labels = await pages(result.bytes);
  assert.equal(labels.length, 2);
  for (const label of labels) {
    assert.deepEqual(label.size, { width: 792, height: 612 });
    assert.ok(label.text.includes("PART NO.(P)"));
    assert.ok(label.text.includes("PART NO. EXT (C)"));
    assert.ok(label.text.includes("D/C PART LEVEL (2P)"));
    assert.ok(label.text.includes("QUANTITY (Q)"));
    assert.ok(label.text.includes("SERIAL (1S)"));
    assert.ok(label.text.includes(first.serial));
    assert.ok(label.text.includes(first.partNumber));
    assert.match(label.operators, /3\.2 w/);
    assert.match(label.operators, /72 Tz/);
  }
  assert.ok(labels[0].text.includes("SUPPLIER-A"));
  assert.ok(labels[1].text.includes("SUPPLIER-B"));
});

test("drawn barcode bars retain all data identifier prefixes, including prefix-like canonical values", async () => {
  const result = await generateInventoryLabelsPdf([item({ serial: "1SABC", partNumber: "PPART", color: "CBLUE" })]);
  const [label] = await pages(result.bytes);
  assertBarcode(label, 462, "PPPART", { x: 32, width: 728, height: 66 });
  assertBarcode(label, 313, "CCBLUE", { x: 32, width: 380, height: 48 });
  assertBarcode(label, 223, "Q20", { x: 436, width: 312, height: 66 });
  assertBarcode(label, 32, "1S1SABC", { x: 32, width: 728, height: 66 });
  assert.ok(label.text.includes("1SABC"));
  assert.ok(!label.text.includes("1S1SABC"), "Human-readable serial stays canonical");
});

test("quantity labels use the original container quantity rather than remaining stock", async () => {
  const [label] = await pages((await generateInventoryLabelsPdf([item({
    quantity: 20, consumedQuantity: 17, remainingQuantity: 3, loadedQuantity: 17,
  })])).bytes);
  assert.ok(label.text.includes("20"));
  assert.ok(!label.text.includes("3"));
  assertBarcode(label, 223, "Q20", { x: 436, width: 312, height: 66 });
});

test("Code 128 preserves mixed-case inventory values in both displayed text and scanned data", async () => {
  const source = item({ serial: "1sAbC", partNumber: "pPart", color: "cBlue" });
  const result = await generateInventoryLabelsPdf([source]);
  const [label] = await pages(result.bytes);
  assert.ok(label.text.includes("1sAbC"));
  assert.ok(label.text.includes("pPart"));
  assert.ok(label.text.includes("cBlue"));
  assertBarcode(label, 462, "PpPart", { x: 32, width: 728, height: 66 });
  assertBarcode(label, 313, "CcBlue", { x: 32, width: 380, height: 48 });
  assertBarcode(label, 32, "1S1sAbC", { x: 32, width: 728, height: 66 });
  for (const [payload, field] of [["PpPart", "partNumber"], ["CcBlue", "color"], ["1S1sAbC", "serial"]]) {
    assert.equal(normalizeScanValue(detectDemandBarcode(payload).value), normalizeScanValue(source[field]));
  }
});

test("Code 128 scans punctuation that was unsupported by the previous Code 39 labels", async () => {
  const source = item({ serial: "sn_01:[]{}", partNumber: "part_*@#", color: "blue*" });
  const [label] = await pages((await generateInventoryLabelsPdf([source])).bytes);
  for (const value of [source.serial, source.partNumber, source.color]) assert.ok(label.text.includes(value));
  assertBarcode(label, 462, `P${source.partNumber}`, { x: 32, width: 728, height: 66 });
  assertBarcode(label, 313, `C${source.color}`, { x: 32, width: 380, height: 48 });
  assertBarcode(label, 32, `1S${source.serial}`, { x: 32, width: 728, height: 66 });
});

test("mixed-case descenders clear barcodes and rules without crossing the printable top edge", async () => {
  const source = item({ partNumber: "pgyjpgyj", serial: "gyjpgyjp", color: "jpgyjpgy", quantity: 20 });
  const [label] = await pages((await generateInventoryLabelsPdf([source])).bytes);
  const metricsDocument = await PDFDocument.create();
  const font = await metricsDocument.embedFont(StandardFonts.HelveticaBold);
  const textBounds = new Map();
  for (const match of label.operators.matchAll(/BT\s+([\s\S]*?)\s+ET/g)) {
    const block = match[1];
    const size = Number(block.match(/\/[^\s]+ ([\d.]+) Tf/)[1]);
    const baseline = Number(block.match(/1 0 0 1 [\d.]+ ([\d.]+) Tm/)[1]);
    const text = Buffer.from(block.match(/<([0-9A-Fa-f]+)>\s*Tj/)[1], "hex").toString("latin1");
    const ascent = font.heightAtSize(size, { descender: false });
    const descent = font.heightAtSize(size) - ascent;
    textBounds.set(text, { top: baseline + ascent, bottom: baseline - descent });
  }
  const part = textBounds.get(source.partNumber);
  const serial = textBounds.get(source.serial);
  const color = textBounds.get(source.color);
  const quantity = textBounds.get("20");
  const barcodeTop = (y) => Math.max(...label.bars.filter((bar) => bar.y === y).map((bar) => bar.y + bar.height));
  assert.ok(part.top <= 588, "Part value stays inside the 24-point top margin");
  assert.ok(part.bottom - barcodeTop(462) >= 6, "Part descenders clear its barcode");
  assert.ok(serial.bottom - barcodeTop(32) >= 6, "Serial descenders clear its barcode");
  assert.ok(164 - 3.2 / 2 - serial.top >= 6, "Serial ascenders clear the divider rule");
  assert.ok(color.bottom - barcodeTop(313) >= 6, "Color descenders clear its barcode");
  assert.ok(textBounds.get("PART NO. EXT (C)").bottom - color.top >= 6, "Color clears its field heading");
  assert.ok(quantity.bottom - (164 + 3.2 / 2) >= 6, "Quantity clears the divider rule");
  assert.ok(223 - quantity.top >= 6, "Quantity clears the barcode above");
});

test("measured quantities preserve all decimals, identify the unit, and encode only the quantity", async () => {
  for (const quantity of [0.000001, 1.234567, 3000.5]) {
    const [label] = await pages((await generateInventoryLabelsPdf([item({ quantity, unitOfMeasure: "KG" })])).bytes);
    assert.ok(label.text.includes(`${quantity} KG`));
    assertBarcode(label, 223, `Q${quantity}`, { x: 436, width: 312, height: 66 });
  }
});

test("unavailable fields stay empty and compatibility part marks do not invent an engineering level", async () => {
  const [label] = await pages((await generateInventoryLabelsPdf([item({
    serial: "", partNumber: "", color: "", partMark: "2PBLUE", partLevel: "00",
  })])).bytes);
  assert.deepEqual([...new Set(label.bars.map((bar) => bar.y))], [223]);
  assert.ok(!label.text.includes("00"));
  assert.ok(!label.text.some((text) => text.includes("BLUE")));
  assert.ok(!label.text.includes("SUPPLIER ID"));
});

test("barcodes remain inside their boxes with quiet zones at the longest supported serial length", async () => {
  const serial = "I".repeat(87);
  const [label] = await pages((await generateInventoryLabelsPdf([item({ serial })])).bytes);
  assert.ok(label.text.includes(serial));
  assertBarcode(label, 32, `1S${serial}`, { x: 32, width: 728, height: 66 });
  for (const bar of label.bars) {
    assert.ok(bar.x >= 24 && bar.x + bar.width <= 768);
    assert.ok(bar.y >= 24 && bar.y + bar.height <= 588);
    assert.ok(bar.width >= 0.7);
  }
});

test("unprintable or unsupported identifiers fail with a specific actionable error", async () => {
  for (const [field, value, expected] of [
    ["serial", "SN\nABC", /serial contains characters/],
    ["partNumber", "PÄRT", /part number contains characters/],
    ["color", "BLÜE", /extension \/ color contains characters/],
    ["serial", " SERIAL ", /serial has leading or trailing spaces/],
    ["supplierId", "SUPPLIER\t1", /supplier ID contains characters/],
  ]) {
    await assert.rejects(generateInventoryLabelsPdf([item({ [field]: value })]), (error) => {
      assert.ok(error instanceof InventoryLabelValidationError);
      assert.match(error.message, /Container 1/);
      assert.match(error.message, expected);
      return true;
    });
  }
});

test("overlong barcode and readable-text fields fail instead of being abbreviated or squeezed below their minimum", async () => {
  await assert.rejects(generateInventoryLabelsPdf([item({ serial: "I".repeat(88) })]), /serial is too long for a reliably scannable barcode/);
  await assert.rejects(generateInventoryLabelsPdf([item({ color: "I".repeat(44) })]), /extension \/ color is too long for a reliably scannable barcode/);
  await assert.rejects(generateInventoryLabelsPdf([item({ supplierId: "W".repeat(100) })]), /supplier ID is too long to print legibly/);
});

test("empty inventory and invalid original quantities do not produce a misleading PDF", async () => {
  await assert.rejects(generateInventoryLabelsPdf([]), /At least one inventory container/);
  for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2147483648]) {
    await assert.rejects(generateInventoryLabelsPdf([item({ quantity })]), /invalid original container quantity/);
  }
  await assert.rejects(generateInventoryLabelsPdf([item({ quantity: 0.0000001, unitOfMeasure: "KG" })]), /invalid original container quantity/);
});
