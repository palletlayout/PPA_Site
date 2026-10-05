import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("reset atomically clears production, test inventory and all operational history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-reset-"));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "disposable.sqlite");
  for (const key of ["DATABASE_URL", "POSTGRES_URL", "VERCEL"]) delete process.env[key];
  const store = await import("../db/cart-store.ts");
  const sessions = await import("../lib/session-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const principal = { id: "qa-admin", sessionId: randomUUID(), name: "QA admin", role: "admin" };
  await sessions.registerSession(principal);

  const row = { plant: "QA", zone: "A", areaType: "onsite", shipCategory: "Production", loadNumber: "", trainNumber: "RESET-TRAIN", picklistNumber: "RESET-PICK", cartNumber: "RESET-CART", cartId: "RESET-CART", palletId: "RESET-PALLET", sequence: "001", partNumber: "RESET-PART", description: "Disposable reset fixture", color: "BLUE", quantity: 15, aiagSerial: "", masterBarcode: "RESET-MASTER", movementBarcode: "RESET-MOVEMENT" };
  await store.replaceImport("reset-fixture.csv", [row]);
  await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ["1SRESET-STOCK", "PRESET-PART", "2PBLUE", "Q15"], operatorName: "QA receiver" });
  const line = (await store.getAppState()).lines[0];
  const context = { lineId: line.id, cartKey: [line.plant, line.areaType, line.trainNumber, line.picklistNumber, line.cartNumber, line.cartId].join("::"), sessionId: "reset-qa-scanner", operatorName: "QA packer" };
  await store.manageLock({ ...context, action: "acquire" });
  await store.recordScan({ ...context, field: "cartBarcode", value: line.cartBarcode });
    assert.equal((await store.fulfillDemand({ ...context, serial: "1SRESET-STOCK", serialFormat: "barcode" })).verified, true);
  assert.equal((await store.confirmCartLoading({ cartBarcode: line.cartBarcode, movementValue: row.movementBarcode, operatorName: "QA loader" })).ok, true);
  await store.manageLock({ ...context, action: "release" });
  await store.appendTestDemandFromPhysicalLabel({ captureId: randomUUID(), testSessionId: randomUUID(), rawValues: ["1SRESET-TEST", "PRESET-TEST-PART", "2PRED", "Q4"], operatorName: "QA tester" });

  const tables = ["fulfillment_allocations", "demand_audit_events", "inventory_demand_projections", "inventory_capture_receipts", "load_confirmations", "scan_events", "cart_locks", "demand_details", "inventory_items", "demand_headers", "cart_lines", "integration_imports", "demand_import_rows", "import_batches"];
  const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => [table, Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n)])));
  const before = await counts();
  for (const table of ["fulfillment_allocations", "demand_audit_events", "inventory_demand_projections", "inventory_capture_receipts", "inventory_items", "load_confirmations", "scan_events", "demand_import_rows"]) assert.ok(before[table] > 0, `${table} fixture populated`);
  const schema = await db.prepare("SELECT version FROM cartflow_schema WHERE name='primary'").first();

  await db.prepare("CREATE TRIGGER reject_qa_reset BEFORE DELETE ON inventory_items BEGIN SELECT RAISE(ABORT, 'reset unavailable'); END").run();
  await assert.rejects(store.clearAllData(principal), /reset unavailable/);
  assert.deepEqual(await counts(), before, "failed reset rolls back every deletion");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM maintenance_audit_events").first()).n, 0, "failed reset cannot record a successful deletion");
  await db.prepare("DROP TRIGGER reject_qa_reset").run();

  const cleared = await store.clearAllData(principal);
  assert.deepEqual(cleared.deletedByTable, before);
  assert.equal(cleared.deleted, Object.values(before).reduce((total, count) => total + count, 0));
  assert.ok(Object.values(await counts()).every((count) => count === 0));
  assert.deepEqual(await store.getAppState(), { lines: [], locks: [], events: [], lastImport: null, settings: { packingMode: "exact", inventoryMode: "uploaded", partAttribute: "color" } });
  assert.equal((await store.listInventory()).total, 0);
  assert.equal(await sessions.isSessionActive(principal), true, "sign-in access survives an operational reset");
  assert.deepEqual(await db.prepare("SELECT version FROM cartflow_schema WHERE name='primary'").first(), schema);
  const evidence = await db.prepare("SELECT * FROM maintenance_audit_events").first();
  assert.equal(evidence.action, "local_data_reset");
  assert.equal(evidence.actor_id, principal.id);
  assert.equal(evidence.actor_name, principal.name);
  assert.deepEqual(JSON.parse(evidence.detail), before);
  assert.equal((await store.clearAllData(principal)).deleted, 0, "repeat reset is harmless");
  const audit = await db.prepare("SELECT * FROM maintenance_audit_events").all();
  assert.equal(audit.results.length, 2, "reset history survives subsequent resets");
  assert.deepEqual(audit.results.find(row => row.id === evidence.id), evidence);
  assert.ok(Object.values(JSON.parse(audit.results.find(row => row.id !== evidence.id).detail)).every(value => value === 0));
});
