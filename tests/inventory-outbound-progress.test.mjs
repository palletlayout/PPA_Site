import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const row = (quantity, index = 1, unitOfMeasure = "EA") => ({
  plant: "01", areaType: "onsite", zone: "A", shipCategory: "Production",
  trainNumber: "PROGRESS-TRAIN", movementBarcode: "PROGRESS-DEST", loadNumber: "", picklistNumber: `PROGRESS-PICK-${index}`,
  masterBarcode: `PROGRESS-MASTER-${index}`, cartNumber: String(index), cartId: `PROGRESS-CART-${index}`,
  palletId: `PROGRESS-PALLET-${index}`, sequence: "010", partNumber: "PROGRESS-PART",
  color: "BLUE", quantity, unitOfMeasure, aiagSerial: "",
});
const cartKey = (line) => [line.plant, line.areaType, line.trainNumber, line.picklistNumber, line.cartNumber, line.cartId].join("::");
const progress = (item) => ({
  stage: item.fulfillmentStage, loaded: item.loadedQuantity, dispatched: item.dispatchedQuantity,
  loadedAt: item.loadedAt, dispatchedAt: item.dispatchedAt,
});

test("inventory tracks quantities through each outbound picklist", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-inventory-outbound-"));
  const envNames = ["CARTFLOW_DATABASE_PATH", "DATABASE_URL", "POSTGRES_URL", "VERCEL"];
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "inventory.sqlite");
  for (const name of envNames.slice(1)) delete process.env[name];
  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => {
    db.close();
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  });
  const receiveRequest = (quantity, unitOfMeasure = "EA", receiptKind = "received") => ({
    captureId: randomUUID(), receiptSessionId: randomUUID(), operatorName: "Receiver",
    rawValues: ["1SSHARED-PROGRESS", "PPROGRESS-PART", "CBLUE", `Q${quantity}`], unitOfMeasure, receiptKind,
  });
  const pack = async (line) => {
    const context = { cartKey: cartKey(line), lineId: line.id, sessionId: "progress-scanner", operatorName: "Packer" };
    assert.equal((await store.manageLock({ ...context, action: "acquire" })).locked, true);
    assert.equal((await store.recordScan({ ...context, field: "cartBarcode", value: line.cartBarcode })).matched, true);
    const packed = await store.fulfillDemand({ ...context, serial: "SHARED-PROGRESS", serialFormat: "canonical", requestId: randomUUID() });
    assert.equal(packed.verified, true, JSON.stringify(packed));
    await store.manageLock({ ...context, action: "release" });
  };
  const setup = async (quantities = [5, 5], original = 10, unit = "EA") => {
    await store.clearAllData();
    await store.updateFulfillmentSettings({ packingMode: "multiple", inventoryMode: "uploaded" }, { id: "supervisor", name: "Supervisor" });
    await store.replaceImport("progress.csv", quantities.map((quantity, index) => row(quantity, index + 1, unit)));
    const request = receiveRequest(original, unit);
    await store.receiveInventoryFromPhysicalLabel(request);
    const lines = (await store.getAppState()).lines.sort((a, b) => a.picklistNumber.localeCompare(b.picklistNumber));
    for (const line of lines) await pack(line);
    return { lines, request };
  };
  const outbound = (line) => ({ cartBarcode: line.cartBarcode, movementValue: line.trainNumber, operatorName: "Loader" });
  const load = async (line) => {
    const result = await store.confirmCartLoading(outbound(line));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.cart.loadedAt;
  };
  const dispatch = async (line) => {
    const result = await store.confirmPicklistDispatch(outbound(line));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.cart.dispatchedAt;
  };
  const inventory = async () => (await store.listInventory()).items[0];
  const assertConsistentResponses = async (request) => {
    const item = await inventory();
    assert.deepEqual((await store.getInventoryExport())[0], item);
    assert.deepEqual((await store.receiveInventoryFromPhysicalLabel(request)).inventory, item);
    assert.deepEqual((await store.receiveInventoryFromPhysicalLabel({ ...request, captureId: randomUUID(), receiptSessionId: randomUUID() })).inventory, item);
  };

  await t.test("a shared container completes each milestone only after every unit does", async () => {
    const { lines, request } = await setup();
    assert.deepEqual(progress(await inventory()), { stage: "packed", loaded: 0, dispatched: 0, loadedAt: null, dispatchedAt: null });
    const firstLoadedAt = await load(lines[0]);
    assert.deepEqual(progress(await inventory()), { stage: "packed", loaded: 5, dispatched: 0, loadedAt: null, dispatchedAt: null });
    const firstDispatchedAt = await dispatch(lines[0]);
    assert.deepEqual(progress(await inventory()), { stage: "packed", loaded: 5, dispatched: 5, loadedAt: null, dispatchedAt: null });
    await assertConsistentResponses(request);
    const secondLoadedAt = await load(lines[1]);
    const loadedAt = [firstLoadedAt, secondLoadedAt].sort().at(-1);
    assert.deepEqual(progress(await inventory()), { stage: "loaded", loaded: 10, dispatched: 5, loadedAt, dispatchedAt: null });
    const secondDispatchedAt = await dispatch(lines[1]);
    assert.deepEqual(progress(await inventory()), { stage: "dispatched", loaded: 10, dispatched: 10, loadedAt,
      dispatchedAt: [firstDispatchedAt, secondDispatchedAt].sort().at(-1) });
    await assertConsistentResponses(request);
  });

  await t.test("unused stock prevents container completion after all allocated stock departs", async () => {
    const { lines, request } = await setup([5], 12);
    await load(lines[0]);
    await dispatch(lines[0]);
    const item = await inventory();
    assert.deepEqual(progress(item), { stage: "partially_consumed", loaded: 5, dispatched: 5, loadedAt: null, dispatchedAt: null });
    assert.equal(item.remainingQuantity, 7);
    assert.deepEqual((await store.listInventory()).summary, { containers: 1, units: 7, quantitiesByUnit: { EA: 7 } });
    await assertConsistentResponses(request);
  });

  await t.test("reset removes only reversed milestone contributions, including after repacking", async () => {
    const { lines } = await setup();
    await load(lines[0]); await load(lines[1]);
    for (const [index, line] of lines.entries()) {
      await store.resetPicklist({ cartKey: cartKey(line), operatorId: "supervisor", operatorName: "Supervisor" });
      assert.deepEqual(progress(await inventory()), { stage: index === 0 ? "partially_consumed" : "available",
        loaded: index === 0 ? 5 : 0, dispatched: 0, loadedAt: null, dispatchedAt: null });
    }
    await pack(lines[0]); await load(lines[0]);
    assert.deepEqual(progress(await inventory()), { stage: "partially_consumed", loaded: 5, dispatched: 0, loadedAt: null, dispatchedAt: null });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM fulfillment_allocations WHERE reversed_at IS NOT NULL").first()).n, 2);
  });

  await t.test("decimal sums and Postgres numeric strings complete the original quantity exactly", async () => {
    const { lines, request } = await setup([0.1, 0.2], 0.3, "KG");
    await load(lines[0]); await dispatch(lines[0]);
    assert.deepEqual(progress(await inventory()), { stage: "packed", loaded: 0.1, dispatched: 0.1, loadedAt: null, dispatchedAt: null });
    await load(lines[1]); await dispatch(lines[1]);
    const execute = db.execute.bind(db);
    db.execute = async (statement) => {
      const result = await execute(statement);
      if (statement.query.includes("AS loaded_quantity")) {
        result.results = result.results.map((item) => ({ ...item, quantity: String(item.quantity),
          loaded_quantity: String(item.loaded_quantity), dispatched_quantity: String(item.dispatched_quantity) }));
      }
      return result;
    };
    try {
      const item = await inventory();
      assert.equal(item.fulfillmentStage, "dispatched");
      assert.equal(item.loadedQuantity, 0.3);
      assert.equal(item.dispatchedQuantity, 0.3);
      assert.ok(item.loadedAt && item.dispatchedAt);
      await assertConsistentResponses(request);
    } finally { db.execute = execute; }
  });

  await t.test("expected, untouched and deleted containers have no outbound quantities", async () => {
    await store.clearAllData();
    const request = receiveRequest(10, "EA", "expected");
    const expected = await store.receiveInventoryFromPhysicalLabel(request);
    assert.deepEqual(progress(expected.inventory), { stage: "expected", loaded: 0, dispatched: 0, loadedAt: null, dispatchedAt: null });
    const received = await store.receiveExpectedInventory({ inventoryId: expected.inventory.id,
      captureId: randomUUID(), receiptSessionId: randomUUID(), operatorName: "Receiver" });
    assert.deepEqual(progress(received.inventory), { stage: "available", loaded: 0, dispatched: 0, loadedAt: null, dispatchedAt: null });
    const deleted = await store.setInventoryDeleted({ id: received.inventory.id, deleted: true, operatorId: "supervisor", operatorName: "Supervisor" });
    assert.deepEqual(progress(deleted.inventory), { stage: "deleted", loaded: 0, dispatched: 0, loadedAt: null, dispatchedAt: null });
    assert.deepEqual(progress((await store.listInventory({ deleted: true })).items[0]), progress(deleted.inventory));
  });
});
