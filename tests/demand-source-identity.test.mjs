import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "../db/index.ts";

const row = (changes = {}) => ({ sourceScope: "erp", sourceLineId: "source-one", plant: "PLT-01", zone: "A-12",
  areaType: "onsite", shipCategory: "Production", loadNumber: "", trainNumber: "TR-204", picklistNumber: "PL-1001",
  cartNumber: "CT-001", cartId: "CART-001", palletId: "PAL-001", sequence: "010", partNumber: "PART-001",
  description: "Part", color: "BLUE", quantity: 12, aiagSerial: "", masterBarcode: "MASTER-001", movementBarcode: "MOVEMENT-001", ...changes });
const conflict = (error) => error.status === 409;

test("durable demand source identities are unique across imports, append and maintenance", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-source-identity-"));
  const path = join(directory, "legacy.sqlite");
  const names = ["CARTFLOW_DATABASE_PATH", "DATABASE_URL", "POSTGRES_URL", "VERCEL"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.CARTFLOW_DATABASE_PATH = path;
  for (const name of names.slice(1)) delete process.env[name];
  // Rehearse an existing v9 inventory schema, not just fresh table creation.
  const legacy = new Database({ sqlitePath: path });
  await legacy.batch([
    legacy.prepare("CREATE TABLE cartflow_schema (name TEXT PRIMARY KEY, version INTEGER NOT NULL)"),
    legacy.prepare("INSERT INTO cartflow_schema VALUES ('primary',9)"),
    legacy.prepare(`CREATE TABLE inventory_items (id TEXT PRIMARY KEY, capture_session_id TEXT NOT NULL,
      source TEXT DEFAULT 'physical_label', aiag_serial TEXT NOT NULL, normalized_serial TEXT NOT NULL,
      part_number TEXT NOT NULL, part_level TEXT NOT NULL, quantity INTEGER NOT NULL,
      raw_aiag_serial TEXT DEFAULT '', raw_part_number TEXT DEFAULT '', raw_part_level TEXT DEFAULT '', raw_quantity TEXT DEFAULT '',
      status TEXT DEFAULT 'available', is_test INTEGER DEFAULT 0, operator_name TEXT NOT NULL, captured_at TEXT NOT NULL)`),
    legacy.prepare("CREATE UNIQUE INDEX inventory_items_scope_serial_idx ON inventory_items(is_test,normalized_serial)"),
    legacy.prepare("INSERT INTO inventory_items (id,capture_session_id,aiag_serial,normalized_serial,part_number,part_level,quantity,operator_name,captured_at) VALUES ('legacy','session','OLD','OLD','PART-001','BLUE',12,'Receiver','2026-09-15T00:00:00Z')"),
  ]);
  legacy.close();
  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => {
    db.close();
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  });
  const setup = async (rows = [row()]) => {
    await store.clearAllData();
    await store.replaceImport("source.csv", rows);
    return (await store.getAppState()).lines;
  };

  await t.test("v9 upgrade preserves stock and replaces supplier-scoped and source identity indexes", async () => {
    const old = await db.prepare("SELECT quantity,supplier_id,unit_of_measure FROM inventory_items WHERE id='legacy'").first();
    assert.deepEqual({ ...old }, { quantity: 12, supplier_id: "", unit_of_measure: "EA" });
    const columns = (await db.prepare("PRAGMA index_info('inventory_items_scope_serial_idx')").all()).results;
    assert.deepEqual(columns.map((column) => column.name), ["is_test", "supplier_id", "normalized_serial"]);
    const index = await db.prepare("SELECT sql FROM sqlite_master WHERE name='demand_details_source_identity_idx'").first();
    assert.match(index.sql, /WHERE source_line_id <> ''/);
  });

  await t.test("append rejects an existing source identity while allowing another source scope", async () => {
    await setup();
    await assert.rejects(store.appendImportRow("append", row({ sequence: "020" })), (error) => conflict(error) && /Source Line ID/.test(error.message));
    await store.appendImportRow("append", row({ sourceScope: "other", sequence: "020" }));
    assert.equal((await store.getAppState()).lines.length, 2);
  });

  await t.test("historical IDs remain reserved after omission from an unworked snapshot", async () => {
    await setup();
    await store.replaceImport("next.csv", [row({ sourceLineId: "new-source", cartNumber: "CT-002", cartId: "CART-002" })]);
    await assert.rejects(store.appendImportRow("append", row({ sequence: "030" })), (error) => conflict(error) && /historical demand/.test(error.message));
    assert.equal((await store.getAppState()).lines.length, 1);
  });

  await t.test("maintenance rejects a duplicate source ID and keeps the original value", async () => {
    const lines = await setup([row(), row({ sourceLineId: "source-two", sequence: "020" })]);
    await assert.rejects(store.updateDemandLine(lines[1].id, { sourceLineId: "source-one" }), (error) => conflict(error) && /Source Line ID/.test(error.message));
    assert.equal((await db.prepare("SELECT source_line_id FROM demand_details WHERE id=?").bind(lines[1].id).first()).source_line_id, "source-two");
  });

  await t.test("database uniqueness protects direct writes and blank legacy IDs remain usable", async () => {
    const lines = await setup([row(), row({ sourceLineId: "source-two", sequence: "020" })]);
    await assert.rejects(db.prepare("UPDATE demand_details SET source_line_id='source-one' WHERE id=?").bind(lines[1].id).run(), /UNIQUE constraint failed/);
    await store.appendImportRow("legacy", row({ sourceLineId: "", sequence: "030" }));
    await store.appendImportRow("legacy", row({ sourceLineId: "", sequence: "040" }));
    assert.equal((await store.getAppState()).lines.length, 4);
  });

  await t.test("append race fails atomically with 409 when another cart claims the source ID", async () => {
    const lines = await setup([row(), row({ sourceLineId: "competitor", cartId: "CART-002", cartNumber: "CT-002", picklistNumber: "PL-2002" })]);
    const competitor = lines.find((line) => line.sourceLineId === "competitor");
    const original = db.guardedBatch.bind(db);
    let injected = false;
    db.guardedBatch = async (statements, guard) => {
      if (!injected && statements.some((statement) => /INSERT INTO demand_details/.test(statement.query))) {
        injected = true;
        await db.prepare("UPDATE demand_details SET source_line_id='raced',revision=revision+1 WHERE id=?").bind(competitor.id).run();
      }
      return original(statements, guard);
    };
    try {
      await assert.rejects(store.appendImportRow("append", row({ sourceLineId: "raced", sequence: "020" })), conflict);
      assert.equal((await store.getAppState()).lines.length, 2);
      assert.equal((await db.prepare("SELECT row_count FROM import_batches WHERE is_active=1").first()).row_count, 2);
    } finally { db.guardedBatch = original; }
  });

  await t.test("maintenance race rolls back its audit and source change with 409", async () => {
    const lines = await setup([row(), row({ sourceLineId: "competitor", cartId: "CART-002", cartNumber: "CT-002", picklistNumber: "PL-2002" })]);
    const target = lines.find((line) => line.sourceLineId === "source-one");
    const competitor = lines.find((line) => line.sourceLineId === "competitor");
    const count = (await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events").first()).n;
    const original = db.guardedBatch.bind(db);
    let injected = false;
    db.guardedBatch = async (statements, guard) => {
      if (!injected && statements.some((statement) => statement.query.includes("'update'"))) {
        injected = true;
        await db.prepare("UPDATE demand_details SET source_line_id='raced',revision=revision+1 WHERE id=?").bind(competitor.id).run();
      }
      return original(statements, guard);
    };
    try {
      await assert.rejects(store.updateDemandLine(target.id, { sourceLineId: "raced" }), conflict);
      assert.equal((await db.prepare("SELECT source_line_id FROM demand_details WHERE id=?").bind(target.id).first()).source_line_id, "source-one");
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events").first()).n, count);
    } finally { db.guardedBatch = original; }
  });
});
