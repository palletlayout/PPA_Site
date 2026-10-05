import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import * as XLSX from "xlsx";
import { generatePicklistPdf } from "../lib/picklist-pdf.ts";
import { mapDemandRecords, parseDemandSpreadsheet } from "../lib/spreadsheet-import.ts";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demand-header-template.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);
const { Code128Reader, BitArray, BarcodeFormat } = createRequire(require.resolve("@zxing/browser"))("@zxing/library");

const metadataHeaders = {
  containerSequence: "Container sequence",
  fromModel: "From Model", fromType: "From Type ", fromOption: "From Option",
  fromColor: "From Color", fromInteriorColor: "From Interior Color", fromUnits: "From Units",
  toModel: "To  Model", toType: "To Type ", toOption: "To Option",
  toColor: "To Color", toInteriorColor: "To Interior Color", toUnits: "To Units",
};

function records() {
  return fixture.rows.map((cells) => Object.fromEntries(fixture.headers.map((header, index) => [header, cells[index]])));
}

function cartLines(rows) {
  return rows.map((row, index) => ({
    ...row, id: `demand-${index + 1}`, batchId: "demand-field-regression",
    cartBarcode: `CFCART-DEMAND-${row.picklistNumber}`, loadedAt: null, loadedBy: "",
    status: "pending", verifiedAt: null, fulfilledQuantity: 0, inventoryItemId: null,
    allocations: [],
  }));
}

async function decodedPages(bytes) {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFRawStream ? [contents]
      : contents.asArray().map((ref) => document.context.lookup(ref, PDFRawStream));
    const operators = streams.map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1")).join("\n");
    const entries = [...operators.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
      .map((match) => Buffer.from(match[1], "hex").toString("latin1"));
    const textItems = [...operators.matchAll(/BT\s+([\s\S]*?)\s+ET/g)].flatMap((match) => {
      const text = match[1].match(/<([0-9A-Fa-f]+)>\s*Tj/);
      const position = match[1].match(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/);
      return text && position ? [{ text: Buffer.from(text[1], "hex").toString("latin1"), x: Number(position[1]), y: Number(position[2]) }] : [];
    });
    const rectangles = [...operators.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re\s+f/g)]
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) }));
    // pdf-lib may express rectangles as four line segments after translating
    // the origin instead of using the compact PDF `re` operator.
    for (const match of operators.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) cm\s+(?:1 0 0 1 0 0 cm\s+)*0 0 m\s+0 ([\d.]+) l\s+([\d.]+) [\d.]+ l\s+[\d.]+ 0 l\s+h\s+f/g)) {
      rectangles.push({ x: Number(match[1]), y: Number(match[2]), width: Number(match[4]), height: Number(match[3]) });
    }
    const bars = rectangles.filter((rectangle) => rectangle.height >= 15 && rectangle.width <= 32);
    return { size: page.getSize(), entries, textItems, text: entries.join("\n"), compact: entries.join(""), operators, bars };
  });
}

function decodeDrawnBarcodes(page) {
  const bands = [];
  const scale = 8;
  for (const y of new Set(page.bars.map((bar) => bar.y))) {
    const payloads = [];
    const row = new BitArray(Math.ceil(page.size.width * scale));
    for (const bar of page.bars.filter((candidate) => candidate.y === y)) {
      for (let pixel = Math.ceil(bar.x * scale); pixel < Math.ceil((bar.x + bar.width) * scale); pixel += 1) row.set(pixel);
    }
    // A row may contain several side-by-side symbols. Remove each decoded
    // symbol and continue, testing the PDF's actual bars rather than its encoder.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let decoded;
      try {
        decoded = new Code128Reader().decodeRow(0, row);
      } catch {
        break;
      }
      assert.equal(decoded.getBarcodeFormat(), BarcodeFormat.CODE_128);
      payloads.push(decoded.getText());
      const end = Math.ceil(Math.max(...decoded.getResultPoints().map((point) => point.getX())));
      let clearTo = end;
      while (clearTo < row.getSize() && row.get(clearTo)) clearTo += 1;
      for (let pixel = 0; pixel <= clearTo && pixel < row.getSize(); pixel += 1) if (row.get(pixel)) row.flip(pixel);
    }
    bands.push({ y, payloads });
  }
  return bands.sort((a, b) => b.y - a.y);
}

function assertOnlyMasterLabels(pages) {
  for (const page of pages) {
    assert.deepEqual(page.size, { width: 612, height: 792 });
    assert.ok(page.entries.includes("CART MASTER LABEL"));
    assert.doesNotMatch(page.text, /PACKING DETAIL|See detail/i);
  }
}

test("all 37 supplied demand columns survive XLSX import and TRAIN/LOAD checksheet output", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([fixture.headers, ...fixture.rows]), "Demand");
  const parsed = await parseDemandSpreadsheet(XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true }));
  const lines = cartLines(parsed);
  assert.equal(fixture.headers.length, 37);
  assert.equal(Object.keys(metadataHeaders).length, 13);

  for (const areaType of ["onsite", "offsite"]) {
    const selected = lines.filter((line) => line.areaType === areaType);
    const result = await generatePicklistPdf(selected, { scope: "movement" });
    const pages = await decodedPages(result.bytes);
    assertOnlyMasterLabels(pages);
    assert.equal(pages.length, 1, "short demand groups need only their master label");
    const text = pages.map((page) => page.compact).join("");
    for (const line of selected) {
      const sourceIndex = lines.indexOf(line);
      for (const [column, header] of fixture.headers.entries()) {
        const expected = fixture.rows[sourceIndex][column];
        assert.ok(text.toUpperCase().includes(expected.toUpperCase()), `${areaType} row ${sourceIndex + 2}: ${header} (${expected}) is printed`);
      }
      for (const [field, header] of Object.entries(metadataHeaders)) {
        assert.equal(line[field], fixture.rows[sourceIndex][fixture.headers.indexOf(header)]);
        assert.ok(text.includes(line[field]), `${areaType} prints complete, case-preserved ${field}`);
      }
    }
  }
});

test("container sequence, packing sequence, lot units, and required quantity remain distinct", async () => {
  const source = { ...records()[0], "Container Packing Sequence": "071", "Container sequence": "0893", "Final Required Quantity": "15", "From Units": "0030", "To Units": "0040" };
  const [line] = cartLines(mapDemandRecords([source]));
  const pages = await decodedPages((await generatePicklistPdf([line])).bytes);
  const text = pages.map((page) => page.text).join("\n");
  assertOnlyMasterLabels(pages);
  assert.match(text, /Pack Seq\./);
  assert.match(text, /Cont\. Seq\./);
  assert.match(text, /\b071\b/);
  assert.match(text, /\b0893\b/);
  assert.match(text, /15 EA/);
  assert.match(text, /\b0030\b/);
  assert.match(text, /\b0040\b/);
  assert.equal(line.quantity, 15);
});

test("different From/To combinations print only in the header, above every demand item", async () => {
  const lines = cartLines(mapDemandRecords(records().slice(0, 2)));
  const pages = await decodedPages((await generatePicklistPdf(lines)).bytes);
  const text = pages.map((page) => page.compact).join("");
  for (const line of lines) {
    for (const field of Object.keys(metadataHeaders)) assert.ok(text.includes(line[field]), `${line.id}: ${field}`);
  }
  assertOnlyMasterLabels(pages);
  assert.doesNotMatch(pages[0].text, /Per row|From Lot:|To Lot:/i);
  for (const page of pages) {
    const divider = page.textItems.find((item) => item.text === "O/G Serial# :").y;
    const header = page.textItems.filter((item) => item.y > divider && item.y <= 635).map((item) => item.text).join("");
    const body = page.textItems.filter((item) => item.y < divider).map((item) => item.text).join("");
    for (const line of lines) {
      for (const field of Object.keys(metadataHeaders).filter((field) => field !== "containerSequence")) {
        assert.ok(header.includes(line[field]), `${field} belongs in the header`);
        assert.ok(!body.includes(line[field]), `${field} is absent from the line items`);
      }
      assert.ok(body.includes(line.partNumber), "part rows remain in the body");
    }
  }
});

test("shared From/To combinations appear once in the header, including source zero units", async () => {
  const source = { ...records()[0], "From Units": "0", "To Units": "0000" };
  const lines = cartLines(mapDemandRecords([
    source,
    { ...source, "Part Number": "ANOTHER-PART", "Container Packing Sequence": "002", "Container sequence": "0002" },
  ]));
  const pages = await decodedPages((await generatePicklistPdf(lines)).bytes);
  assert.equal(pages.length, 1);
  for (const field of ["fromModel", "fromType", "fromOption", "fromColor", "fromInteriorColor", "toModel", "toType", "toOption", "toColor", "toInteriorColor"]) {
    assert.equal(pages[0].compact.split(lines[0][field]).length - 1, 1, `${field} is not repeated for identical combinations`);
  }
  const headerLines = pages[0].textItems.filter((item) => item.y > 548 && item.y < 635).map((item) => item.text);
  assert.ok(headerLines.some((text) => text.endsWith(" / 0")));
  assert.ok(headerLines.some((text) => text.endsWith(" / 0000")));
  assert.ok(pages[0].compact.includes("ANOTHER-PART"));
});

test("long source metadata wraps across continued master labels without losing characters", async () => {
  const source = { ...records()[0] };
  for (const [field, header] of Object.entries(metadataHeaders)) {
    const prefix = `${field}-`;
    source[header] = `${prefix}${"X".repeat(512 - prefix.length - 4)}-END`;
  }
  const [line] = cartLines(mapDemandRecords([source]));
  const pages = await decodedPages((await generatePicklistPdf([line])).bytes);
  assert.ok(pages.length > 2, "long metadata needs readable continuation pages");
  assertOnlyMasterLabels(pages);
  const headerText = pages.map((page) => {
    const divider = page.textItems.find((item) => item.text === "O/G Serial# :").y;
    return page.textItems.filter((item) => item.y > divider && item.y < 635 && !/^(FROM|TO) Lot#/.test(item.text)).map((item) => item.text).join("");
  }).join("");
  const bodyText = pages.map((page) => {
    const divider = page.textItems.find((item) => item.text === "Position").y;
    return page.textItems.filter((item) => item.y < divider && item.y >= 166).map((item) => item.text).join("");
  }).join("");
  for (const field of Object.keys(metadataHeaders).filter((field) => field !== "containerSequence")) {
    assert.ok(headerText.includes(line[field]), `${field} is printed losslessly in the header across pages`);
    assert.ok(!bodyText.includes(line[field]), `${field} is never printed in a demand item`);
  }
  assert.ok(bodyText.includes(line.containerSequence), "the long container sequence remains part-specific");
  for (const [index, page] of pages.entries()) {
    if (index > 0) assert.ok(page.entries.includes("CONTINUED"));
    assert.deepEqual(decodeDrawnBarcodes(page).map((band) => band.payloads), [[line.masterBarcode], [line.movementBarcode]], "continuations retain the same two business barcodes");
    for (const item of page.textItems.filter((item) => item.text.includes("XXXXX"))) {
      const bodyHeading = page.textItems.find((candidate) => candidate.text === "Position").y;
      assert.ok(item.y >= 166 && item.y <= 635, "long source values stay inside their printable region");
      if (item.y > bodyHeading) assert.ok(item.y > page.textItems.find((candidate) => candidate.text === "O/G Serial# :").y, "vehicle metadata stays above the operational header and parts");
    }
  }
});

test("new demand metadata cannot silently print Unicode as replacement question marks", async () => {
  const [line] = cartLines(mapDemandRecords([records()[0]]));
  for (const field of Object.keys(metadataHeaders)) {
    await assert.rejects(generatePicklistPdf([{ ...line, [field]: "VALUE-\u00e9" }]), /cannot be printed losslessly|printable ASCII|unsupported character/i, field);
  }
});

test("every TRAIN and LOAD master page has exactly two Code 128 bands: master above, movement below", async () => {
  const lines = cartLines(mapDemandRecords(records()));
  for (const source of [lines[0], lines[2]]) {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      ...source, id: `continued-${index}`, sequence: String(index + 1), packSequence: String(index + 1),
    }));
    const pages = await decodedPages((await generatePicklistPdf(rows)).bytes);
    assertOnlyMasterLabels(pages);
    assert.ok(pages.length >= 2, `${source.areaType}: test includes a continuation master label`);
    for (const [index, master] of pages.entries()) {
      const bands = decodeDrawnBarcodes(master);
      assert.equal(bands.length, 2, `${source.areaType} master ${index + 1}: exactly two barcode bands`);
      assert.ok(bands[0].y > master.size.height / 2, "the master barcode is in the upper half");
      assert.ok(bands[1].y < master.size.height / 4, "the movement barcode is at the bottom");
      assert.deepEqual(bands.map((band) => band.payloads), [[source.masterBarcode], [source.movementBarcode]],
        `${source.areaType} master ${index + 1}: actual vector bars decode exactly the intended master and movement payloads`);
      assert.ok(!master.text.includes(source.cartBarcode), "the internal cart alias is not printed on a master label");
    }
  }
});

test("a long accepted ship category prints losslessly on its master label", async () => {
  const source = { ...records()[0], "Ship Category": "SHIP-CATEGORY-" + "X".repeat(40) };
  const [line] = cartLines(mapDemandRecords([source]));
  // Exercise the category-only trigger, independent of the new metadata.
  for (const field of Object.keys(metadataHeaders)) line[field] = "";
  const pages = await decodedPages((await generatePicklistPdf([line])).bytes);
  assertOnlyMasterLabels(pages);
  assert.equal(pages.length, 1);
  assert.ok(pages[0].compact.includes(line.shipCategory));
});

test("37-column demand produces exactly three master labels per movement for 3, 5, and 4 demand rows", async () => {
  for (const areaType of ["TRAIN", "LOAD"]) {
    const input = [3, 5, 4].flatMap((count, groupIndex) => Array.from({ length: count }, (_, index) => {
      const number = groupIndex * 10 + index + 1;
      return {
        ...records()[areaType === "TRAIN" ? 0 : 2],
        "Type": areaType,
        "Train/Load Number": areaType === "TRAIN" ? "TP00001" : "L000001",
        "Movement Barcode": areaType === "TRAIN" ? "AE3TP00001XSGS" : "L000001",
        "Picklist Number": `Z101000000000000${groupIndex + 1}`,
        "Master Barcode": `Z101000000000000${groupIndex + 1}`,
        "Checksheet Number": `Z101000000000000${groupIndex + 1}`,
        "Cart Sequence Number": `0${groupIndex + 1}`,
        "Cart ID": `CART-${groupIndex + 1}`,
        "Part Number": `PART-${number}`,
        "Container Packing Sequence": String(index + 1).padStart(3, "0"),
        "Container sequence": String(index + 1).padStart(2, "0"),
        "From Model": `MDL${number}`, "From Type ": `TYP${number}`, "From Option": `OPT${number}`,
        "From Color": `CLR${number}`, "From Interior Color": `ICLR${number}`, "From Units": String(number + 30),
        "To  Model": `MDL${number + 1}`, "To Type ": `TYP${number + 1}`, "To Option": `OPT${number + 1}`,
        "To Color": `CLR${number + 1}`, "To Interior Color": `ICLR${number + 1}`, "To Units": String(number + 31),
      };
    }));
    const lines = cartLines(mapDemandRecords(input));
    const pages = await decodedPages((await generatePicklistPdf(lines, { scope: "movement" })).bytes);
    assertOnlyMasterLabels(pages);
    assert.equal(pages.length, 3, `${areaType}: three cart masters and no appended report`);
    for (const [index, page] of pages.entries()) {
      const group = lines.filter((line) => line.masterBarcode.endsWith(String(index + 1)));
      assert.deepEqual(decodeDrawnBarcodes(page).map((band) => band.payloads), [[group[0].masterBarcode], [group[0].movementBarcode]]);
      assert.ok(page.text.includes(`File: ${index + 1} Of 3`));
      for (const line of group) {
        assert.ok(page.compact.includes(line.partNumber), `${line.id} remains on its own master label`);
        for (const field of Object.keys(metadataHeaders)) assert.ok(page.compact.includes(line[field]), `${line.id} ${field} is on the same page`);
      }
    }
  }
});

test("section PDFs include both movements and all six masters with each movement's own barcode", async () => {
  for (const areaType of ["TRAIN", "LOAD"]) {
    const input = [1, 2].flatMap((movement) => [1, 2, 3].map((master) => ({
      ...records()[areaType === "TRAIN" ? 0 : 2],
      "Type": areaType,
      "Train/Load Number": areaType === "TRAIN" ? `TP0000${movement}` : `L00000${movement}`,
      "Movement Barcode": areaType === "TRAIN" ? `AE3TP0000${movement}XSGS` : `L00000${movement}`,
      // Reuse picklist/cart identities to exercise separation by movement.
      "Picklist Number": `PICK-${master}`,
      "Master Barcode": `MASTER-${movement}-${master}`,
      "Checksheet Number": `MASTER-${movement}-${master}`,
      "Cart ID": `CART-${master}`,
      "Part Number": `PART-${movement}-${master}`,
    })));
    const lines = cartLines(mapDemandRecords(input));
    const result = await generatePicklistPdf([...lines].reverse(), { scope: "section" });
    assert.equal(result.filename, areaType === "TRAIN" ? "trains-all-checksheets.pdf" : "loads-all-checksheets.pdf");
    const pages = await decodedPages(result.bytes);
    assertOnlyMasterLabels(pages);
    assert.equal(pages.length, 6);
    pages.forEach((page, index) => {
      const line = lines[index];
      assert.deepEqual(decodeDrawnBarcodes(page).map((band) => band.payloads), [[line.masterBarcode], [line.movementBarcode]]);
      assert.ok(page.text.includes(line.partNumber));
      assert.ok(page.text.includes(`File: ${index + 1} Of 6`));
    });
  }
});

test("section PDFs reject mixing loads and trains", async () => {
  const lines = cartLines(mapDemandRecords(records()));
  await assert.rejects(generatePicklistPdf(lines, { scope: "section" }), /only loads or only trains/);
});
