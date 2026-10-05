import assert from "node:assert/strict";
import test from "node:test";
import { conflictingPackingPicklists, matchingPackingReferences } from "../app/packing-selection.ts";

const movement = { plant: "01", areaType: "offsite", number: "LOAD-1" };
const reference = (key, overrides = {}) => ({
  key, plant: "01", areaType: "offsite", loadNumber: "LOAD-1", trainNumber: "", verified: 0, total: 2,
  lines: [{ cartBarcode: `CF-${key}`, picklistNumber: "PICK-1", masterBarcode: `MASTER-${key}`, checksheetNumber: "CHECK-1" }], ...overrides,
});

test("packing checksheet labels are scoped to the selected plant and movement", () => {
  const selected = reference("selected");
  const others = [reference("other-plant", { plant: "02" }), reference("other-load", { loadNumber: "LOAD-2" }), reference("other-type", { areaType: "onsite", trainNumber: "LOAD-1" })];
  assert.deepEqual(matchingPackingReferences([selected, ...others], movement, "PICK-1"), [selected]);
  for (const label of ["MASTER-selected", "CHECK-1", "CF-selected", "\r]C1pick-1\r"]) {
    assert.deepEqual(matchingPackingReferences([selected], movement, label), [selected]);
  }
  assert.deepEqual(matchingPackingReferences([selected], movement, "unrelated"), []);
  assert.deepEqual(conflictingPackingPicklists([selected, ...others], movement), []);
});

test("duplicate legacy outbound cards block the whole picklist, including specific master and CF aliases", () => {
  const references = [reference("one"), reference("two")];
  assert.deepEqual(conflictingPackingPicklists(references, movement), ["PICK-1"]);
  for (const label of ["PICK-1", "CHECK-1", "MASTER-two", "CF-one"]) {
    assert.deepEqual(matchingPackingReferences(references, movement, label), [], label);
  }
});

test("a completed duplicate card cannot hide the reconciliation requirement", () => {
  const finished = reference("done", { verified: 2 });
  const pending = reference("pending");
  assert.deepEqual(conflictingPackingPicklists([finished, pending], movement), ["PICK-1"]);
  assert.deepEqual(matchingPackingReferences([finished, pending], movement, "CF-pending"), []);
  assert.deepEqual(matchingPackingReferences([finished], movement, "CF-done"), []);
});

test("many demand lines on one outbound card remain one valid picklist", () => {
  const one = reference("one");
  one.lines.push({ ...one.lines[0] });
  assert.deepEqual(conflictingPackingPicklists([one], movement), []);
  assert.deepEqual(matchingPackingReferences([one], movement, "PICK-1"), [one]);
  const mergedLegacy = { ...one, lines: [...one.lines, reference("two").lines[0]] };
  assert.deepEqual(conflictingPackingPicklists([mergedLegacy], movement), ["PICK-1"], "distinct saved headers remain a conflict even if physical fields match");
  assert.deepEqual(matchingPackingReferences([mergedLegacy], movement, "MASTER-two"), []);
});

test("completed physical labels cannot be redirected to another unfinished picklist", () => {
  const finished = reference("done", { verified: 2, lines: [{ cartBarcode: "CF-DONE", picklistNumber: "PICK-DONE", masterBarcode: "SHARED" }] });
  const pending = reference("pending", { lines: [{ cartBarcode: "CF-PENDING", picklistNumber: "PICK-PENDING", masterBarcode: "SHARED" }] });
  assert.deepEqual(conflictingPackingPicklists([finished, pending], movement), [], "the records have different valid business identities");
  assert.deepEqual(matchingPackingReferences([finished, pending], movement, "SHARED"), [finished, pending], "the caller must show ambiguity");
  assert.deepEqual(matchingPackingReferences([finished, pending], movement, "CF-PENDING"), [pending]);
  assert.deepEqual(matchingPackingReferences([finished, pending], movement, "CF-DONE"), []);
});
