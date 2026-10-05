import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const base = {
  plant: "P1", areaType: "onsite", zone: "Z", shipCategory: "Production",
  trainNumber: "TRAIN-1", loadNumber: "", picklistNumber: "PICK-1", cartNumber: "1",
  cartId: "CART-1", palletId: "PAL-1", masterBarcode: "MASTER-1", movementBarcode: "MOVE-1",
  partNumber: "PART", description: "Large picklist regression", color: "BLUE", quantity: 5, aiagSerial: "",
};
const keyFor = (line) => [line.plant, line.areaType, line.trainNumber, line.picklistNumber, line.cartNumber, line.cartId].join("::");

test("large picklist actions keep every guard and mutation in one transaction", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-large-actions-"));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "qa.sqlite");
  for (const name of ["DATABASE_URL", "POSTGRES_URL", "VERCEL"]) delete process.env[name];
  const store = await import("../db/cart-store.ts");
  const { DatabaseConflictError } = await import("../db/index.ts");
  const db = await store.ensureDatabase();
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const actor = { id: "supervisor", name: "Supervisor" };
  const countGuards = async () => Number((await db.prepare("SELECT COUNT(*) AS n FROM cartflow_write_guards").first()).n);
  const contextFor = (line) => ({ lineId: line.id, cartKey: keyFor(line), sessionId: `scanner-${line.picklistNumber}`, operatorName: "Packer", operatorId: "packer" });
  const setup = async (size, mode = "exact", extra = []) => {
    await store.clearAllData();
    await store.updateFulfillmentSettings({ packingMode: mode, inventoryMode: "uploaded" }, actor);
    await store.replaceImport("large.csv", [
      ...Array.from({ length: size }, (_, index) => ({ ...base, sourceLineId: `ROW-${index}`, sequence: String(index + 1).padStart(4, "0") })),
      ...extra,
    ]);
    const lines = (await store.getAppState()).lines.filter((line) => line.picklistNumber === "PICK-1");
    const context = contextFor(lines[0]);
    assert.equal((await store.manageLock({ ...context, action: "acquire" })).locked, true);
    return { lines, context };
  };

  for (const size of [1100, 2000]) await t.test(`close and reset ${size} lines without exceeding SQLite limits`, async () => {
    const { context } = await setup(size);
    const closed = await store.closePicklist(context);
    assert.equal(closed.shortLines, size);
    assert.ok((await store.getAppState()).lines.every((line) => line.status === "short"));
    assert.equal((await store.resetPicklist(context)).resetLines, size);
    assert.ok((await store.getAppState()).lines.every((line) => line.status === "pending" && !line.shortClosedAt));
    assert.equal(await countGuards(), 0);
  });

  await t.test("a revision change in the final close guard chunk leaves all rows open", async () => {
    const { lines, context } = await setup(80);
    const original = db.guardedBatch.bind(db);
    let injected = false;
    db.guardedBatch = async (statements, condition) => {
      if (!injected && statements.some((statement) => statement.query.includes("'close_short'"))) {
        injected = true;
        await db.prepare("UPDATE demand_details SET revision=revision+1 WHERE id=?").bind(lines.at(-1).id).run();
      }
      return original(statements, condition);
    };
    try { await assert.rejects(store.closePicklist(context), DatabaseConflictError); }
    finally { db.guardedBatch = original; }
    assert.equal(injected, true);
    assert.ok((await store.getAppState()).lines.every((line) => line.status === "pending" && !line.shortClosedAt));
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events WHERE action='close_short'").first()).n, 0);
    assert.equal(await countGuards(), 0);
  });

  const packMany = async () => {
    const otherRow = { ...base, sourceLineId: "OTHER", sequence: "0001", picklistNumber: "PICK-2", cartNumber: "2", cartId: "CART-2", palletId: "PAL-2", masterBarcode: "MASTER-2" };
    const { lines, context } = await setup(80, "multiple", [otherRow]);
    assert.equal((await store.recordScan({ ...context, field: "cartBarcode", value: lines[0].cartBarcode })).matched, true);
    const containers = [];
    for (const [index, line] of lines.entries()) {
      const serial = `STOCK-${index}`;
      const received = await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: [`1S${serial}`, "PPART", "CBLUE", "Q10"], operatorName: "Receiver" });
      containers.push(received.inventory);
      const result = await store.fulfillDemand({ ...context, lineId: line.id, serial, serialFormat: "canonical", requestId: randomUUID() });
      assert.equal(result.verified, true, JSON.stringify(result));
    }
    const other = (await store.getAppState()).lines.find((line) => line.picklistNumber === "PICK-2");
    const otherContext = contextFor(other);
    await store.manageLock({ ...otherContext, action: "acquire" });
    await store.recordScan({ ...otherContext, field: "cartBarcode", value: other.cartBarcode });
    return { lines, context, containers, other, otherContext };
  };

  await t.test("reset retries a late inventory conflict and preserves another picklist's allocation", async () => {
    const { context, containers, otherContext, other } = await packMany();
    const shared = containers.at(-1);
    const original = db.guardedBatch.bind(db);
    let resetAttempts = 0;
    db.guardedBatch = async (statements, condition) => {
      if (statements.some((statement) => statement.query.includes("'unpack_reset'"))) {
        resetAttempts++;
        if (resetAttempts === 1) {
          const packed = await store.fulfillDemand({ ...otherContext, serial: shared.serial, serialFormat: "canonical", requestId: randomUUID() });
          assert.equal(packed.verified, true, JSON.stringify(packed));
        }
      }
      return original(statements, condition);
    };
    try { assert.equal((await store.resetPicklist(context)).releasedContainers, 80); }
    finally { db.guardedBatch = original; }
    assert.equal(resetAttempts, 2, "the stale final inventory chunk must force a fresh snapshot");
    const state = await store.getAppState();
    assert.ok(state.lines.filter((line) => line.picklistNumber === "PICK-1").every((line) => line.fulfilledQuantity === 0 && line.status === "pending"));
    assert.equal(state.lines.find((line) => line.id === other.id).fulfilledQuantity, 5);
    const item = (await store.listInventory({ q: shared.serial })).items.find((item) => item.id === shared.id);
    assert.equal(item.consumedQuantity, 5);
    assert.equal(item.remainingQuantity, 5);
    assert.deepEqual(item.fulfilledDemandIds, [other.id]);
    assert.equal(await countGuards(), 0);
  });

  await t.test("reset preserves 3,000 shared units without overflowing PostgreSQL's integer CASE parameter", async () => {
    const otherRow = { ...base, sourceLineId: "OTHER", sequence: "0001", quantity: 3000,
      picklistNumber: "PICK-2", cartNumber: "2", cartId: "CART-2", palletId: "PAL-2", masterBarcode: "MASTER-2" };
    const { lines, context } = await setup(1, "multiple", [otherRow]);
    await store.recordScan({ ...context, field: "cartBarcode", value: lines[0].cartBarcode });
    const received = await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(),
      rawValues: ["1SLARGE-SHARED", "PPART", "CBLUE", "Q3005"], operatorName: "Receiver" });
    assert.equal((await store.fulfillDemand({ ...context, serial: "LARGE-SHARED", serialFormat: "canonical", requestId: randomUUID() })).verified, true);
    const other = (await store.getAppState()).lines.find((line) => line.picklistNumber === "PICK-2");
    const otherContext = contextFor(other);
    await store.manageLock({ ...otherContext, action: "acquire" });
    await store.recordScan({ ...otherContext, field: "cartBarcode", value: other.cartBarcode });
    assert.equal((await store.fulfillDemand({ ...otherContext, serial: "LARGE-SHARED", serialFormat: "canonical", requestId: randomUUID() })).verified, true);
    const original = db.guardedBatch.bind(db);
    let checked = false;
    db.guardedBatch = async (statements, condition) => {
      for (const statement of statements.filter((item) => item.query.includes("consumed_at=CASE WHEN ?=0"))) {
        // PostgreSQL infers int4 for the parameter compared with the literal 0.
        // Enforce its range here because SQLite would accept scaled millionths.
        const value = statement.values[2];
        assert.ok(Number.isInteger(value) && value >= -2147483648 && value <= 2147483647);
        checked = true;
      }
      return original(statements, condition);
    };
    try { assert.equal((await store.resetPicklist(context)).releasedContainers, 1); }
    finally { db.guardedBatch = original; }
    assert.equal(checked, true);
    const item = (await store.listInventory({ q: "LARGE-SHARED" })).items.find((item) => item.id === received.inventory.id);
    assert.equal(item.consumedQuantity, 3000);
    assert.equal(item.remainingQuantity, 5);
    assert.ok(item.consumedAt);
    assert.deepEqual(item.fulfilledDemandIds, [other.id]);
    assert.equal(await countGuards(), 0);
  });

  await t.test("reset audit failure rolls back all allocations, stock, loading, and scan evidence", async () => {
    const { context, lines } = await packMany();
    const loaded = await store.confirmCartLoading({ cartBarcode: lines[0].cartBarcode, movementValue: lines[0].movementBarcode, operatorName: "Loader" });
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    const before = await store.getAppState();
    const stockBefore = await store.getInventoryExport();
    await db.prepare("CREATE TRIGGER reject_reset_audit BEFORE INSERT ON demand_audit_events WHEN NEW.action='unpack_reset' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END").run();
    try { await assert.rejects(store.resetPicklist(context), /audit unavailable/); }
    finally { await db.prepare("DROP TRIGGER reject_reset_audit").run(); }
    const after = await store.getAppState();
    assert.deepEqual(after.lines, before.lines);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(await store.getInventoryExport(), stockBefore);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM load_confirmations").first()).n, 1);
    assert.equal(await countGuards(), 0);
  });
});
