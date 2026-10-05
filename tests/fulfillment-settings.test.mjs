import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FULFILLMENT_SETTINGS, partAttributeLabels, validateFulfillmentSettings } from "../lib/fulfillment-settings.ts";
import { captureReceivingBarcode, receivingDemandMismatch } from "../lib/receive-label.ts";
import { checkPackingDemand } from "../lib/packing-demand.ts";

test("legacy settings normalize to optional color and invalid attributes are rejected", () => {
  assert.deepEqual(validateFulfillmentSettings({ packingMode: "exact", inventoryMode: "uploaded" }), DEFAULT_FULFILLMENT_SETTINGS);
  for (const partAttribute of ["", "custom", null, 12]) {
    assert.throws(() => validateFulfillmentSettings({ ...DEFAULT_FULFILLMENT_SETTINGS, partAttribute }), /Part attribute/);
  }
});

test("color prompts accept both identifiers and preserve blank versus specified demand", () => {
  for (const [partAttribute, label] of [["color", "Color"], ["part_level", "Color"], ["color_or_part_level", "Color"]]) {
    assert.equal(validateFulfillmentSettings({ ...DEFAULT_FULFILLMENT_SETTINGS, partAttribute }).partAttribute, "color");
    assert.equal(partAttributeLabels(partAttribute).label, label);
    const demand = { partNumber: "PART", color: "M4", quantity: 2 };
    const draft = ["1SNEW", "PPART", "", "Q2"];
    for (const raw of ["2PM4", "CM4"]) {
      const result = captureReceivingBarcode(draft, raw, null, "EA", demand, partAttribute);
      assert.equal(result.completed, true);
      assert.equal(result.rawValues[2], raw);
      assert.equal(receivingDemandMismatch(result.rawValues, demand, "EA", partAttribute), null);
    }
    const wrong = captureReceivingBarcode(draft, "2PWRONG", null, "EA", demand, partAttribute);
    assert.equal(wrong.status, "mismatch");
    assert.ok(wrong.message.includes(`Wrong ${label.toLowerCase()}`));
    assert.equal(captureReceivingBarcode(draft, "2P", null, "EA", demand, partAttribute).status, "mismatch");
    assert.equal(captureReceivingBarcode(draft, "2P", null, "EA", { ...demand, color: "" }, partAttribute).completed, true);
    const mismatch = checkPackingDemand([demand], { ...demand, color: "OTHER" }, "exact", partAttribute);
    assert.ok(mismatch.message.includes(`${label.toLowerCase()} requires M4`));
  }
});
