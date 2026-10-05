import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("inventory deletion and restoration preserve receipts and update only active stock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-inventory-delete-"));
  const names = ["CARTFLOW_DATABASE_PATH", "DATABASE_URL", "POSTGRES_URL", "VERCEL"];
  const previous = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "qa.sqlite");
  for (const key of names.slice(1)) delete process.env[key];
  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => {
    db.close();
    for (const key of names) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(directory, { recursive: true, force: true });
  });
  const body = { captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ["Q20", "PDELETE-PART", "2P00", "1SDELETE-SERIAL"], operatorName: "Receiver" };
  const received = await store.receiveInventoryFromPhysicalLabel(body);
  const action = { id: received.inventory.id, operatorId: "supervisor-one", operatorName: "Supervisor" };

  await t.test("concurrent deletes change stock and create the audit exactly once", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => store.setInventoryDeleted({ ...action, deleted: true })));
    assert.equal(results.filter((result) => result.changed).length, 1);
    assert.deepEqual((await store.listInventory()).summary, { containers: 0, units: 0, quantitiesByUnit: {} });
    assert.equal((await store.getInventoryExport()).length, 0);
    const removed = await store.listInventory({ deleted: true, q: "DELETE-SERIAL" });
    assert.equal(removed.items[0].id, received.inventory.id);
    assert.equal(removed.items[0].status, "deleted");
    const audits = await db.prepare("SELECT * FROM demand_audit_events WHERE action = 'inventory_deleted'").all();
    assert.equal(audits.results.length, 1);
    assert.equal(audits.results[0].actor_id, action.operatorId);
    assert.equal(JSON.parse(audits.results[0].before_json).status, "available");
    assert.equal(JSON.parse(audits.results[0].after_json).status, "deleted");
    assert.ok(await db.prepare("SELECT capture_id FROM inventory_capture_receipts WHERE capture_id = ?").bind(body.captureId).first());
  });
  await t.test("receipt retries and new scans cannot silently restore deleted stock", async () => {
    for (const captureId of [body.captureId, randomUUID()]) await assert.rejects(
      store.receiveInventoryFromPhysicalLabel({ ...body, captureId }), /deleted by a supervisor/,
    );
    assert.equal((await store.listInventory()).total, 0);
  });
  await t.test("restoration retains the original identity, time and receiver", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => store.setInventoryDeleted({ ...action, deleted: false })));
    assert.equal(results.filter((result) => result.changed).length, 1);
    assert.deepEqual((await store.listInventory()).items, [received.inventory]);
    assert.equal((await store.listInventory({ deleted: true })).total, 0);
    assert.equal((await store.receiveInventoryFromPhysicalLabel(body)).duplicate, true);
    assert.deepEqual((await store.listInventory()).summary, { containers: 1, units: 20, quantitiesByUnit: { EA: 20 } });
  });
  await t.test("audit failure rolls deletion back and unknown identifiers cannot change stock", async () => {
    await db.prepare(`CREATE TRIGGER reject_deletion_audit BEFORE INSERT ON demand_audit_events
      WHEN NEW.action = 'inventory_deleted' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`).run();
    try { await assert.rejects(store.setInventoryDeleted({ ...action, deleted: true }), /audit unavailable/); }
    finally { await db.prepare("DROP TRIGGER reject_deletion_audit").run(); }
    assert.deepEqual((await store.listInventory()).items, [received.inventory]);
    await assert.rejects(store.setInventoryDeleted({ ...action, id: randomUUID(), deleted: true }), (error) => error.status === 404);
    await assert.rejects(store.setInventoryDeleted({ ...action, id: "invalid", deleted: true }), /valid inventory identifier/);
  });
});
