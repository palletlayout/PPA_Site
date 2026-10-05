import assert from "node:assert/strict";
import test from "node:test";
import { captureLabelBarcode } from "../lib/label-capture.ts";
import { checkPackingDemand } from "../lib/packing-demand.ts";
import { captureReceivingBarcode, receivingDemandMismatch } from "../lib/receive-label.ts";
import { packingScanFeedback, receivingScanFeedback, SCAN_FEEDBACK } from "../lib/scan-feedback.ts";

const phraseFor = (result) => SCAN_FEEDBACK[receivingScanFeedback(result)];

test("packing speech distinguishes used stock, fulfilled demand, and a container outside the picklist", () => {
  const demand = { partNumber: "PART-1", color: "BLUE", quantity: 20, unitOfMeasure: "EA" };
  const fulfilled = checkPackingDemand([{ ...demand, status: "verified" }], demand);
  assert.equal(fulfilled.reason, "demand_fulfilled");
  assert.equal(SCAN_FEEDBACK[packingScanFeedback(fulfilled.reason)], "Demand already fulfilled");
  assert.equal(SCAN_FEEDBACK[packingScanFeedback("inventory_consumed")], "Container already used");
  assert.notEqual(packingScanFeedback(fulfilled.reason), "alreadyScanned", "a full demand does not prove this container was previously scanned");
  for (const reason of ["no_matching_demand", "content_mismatch", "inventory_mismatch"]) {
    assert.equal(SCAN_FEEDBACK[packingScanFeedback(reason)], "Not in picklist");
  }
});

test("detailed packing mismatches retain identifiers while spoken feedback contains none", () => {
  const part = "SCANNED-PART-7972A-THR-A000-51606101-04120568";
  const color = "SCANNED-COLOR-BATCH-04120568";
  const result = checkPackingDemand([
    { partNumber: "REQUIRED-PART-9999", color: "REQUIRED-COLOR", quantity: 20, sequence: "1234", status: "pending" },
  ], { partNumber: part, color, quantity: 35 });
  assert.equal(result.reason, "no_matching_demand");
  for (const value of [part, color, "REQUIRED-PART-9999", "1234"]) assert.ok(result.message.includes(value));
  assert.equal(SCAN_FEEDBACK[packingScanFeedback(result.reason)], "Not in picklist");
  assert.equal(SCAN_FEEDBACK[packingScanFeedback(result.message)], "Check screen", "an unexpected full message never becomes speech");
});

test("receiving mismatches speak only the field while keeping expected and actual values on screen", () => {
  const demand = { partNumber: "REQUIRED-PART-51606101-04120568", color: "REQUIRED-BLUE-04120568", quantity: 20 };
  for (const { values, raw, actual, expected, phrase } of [
    { values: ["", "", "", ""], raw: "PSCANNED-PART-7972A-THR-A000", actual: "SCANNED-PART-7972A-THR-A000", expected: demand.partNumber, phrase: "Wrong part number" },
    { values: ["", `P${demand.partNumber}`, "", ""], raw: "CSCANNED-RED-51606101", actual: "SCANNED-RED-51606101", expected: demand.color, phrase: "Wrong color" },
    { values: ["", `P${demand.partNumber}`, `C${demand.color}`, ""], raw: "Q123456", actual: "123456 EA", expected: "20 EA", phrase: "Wrong quantity" },
  ]) {
    const result = captureReceivingBarcode(values, raw, null, "EA", demand);
    assert.equal(result.status, "mismatch");
    assert.strictEqual(result.rawValues, values);
    assert.ok(result.message.includes(actual));
    assert.ok(result.message.includes(expected));
    assert.equal(phraseFor(result), phrase);
  }
});

test("out-of-order receiving reads announce the expected field rather than the scanned identifier", () => {
  for (const [values, raw, field, phrase] of [
    [["", "", "", ""], "1S51606101-04120568", "partNumber", "Scan part number"],
    [["", "PPART", "", ""], "1S51606101-04120568", "color", "Scan color"],
    [["", "PPART", "CBLUE", ""], "1S51606101-04120568", "quantity", "Scan quantity"],
    [["", "PPART", "CBLUE", "Q20"], "PPART-7972A-THR-A000", "aiagSerial", "Scan serial"],
  ]) {
    const result = captureReceivingBarcode(values, raw);
    assert.equal(result.status, "invalid");
    assert.equal(result.field, field);
    assert.strictEqual(result.rawValues, values);
    assert.equal(phraseFor(result), phrase);
  }
});

test("invalid quantity after an implicit blank color still requests quantity without advancing", () => {
  const values = ["", "PPART", "", ""];
  for (const raw of ["Q", "Q0", "Q1.5", "Q2147483648"]) {
    const result = captureReceivingBarcode(values, raw);
    assert.equal(result.status, "invalid", raw);
    assert.equal(result.field, "quantity", raw);
    assert.equal(phraseFor(result), "Scan quantity", raw);
    assert.strictEqual(result.rawValues, values);
    assert.equal(result.count, 1);
    assert.equal(result.completed, false);
  }
  const missingRequiredColor = captureReceivingBarcode(values, "Q20", null, "EA", { partNumber: "PART", color: "BLUE", quantity: 20 });
  assert.equal(missingRequiredColor.status, "mismatch");
  assert.equal(missingRequiredColor.field, "color");
  assert.equal(phraseFor(missingRequiredColor), "Wrong color");
});

test("restored receiving drafts get short field feedback while retaining their detailed mismatch", () => {
  const serial = "51606101-04120568-VERY-LONG-CONTAINER-SERIAL";
  const values = [`1S${serial}`, "PSCANNED-PART-7972A-THR-A000", "CBLUE", "Q20"];
  const mismatch = receivingDemandMismatch(values, { partNumber: "REQUIRED-PART-9999", color: "BLUE", quantity: 20 });
  assert.ok(mismatch);
  assert.ok(mismatch.message.includes("SCANNED-PART-7972A-THR-A000"));
  assert.ok(mismatch.message.includes("REQUIRED-PART-9999"));
  assert.equal(phraseFor({ status: "mismatch", field: mismatch.field }), "Wrong part number");
  assert.equal(values[0], `1S${serial}`);
});

test("duplicate, conflicting, and completed label captures never speak label values", () => {
  const serial = "51606101-04120568-VERY-LONG-CONTAINER-SERIAL";
  const first = captureLabelBarcode({}, `1S${serial}`);
  assert.equal(first.status, "accepted");
  const duplicate = captureLabelBarcode(first.captured, `1S${serial}`);
  const conflict = captureLabelBarcode(first.captured, "1SDIFFERENT-SERIAL-7972A-THR-A000");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(phraseFor(duplicate), "Already scanned");
  assert.equal(conflict.status, "conflict");
  assert.equal(phraseFor(conflict), "Already captured. Check screen");
  const complete = captureReceivingBarcode([`1S${serial}`, "PPART", "CBLUE", "Q20"], `1S${serial}`);
  assert.equal(complete.status, "invalid");
  assert.equal(phraseFor(complete), "Check screen");
  for (const phrase of Object.values(SCAN_FEEDBACK)) {
    assert.ok(phrase.split(/\s+/).length <= 6, `Speech must stay brief: ${phrase}`);
    assert.doesNotMatch(phrase, /\d/, "speech contains no serial or quantity digits");
  }
});
