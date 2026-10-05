import assert from "node:assert/strict";
import test from "node:test";
import { createFulfillmentAttempt, fulfillmentAttemptAfterReset, fulfillmentAttemptKey, prepareFulfillmentAttempt, resolveFulfillmentSerial, restoreFulfillmentAttempt } from "../lib/fulfillment-request.ts";

test("serial formats never guess whether literal prefixes are identifiers", () => {
  for (const serial of ["ABC", "1SABC", "PABC", "Q123", "CRED", "00001"]) {
    assert.equal(resolveFulfillmentSerial(`1S${serial}`, "barcode").canonicalSerial, serial);
    assert.equal(resolveFulfillmentSerial(serial, "canonical").canonicalSerial, serial);
  }
  assert.equal(resolveFulfillmentSerial("]C1 1Sabc\r", "barcode").canonicalSerial, "ABC");
  for (const serial of ["ABC", "1S", "PABC", "2SABC", "1SA\nB"]) assert.equal(resolveFulfillmentSerial(serial, "barcode"), null);
});

const request = { cartKey:"PICKLIST", serial:"1S1SABC", serialFormat:"barcode" };
test("recover old browser attempts with the same ID and original barcode envelope", () => {
  const old = { key:JSON.stringify(["PICKLIST", "1SABC", ""]), requestId:"pending-old-request" };
  const restored = restoreFulfillmentAttempt(old);
  assert.deepEqual(restored.request, request);
  assert.equal(restored.requestId, old.requestId);
  assert.equal(restored.key, fulfillmentAttemptKey(request));
  assert.deepEqual(restoreFulfillmentAttempt(JSON.parse(JSON.stringify(restored))), restored);
});

test("callbacks preserve the whole uncertain request, including omitted supplier scope", () => {
  const previous = createFulfillmentAttempt(request, "original-id");
  const callback = { ...request, serial:"1SABC", serialFormat:"canonical", supplierId:"" };
  const next = prepareFulfillmentAttempt(previous, callback, "must-not-be-used", true);
  assert.equal(next.requestId, "original-id");
  assert.deepEqual(next.request, request);
  assert.throws(() => prepareFulfillmentAttempt(next, { ...request, serial:"1SOTHER" }, "new-id"), /previous container scan/);
});

test("only a definite non-allocation allows another container; every retry becomes uncertain again", () => {
  const previous = { ...createFulfillmentAttempt(request, "original-id"), phase:"not_allocated" };
  assert.equal(prepareFulfillmentAttempt(previous, { ...request, serial:"1SOTHER" }, "next-id").requestId, "next-id");
  const retry = prepareFulfillmentAttempt(previous, request, "unused");
  assert.equal(retry.requestId, "original-id");
  assert.equal(retry.phase, "unconfirmed");
});

test("reset decisions preserve independently stored foreign drafts and recover legacy attempts", () => {
  const current = createFulfillmentAttempt(request, "in-memory");
  const stored = { key:JSON.stringify(["OTHER", "ABC", ""]), requestId:"saved-legacy" };
  const reset = fulfillmentAttemptAfterReset(current, stored, "PICKLIST");
  assert.equal(reset.clearStored, false);
  assert.equal(reset.attempt.requestId, "saved-legacy");
  assert.equal(reset.attempt.request.cartKey, "OTHER");
  assert.equal(fulfillmentAttemptAfterReset(current, { broken:true }, "OTHER").attempt.requestId, "in-memory");
  assert.deepEqual(fulfillmentAttemptAfterReset(current, { broken:true }, null), { attempt:null, clearStored:true });
});
