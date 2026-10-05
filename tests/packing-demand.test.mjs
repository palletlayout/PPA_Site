import assert from "node:assert/strict";
import test from "node:test";
import { capturedPackingContents, checkPackingDemand, packingDemandIsFulfilled, packingReceiptDefaults } from "../lib/packing-demand.ts";

const line = { sequence: "010", partNumber: "PART-001", color: "BLUE", quantity: 15, unitOfMeasure: "EA", status: "pending" };
const capture = (overrides = {}) => ({ ...capturedPackingContents(["1SNEW", "PPART-001", "CBLUE", "Q00015"], "EA", ""), ...overrides });

test("a capture matches any unfulfilled line, including repeated requirements", () => {
  const lines = [{ ...line, status: "verified" }, { ...line, sequence: "020" }];
  assert.equal(checkPackingDemand(lines, capture()).line.sequence, "020");
  assert.equal(checkPackingDemand([lines[0]], capture()).reason, "demand_fulfilled");
});

test("mismatches identify the scanned value and the remaining requirement", () => {
  for (const [field, value, message] of [["partNumber", "OTHER", /part number requires PART-001; scanned OTHER/], ["color", "RED", /color requires BLUE; scanned RED/], ["quantity", "14", /quantity requires 15 EA; scanned 14 EA/], ["unitOfMeasure", "KG", /quantity requires 15 EA; scanned 15 KG/]]) {
    const result = checkPackingDemand([line], capture({ [field]: value }));
    assert.equal(result.reason, "no_matching_demand");
    assert.match(result.message, message);
  }
  assert.match(checkPackingDemand([{ ...line, preferredSupplierId: "SUP-A" }], capture()).message, /supplier requires SUP-A; scanned Unspecified/);
});

test("known formatted parts match compact barcodes without erasing arbitrary punctuation", () => {
  const demand = { ...line, partNumber: "83280-TYA-A011-M1" };
  assert.equal(checkPackingDemand([demand], capture({ partNumber: "83280TYAA011M1" })).line, demand);
  assert.equal(checkPackingDemand([line], capture({ partNumber: "PART001" })).reason, "no_matching_demand");
  assert.equal(checkPackingDemand([demand], capture({ partNumber: "83280TYAA012M1" })).reason, "no_matching_demand");
});

test("blank color and measured quantities match without converting units", () => {
  const demand = { ...line, color: "", quantity: 1.5, unitOfMeasure: "KG" };
  const actual = capturedPackingContents(["1SNEW", "PPART-001", "C", "Q1.500"], "KG", "");
  assert.equal(checkPackingDemand([demand], actual).line, demand);
  assert.equal(checkPackingDemand([demand], { ...actual, unitOfMeasure: "G", quantity: 1500 }).reason, "no_matching_demand");
});

test("fallback metadata uses common remaining requirements instead of the first line", () => {
  const measured = { ...line, unitOfMeasure: "KG", preferredSupplierId: "SUP-A" };
  assert.deepEqual(packingReceiptDefaults([measured, { ...line, preferredSupplierId: "SUP-B" }]), { unitOfMeasure: "EA", supplierId: "" });
  assert.deepEqual(packingReceiptDefaults([measured, { ...line, status: "verified" }]), { unitOfMeasure: "KG", supplierId: "SUP-A" });
});

test("an inventory link alone does not complete a partially allocated modern demand line", () => {
  for (const status of ["pending", "active", "short"]) {
    const partial = { ...line, status, inventoryItemId: "CONTAINER-1", fulfilledQuantity: 5 };
    assert.equal(packingDemandIsFulfilled(partial), false, status);
  }
  assert.equal(packingDemandIsFulfilled({ ...line, inventoryItemId: "CONTAINER-1", fulfilledQuantity: 0 }), false);
  assert.equal(packingDemandIsFulfilled({ ...line, status: "verified", fulfilledQuantity: 15 }), true);
  assert.equal(packingDemandIsFulfilled({ ...line, loadedAt: "2026-09-23T10:00:00Z" }), true);
  assert.equal(packingDemandIsFulfilled({ ...line, inventoryItemId: "LEGACY-CONTAINER" }), true);
});

test("multiple-container mode accepts positive quantities below or above the remaining requirement", () => {
  const partial = { ...line, status: "active", inventoryItemId: "FIRST-CONTAINER", fulfilledQuantity: 5 };
  for (const quantity of [1, 10, 20]) {
    assert.equal(checkPackingDemand([partial], capture({ quantity }), "multiple").line, partial);
  }
  assert.equal(checkPackingDemand([partial], capture({ quantity: 10 }), "exact").reason, "no_matching_demand");
  for (const quantity of [0, -1, "NaN", "1.5"]) {
    assert.equal(checkPackingDemand([partial], capture({ quantity }), "multiple").reason, "no_matching_demand");
  }
});

test("multiple-container mode still requires matching part, color, supplier and unit", () => {
  const partial = { ...line, quantity: 0.3, fulfilledQuantity: 0.2, unitOfMeasure: "KG", preferredSupplierId: "SUP-A", status: "active" };
  const actual = capture({ quantity: "0.100000", unitOfMeasure: "KG", supplierId: "SUP-A" });
  assert.equal(checkPackingDemand([partial], actual, "multiple").line, partial);
  for (const change of [{ partNumber: "OTHER" }, { color: "RED" }, { supplierId: "SUP-B" }, { quantity: 100, unitOfMeasure: "G" }, { quantity: "0.0000001" }]) {
    assert.equal(checkPackingDemand([partial], { ...actual, ...change }, "multiple").reason, "no_matching_demand");
  }
});

test("repeated requirements remain eligible separately after another row is packed", () => {
  const first = { ...line, id: "FIRST", status: "verified", fulfilledQuantity: 15, inventoryItemId: "FIRST-CONTAINER" };
  const second = { ...line, id: "SECOND", sequence: "020", status: "active", fulfilledQuantity: 5, inventoryItemId: "SECOND-CONTAINER" };
  assert.equal(checkPackingDemand([first, second], capture({ quantity: 10 }), "multiple").line.id, "SECOND");
  assert.deepEqual(packingReceiptDefaults([first, { ...second, unitOfMeasure: "KG", preferredSupplierId: "SUP-B" }]), { unitOfMeasure: "KG", supplierId: "SUP-B" });
});


test("short rows are closed and never selected for packing or receiving metadata", () => {
  const closed = { ...line, status: "short", fulfilledQuantity: 5, unitOfMeasure: "KG", preferredSupplierId: "CLOSED" };
  assert.equal(packingDemandIsFulfilled(closed), false, "short is closed without claiming packed completion");
  assert.equal(checkPackingDemand([closed], capture({ unitOfMeasure: "KG", supplierId: "CLOSED" }), "multiple").line, null);
  assert.deepEqual(packingReceiptDefaults([closed, line]), { unitOfMeasure: "EA", supplierId: "" });
});

test("a matching later part wins over an earlier unrelated requirement", () => {
  const earlier = { ...line, partNumber: "OTHER", sequence: "001" };
  const matching = { ...line, sequence: "999" };
  assert.equal(checkPackingDemand([earlier, matching], capture()).line, matching);
  assert.equal(checkPackingDemand([earlier, matching], capture({ quantity: 7 }), "multiple").line, matching);
});
