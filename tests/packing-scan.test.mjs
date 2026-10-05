import assert from "node:assert/strict";
import test from "node:test";
import { packingReceiptForResult } from "../lib/packing-scan.ts";
import { captureReceivingBarcode, nextReceivingField } from "../lib/receive-label.ts";

test("the first unknown serial response starts capture with that serial retained", () => {
  for (const serial of ["1SNEW", "1S1SNEW", "1SPART-LIKE", "1S0000123"]) {
    const receipt = packingReceiptForResult({ ok: false, reason: "inventory_not_found" }, serial);
    assert.deepEqual(receipt, { serial, capturing: true });
    let values = [receipt.serial, "", "", ""];
    assert.equal(nextReceivingField(values), "partNumber");
    for (const raw of ["PPART", "2PM4", "Q2"]) {
      const captured = captureReceivingBarcode(values, raw);
      assert.equal(captured.status, "accepted");
      values = captured.rawValues;
    }
    assert.equal(values[0], serial);
    assert.equal(nextReceivingField(values), undefined);
  }
});

test("only confirmed missing or expected stock opens receiving", () => {
  const inventory = { id: "expected", serial: "1SREAL" };
  assert.deepEqual(packingReceiptForResult({ reason: "inventory_expected", inventory }, "1S1SREAL"),
    { serial: "1S1SREAL", capturing: true, inventory });
  for (const reason of [undefined, "inventory_expected", "inventory_mismatch", "inventory_consumed", "lock_lost", "ambiguous_serial"]) {
    assert.equal(packingReceiptForResult({ reason }, "1SNEW"), null);
  }
});

test("canonical missing-container responses generate exactly one receiving barcode prefix", () => {
  assert.deepEqual(packingReceiptForResult({ reason:"inventory_not_found", serial:"1SREAL" }, "1SREAL"),
    { serial:"1S1SREAL", capturing:true });
});
