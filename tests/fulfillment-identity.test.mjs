import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFulfillmentAttempt, fulfillmentAttemptAfterReset, legacyFulfillmentFingerprint, prepareFulfillmentAttempt, recordFulfillmentResponse } from "../lib/fulfillment-request.ts";

const row = { plant:"P1", zone:"Z", areaType:"onsite", shipCategory:"Production", trainNumber:"TR1", loadNumber:"", picklistNumber:"PICK1", cartNumber:"1", cartId:"C1", palletId:"", sequence:"1", partNumber:"PART", description:"", color:"BLUE", quantity:10, aiagSerial:"", masterBarcode:"MASTER1", movementBarcode:"MOVE1" };

test("explicit serial identities and cross-version allocation receipts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-identity-"));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "qa.sqlite");
  for (const name of ["DATABASE_URL", "POSTGRES_URL", "VERCEL"]) delete process.env[name];
  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => { db.close(); await rm(directory, { recursive:true, force:true }); });
  const setup = async (mode = "exact", rows = [row]) => {
    await store.clearAllData();
    await store.updateFulfillmentSettings({ packingMode:mode, inventoryMode:"uploaded" }, { id:"boss", name:"Boss" });
    await store.replaceImport("identity.csv", rows);
    const lines = (await store.getAppState()).lines;
    const line = lines[0];
    const context = { cartKey:[line.plant,line.areaType,line.trainNumber,line.picklistNumber,line.cartNumber,line.cartId].join("::"), sessionId:"scanner", operatorName:"Packer" };
    await store.manageLock({ ...context, action:"acquire" });
    await store.recordScan({ ...context, lineId:line.id, field:"cartBarcode", value:line.cartBarcode });
    return context;
  };
  const receive = (serial, supplierId = "SUP-A", quantity = 10) => store.receiveInventoryFromPhysicalLabel({ captureId:randomUUID(), receiptSessionId:randomUUID(), rawValues:[`1S${serial}`,"PPART","CBLUE",`Q${quantity}`], supplierId, operatorName:"Receiver" });
  const count = async () => Number((await db.prepare("SELECT COUNT(*) AS n FROM fulfillment_allocations").first()).n);

  for (const mode of ["exact", "multiple"]) {
    await t.test(`${mode}: absent ABC never consumes literal 1SABC`, async () => {
      const context = await setup(mode);
      const stock = await receive("1SABC");
      const result = await store.fulfillDemand({ ...context, serial:"1SABC", serialFormat:"barcode", supplierId:"SUP-A", requestId:randomUUID() });
      assert.equal(result.reason, "inventory_not_found");
      assert.equal(result.serial, "ABC");
      assert.equal(await count(), 0);
      assert.equal((await store.listInventory()).items[0].consumedQuantity, 0);
      const correct = await store.fulfillDemand({ ...context, serial:"1S1SABC", serialFormat:"barcode", supplierId:"SUP-A", requestId:randomUUID() });
      assert.equal(correct.inventoryItemId, stock.inventory.id);
    });
    for (const supplier of ["SUP-A", "SUP-B"]) {
      await t.test(`${mode}: both colliding serials resolve exactly with ${supplier}`, async () => {
        const context = await setup(mode, [row, { ...row, sequence:"2" }]);
        const first = await receive("ABC");
        const second = await receive("1SABC", supplier);
        const a = await store.fulfillDemand({ ...context, serial:"1SABC", serialFormat:"barcode", requestId:randomUUID() });
        const b = await store.fulfillDemand({ ...context, serial:"1SABC", serialFormat:"canonical", supplierId:supplier, requestId:randomUUID() });
        assert.equal(a.inventoryItemId, first.inventory.id);
        assert.equal(b.inventoryItemId, second.inventory.id);
        assert.equal(await count(), 2);
      });
    }
  }

  await t.test("supplier ambiguity is limited to the one canonical identity", async () => {
    const context = await setup();
    await receive("ABC", "SUP-A"); await receive("ABC", "SUP-B"); await receive("1SABC", "SUP-C");
    const request = { ...context, serial:"1SABC", serialFormat:"barcode", requestId:randomUUID() };
    const result = await store.fulfillDemand(request);
    assert.equal(result.reason, "ambiguous_serial");
    assert.deepEqual(result.suppliers.sort(), ["SUP-A", "SUP-B"]);
    assert.equal((await store.fulfillDemand({ ...request, supplierId:"SUP-B" })).serial, "ABC");
  });

  await t.test("new untyped legacy inputs never allocate, including a unique match", async () => {
    const context = await setup(); await receive("ABC");
    for (const serial of ["ABC", "1SABC"]) {
      assert.equal((await store.fulfillDemand({ ...context, serial, requestId:randomUUID() })).reason, "client_update_required");
      assert.equal((await store.fulfillDemand({ ...context, serial })).reason, "client_update_required");
    }
    assert.equal(await count(), 0);
  });

  await t.test("same v2 receipt survives barcode-to-canonical callbacks and concurrent retries", async () => {
    const context = await setup("multiple", [row, { ...row, sequence:"2" }]); await receive("1SABC", "SUP-A", 15);
    const request = { ...context, serial:"1S1SABC", serialFormat:"barcode", supplierId:"SUP-A", requestId:randomUUID() };
    const [first, second] = await Promise.all([store.fulfillDemand(request), store.fulfillDemand({ ...request, serial:"1SABC", serialFormat:"canonical" })]);
    assert.ok(first.ok && second.ok);
    assert.equal(Number(first.alreadyFulfilled) + Number(second.alreadyFulfilled), 1);
    assert.equal(await count(), 1);
    assert.equal((await store.fulfillDemand({ ...request, serial:"1SABC", serialFormat:"canonical" })).allocatedQuantity, 10);
    const next = await store.fulfillDemand({ ...request, requestId:randomUUID() });
    assert.equal(next.allocatedQuantity, 5);
    assert.equal((await store.fulfillDemand(request)).allocatedQuantity, 10);
    assert.equal(await count(), 2);
  });

  await t.test("v2 fingerprints distinguish omitted and explicitly blank suppliers", async () => {
    const context = await setup(); await receive("ABC", "");
    const request = { ...context, serial:"1SABC", serialFormat:"barcode", requestId:randomUUID() };
    assert.equal((await store.fulfillDemand(request)).ok, true);
    assert.equal((await store.fulfillDemand({ ...request, supplierId:"" })).reason, "request_conflict");
    assert.equal(await count(), 1);
  });

  await t.test("legacy receipt replay uses its saved inventory ID even after a collision arrives", async () => {
    const context = await setup(); const inventory = await receive("ABC");
    const request = { ...context, serial:"1SABC", serialFormat:"barcode", supplierId:"SUP-A", requestId:randomUUID() };
    await store.fulfillDemand(request);
    await db.prepare("UPDATE fulfillment_allocations SET request_fingerprint=? WHERE request_id=?").bind(legacyFulfillmentFingerprint(request), request.requestId).run();
    await receive("1SABC");
    const callback = { ...request, serial:"ABC", serialFormat:"canonical" };
    const [old, updated, canonical] = await Promise.all([store.fulfillDemand({ ...request, serialFormat:undefined }), store.fulfillDemand(request), store.fulfillDemand(callback)]);
    for (const result of [old, updated, canonical]) {
      assert.equal(result.alreadyFulfilled, true);
      assert.equal(result.inventoryItemId, inventory.inventory.id);
    }
    assert.equal(await count(), 1);
    await store.manageLock({ ...context, action:"release" });
    assert.equal((await store.getFulfillmentReceipt(request)).inventoryItemId, inventory.inventory.id, "completed picklists need no lease to confirm their saved receipt");
    assert.equal((await store.getFulfillmentReceipt(callback)).inventoryItemId, inventory.inventory.id);
    assert.equal((await store.getFulfillmentReceipt({ ...request, cartKey:"OTHER" })).reason, "reconciliation_required");
    assert.equal((await store.getFulfillmentReceipt({ ...request, requestId:randomUUID() })).reason, "receipt_unconfirmed");
    await store.resetPicklist({ ...context, operatorName:"Boss", operatorId:"boss" });
    assert.equal((await store.getFulfillmentReceipt(request)).reason, "allocation_reversed");
    await store.manageLock({ ...context, action:"acquire" });
    assert.equal((await store.fulfillDemand(request)).reason, "allocation_reversed");
  });

  await t.test("typed retry exposes a historic wrong-container allocation instead of reallocating", async () => {
    const context = await setup(); const inventory = await receive("1SABC");
    const old = { ...context, serial:"1SABC", supplierId:"SUP-A", requestId:randomUUID() };
    await store.fulfillDemand({ ...old, serialFormat:"canonical" });
    await db.prepare("UPDATE fulfillment_allocations SET request_fingerprint=? WHERE request_id=?").bind(legacyFulfillmentFingerprint(old), old.requestId).run();
    await receive("ABC");
    const explicit = await store.fulfillDemand({ ...old, serialFormat:"barcode" });
    assert.equal(explicit.reason, "reconciliation_required");
    assert.equal((await store.getFulfillmentReceipt({ ...old, serialFormat:"barcode" })).reason, "reconciliation_required");
    const replay = await store.fulfillDemand(old);
    assert.equal(replay.alreadyFulfilled, true);
    assert.equal(replay.inventoryItemId, inventory.inventory.id);
    assert.equal(await count(), 1);
  });

  await t.test("uncommitted old attempts can resume with the same ID after refresh", async () => {
    const context = await setup("multiple"); await receive("ABC");
    const request = { ...context, serial:"1SABC", supplierId:"SUP-A", requestId:randomUUID() };
    assert.equal((await store.fulfillDemand(request)).reason, "client_update_required");
    const typed = { ...request, serialFormat:"barcode" };
    assert.equal((await store.fulfillDemand(typed)).ok, true);
    assert.equal((await store.fulfillDemand(typed)).alreadyFulfilled, true);
    assert.equal(await count(), 1);
  });

  await t.test("a rejected deleted container does not strand the next valid scan", async () => {
    const context = await setup(); const deleted = await receive("DELETED"); await receive("VALID");
    await store.setInventoryDeleted({ id:deleted.inventory.id, deleted:true, operatorName:"Boss", operatorId:"boss" });
    const request = { cartKey:context.cartKey, serial:"1SDELETED", serialFormat:"barcode", supplierId:"SUP-A" };
    const pending = createFulfillmentAttempt(request, randomUUID());
    const result = await store.fulfillDemand({ ...context, ...request, requestId:pending.requestId });
    assert.equal(result.reason, "inventory_unavailable");
    assert.equal(result.retryDisposition, "not_allocated");
    const recorded = recordFulfillmentResponse(pending, result);
    const next = prepareFulfillmentAttempt(recorded, { ...request, serial:"1SVALID" }, randomUUID());
    assert.notEqual(next.requestId, pending.requestId);
    assert.equal((await store.fulfillDemand({ ...context, ...next.request, requestId:next.requestId })).ok, true);
    assert.equal(await count(), 1);
  });

  await t.test("resetting another picklist preserves a lost-response ID and cannot allocate its next repeated line", async () => {
    const otherRow = { ...row, picklistNumber:"OTHER", cartNumber:"2", cartId:"C2", masterBarcode:"MASTER2" };
    const context = await setup("multiple", [row, { ...row, sequence:"2" }, otherRow]);
    await receive("SHARED", "SUP-A", 20);
    const pending = createFulfillmentAttempt({ cartKey:context.cartKey, serial:"1SSHARED", serialFormat:"barcode", supplierId:"SUP-A" }, randomUUID());
    const first = await store.fulfillDemand({ ...context, ...pending.request, requestId:pending.requestId });
    assert.equal(first.allocatedQuantity, 10);
    // The server committed, but the browser still has its pre-response draft.
    const persisted = JSON.parse(JSON.stringify(pending));
    const other = (await store.getAppState()).lines.find((line) => line.picklistNumber === "OTHER");
    const otherKey = [other.plant,other.areaType,other.trainNumber,other.picklistNumber,other.cartNumber,other.cartId].join("::");
    await store.resetPicklist({ cartKey:otherKey, operatorName:"Boss", operatorId:"boss" });
    for (const inMemory of [pending, null]) {
      const after = fulfillmentAttemptAfterReset(inMemory, persisted, otherKey);
      assert.equal(after.clearStored, false);
      assert.equal(after.attempt.requestId, pending.requestId);
      const retry = prepareFulfillmentAttempt(after.attempt, pending.request, randomUUID());
      const result = await store.fulfillDemand({ ...context, ...retry.request, requestId:retry.requestId });
      assert.equal(result.alreadyFulfilled, true);
      assert.equal(result.lineId, first.lineId);
      assert.equal(await count(), 1);
      assert.equal((await store.listInventory()).items[0].consumedQuantity, 10);
    }
    await store.resetPicklist({ ...context, operatorName:"Boss", operatorId:"boss" });
    assert.deepEqual(fulfillmentAttemptAfterReset(null, persisted, context.cartKey), { attempt:null, clearStored:true });
  });

  await t.test("successful clear-all invalidates pending browser receipts before new work", async () => {
    const context = await setup("multiple"); await receive("BEFORE");
    const pending = createFulfillmentAttempt({ cartKey:context.cartKey, serial:"1SBEFORE", serialFormat:"barcode" }, randomUUID());
    await store.fulfillDemand({ ...context, ...pending.request, requestId:pending.requestId });
    await store.clearAllData();
    const cleared = fulfillmentAttemptAfterReset(pending, JSON.parse(JSON.stringify(pending)), null);
    assert.deepEqual(cleared, { attempt:null, clearStored:true });
    const nextContext = await setup("multiple"); await receive("AFTER");
    const next = prepareFulfillmentAttempt(cleared.attempt, { cartKey:nextContext.cartKey, serial:"1SAFTER", serialFormat:"barcode" }, randomUUID());
    assert.notEqual(next.requestId, pending.requestId);
    assert.equal((await store.fulfillDemand({ ...nextContext, ...next.request, requestId:next.requestId })).ok, true);
    assert.equal(await count(), 1);
  });

  await t.test("a reversed receipt remains recoverable after its reopened header identity is edited", async () => {
    const context = await setup(); await receive("RESET-EDIT");
    const request = { ...context, serial:"1SRESET-EDIT", serialFormat:"barcode", supplierId:"SUP-A", requestId:randomUUID() };
    const packed = await store.fulfillDemand(request);
    await store.resetPicklist({ ...context, operatorName:"Boss", operatorId:"boss" });
    await store.updateDemandLine(packed.lineId, { cartNumber:"2" });
    assert.equal((await store.getFulfillmentReceipt(request)).reason, "allocation_reversed");
    assert.equal((await store.getFulfillmentReceipt({ ...request, cartKey:"ALTERED" })).reason, "reconciliation_required");
    assert.equal((await store.getFulfillmentReceipt({ ...request, serial:"1SOTHER" })).reason, "reconciliation_required");
    assert.equal((await store.getFulfillmentReceipt({ ...request, supplierId:"OTHER" })).reason, "reconciliation_required");
  });
});
