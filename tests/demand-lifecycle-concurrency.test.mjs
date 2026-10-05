import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const row = (name, changes = {}) => ({
  sourceScope: "erp", sourceLineId: `order-${name}`, plant: "P1", zone: "A", areaType: "onsite",
  shipCategory: "Production", loadNumber: "", trainNumber: "TRAIN", picklistNumber: `PICK-${name}`,
  cartNumber: `CART-${name}`, cartId: `CART-${name}`, palletId: `PAL-${name}`, sequence: "010",
  partNumber: "PART", description: "Part", color: "BLUE", quantity: 10, aiagSerial: "",
  masterBarcode: `MASTER-${name}`, movementBarcode: "DESTINATION", ...changes,
});
const cartKey = (line) => [line.plant, line.areaType, line.trainNumber, line.picklistNumber, line.cartNumber, line.cartId].join("::");

test("demand lifecycle and imports retain evidence while unrelated scanners keep working", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-demand-lifecycle-"));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "test.sqlite");
  for (const name of ["DATABASE_URL", "POSTGRES_URL", "VERCEL"]) delete process.env[name];
  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const actor = { id: "supervisor", name: "Supervisor" };
  const context = (line) => ({ lineId: line.id, cartKey: cartKey(line), sessionId: "scanner", operatorId: "operator", operatorName: "Operator" });
  const setup = async (rows) => {
    await store.clearAllData();
    await store.replaceImport("first.json", rows, undefined, actor);
    return (await store.getAppState()).lines;
  };
  const receive = async (serial) => store.receiveInventoryFromPhysicalLabel({
    captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: [`1S${serial}`, "PPART", "CBLUE", "Q10"],
    operatorId: actor.id, operatorName: actor.name,
  });

  await t.test("a completely departed snapshot can become empty with stock and audit intact", async () => {
    const [line] = await setup([row("OLD")]);
    const scan = context(line);
    const received = await receive("OLD-STOCK");
    assert.equal((await store.manageLock({ ...scan, action: "acquire" })).locked, true);
    assert.equal((await store.recordScan({ ...scan, field: "cartBarcode", value: line.cartBarcode })).matched, true);
    assert.equal((await store.fulfillDemand({ ...scan, serial: "1SOLD-STOCK", serialFormat: "barcode", requestId: randomUUID() })).verified, true);
    await store.manageLock({ ...scan, action: "release" });
    const outbound = { cartBarcode: line.cartBarcode, movementValue: line.trainNumber, operatorId: actor.id, operatorName: actor.name };
    assert.equal((await store.confirmCartLoading(outbound)).ok, true);
    assert.equal((await store.confirmPicklistDispatch(outbound)).ok, true);
    const { header_id: headerId } = await db.prepare("SELECT header_id FROM demand_details WHERE id=?").bind(line.id).first();
    const before = {
      allocations: (await db.prepare("SELECT * FROM fulfillment_allocations").all()).results,
      scans: (await db.prepare("SELECT * FROM scan_events ORDER BY id").all()).results,
      loads: (await db.prepare("SELECT * FROM load_confirmations").all()).results,
      inventory: (await db.prepare("SELECT * FROM inventory_items").all()).results,
      detail: await db.prepare("SELECT * FROM demand_details WHERE id=?").bind(line.id).first(),
      header: await db.prepare("SELECT * FROM demand_headers WHERE id=?").bind(headerId).first(),
    };
    const empty = await store.replaceIntegrationImport({ source: "erp", fileName: "no-open-orders.json", rows: [], idempotencyKey: "empty-orders", contentHash: "empty" });
    assert.equal(empty.rowCount, 0);
    assert.equal((await store.getAppState()).lines.length, 0);
    assert.deepEqual((await db.prepare("SELECT * FROM fulfillment_allocations").all()).results, before.allocations);
    assert.deepEqual((await db.prepare("SELECT * FROM scan_events ORDER BY id").all()).results, before.scans);
    assert.deepEqual((await db.prepare("SELECT * FROM load_confirmations").all()).results, before.loads);
    assert.deepEqual((await db.prepare("SELECT * FROM inventory_items").all()).results, before.inventory);
    assert.deepEqual(await db.prepare("SELECT * FROM demand_details WHERE id=?").bind(line.id).first(), before.detail);
    assert.deepEqual(await db.prepare("SELECT * FROM demand_headers WHERE id=?").bind(headerId).first(), before.header);
    assert.equal((await store.listInventory()).items.find((item) => item.id === received.inventory.id).fulfillmentStage, "dispatched");
    assert.ok((await store.getScannedDemandExport("history")).some((event) => event.line_id === line.id));
    const archived = await db.prepare("SELECT * FROM demand_audit_events WHERE action='reconcile_archive'").first();
    assert.equal(archived.line_id, line.id);
    assert.equal(archived.actor_id, "integration:erp");
    await assert.rejects(store.replaceImport("reopen.json", [row("OLD")]), (error) => error.issues?.some((issue) => issue.reason === "terminal_demand_reintroduced"));
    await store.replaceImport("new-orders.json", [row("NEW")]);
    assert.equal((await store.getAppState()).lines[0].sourceLineId, "order-NEW");
    assert.equal((await db.prepare("SELECT consumed_quantity FROM inventory_items WHERE id=?").bind(received.inventory.id).first()).consumed_quantity, 10);
  });

  await t.test("empty snapshots cannot remove reserved or scanned work", async () => {
    const [line] = await setup([row("ACTIVE")]);
    const scan = context(line);
    const confirmed = { allowShrink: true };
    await store.manageLock({ ...scan, action: "acquire" });
    // The confirmation gate comes first; confirming it must not bypass the lease.
    await assert.rejects(store.replaceImport("empty.json", []), (error) => error.code === "shrink_confirmation_required");
    await assert.rejects(store.replaceImport("empty.json", [], undefined, undefined, confirmed), (error) => error.code === "active_locks");
    await store.recordScan({ ...scan, field: "cartBarcode", value: line.cartBarcode });
    await store.manageLock({ ...scan, action: "release" });
    await assert.rejects(store.replaceImport("empty.json", [], undefined, undefined, confirmed), (error) => error.code === "reconciliation_required");
    assert.equal((await store.getAppState()).lines[0].id, line.id);
  });

  await t.test("a scanned reservation stays valid while unrelated demand changes", async () => {
    const lines = await setup([row("ACTIVE"), row("OTHER")]);
    const line = lines.find((candidate) => candidate.sourceLineId === "order-ACTIVE");
    const scan = context(line);
    await store.manageLock({ ...scan, action: "acquire" });
    await store.recordScan({ ...scan, field: "cartBarcode", value: line.cartBarcode });
    const lease = await db.prepare("SELECT * FROM cart_locks WHERE cart_key=?").bind(scan.cartKey).first();
    const revisions = () => db.prepare("SELECT h.id AS header_id,h.revision AS header_revision,d.revision AS detail_revision FROM demand_details d JOIN demand_headers h ON h.id=d.header_id WHERE d.id=?").bind(line.id).first();
    const before = await revisions();
    await store.replaceImport("updated.json", [row("ACTIVE"), row("OTHER", { quantity: 20 }), row("NEW")]);
    const current = (await store.getAppState()).lines.find((candidate) => candidate.id === line.id);
    assert.ok(current);
    assert.deepEqual(await revisions(), before);
    assert.deepEqual(await db.prepare("SELECT * FROM cart_locks WHERE cart_key=?").bind(scan.cartKey).first(), lease);
    await receive("ACTIVE-STOCK");
    assert.equal((await store.fulfillDemand({ ...scan, serial: "1SACTIVE-STOCK", serialFormat: "barcode", requestId: randomUUID() })).verified, true);
  });

  await t.test("scanner acquisition and renewal remain available during an unrelated import claim", async () => {
    const [line] = await setup([row("ACTIVE")]);
    const scan = context(line);
    const original = db.guardedBatch.bind(db);
    let checked = false;
    db.guardedBatch = async (statements, condition) => {
      if (!checked && statements.some((statement) => statement.query.includes("UPDATE import_batches SET is_active = 1"))) {
        checked = true;
        assert.ok(await db.prepare("SELECT id FROM integration_imports WHERE status='processing'").first());
        assert.equal((await store.manageLock({ ...scan, action: "acquire" })).locked, true);
        assert.equal((await store.manageLock({ ...scan, action: "renew" })).locked, true);
      }
      return original(statements, condition);
    };
    try { await store.replaceImport("updated.json", [row("ACTIVE"), row("NEW")]); }
    finally { db.guardedBatch = original; }
    assert.equal(checked, true);
    assert.equal((await store.recordScan({ ...scan, field: "cartBarcode", value: line.cartBarcode })).matched, true);
  });

  await t.test("the 10,000-row snapshot limit persists every row and can safely retire untouched demand", async () => {
    await store.clearAllData();
    const rows = Array.from({ length: 10_000 }, (_, index) => row("LARGE", {
      sourceLineId: `large-${index}`, sequence: String(index).padStart(5, "0"),
    }));
    const result = await store.replaceImport("large.json", rows, undefined, actor);
    assert.equal(result.rowCount, rows.length);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_details d JOIN demand_headers h ON h.id=d.header_id WHERE h.batch_id=?").bind(result.batchId).first()).n, rows.length);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_import_rows WHERE batch_id=?").bind(result.batchId).first()).n, rows.length);
    assert.ok(await db.prepare("SELECT id FROM demand_details WHERE source_line_id='large-9999'").first());
    await assert.rejects(store.replaceImport("empty.json", [], undefined, actor), (error) => error.code === "shrink_confirmation_required");
    assert.equal((await store.getAppState()).lines.length, rows.length, "the refused snapshot retired nothing");
    const empty = await store.replaceImport("empty.json", [], undefined, actor, { allowShrink: true });
    assert.equal(empty.rowCount, 0);
    assert.equal((await store.getAppState()).lines.length, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_details").first()).n, rows.length);
  });
});
