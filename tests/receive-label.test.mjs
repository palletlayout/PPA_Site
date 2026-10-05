import assert from "node:assert/strict";
import test from "node:test";
import { captureReceivingBarcode, nextReceivingField, receivingDemandMismatch } from "../lib/receive-label.ts";
import { scanSerialBarcode } from "../lib/scan-values.ts";

const ordered = ["PPART-123", "2P00", "Q20", "1SSERIAL-1"]; // part, color, quantity, then serial
test("receiving scans part, color, quantity, then serial and completes", () => {
  let values = ["", "", "", ""];
  for (const [index, raw] of ordered.entries()) {
    for (const wrong of ordered.filter((candidate) => (candidate !== raw && !(index === 1 && candidate.startsWith("Q"))))) {
      const rejected = captureReceivingBarcode(values, wrong);
      assert.equal(rejected.status, "invalid");
      assert.match(rejected.message, /not detected/);
      assert.doesNotMatch(rejected.message, /duplicate|already/i);
      assert.equal(rejected.rawValues, values);
    }
    const result = captureReceivingBarcode(values, raw);
    assert.equal(result.status, "accepted");
    assert.equal(result.count, index + 1);
    assert.equal(result.completed, index === 3);
    values = result.rawValues;
  }
  // Storage positions stay serial, part, color, quantity regardless of scan order.
  assert.deepEqual(values, [ordered[3], ordered[0], ordered[1], ordered[2]]);
  assert.equal(nextReceivingField(values), undefined);
  assert.equal(captureReceivingBarcode(values, ordered[0]).completed, false);
});

test("an unknown scanned serial is retained while fallback scans part, color, then quantity", () => {
  const serial = scanSerialBarcode("1S000-UNKNOWN");
  assert.equal(serial.ok, true);
  let values = [serial.rawValue, "", "", ""];
  for (const [field, barcode] of [["partNumber", "PPART-ANY"], ["color", "2PGRAY"], ["quantity", "Q8"]]) {
    assert.equal(nextReceivingField(values), field);
    for (const wrong of ["1SOTHER", "PPART-ANY", "2PGRAY", "Q8"].filter((raw) => (raw !== barcode && !(field === "color" && raw.startsWith("Q"))))) {
      const rejected = captureReceivingBarcode(values, wrong);
      assert.equal(rejected.status, "invalid", `${field}: ${wrong}`);
      assert.strictEqual(rejected.rawValues, values);
      assert.equal(rejected.completed, false);
      assert.equal(nextReceivingField(rejected.rawValues), field);
    }
    const accepted = captureReceivingBarcode(values, barcode);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.completed, field === "quantity");
    values = accepted.rawValues;
    assert.equal(values[0], "1S000-UNKNOWN");
  }
  assert.equal(nextReceivingField(values), undefined);
  assert.deepEqual(values, ["1S000-UNKNOWN", "PPART-ANY", "2PGRAY", "Q8"]);
});

test("restored fallback drafts reject the wrong barcode type before receipt even without fixed demand", () => {
  const valid = ["1SSERIAL", "PPART", "CBLUE", "Q8"];
  for (const [index, field, wrong] of [[0, "aiagSerial", "PPART"], [0, "aiagSerial", "SSERIAL"], [1, "partNumber", "1SSERIAL"], [2, "color", "Q8"], [3, "quantity", "CBLUE"], [3, "quantity", "Q0"]]) {
    const values = [...valid];
    values[index] = wrong;
    assert.equal(receivingDemandMismatch(values)?.field, field);
  }
  assert.equal(receivingDemandMismatch(valid), null);
});

test("invalid quantities and unidentified labels never advance", () => {
  const values = ["", "PPART", "2P00", ""];
  for (const raw of ["Q0", "Q-1", "Q1.5", "Q2147483648", "1S", "unknown", "20"]) {
    const result = captureReceivingBarcode(values, raw);
    assert.equal(result.status, "invalid", raw);
    assert.equal(result.count, 2);
    assert.equal(result.rawValues, values);
  }
});

test("the color step accepts C or 2P and preserves its identifier", () => {
  for (const raw of ["2P00", "CBLUE"]) {
    const result = captureReceivingBarcode(["1SSERIAL", "PPART", "", "Q20"], raw);
    assert.equal(result.status, "accepted");
    assert.equal(result.rawValues[2], raw);
    assert.equal(nextReceivingField(result.rawValues), undefined);
  }
});

test("explicit edits allow equal values without duplicate warnings and preserve draft slots", () => {
  const partial = ["", "PPART", "", "Q20"];
  for (const raw of ["Q20", "Q21"]) {
    const edited = captureReceivingBarcode(partial, raw, 3);
    assert.equal(edited.status, "accepted");
    assert.equal(edited.count, 2);
    assert.equal(edited.completed, false);
    assert.equal(edited.rawValues[3], raw);
  }
  assert.equal(captureReceivingBarcode(partial, "2P00", 3).status, "invalid");
  assert.equal(nextReceivingField(["1SLEGACY", "", "2P00", "Q20"]), "partNumber");
});

test("No color completes the optional color step without fabricating a color value", () => {
  const result = captureReceivingBarcode(["1SKNOWN", "PPART", "", "Q20"], "2P");
  assert.equal(result.status, "accepted");
  assert.equal(result.completed, true);
  assert.equal(result.rawValues[2], "2P");
  assert.equal(nextReceivingField(result.rawValues), undefined);
});

test("quantity directly after part completes an unknown-serial label with no color", () => {
  const draft = ["1SUNKNOWN", "PPART", "", ""];
  const result = captureReceivingBarcode(draft, "Q20");
  assert.equal(result.status, "accepted");
  assert.equal(result.completed, true);
  assert.deepEqual(result.rawValues, ["1SUNKNOWN", "PPART", "C", "Q20"]);
  assert.deepEqual(draft, ["1SUNKNOWN", "PPART", "", ""]);
  const standalone = captureReceivingBarcode(["", "PPART", "", ""], "Q20");
  assert.equal(standalone.completed, false);
  assert.equal(nextReceivingField(standalone.rawValues), "aiagSerial");
});

test("skipping color validates demand and quantity before advancing either field", () => {
  const draft = ["1SUNKNOWN", "PPART", "", ""];
  const blankDemand = { partNumber: "PART", color: "", quantity: 20 };
  assert.equal(captureReceivingBarcode(draft, "Q20", null, "EA", blankDemand).completed, true);
  for (const [barcode, demand, status] of [
    ["Q0", blankDemand, "invalid"], ["Q1.5", blankDemand, "invalid"],
    ["Q19", blankDemand, "mismatch"], ["Q20", { ...blankDemand, color: "BLUE" }, "mismatch"],
  ]) {
    const result = captureReceivingBarcode(draft, barcode, null, "EA", demand);
    assert.equal(result.status, status);
    assert.strictEqual(result.rawValues, draft);
    assert.equal(result.completed, false);
    assert.equal(nextReceivingField(result.rawValues), "color");
  }
});

test("measured receiving accepts exact decimal quantities only with a measured unit", () => {
  const values = ["", "PPART", "2P00", ""];
  assert.equal(captureReceivingBarcode(values, "Q0.125", null, "KG").status, "accepted");
  assert.equal(captureReceivingBarcode(values, "Q0.125").status, "invalid");
  assert.equal(captureReceivingBarcode(values, "Q0.0000001", null, "KG").status, "invalid");
});

const demand = { partNumber: "PART-123", color: "BLUE", quantity: 15, unitOfMeasure: "EA" };

test("packing stops on each wrong label value without saving it or advancing", () => {
  let values = ["1SSERIAL-1", "", "", ""];
  for (const [field, bad, good] of [
    ["partNumber", "POTHER-PART", "PPART-123"],
    ["color", "CRED", "CBLUE"],
    ["quantity", "Q30", "Q15"],
  ]) {
    const before = [...values];
    const rejected = captureReceivingBarcode(values, bad, null, "EA", demand);
    assert.equal(rejected.status, "mismatch");
    assert.equal(rejected.field, field);
    assert.match(rejected.message, /Wrong .*Demand requires .*scanned .*again/);
    assert.strictEqual(rejected.rawValues, values);
    assert.deepEqual(values, before);
    assert.equal(rejected.completed, false);
    assert.equal(rejected.count, values.filter(Boolean).length);
    assert.equal(nextReceivingField(rejected.rawValues), field);
    const accepted = captureReceivingBarcode(values, good, null, "EA", demand);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.completed, field === "quantity");
    values = accepted.rawValues;
  }
  assert.equal(receivingDemandMismatch(values, demand), null);
});

test("packing accepts any container serial and both printed color identifiers", () => {
  for (const serial of ["1SFIRST-CONTAINER", "1SSECOND-CONTAINER"]) {
    let values = ["", "", "", ""];
    for (const raw of ["Ppart-123", "2Pblue", "Q015", serial]) {
      const result = captureReceivingBarcode(values, raw, null, "EA", demand);
      assert.equal(result.status, "accepted");
      values = result.rawValues;
    }
    assert.equal(values[0], serial);
    assert.equal(receivingDemandMismatch(values, demand), null);
  }
});

test("packing cannot skip a required color and treats no color as an exact requirement", () => {
  const values = ["1SSERIAL", "PPART-123", "", "Q15"];
  assert.equal(captureReceivingBarcode(values, "2P", null, "EA", demand).status, "mismatch");
  const noColor = { ...demand, color: "" };
  assert.equal(captureReceivingBarcode(values, "CBLUE", null, "EA", noColor).status, "mismatch");
  for (const barcode of ["C", "2P"]) assert.equal(captureReceivingBarcode(values, barcode, null, "EA", noColor).status, "accepted");
});

test("packing quantity checks use exact quantities and matching units", () => {
  const values = ["", "PPART-123", "2PBLUE", ""];
  const measured = { ...demand, quantity: 0.125, unitOfMeasure: "KG" };
  assert.equal(captureReceivingBarcode(values, "Q0.125000", null, "KG", measured).status, "accepted");
  assert.equal(captureReceivingBarcode(values, "Q0.125001", null, "KG", measured).status, "mismatch");
  assert.equal(captureReceivingBarcode(values, "Q0.125", null, "G", measured).status, "mismatch");
  assert.equal(captureReceivingBarcode(values, "Q15", null, "KG", demand).status, "mismatch");
});

test("edited and restored packing drafts are checked against demand before receiving", () => {
  const values = ["1SSERIAL", "PPART-123", "CBLUE", "Q15"];
  const edited = captureReceivingBarcode(values, "Q30", 3, "EA", demand);
  assert.equal(edited.status, "mismatch");
  assert.strictEqual(edited.rawValues, values);
  for (const [index, raw, field] of [[1,"POTHER","partNumber"], [3,"Q30","quantity"], [2,"CRED","color"]]) {
    const restored = [...values];
    restored[index] = raw;
    assert.equal(receivingDemandMismatch(restored, demand)?.field, field);
  }
  assert.equal(receivingDemandMismatch(values, demand, "KG")?.field, "quantity");
  assert.equal(receivingDemandMismatch(values, { ...demand, quantity: 30 })?.field, "quantity");
});

test("standalone receiving still accepts stock without any demand requirement", () => {
  let values = ["", "", "", ""];
  for (const raw of ["POTHER-PART", "CRED", "Q30", "1SUNPLANNED-STOCK"]) {
    const result = captureReceivingBarcode(values, raw);
    assert.equal(result.status, "accepted");
    values = result.rawValues;
  }
  assert.equal(receivingDemandMismatch(values), null);
});

test("multiple-container receiving stops at the first wrong field and preserves scan order", () => {
  const partial = { ...demand, quantity: 10, packingMode: "multiple" };
  let values = ["", "", "", ""];
  for (const [field, wrong, correct] of [["partNumber", "POTHER", "PPART-123"], ["color", "CRED", "CBLUE"]]) {
    const rejected = captureReceivingBarcode(values, wrong, null, "EA", partial);
    assert.equal(rejected.status, "mismatch");
    assert.equal(rejected.field, field);
    assert.strictEqual(rejected.rawValues, values);
    assert.equal(rejected.completed, false);
    assert.equal(nextReceivingField(rejected.rawValues), field);
    assert.equal(captureReceivingBarcode(values, "Q5", null, "EA", partial).status, field === "color" ? "mismatch" : "invalid");
    assert.equal(captureReceivingBarcode(values, "1SNEW", null, "EA", partial).status, "invalid");
    const accepted = captureReceivingBarcode(values, correct, null, "EA", partial);
    assert.equal(accepted.status, "accepted");
    values = accepted.rawValues;
  }
  const badQuantity = captureReceivingBarcode(values, "Q0", null, "EA", partial);
  assert.equal(badQuantity.status, "invalid");
  assert.strictEqual(badQuantity.rawValues, values);
  assert.equal(nextReceivingField(badQuantity.rawValues), "quantity");
  const quantity = captureReceivingBarcode(values, "Q5", null, "EA", partial);
  assert.equal(quantity.status, "accepted");
  assert.equal(quantity.completed, false);
  assert.equal(nextReceivingField(quantity.rawValues), "aiagSerial");
  const serial = captureReceivingBarcode(quantity.rawValues, "1SNEW", null, "EA", partial);
  assert.equal(serial.status, "accepted");
  assert.equal(serial.completed, true);
  assert.equal(receivingDemandMismatch(serial.rawValues, partial, "EA"), null);
});

test("multiple-container receiving accepts different container quantities while enforcing the unit", () => {
  const values = ["", "PPART-123", "CBLUE", ""];
  const partial = { ...demand, quantity: 0.1, unitOfMeasure: "KG", packingMode: "multiple" };
  for (const raw of ["Q0.025", "Q0.1", "Q0.5"]) {
    const result = captureReceivingBarcode(values, raw, null, "KG", partial);
    assert.equal(result.status, "accepted", raw);
    assert.equal(result.completed, false);
    assert.equal(receivingDemandMismatch(result.rawValues, partial, "KG"), null);
  }
  assert.equal(captureReceivingBarcode(values, "Q0.1", null, "G", partial).status, "mismatch");
  assert.equal(captureReceivingBarcode(values, "Q0.0000001", null, "KG", partial).status, "invalid");
  assert.equal(captureReceivingBarcode(values, "Q0.5", null, "KG", { ...partial, packingMode: "exact" }).status, "mismatch");
});

test("restored partial-mode drafts report the earliest incorrect requirement", () => {
  const partial = { ...demand, quantity: 10, packingMode: "multiple" };
  const values = ["1SNEW", "POTHER", "CRED", "Q0"];
  assert.equal(receivingDemandMismatch(values, partial)?.field, "partNumber");
  values[1] = "PPART-123";
  assert.equal(receivingDemandMismatch(values, partial)?.field, "color");
  values[2] = "CBLUE";
  assert.equal(receivingDemandMismatch(values, partial)?.field, "quantity");
  values[3] = "Q5";
  assert.equal(receivingDemandMismatch(values, partial), null);
});

test("sequential receiving compares supported printed parts with their compact barcode", () => {
  const formatted = { ...demand, partNumber: "83280-TYA-A011-M1" };
  assert.equal(captureReceivingBarcode(["", "", "", ""], "P83280TYAA011M1", null, "EA", formatted).status, "accepted");
  assert.equal(captureReceivingBarcode(["", "", "", ""], "PPART123", null, "EA", demand).status, "mismatch");
});
