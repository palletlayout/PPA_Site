import assert from "node:assert/strict";
import test from "node:test";
import { captureLabelBarcode, sameLabelBarcode } from "../lib/label-capture.ts";

// The four printed values from the user's physical container label.
const label = ["P7972A-THR-A000", "Q20", "2P00", "1S51606101-04120566"];

function permutations(values) {
  if (!values.length) return [[]];
  return values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map((rest) => [value, ...rest]));
}

test("all scan orders count each barcode once and announce completion only on the fourth distinct type", () => {
  for (const order of permutations(label)) {
    let captured = {};
    let completions = 0;
    for (const [index, raw] of order.entries()) {
      const accepted = captureLabelBarcode(captured, raw);
      assert.equal(accepted.status, "accepted");
      assert.equal(accepted.count, index + 1);
      completions += Number(accepted.completed);
      captured = accepted.captured;
      for (let repeat = 0; repeat < 5; repeat++) {
        const duplicate = captureLabelBarcode(captured, raw);
        assert.equal(duplicate.status, "duplicate");
        assert.equal(duplicate.count, index + 1);
        assert.equal(duplicate.completed, false);
        assert.equal(duplicate.captured, captured, "a duplicate cannot replace or add a value");
      }
    }
    assert.equal(completions, 1);
    assert.deepEqual(Object.keys(captured).sort(), ["aiagSerial", "color", "partNumber", "quantity"]);
  }
});

test("scanner framing, case, part formatting, and quantity zero padding do not create extra scans", () => {
  for (const [first, repeated] of [
    [label[0], "\u0002]C0p7972a-thr-a000 .&\r\n"],
    [label[1], "q00020"],
    [label[2], "2p00"],
    [label[3], "\t1s51606101-04120566\r"],
  ]) {
    assert.equal(sameLabelBarcode(first, repeated), true);
    const initial = captureLabelBarcode({}, first);
    assert.equal(captureLabelBarcode(initial.captured, repeated).status, "duplicate");
  }
  assert.equal(sameLabelBarcode("P20", "Q20"), false, "the same value in different barcode types is not a duplicate");
});

test("a different part or serial for an occupied type cannot silently overwrite a captured label", () => {
  let captured = captureLabelBarcode({}, label[0]).captured;
  captured = captureLabelBarcode(captured, label[3]).captured;
  for (const raw of ["POTHER-PART", "1SOTHER-CONTAINER"]) {
    const result = captureLabelBarcode(captured, raw);
    assert.equal(result.status, "conflict");
    assert.equal(result.captured, captured);
    assert.equal(result.completed, false);
  }
});

test("invalid quantities and incomplete reads cannot trigger the four-label completion signal", () => {
  let captured = {};
  for (const raw of [label[0], label[2], label[3]]) captured = captureLabelBarcode(captured, raw).captured;
  for (const raw of ["Q0", "Q-2", "Q1.5", "Q2147483648", "Q", "", "Q20\nPOTHER", `P${"X".repeat(513)}`]) {
    const result = captureLabelBarcode(captured, raw);
    assert.equal(result.status, "invalid", raw);
    assert.equal(result.count, 3);
    assert.equal(result.completed, false);
    assert.equal(result.captured, captured);
  }
  assert.equal(captureLabelBarcode(captured, "Q20").completed, true);
});

test("clearing a field or starting a new label permits a new completion without carrying old reads", () => {
  let captured = {};
  for (const raw of label) captured = captureLabelBarcode(captured, raw).captured;
  const next = { ...captured };
  delete next.quantity;
  assert.equal(captureLabelBarcode(next, "Q21").completed, true);
  assert.equal(captureLabelBarcode({}, label[0]).count, 1);
  assert.equal(captureLabelBarcode({}, label[0]).completed, false);
});
