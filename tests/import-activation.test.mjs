import assert from "node:assert/strict";
import test from "node:test";
import { Database, DatabaseConflictError } from "../db/index.ts";
import { activateReconciledImport } from "../db/import-activation.ts";
import { DemandReconciliationError, reconciliationCartKey } from "../db/demand-reconciliation.ts";

const headerColumns = { plant: "plant", zone: "zone", areaType: "area_type", shipCategory: "ship_category",
  loadNumber: "load_number", trainNumber: "train_number", picklistNumber: "picklist_number",
  cartNumber: "cart_number", cartId: "cart_id", palletId: "pallet_id",
  programId: "program_id", pymtc: "pymtc" };
const detailColumns = { sequence: "sequence", partNumber: "part_number", description: "description", color: "color",
  quantity: "quantity", sourceLineId: "source_line_id", sourceScope: "source_scope", unitOfMeasure: "unit_of_measure" };
const row = (changes = {}) => ({ sourceScope: "erp", sourceLineId: "line-1", plant: "PLANT", zone: "A",
  areaType: "onsite", shipCategory: "PRODUCTION", loadNumber: "", trainNumber: "TRAIN-1",
  picklistNumber: "PICK-1", cartNumber: "C-1", cartId: "CART-1", palletId: "PAL-1",
  sequence: "010", partNumber: "PART", description: "Part", color: "BLUE", quantity: 12, aiagSerial: "", unitOfMeasure: "EA", ...changes });
const sqlNow = () => "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

async function fixture(t) {
  const db = new Database({ sqlitePath: ":memory:" });
  t.after(() => db.close());
  const schemas = [
    "CREATE TABLE cartflow_write_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CONSTRAINT cartflow_write_guard_valid CHECK(valid=1))",
    "CREATE TABLE import_batches (id TEXT PRIMARY KEY, file_name TEXT, row_count INTEGER, imported_at TEXT, is_active INTEGER DEFAULT 0)",
    "CREATE UNIQUE INDEX one_active ON import_batches(is_active) WHERE is_active=1",
    "CREATE TABLE integration_imports (id TEXT PRIMARY KEY, batch_id TEXT, status TEXT, expires_at TEXT, row_count INTEGER, imported_at TEXT)",
    "CREATE TABLE demand_import_rows (id TEXT PRIMARY KEY, batch_id TEXT REFERENCES import_batches(id) ON DELETE CASCADE, row_json TEXT)",
    `CREATE TABLE demand_headers (id TEXT PRIMARY KEY, batch_id TEXT REFERENCES import_batches(id) ON DELETE CASCADE,
      cart_key TEXT, picklist_identity TEXT DEFAULT '', cart_barcode TEXT UNIQUE, revision INTEGER DEFAULT 0, loaded_at TEXT, loaded_by TEXT DEFAULT '', dispatched_at TEXT, dispatched_by TEXT DEFAULT '',
      ${Object.values(headerColumns).map((column) => `${column} TEXT`).join(",")}, UNIQUE(batch_id,cart_key))`,
    "CREATE TABLE inventory_items (id TEXT PRIMARY KEY, status TEXT, consumed_quantity NUMERIC)",
    `CREATE TABLE demand_details (id TEXT PRIMARY KEY, header_id TEXT REFERENCES demand_headers(id) ON DELETE CASCADE,
      revision INTEGER DEFAULT 0, aiag_serial TEXT DEFAULT '', status TEXT DEFAULT 'pending', verified_at TEXT,
      fulfilled_quantity NUMERIC DEFAULT 0, inventory_item_id TEXT UNIQUE REFERENCES inventory_items(id),
      ${Object.values(detailColumns).map((column) => `${column} ${column === "quantity" ? "NUMERIC" : "TEXT"}`).join(",")})`,
    "CREATE TABLE scan_events (id TEXT PRIMARY KEY, line_id TEXT, matched INTEGER, invalidated_at TEXT)",
    "CREATE TABLE load_confirmations (id TEXT PRIMARY KEY, header_id TEXT UNIQUE REFERENCES demand_headers(id) ON DELETE CASCADE)",
    "CREATE TABLE cart_locks (cart_key TEXT PRIMARY KEY, picklist_key TEXT NOT NULL DEFAULT '', expires_at TEXT)",
    "CREATE TABLE demand_audit_events (id TEXT PRIMARY KEY, batch_id TEXT, header_id TEXT, line_id TEXT, action TEXT, before_json TEXT, after_json TEXT, actor_id TEXT, actor_name TEXT, created_at TEXT)",
  ];
  await db.batch(schemas.map((sql) => db.prepare(sql)));
  const adapters = {
    headerColumns, detailColumns, databaseNow: sqlNow,
    selectSql: `SELECT d.id, d.header_id, h.batch_id, h.cart_barcode, h.loaded_at, h.loaded_by,
      h.dispatched_at, h.dispatched_by, d.status, d.verified_at, d.fulfilled_quantity, d.inventory_item_id,
      d.aiag_serial, d.revision AS detail_revision, h.revision AS header_revision,
      ${Object.values(headerColumns).map((column) => `h.${column}`).join(",")},
      ${Object.values(detailColumns).map((column) => `d.${column}`).join(",")}
      FROM demand_details d JOIN demand_headers h ON h.id=d.header_id`,
    lineFromRow: (raw) => ({
      ...Object.fromEntries([...Object.entries(headerColumns), ...Object.entries(detailColumns)].map(([field, column]) => [field, raw[column]])),
      id: raw.id, batchId: raw.batch_id, cartBarcode: raw.cart_barcode, loadedAt: raw.loaded_at,
      loadedBy: raw.loaded_by, dispatchedAt: raw.dispatched_at, dispatchedBy: raw.dispatched_by,
      status: raw.status, verifiedAt: raw.verified_at, fulfilledQuantity: Number(raw.fulfilled_quantity),
      inventoryItemId: raw.inventory_item_id, aiagSerial: raw.aiag_serial,
    }),
    prepareHeaderInsert: (database, batchId, id, source) => database.prepare(`INSERT INTO demand_headers
      (id,batch_id,cart_key,cart_barcode,${Object.values(headerColumns).join(",")})
      VALUES (${Array(4 + Object.keys(headerColumns).length).fill("?").join(",")})`)
      .bind(id, batchId, reconciliationCartKey(source), `BARCODE-${id}`, ...Object.keys(headerColumns).map((field) => source[field] ?? "")),
    prepareDetailInsert: (database, headerId, id, source) => database.prepare(`INSERT INTO demand_details
      (id,header_id,${Object.values(detailColumns).join(",")}) VALUES (${Array(2 + Object.keys(detailColumns).length).fill("?").join(",")})`)
      .bind(id, headerId, ...Object.keys(detailColumns).map((field) => source[field] ?? "")),
  };
  const activate = async (batchId, rows, extra = {}) => {
    const receiptId = `receipt-${batchId}`;
    await db.prepare("INSERT INTO integration_imports (id,batch_id,status,expires_at) VALUES (?,?,'processing',?)")
      .bind(receiptId, batchId, new Date(Date.now() + 600_000).toISOString()).run();
    return activateReconciledImport(db, { batchId, fileName: `${batchId}.csv`, rows, integrationReceiptId: receiptId, ...extra }, adapters);
  };
  const active = async () => (await db.prepare(`${adapters.selectSql} JOIN import_batches b ON b.id=h.batch_id WHERE b.is_active=1 ORDER BY d.sequence`).all()).results;
  return { db, activate, active, adapters };
}

test("recurring snapshots preserve demand/header identity, consumed stock, scans and loaded/dispatch evidence", async (t) => {
  const { db, activate, active } = await fixture(t);
  await activate("first", [row()]);
  const original = (await active())[0];
  await db.batch([
    db.prepare("INSERT INTO inventory_items VALUES ('container','consumed',12)"),
    db.prepare("UPDATE demand_details SET status='verified',fulfilled_quantity=12,inventory_item_id='container',aiag_serial='SERIAL',verified_at='packed',revision=revision+1 WHERE id=?").bind(original.id),
    db.prepare("INSERT INTO scan_events VALUES ('scan',?,1,NULL)").bind(original.id),
    db.prepare("UPDATE demand_headers SET loaded_at='loaded',loaded_by='Loader',dispatched_at='dispatched',dispatched_by='Dispatcher' WHERE id=?").bind(original.header_id),
    db.prepare("INSERT INTO load_confirmations VALUES ('load',?)").bind(original.header_id),
  ]);
  const result = await activate("second", [row()]);
  assert.deepEqual(result.reconciliation, { preserved: 1, updated: 0, added: 0, removed: 0 });
  const next = (await active())[0];
  for (const field of ["id", "header_id", "cart_barcode"]) assert.equal(next[field], original[field]);
  assert.equal(next.status, "verified"); assert.equal(next.inventory_item_id, "container");
  assert.equal(next.fulfilled_quantity, 12); assert.equal(next.aiag_serial, "SERIAL");
  assert.equal(next.loaded_at, "loaded"); assert.equal(next.dispatched_at, "dispatched");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM scan_events").first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM load_confirmations").first()).n, 1);
  assert.equal((await db.prepare("SELECT consumed_quantity FROM inventory_items").first()).consumed_quantity, 12);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_import_rows").first()).n, 2);
});

test("production imports retain active generated TEST work without adding it to the source snapshot", async (t) => {
  const { db, activate, active } = await fixture(t);
  const testRow = row({ sourceLineId: "test-line", plant: "TEST", programId: "TESTSCAN", pymtc: "TEST:CAPTURE",
    picklistNumber: "TEST-PICK", cartId: "TEST-CART" });
  await activate("test-batch", [testRow]);
  const original = (await active())[0];
  await db.batch([
    db.prepare("UPDATE demand_details SET status='verified',verified_at='packed' WHERE id=?").bind(original.id),
    db.prepare("INSERT INTO scan_events VALUES ('test-scan',?,1,NULL)").bind(original.id),
    db.prepare("UPDATE demand_headers SET loaded_at='loaded',loaded_by='Tester' WHERE id=?").bind(original.header_id),
    db.prepare("INSERT INTO load_confirmations VALUES ('test-load',?)").bind(original.header_id),
  ]);
  for (const batch of ["production-one", "production-two"]) {
    await activate(batch, [row()]);
    const lines = await active();
    assert.equal(lines.length, 2);
    const retained = lines.find((line) => line.id === original.id);
    assert.ok(retained);
    assert.equal(retained.header_id, original.header_id);
    assert.equal(retained.cart_barcode, original.cart_barcode);
    assert.equal(retained.status, 'verified');
    assert.equal(retained.loaded_at, 'loaded');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM scan_events WHERE line_id=?").bind(original.id).first()).n, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM load_confirmations WHERE header_id=?").bind(original.header_id).first()).n, 1);
    const snapshots = (await db.prepare("SELECT row_json FROM demand_import_rows WHERE batch_id=?").bind(batch).all()).results;
    assert.equal(snapshots.length, 1);
    assert.equal(JSON.parse(snapshots[0].row_json).sourceLineId, row().sourceLineId);
  }
  await assert.rejects(activate("changed-test", [row(), { ...testRow, quantity: 15 }]), DemandReconciliationError);
});

test("untouched updates/additions/removals archive omitted siblings and audit source changes", async (t) => {
  const { db, activate, active } = await fixture(t);
  await activate("first", [row(), row({ sourceLineId: "remove-me", sequence: "020" })]);
  const original = await active();
  const result = await activate("second", [row({ quantity: 10.5, unitOfMeasure: "KG" }), row({ sourceLineId: "new", sequence: "030" })]);
  assert.deepEqual(result.reconciliation, { preserved: 0, updated: 1, added: 1, removed: 1 });
  const current = await active();
  assert.equal(current.length, 2); assert.equal(current[0].id, original[0].id);
  assert.equal(current[0].header_id, original[0].header_id); assert.equal(current[0].quantity, 10.5);
  const removed = await db.prepare("SELECT d.id,h.batch_id,d.header_id FROM demand_details d JOIN demand_headers h ON h.id=d.header_id WHERE d.id=?").bind(original[1].id).first();
  assert.equal(removed.batch_id, "first"); assert.notEqual(removed.header_id, current[0].header_id);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_import_rows WHERE batch_id='first'").first()).n, 2);
  const audits = (await db.prepare("SELECT action FROM demand_audit_events ORDER BY created_at,id").all()).results.map((item) => item.action);
  assert.ok(audits.includes("reconcile_remove")); assert.ok(audits.includes("reconcile_update"));
  assert.equal((await db.prepare("SELECT status FROM integration_imports WHERE batch_id='second'").first()).status, "complete");
});

test("worked source changes fail without new batches, evidence loss or stuck claims", async (t) => {
  const { db, activate, active } = await fixture(t);
  await activate("first", [row()]);
  const original = (await active())[0];
  await db.prepare("INSERT INTO scan_events VALUES ('scan',?,0,'invalidated')").bind(original.id).run();
  await assert.rejects(activate("rejected", [row({ quantity: 15 })]), DemandReconciliationError);
  assert.equal((await active())[0].id, original.id);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM import_batches").first()).n, 1);
  assert.equal(await db.prepare("SELECT id FROM integration_imports WHERE batch_id='rejected'").first(), null);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM scan_events").first()).n, 1);
});

test("a scan arriving after planning rolls back activation even without a revision change", async (t) => {
  const { db, activate, active } = await fixture(t);
  await activate("first", [row()]);
  const original = (await active())[0];
  const originalGuardedBatch = db.guardedBatch.bind(db);
  let injected = false;
  db.guardedBatch = async (statements, condition) => {
    if (!injected) {
      injected = true;
      await db.prepare("INSERT INTO scan_events VALUES ('late-scan',?,1,NULL)").bind(original.id).run();
    }
    return originalGuardedBatch(statements, condition);
  };
  await assert.rejects(activate("raced", [row({ quantity: 15 })]), DatabaseConflictError);
  assert.equal((await active())[0].quantity, 12);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM import_batches").first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cartflow_write_guards").first()).n, 0);
});

test("audit failure rolls back moved headers, detail changes, snapshots and batch activation", async (t) => {
  const { db, activate, active } = await fixture(t);
  await activate("first", [row()]);
  const before = await active();
  await db.prepare("CREATE TRIGGER reject_reconcile BEFORE INSERT ON demand_audit_events WHEN NEW.action='reconcile_update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END").run();
  await assert.rejects(activate("failed", [row({ quantity: 15 })]), /audit unavailable/);
  assert.deepEqual(await active(), before);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM import_batches").first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_import_rows").first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cartflow_write_guards").first()).n, 0);
});

test("snapshot guard chunks remain atomic across larger imports", async (t) => {
  const { db, activate, active } = await fixture(t);
  const rows = Array.from({ length: 110 }, (_, index) => row({ sourceLineId: `line-${index}`, sequence: String(index).padStart(3, "0") }));
  await activate("first", rows);
  const originals = await active();
  const result = await activate("second", [...rows].reverse());
  assert.equal(result.reconciliation.preserved, rows.length);
  assert.deepEqual((await active()).map((line) => line.id), originals.map((line) => line.id));
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cartflow_write_guards").first()).n, 0);
});

test("restoring omitted untouched demand retains IDs, the active card and membership audits", async (t) => {
  for (const legacy of [false, true]) await t.test(legacy ? "legacy sequence identity" : "scoped source identity", async (t) => {
    const { db, activate, active } = await fixture(t);
    const rows = ["010", "020", "030"].map((sequence) => row({ sourceLineId: legacy ? "" : `line-${sequence}`, sequence }));
    await activate("first", rows);
    const originals = await active();
    await activate("omitted", [rows[0]]);
    const archived = await db.prepare("SELECT header_id FROM demand_details WHERE id=?").bind(originals[1].id).first();
    await activate("restored", [rows[1], rows[0]], { actorId: "erp", actorName: "ERP" });
    const restored = await active();
    assert.deepEqual(restored.map((line) => line.id), originals.slice(0, 2).map((line) => line.id));
    assert.ok(restored.every((line) => line.header_id === originals[0].header_id && line.cart_barcode === originals[0].cart_barcode));
    assert.ok(restored.every((line) => line.source_scope === "erp"));
    const omitted = await db.prepare("SELECT h.batch_id,d.header_id FROM demand_details d JOIN demand_headers h ON h.id=d.header_id WHERE d.id=?")
      .bind(originals[2].id).first();
    assert.equal(omitted.batch_id, "first");
    assert.equal(omitted.header_id, archived.header_id);
    const audit = await db.prepare("SELECT * FROM demand_audit_events WHERE action='reconcile_restore'").first();
    assert.equal(audit.line_id, originals[1].id);
    assert.equal(audit.actor_id, "erp");
    assert.deepEqual(JSON.parse(audit.before_json), { batchId: "first", headerId: archived.header_id, active: false });
    assert.deepEqual(JSON.parse(audit.after_json), { batchId: "restored", headerId: originals[0].header_id, active: true });
    const auditCount = (await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events").first()).n;
    await activate("repeated", [rows[0], rows[1]]);
    assert.deepEqual((await active()).map((line) => line.id), restored.map((line) => line.id));
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events").first()).n, auditCount);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_details").first()).n, 3);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cartflow_write_guards").first()).n, 0);
  });
});

test("historical-only restoration consolidates compatible untouched cards and leaves omitted siblings historical", async (t) => {
  const { db, activate, active } = await fixture(t);
  const rows = ["010", "020", "030"].map((sequence) => row({ sourceLineId: `line-${sequence}`, sequence }));
  const other = row({ sourceLineId: "other", picklistNumber: "OTHER", cartId: "OTHER", cartNumber: "2", sequence: "040" });
  await activate("first", rows);
  const originals = await active();
  await activate("split", [rows[0]]);
  const archived = await db.prepare("SELECT header_id FROM demand_details WHERE id=?").bind(originals[1].id).first();
  await activate("unrelated", [other]);
  await activate("restored", [other, rows[0], rows[1]]);
  const restored = (await active()).filter((line) => line.picklist_number === "PICK-1");
  assert.deepEqual(restored.map((line) => line.id), originals.slice(0, 2).map((line) => line.id));
  assert.equal(new Set(restored.map((line) => line.header_id)).size, 1);
  assert.notEqual(restored[0].header_id, originals[0].header_id);
  assert.notEqual(restored[0].header_id, archived.header_id);
  const omitted = await db.prepare("SELECT h.batch_id,d.header_id FROM demand_details d JOIN demand_headers h ON h.id=d.header_id WHERE d.id=?")
    .bind(originals[2].id).first();
  assert.equal(omitted.batch_id, "first");
  assert.equal(omitted.header_id, archived.header_id);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events WHERE action='reconcile_restore'").first()).n, 2);
  await activate("repeat", [rows[1], rows[0], other]);
  assert.deepEqual((await active()).filter((line) => line.picklist_number === "PICK-1").map((line) => line.header_id), restored.map((line) => line.header_id));
});

test("restoring one historical card reuses its header and records the activation", async (t) => {
  const { db, activate, active } = await fixture(t);
  const other = row({ sourceLineId: "other", picklistNumber: "OTHER", cartId: "OTHER", cartNumber: "2", sequence: "020" });
  await activate("first", [row()]);
  const original = (await active())[0];
  await activate("omitted", [other]);
  await activate("restored", [row(), other]);
  const restored = (await active()).find((line) => line.id === original.id);
  assert.equal(restored.header_id, original.header_id);
  assert.equal(restored.cart_barcode, original.cart_barcode);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events WHERE action='reconcile_restore'").first()).n, 1);
});

test("moving active untouched demand audits old and new header membership", async (t) => {
  const { db, activate, active } = await fixture(t);
  const target = row({ sourceLineId: "target", picklistNumber: "OTHER", cartId: "OTHER", cartNumber: "2", sequence: "020" });
  await activate("first", [row(), target]);
  const originals = await active();
  await activate("moved", [{ ...row(), picklistNumber: target.picklistNumber, cartId: target.cartId, cartNumber: target.cartNumber }, target]);
  const audit = await db.prepare("SELECT * FROM demand_audit_events WHERE action='reconcile_reparent'").first();
  assert.equal(audit.line_id, originals[0].id);
  assert.deepEqual(JSON.parse(audit.before_json), { batchId: "first", headerId: originals[0].header_id, active: true });
  assert.deepEqual(JSON.parse(audit.after_json), { batchId: "moved", headerId: originals[1].header_id, active: true });
});

test("failed or invalidated evidence anywhere on source or target cards prevents restoration", async (t) => {
  for (const position of [0, 1, 2]) await t.test(`evidence on ${["active", "restored", "omitted historical"][position]} row`, async (t) => {
    const { db, activate, active } = await fixture(t);
    const rows = ["010", "020", "030"].map((sequence) => row({ sourceLineId: `line-${sequence}`, sequence }));
    await activate("first", rows);
    const originals = await active();
    await activate("omitted", [rows[0]]);
    const before = await active();
    await db.prepare("INSERT INTO scan_events VALUES ('old-scan',?,0,'invalidated')").bind(originals[position].id).run();
    await assert.rejects(activate("blocked", [rows[0], rows[1]]), DemandReconciliationError);
    assert.deepEqual(await active(), before);
    assert.equal(await db.prepare("SELECT id FROM integration_imports WHERE batch_id='blocked'").first(), null);
  });
});

test("restoration rechecks historical evidence, revisions, membership and live leases under the transaction lock", async (t) => {
  for (const race of ["source scan", "omitted sibling scan", "revision", "membership", "lease"]) await t.test(race, async (t) => {
    const { db, activate, active } = await fixture(t);
    const rows = ["010", "020", "030"].map((sequence) => row({ sourceLineId: `line-${sequence}`, sequence }));
    await activate("first", rows);
    const originals = await active();
    await activate("omitted", [rows[0]]);
    const before = await active();
    const originalGuardedBatch = db.guardedBatch.bind(db);
    let injected = false;
    db.guardedBatch = async (statements, condition) => {
      if (!injected) {
        injected = true;
        if (race.endsWith("scan")) await db.prepare("INSERT INTO scan_events VALUES ('late-scan',?,0,'invalidated')")
          .bind(originals[race === "source scan" ? 1 : 2].id).run();
        if (race === "revision") await db.prepare("UPDATE demand_details SET revision=revision+1 WHERE id=?").bind(originals[1].id).run();
        if (race === "membership") await db.prepare("INSERT INTO demand_details (id,header_id,status,sequence) SELECT 'late-sibling',header_id,'pending','040' FROM demand_details WHERE id=?")
          .bind(originals[1].id).run();
        if (race === "lease") await db.prepare("INSERT INTO cart_locks (cart_key,expires_at) VALUES (?,?)")
          .bind(reconciliationCartKey(rows[0]), new Date(Date.now() + 600_000).toISOString()).run();
      }
      return originalGuardedBatch(statements, condition);
    };
    try { await assert.rejects(activate("raced", [rows[0], rows[1]]), DatabaseConflictError); }
    finally { db.guardedBatch = originalGuardedBatch; }
    assert.deepEqual(await active(), before);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM import_batches WHERE id='raced'").first()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events WHERE action='reconcile_restore'").first()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cartflow_write_guards").first()).n, 0);
    assert.equal(await db.prepare("SELECT id FROM integration_imports WHERE batch_id='raced'").first(), null);
  });
});

test("restoration audit failure rolls back reparenting, snapshots and activation", async (t) => {
  const { db, activate, active } = await fixture(t);
  const rows = [row(), row({ sourceLineId: "second", sequence: "020" })];
  await activate("first", rows);
  await activate("omitted", [rows[0]]);
  const before = await active();
  const details = (await db.prepare("SELECT * FROM demand_details ORDER BY id").all()).results;
  await db.prepare("CREATE TRIGGER reject_restore BEFORE INSERT ON demand_audit_events WHEN NEW.action='reconcile_restore' BEGIN SELECT RAISE(ABORT,'restore audit unavailable'); END").run();
  await assert.rejects(activate("failed", rows), /restore audit unavailable/);
  assert.deepEqual(await active(), before);
  assert.deepEqual((await db.prepare("SELECT * FROM demand_details ORDER BY id").all()).results, details);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_import_rows WHERE batch_id='failed'").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM import_batches WHERE id='failed'").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cartflow_write_guards").first()).n, 0);
});

test("departed picklists leave the active snapshot with intact evidence and cannot be reopened", async (t) => {
  const { db, activate, active, adapters } = await fixture(t);
  const previous = [row(), row({ sourceLineId: "second", sequence: "020" })];
  await activate("first", previous);
  const originals = await active();
  await db.batch([
    db.prepare("UPDATE demand_headers SET loaded_at='loaded',dispatched_at='departed',revision=revision+1"),
    db.prepare("UPDATE demand_details SET status='verified',fulfilled_quantity=quantity,verified_at='packed',revision=revision+1"),
    ...originals.map((line) => db.prepare("INSERT INTO scan_events VALUES (?,?,1,NULL)").bind(`scan-${line.id}`, line.id)),
    db.prepare("INSERT INTO load_confirmations VALUES ('loaded-card',?)").bind(originals[0].header_id),
  ]);
  const before = await active();
  const next = row({ sourceLineId: "new", picklistNumber: "PICK-NEW", cartNumber: "C-NEW", cartId: "CART-NEW" });
  await activate("next", [next]);
  assert.equal((await active()).length, 1);
  for (const original of before) {
    const historical = await db.prepare(`SELECT q.* FROM (${adapters.selectSql}) q WHERE q.id=?`).bind(original.id).first();
    assert.deepEqual(historical, original);
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM scan_events").first()).n, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM load_confirmations").first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events WHERE action='reconcile_archive'").first()).n, 2);
  await assert.rejects(activate("reopen", [next, ...previous]), (error) => error.issues?.some((issue) => issue.reason === "terminal_demand_reintroduced"));
  assert.equal((await active())[0].source_line_id, "new");
});

test("unchanged reserved picklists survive unrelated source changes without losing their lease or revisions", async (t) => {
  const { db, activate, active } = await fixture(t);
  const untouched = row();
  const other = row({ sourceLineId: "other", picklistNumber: "PICK-OTHER", cartNumber: "C-OTHER", cartId: "CART-OTHER" });
  await activate("first", [untouched, other]);
  const previous = (await active()).find((line) => line.source_line_id === untouched.sourceLineId);
  const lease = { key: reconciliationCartKey(untouched), until: new Date(Date.now() + 600_000).toISOString() };
  await db.prepare("INSERT INTO cart_locks (cart_key,expires_at) VALUES (?,?)").bind(lease.key, lease.until).run();
  await activate("next", [untouched, { ...other, quantity: 99 }]);
  const current = (await active()).find((line) => line.id === previous.id);
  assert.equal(current.header_id, previous.header_id);
  assert.equal(current.header_revision, previous.header_revision);
  assert.equal(current.detail_revision, previous.detail_revision);
  assert.equal((await db.prepare("SELECT expires_at FROM cart_locks WHERE cart_key=?").bind(lease.key).first()).expires_at, lease.until);
  await assert.rejects(activate("changed", [{ ...untouched, quantity: 13 }, { ...other, quantity: 99 }]), DatabaseConflictError);
  assert.equal((await active()).find((line) => line.id === previous.id).quantity, 12);
});

test("leases acquired after planning guard changed and new picklist identities at commit", async (t) => {
  for (const newHeader of [false, true]) await t.test(newHeader ? "new target" : "changed existing", async (t) => {
    const { db, activate, active } = await fixture(t);
    await activate("first", [row()]);
    const incoming = newHeader ? row({ sourceLineId: "new", picklistNumber: "PICK-NEW", cartNumber: "C-NEW", cartId: "CART-NEW" }) : row({ quantity: 13 });
    const original = db.guardedBatch.bind(db);
    db.guardedBatch = async (statements, condition) => {
      db.guardedBatch = original;
      await db.prepare("INSERT INTO cart_locks (cart_key,picklist_key,expires_at) VALUES ('append-reservation',?,?)")
        .bind([incoming.plant, incoming.areaType, incoming.trainNumber, incoming.picklistNumber].join("::"), new Date(Date.now() + 600_000).toISOString()).run();
      return original(statements, condition);
    };
    await assert.rejects(activate("raced", newHeader ? [row(), incoming] : [incoming]), DatabaseConflictError);
    assert.equal((await active()).length, 1);
    assert.equal((await active())[0].quantity, 12);
  });
});

test("empty snapshot archival rolls back if its audit fails or departed evidence changes before commit", async (t) => {
  for (const failure of ["audit", "departure", "lease"]) await t.test(failure, async (t) => {
    const { db, activate, active } = await fixture(t);
    await activate("first", [row()]);
    await db.prepare("UPDATE demand_headers SET loaded_at='loaded',dispatched_at='departed'").run();
    await db.prepare("UPDATE demand_details SET status='verified',fulfilled_quantity=quantity").run();
    const before = await active();
    if (failure === "audit") await db.prepare("CREATE TRIGGER reject_archive BEFORE INSERT ON demand_audit_events WHEN NEW.action='reconcile_archive' BEGIN SELECT RAISE(ABORT,'archive audit failed'); END").run();
    else {
      const original = db.guardedBatch.bind(db);
      db.guardedBatch = async (statements, condition) => {
        db.guardedBatch = original;
        if (failure === "departure") await db.prepare("UPDATE demand_headers SET dispatched_at=NULL").run();
        else await db.prepare("INSERT INTO cart_locks (cart_key,expires_at) VALUES (?,?)")
          .bind(reconciliationCartKey(row()), new Date(Date.now() + 600_000).toISOString()).run();
        return original(statements, condition);
      };
    }
    await assert.rejects(activate("empty", []), failure === "audit" ? /archive audit failed/ : DatabaseConflictError);
    assert.equal((await active())[0].id, before[0].id);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM import_batches").first()).n, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events WHERE action='reconcile_archive'").first()).n, 0);
  });
});
