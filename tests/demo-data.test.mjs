import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generatePicklistPdf } from "../lib/picklist-pdf.ts";
import { cartBarcodeForHeaderId } from "../lib/cart-identity.ts";
import { parseDemandSpreadsheet } from "../lib/spreadsheet-import.ts";

test("the downloadable demo imports and every picklist generates a PDF", async () => {
  const file = await readFile(new URL("../public/cartflow-demo-pick-list.csv", import.meta.url));
  const header = new TextDecoder().decode(file).split(/\r?\n/, 1)[0].split(",");
  assert.deepEqual(header.slice(0, 2), ["Type", "Train/Load Number"]);
  assert.equal(new Set(header).size, header.length);
  for (const name of ["Loading Sequence", "Header Delivery Location", "Detail Delivery Location", "Final Required Quantity"]) assert.ok(header.includes(name));

  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const rows = await parseDemandSpreadsheet(buffer);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.slice(0, 2).map((row) => row.quantity), [60, 20]);
  assert.equal(rows[0].description, "COVER, FR");
  assert.equal(rows[0].pymtc, "T30B/ALL/O/I/EXTCOLR");
  assert.equal(rows[0].detailDeliveryLocation, "H320R1");
  assert.equal(rows[0].containerTotal, 0);
  assert.ok(rows.filter((row) => row.areaType === "onsite").every((row) => row.totalCarts === 7));
  assert.equal(new Set(rows.map((row) => `${row.cartNumber}::${row.cartId}`)).size, 8);

  assert.equal(rows[0].deliveryLocation, "DOCK01");
  assert.ok(rows.slice(8).every(row => row.areaType === "offsite" && row.loadNumber === "LD9002" && row.trainNumber === "" && row.loadingSequence === "51"));
  const picklists = new Map();
  rows.forEach((row, index) => {
    const movement = row.areaType === "onsite" ? row.trainNumber : row.loadNumber;
    const key = [row.areaType, movement, row.picklistNumber].join("::");
    const lines = picklists.get(key) || [];
    lines.push({
      ...row,
      id: `demo-${index + 1}`,
      batchId: "demo-batch",
      cartBarcode: cartBarcodeForHeaderId(`${key}::${row.cartNumber}::${row.cartId}`),
      loadedAt: null,
      loadedBy: "",
      status: "pending",
      verifiedAt: null,
    });
    picklists.set(key, lines);
  });

  assert.equal(picklists.size, 8);
  for (const lines of picklists.values()) assert.equal(new Set(lines.map((line) => line.cartId)).size, 1);
  for (const lines of picklists.values()) {
    const result = await generatePicklistPdf(lines);
    assert.equal(new TextDecoder().decode(result.bytes.slice(0, 5)), "%PDF-");
    assert.ok(result.bytes.length > 1_000);
  }
});
