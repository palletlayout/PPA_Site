import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "../db/index.ts";

test("schema upgrades backfill capture receipts before accepting legacy inventory retries", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ppa-inventory-upgrade-"));
  const databasePath = join(temporaryRoot, "cartflow.sqlite");
  const testSessionId = "623e4567-e89b-42d3-a456-426614174000";
  const legacyCaptureId = "723e4567-e89b-42d3-a456-426614174000";
  const legacyLabel = ["1SLEGACY-SERIAL", "PLEGACY-PART", "2PLEGACY-LEVEL", "Q6"];

  const seed = new Database({ sqlitePath: databasePath });
  await seed.batch([
    seed.prepare(`CREATE TABLE cartflow_schema (
      name TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    )`),
    seed.prepare(`CREATE TABLE inventory_items (
      id TEXT PRIMARY KEY,
      capture_session_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'physical_label',
      aiag_serial TEXT NOT NULL,
      normalized_serial TEXT NOT NULL,
      part_number TEXT NOT NULL,
      part_level TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      raw_aiag_serial TEXT NOT NULL DEFAULT '',
      raw_part_number TEXT NOT NULL DEFAULT '',
      raw_part_level TEXT NOT NULL DEFAULT '',
      raw_quantity TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'available',
      is_test INTEGER NOT NULL DEFAULT 0,
      operator_name TEXT NOT NULL,
      captured_at TEXT NOT NULL
    )`),
    seed.prepare("INSERT INTO cartflow_schema (name, version) VALUES ('primary', 3)"),
    seed.prepare(`INSERT INTO inventory_items (
      id, capture_session_id, source, aiag_serial, normalized_serial,
      part_number, part_level, quantity,
      raw_aiag_serial, raw_part_number, raw_part_level, raw_quantity,
      status, is_test, operator_name, captured_at
    ) VALUES (?, ?, 'physical_label', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 1, ?, ?)`)
      .bind(
        legacyCaptureId,
        testSessionId,
        "LEGACY-SERIAL",
        "LEGACY-SERIAL",
        "LEGACY-PART",
        "LEGACY-LEVEL",
        6,
        "1SLEGACY-SERIAL",
        "PLEGACY-PART",
        "2PLEGACY-LEVEL",
        "Q6",
        "Legacy operator",
        "2026-09-01T12:00:00.000Z",
      ),
  ]);
  seed.close();

  const previousDatabasePath = process.env.CARTFLOW_DATABASE_PATH;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousPostgresUrl = process.env.POSTGRES_URL;
  const previousVercel = process.env.VERCEL;
  process.env.CARTFLOW_DATABASE_PATH = databasePath;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.VERCEL;

  const [{ appendTestDemandFromPhysicalLabel, DemandAppendError }, { getDatabase }] = await Promise.all([
    import("../db/cart-store.ts"),
    import("../db/index.ts"),
  ]);
  t.after(async () => {
    getDatabase().close();
    if (previousDatabasePath === undefined) delete process.env.CARTFLOW_DATABASE_PATH;
    else process.env.CARTFLOW_DATABASE_PATH = previousDatabasePath;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previousPostgresUrl;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    appendTestDemandFromPhysicalLabel({
      captureId: legacyCaptureId,
      testSessionId,
      rawValues: ["1SWRONG-SERIAL", "PWRONG-PART", "2PWRONG-LEVEL", "Q9"],
      operatorName: "Upgrade test",
    }),
    (error) => error instanceof DemandAppendError
      && error.code === "conflict"
      && /capture identifier was already used/.test(error.message),
  );

  const correctReplay = await appendTestDemandFromPhysicalLabel({
    captureId: legacyCaptureId,
    testSessionId,
    rawValues: legacyLabel,
    operatorName: "Upgrade test",
  });
  assert.equal(correctReplay.inventoryCreated, false);
  assert.equal(correctReplay.inventory.idempotentReplay, true);
  assert.equal(correctReplay.inventory.id, legacyCaptureId);

  const database = getDatabase();
  const schemaState = await database.prepare(
    "SELECT version FROM cartflow_schema WHERE name = 'primary'",
  ).first();
  const receipt = await database.prepare(`SELECT inventory_item_id, outcome
    FROM inventory_capture_receipts WHERE capture_id = ?`).bind(legacyCaptureId).first();
  assert.equal(schemaState?.version, 17);
  assert.equal(receipt?.inventory_item_id, legacyCaptureId);
  assert.equal(receipt?.outcome, "created");
  const inventory = await database.prepare(`SELECT aiag_serial, part_number, part_level, quantity,
    status, consumed_quantity, operator_name, captured_at, supplier_id, unit_of_measure, pallet_id
    FROM inventory_items WHERE id = ?`).bind(legacyCaptureId).first();
  assert.deepEqual({ ...inventory }, {
    aiag_serial: "LEGACY-SERIAL", part_number: "LEGACY-PART", part_level: "LEGACY-LEVEL", quantity: 6,
    status: "available", consumed_quantity: 0, operator_name: "Legacy operator", captured_at: "2026-09-01T12:00:00.000Z",
    supplier_id: "", unit_of_measure: "EA", pallet_id: "",
  });
  const serialIndex = await database.prepare("PRAGMA index_info('inventory_items_scope_serial_idx')").all();
  assert.deepEqual(serialIndex.results.map((column) => column.name), ["is_test", "supplier_id", "normalized_serial"]);
  const projection = await database.prepare(`SELECT p.inventory_item_id, p.status AS projection_status,
    d.aiag_serial, d.inventory_item_id AS fulfilled_inventory_item_id, d.fulfilled_quantity, d.status
    FROM inventory_demand_projections p JOIN demand_details d ON d.id = p.demand_detail_id
    WHERE p.inventory_item_id = ? AND p.test_session_id = ?`).bind(legacyCaptureId, testSessionId).first();
  assert.deepEqual({ ...projection }, {
    inventory_item_id: legacyCaptureId, projection_status: "completed", aiag_serial: "",
    fulfilled_inventory_item_id: null, fulfilled_quantity: 0, status: "pending",
  });
});
