import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const row = {
  plant: "PLT-01", zone: "A-12", areaType: "onsite", shipCategory: "Production",
  loadNumber: "", trainNumber: "TR-204", picklistNumber: "PL-1001", cartNumber: "CT-001",
  cartId: "CART-001", palletId: "PAL-001", sequence: "010", partNumber: "PART-001",
  description: "Production part", color: "BLUE", quantity: 24, aiagSerial: "SERIAL-001",
  masterBarcode: "MASTER-001", movementBarcode: "MOVEMENT-001",
};
const cartKey = (line) => [line.plant, line.areaType, line.trainNumber, line.picklistNumber, line.cartNumber, line.cartId].join("::");

test("persistent demand integrity under conflicting, simulated, and historical operations", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cartflow-integrity-"));
  const envNames = ["CARTFLOW_DATABASE_PATH", "DATABASE_URL", "POSTGRES_URL", "VERCEL"];
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  process.env.CARTFLOW_DATABASE_PATH = join(temporaryRoot, "cartflow.sqlite");
  for (const name of envNames.slice(1)) delete process.env[name];
  const store = await import("../db/cart-store.ts");
  const { getDatabase, DatabaseConflictError } = await import("../db/index.ts");
  const db = await store.ensureDatabase();
  t.after(async () => {
    getDatabase().close();
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const setup = async (input = row) => {
    await store.clearAllData();
    await store.replaceImport("production.csv", [input]);
    const line = (await store.getAppState()).lines[0];
    const context = { lineId: line.id, cartKey: cartKey(line), sessionId: "session-one", operatorName: "Alice", operatorId: "alice-id" };
    assert.equal((await store.manageLock({ ...context, action: "acquire" })).locked, true);
    return { line, context };
  };
  const release = (context) => store.manageLock({ ...context, action: "release" });
  const scanCart = (line, context) => store.recordScan({ ...context, field: "cartBarcode", value: line.cartBarcode });

  await t.test("a lost lease between validation and commit leaves no partial scan", async () => {
    const { line, context } = await setup();
    const original = db.guardedBatch.bind(db);
    let injected = false;
    db.guardedBatch = async (statements, condition) => {
      if (!injected && statements.some((statement) => statement.query.includes("INSERT INTO scan_events"))) {
        injected = true;
        await db.prepare("DELETE FROM cart_locks WHERE cart_key = ?").bind(context.cartKey).run();
      }
      return original(statements, condition);
    };
    try {
      const result = await scanCart(line, context);
      assert.equal(result.reason, "lock_lost");
      assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM scan_events").first()).count, 0);
    } finally { db.guardedBatch = original; }
  });

  await t.test("an expired import claim cannot activate or remove the previous batch", async () => {
    const { line, context } = await setup();
    await release(context);
    const original = db.guardedBatch.bind(db);
    let injected = false;
    db.guardedBatch = async (statements, condition) => {
      if (!injected && statements.some((statement) => statement.query.includes("SET is_active = 1 WHERE id"))) {
        injected = true;
        await db.prepare("DELETE FROM integration_imports WHERE status = 'processing'").run();
      }
      return original(statements, condition);
    };
    try {
      await assert.rejects(store.replaceImport("new.csv", [{ ...row, aiagSerial: "NEW-SERIAL" }]), /expired import claim/);
      assert.equal((await store.getAppState()).lines[0].id, line.id);
      assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM import_batches").first()).count, 1);
    } finally { db.guardedBatch = original; }
  });

  await t.test("manual replacement cannot change demand under a live scanner lease", async () => {
    const { line } = await setup();
    await assert.rejects(store.replaceImport("replacement.csv", [{ ...row, quantity: 25 }]), (error) => error.code === "active_locks");
    assert.equal((await store.getAppState()).lines[0].id, line.id);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM cart_locks").first()).count, 1);
  });

  await t.test("edits preserve and invalidate scan evidence with attributed before/after history", async () => {
    const { line, context } = await setup();
    await scanCart(line, context);
    await release(context);
    await store.updateDemandLine(line.id, { partNumber: "PART-NEW" }, { id: "supervisor-id", name: "Supervisor" });
    const events = (await db.prepare("SELECT * FROM scan_events").all()).results;
    assert.equal(events.length, 1);
    assert.equal(events.every((event) => event.invalidated_at), true);
    const audit = await db.prepare("SELECT * FROM demand_audit_events WHERE action = 'update'").first();
    assert.equal(audit.actor_id, "supervisor-id");
    assert.equal(JSON.parse(audit.before_json).partNumber, "PART-001");
    assert.equal(JSON.parse(audit.after_json).partNumber, "PART-NEW");
    await assert.rejects(store.deleteDemandLine(line.id), /retained for audit/);
    assert.equal((await store.getScannedDemandExport("history")).length, 1);
  });

  await t.test("retention preserves scanned historical batches and their audit", async () => {
    const { line, context } = await setup();
    await scanCart(line, context);
    await release(context);
    await db.prepare("UPDATE import_batches SET imported_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(line.batchId).run();
    await store.replaceImport("new.csv", [{ ...row, aiagSerial: "NEXT-SERIAL" }]);
    assert.ok(await db.prepare("SELECT 1 FROM demand_details WHERE id = ?").bind(line.id).first());
    assert.equal((await store.getScannedDemandExport("history")).length, 1);
  });

  await t.test("explicit idempotency keys survive retention and repeated content", async () => {
    await store.clearAllData();
    const request = (key, content, rows = [row]) => store.replaceIntegrationImport({
      source: "erp", fileName: "erp.csv", rows, idempotencyKey: key, contentHash: content,
    });
    const first = await request("key-a", "content-a");
    await request("key-b", "content-b", [{ ...row, quantity: 25 }]);
    const repeated = await request("key-c", "content-a");
    assert.notEqual(first.batchId, repeated.batchId);
    const replay = await request("key-a", "content-a");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.batchId, first.batchId);
    await db.prepare("UPDATE import_batches SET imported_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(first.batchId).run();
    await store.replaceImport("new.csv", [row]);
    await assert.rejects(request("key-a", "different-content"), (error) => error.code === "idempotency_conflict");
    assert.ok(await db.prepare("SELECT 1 FROM integration_imports WHERE idempotency_key = 'key-a'").first());
  });

  await t.test("release is repeatable and cannot remove another operator's lease", async () => {
    const { context } = await setup();
    assert.equal((await release(context)).released, true);
    const other = { ...context, sessionId: "session-two" };
    assert.equal((await store.manageLock({ ...other, action: "acquire" })).locked, true);
    assert.equal((await release(context)).released, true);
    assert.equal((await db.prepare("SELECT session_id FROM cart_locks").first()).session_id, other.sessionId);
  });

  await t.test("release_own recovers an operator's own reservation but never another's", async () => {
    const { context } = await setup();
    const otherTab = { ...context, sessionId: "session-two" };
    assert.equal((await store.manageLock({ ...otherTab, action: "release_own" })).released, true);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM cart_locks").first()).count, 0);

    await setup();
    const stranger = { ...context, sessionId: "session-two", operatorName: "Alice", operatorId: "another-alice" };
    assert.equal((await store.manageLock({ ...stranger, action: "release_own" })).released, false);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM cart_locks").first()).count, 1);
  });

  await t.test("guard failures roll back every write without leaving guard records", async () => {
    const before = (await db.prepare("SELECT COUNT(*) AS count FROM scan_events").first()).count;
    await assert.rejects(db.guardedBatch([
      db.prepare("DELETE FROM scan_events"),
    ], db.prepare("0 = 1")), DatabaseConflictError);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM scan_events").first()).count, before);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM cartflow_write_guards").first()).count, 0);
  });
});
