import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUnitOfMeasure, parseQuantity, quantitiesEqual, quantityToScaled } from "../lib/quantity.ts";

test("EA remains whole pieces while measured quantities retain exact six-place values", () => {
  assert.equal(normalizeUnitOfMeasure(" pieces "), "EA");
  assert.equal(normalizeUnitOfMeasure("kilograms"), "KG");
  assert.equal(parseQuantity("1,234", "EA"), 1234);
  assert.equal(Number.isNaN(parseQuantity("1.25", "EA")), true);
  assert.equal(parseQuantity("1.250000", "KG"), 1.25);
  assert.equal(quantityToScaled("0.000001", "KG"), 1n);
  assert.equal(quantityToScaled("2147483646.999999", "KG"), 2147483646999999n);
  assert.equal(parseQuantity("2147483646.999999", "KG"), 2147483646.999999);
});

test("quantity equality uses exact decimal values and requires the same unit", () => {
  assert.equal(quantitiesEqual("0.100000", 0.1, "KG", "kilograms"), true);
  assert.equal(quantitiesEqual("0.000001", "0.000002", "L"), false);
  assert.equal(quantitiesEqual(1, 1, "KG", "EA"), false);
  assert.equal(quantitiesEqual(1, 1000, "KG", "G"), false);
  assert.equal(quantitiesEqual(0.1 + 0.2, "0.3", "KG"), false);
});

test("quantity parser rejects ambiguous formats, excess precision, and unsupported units", () => {
  for (const value of [true, "1e3", "1,2", "-1", "0.0000001", "2147483647.000001", Infinity]) {
    assert.equal(Number.isNaN(parseQuantity(value, "M")), true, String(value));
  }
  assert.throws(() => normalizeUnitOfMeasure("UNKNOWN"), /Unsupported unit/);
  assert.equal(Number.isNaN(parseQuantity("1", "UNKNOWN")), true);
});
