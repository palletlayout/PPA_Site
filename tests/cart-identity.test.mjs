import assert from "node:assert/strict";
import test from "node:test";
import {
  cartBarcodeForHeaderId,
  movementBarcodeCandidates,
  movementBarcodeMatches,
  normalizeIdentityBarcode,
  picklistIdentityKey,
  picklistBarcodeMatches,
} from "../lib/cart-identity.ts";

test("generates stable unique Code 39 cart identities", () => {
  const first = cartBarcodeForHeaderId("5b20f151-f5ca-4e5b-a598-bdb22ba1d273");
  assert.equal(first, "CF9F78E2A1F6BE43B5");
  assert.equal(first, cartBarcodeForHeaderId("5b20f151-f5ca-4e5b-a598-bdb22ba1d273"));
  assert.notEqual(first, cartBarcodeForHeaderId("5b20f151-f5ca-4e5b-a598-bdb22ba1d274"));
  assert.notEqual(
    cartBarcodeForHeaderId("aaaaaaaa-middle-one-bbbbbbbb"),
    cartBarcodeForHeaderId("aaaaaaaa-middle-two-bbbbbbbb"),
  );
  assert.match(first, /^CF[0-9A-F]{16}$/);
});

test("order number is a valid picklist label without changing its business identity", () => {
  const line = { cartBarcode: "CF-PPA", picklistNumber: "PICK-1", checksheetNumber: "CHECK-1", masterBarcode: "MASTER-1", orderNumber: "ORDER-1" };
  for (const barcode of ["CF-PPA", "PICK-1", "CHECK-1", "MASTER-1", "order-1"]) assert.equal(picklistBarcodeMatches(line, barcode), true);
  assert.equal(picklistBarcodeMatches(line, "ORDER-2"), false);
});

test("normalizes scanner framing and validates movement candidates", () => {
  const onsite = {
    areaType: "onsite",
    loadNumber: "",
    trainNumber: "TE309771",
    movementBarcode: "AE1TE309771X5AA",
    plant: "01",
    zone: "5",
    shipCategory: "AA",
  };
  assert.equal(normalizeIdentityBarcode("\r\nae1te309771x5aa\t"), "AE1TE309771X5AA");
  assert.deepEqual(movementBarcodeCandidates(onsite), ["TE309771", "AE1TE309771X5AA"]);
  assert.equal(movementBarcodeMatches(onsite, "te309771"), true);
  assert.equal(movementBarcodeMatches(onsite, "AE1TE309771X5AA"), true);
  assert.equal(movementBarcodeMatches(onsite, "LD-OTHER"), false);

  const offsite = { ...onsite, areaType: "offsite", loadNumber: "LD-9002", trainNumber: "", movementBarcode: "" };
  assert.deepEqual(movementBarcodeCandidates(offsite), ["LD-9002"]);
});

test("accepts AIM scanner framing but rejects joined movement identifiers", () => {
  const line = { areaType: "offsite", loadNumber: "LOAD-100", trainNumber: "", plant: "01", zone: "A", shipCategory: "AA" };
  assert.equal(movementBarcodeMatches(line, "\r]C1LOAD-100\r"), true);
  assert.equal(movementBarcodeMatches(line, "LOAD\n-100"), false);
  assert.equal(normalizeIdentityBarcode("CFABC\u001dDEF"), "");
});


test("outbound identity belongs to the picklist and excludes inbound or legacy card references", () => {
  const line = { plant: "P1", areaType: "onsite", trainNumber: "T1", loadNumber: "", picklistNumber: "PICK-1" };
  assert.equal(picklistIdentityKey(line), picklistIdentityKey({ ...line, cartId: "DIFFERENT", palletId: "DIFFERENT", orderNumber: "DIFFERENT", picklistNumber: "pick-1" }));
  assert.notEqual(picklistIdentityKey(line), picklistIdentityKey({ ...line, trainNumber: "T2" }));
});
