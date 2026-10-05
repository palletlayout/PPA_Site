import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const metadataColumns = {
  containerSequence: "container_sequence",
  fromModel: "from_model", fromType: "from_type", fromOption: "from_option",
  fromColor: "from_color", fromInteriorColor: "from_interior_color", fromUnits: "from_units",
  toModel: "to_model", toType: "to_type", toOption: "to_option",
  toColor: "to_color", toInteriorColor: "to_interior_color", toUnits: "to_units",
};
const metadata = (number) => ({
  containerSequence: `0${number}`,
  fromModel: `MDL${number}`, fromType: `TYP${number}`, fromOption: `OPT${number}`,
  fromColor: `CLR${number}`, fromInteriorColor: `ICLR${number}`, fromUnits: `00${number}`,
  toModel: `MDL${number + 1}`, toType: `TYP${number + 1}`, toOption: `OPT${number + 1}`,
  toColor: `CLR${number + 1}`, toInteriorColor: `ICLR${number + 1}`, toUnits: `000${number + 1}`,
});
const row = (changes = {}) => ({
  sourceScope: "erp", sourceLineId: "source-1", plant: "01", zone: "Z", areaType: "onsite",
  shipCategory: "SC1", loadNumber: "", trainNumber: "TP00001", picklistNumber: "Z1010000000000001",
  cartNumber: "1", cartId: "AH500A22", palletId: "", sequence: "001", partNumber: "11111AAAA000A1",
  description: "Part", color: "CL100A", quantity: 15, unitOfMeasure: "EA", aiagSerial: "",
  masterBarcode: "Z1010000000000001", movementBarcode: "AE3TP00001XSGS", ...changes,
});
const selectMetadata = (line) => Object.fromEntries(Object.keys(metadataColumns).map((key) => [key, line[key]]));

test("demand lot metadata persists per line through upgrades, maintenance and reconciliation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-demand-lot-"));
  const path = join(directory, "demand.sqlite");
  const names = ["CARTFLOW_DATABASE_PATH", "DATABASE_URL", "POSTGRES_URL", "VERCEL"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.CARTFLOW_DATABASE_PATH = path;
  for (const name of names.slice(1)) delete process.env[name];

  // Rehearse a populated v14 database in a separate process so the production
  // initializer must upgrade it on a genuine restart, not a fresh schema.
  const storeUrl = new URL("../db/cart-store.ts", import.meta.url).href;
  execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const store = await import(${JSON.stringify(storeUrl)});
    await store.replaceImport("legacy.csv", [${JSON.stringify(row())}]);
    const db = await store.ensureDatabase();
    for (const column of ${JSON.stringify(Object.values(metadataColumns))}) {
      await db.prepare("ALTER TABLE demand_details DROP COLUMN " + column).run();
    }
    await db.prepare("UPDATE cartflow_schema SET version=14 WHERE name='primary'").run();
    db.close();
  `], { env: process.env, stdio: "pipe" });

  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => {
    db.close();
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  });
  const sourceRows = () => [
    row(metadata(1)),
    row({ sourceLineId: "source-2", sequence: "002", ...metadata(2) }),
  ];
  const active = async () => (await store.getAppState()).lines.sort((a, b) => a.sequence.localeCompare(b.sequence));
  const setup = async () => {
    await store.clearAllData();
    await store.replaceImport("metadata.csv", sourceRows());
    return active();
  };

  await t.test("v14 upgrade retains demand and initializes every metadata column to blank text", async () => {
    assert.equal((await db.prepare("SELECT version FROM cartflow_schema WHERE name='primary'").first()).version, 17);
    const columns = (await db.prepare("PRAGMA table_info(demand_details)").all()).results;
    for (const name of Object.values(metadataColumns)) {
      assert.equal(columns.find((column) => column.name === name)?.type, "TEXT");
    }
    const lines = await active();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].quantity, 15);
    assert.equal(lines[0].sourceLineId, "source-1");
    assert.deepEqual(selectMetadata(lines[0]), Object.fromEntries(Object.keys(metadataColumns).map((key) => [key, ""])));
  });

  await t.test("sibling rows retain distinct metadata and leading zeros in state, snapshots and export", async () => {
    const lines = await setup();
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_headers").first()).n, 1);
    for (let index = 0; index < lines.length; index += 1) {
      assert.deepEqual(selectMetadata(lines[index]), metadata(index + 1));
      assert.equal(lines[index].quantity, 15);
      assert.equal(lines[index].fulfilledQuantity, 0);
    }
    const snapshots = (await db.prepare("SELECT row_json FROM demand_import_rows ORDER BY row_json").all()).results;
    assert.deepEqual(snapshots.map((entry) => selectMetadata(JSON.parse(entry.row_json))), [metadata(1), metadata(2)]);
    await db.prepare("UPDATE demand_details SET status='active'").run();
    const exported = await store.getScannedDemandExport();
    assert.equal(exported.length, 2);
    exported.forEach((entry, index) => {
      assert.deepEqual(Object.fromEntries(Object.entries(metadataColumns).map(([field, column]) => [field, entry[column]])), metadata(index + 1));
    });
  });

  await t.test("maintenance updates only the selected detail and audits original text", async () => {
    const lines = await setup();
    const beforeHeader = await db.prepare("SELECT * FROM demand_headers").first();
    const changed = { fromModel: "MDL-UPDATED", fromUnits: "00045", toInteriorColor: "BEIGE" };
    const result = await store.updateDemandLine(lines[0].id, changed, { id: "supervisor", name: "Supervisor" });
    assert.equal(result.headerFieldsUpdated, false);
    assert.equal(result.scanEventsCleared, false);
    assert.deepEqual(selectMetadata(result.line), { ...metadata(1), ...changed });
    assert.deepEqual(await db.prepare("SELECT * FROM demand_headers").first(), beforeHeader);
    assert.deepEqual(selectMetadata((await active())[1]), metadata(2));
    const audit = await db.prepare("SELECT before_json,after_json FROM demand_audit_events WHERE action='update'").first();
    assert.equal(JSON.parse(audit.before_json).fromUnits, "001");
    assert.equal(JSON.parse(audit.after_json).fromUnits, "00045");
  });

  await t.test("identical reimport preserves IDs while changed metadata updates only its source line", async () => {
    const original = await setup();
    const unchanged = await store.replaceImport("same.csv", sourceRows());
    assert.deepEqual(unchanged.reconciliation, { preserved: 2, updated: 0, added: 0, removed: 0 });
    const nextRows = sourceRows();
    nextRows[0].toUnits = "00099";
    const updated = await store.replaceImport("updated.csv", nextRows);
    assert.deepEqual(updated.reconciliation, { preserved: 1, updated: 1, added: 0, removed: 0 });
    const lines = await active();
    assert.deepEqual(lines.map((line) => line.id), original.map((line) => line.id));
    assert.deepEqual(selectMetadata(lines[0]), { ...metadata(1), toUnits: "00099" });
    assert.deepEqual(selectMetadata(lines[1]), metadata(2));
    const audit = await db.prepare("SELECT before_json,after_json FROM demand_audit_events WHERE action='reconcile_update'").first();
    assert.equal(JSON.parse(audit.before_json).toUnits, "0002");
    assert.equal(JSON.parse(audit.after_json).toUnits, "00099");
  });

  await t.test("worked demand rejects changed metadata without replacing the active snapshot", async () => {
    const lines = await setup();
    await db.prepare("UPDATE demand_details SET status='active',revision=revision+1 WHERE id=?").bind(lines[0].id).run();
    const beforeBatch = await db.prepare("SELECT id FROM import_batches WHERE is_active=1").first();
    const nextRows = sourceRows();
    nextRows[0].fromType = "CHANGED";
    await assert.rejects(store.replaceImport("worked.csv", nextRows), (error) => error.code === "reconciliation_required");
    assert.deepEqual(await db.prepare("SELECT id FROM import_batches WHERE is_active=1").first(), beforeBatch);
    assert.deepEqual(selectMetadata((await active())[0]), metadata(1));
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM integration_imports WHERE status='processing'").first()).n, 0);
    const repeated = await store.replaceImport("worked-same.csv", sourceRows());
    assert.equal(repeated.reconciliation.preserved, 2);
    assert.equal((await active())[0].status, "active");
  });

  await t.test("a concurrent metadata revision aborts activation and rolls back its batch and audit", async () => {
    const lines = await setup();
    const beforeCounts = await db.prepare("SELECT (SELECT COUNT(*) FROM import_batches) AS batches,(SELECT COUNT(*) FROM demand_audit_events) AS audits").first();
    const originalGuardedBatch = db.guardedBatch.bind(db);
    let injected = false;
    db.guardedBatch = async (statements, condition) => {
      if (!injected && statements.some((statement) => statement.query.startsWith("INSERT INTO import_batches"))) {
        injected = true;
        await db.prepare("UPDATE demand_details SET from_model='CONCURRENT',revision=revision+1 WHERE id=?").bind(lines[0].id).run();
      }
      return originalGuardedBatch(statements, condition);
    };
    try {
      const nextRows = sourceRows();
      nextRows[0].fromModel = "IMPORTED";
      await assert.rejects(store.replaceImport("raced.csv", nextRows), (error) => error.status === 409);
      assert.equal(injected, true);
      assert.equal((await active())[0].fromModel, "CONCURRENT");
      assert.deepEqual(await db.prepare("SELECT (SELECT COUNT(*) FROM import_batches) AS batches,(SELECT COUNT(*) FROM demand_audit_events) AS audits").first(), beforeCounts);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cartflow_write_guards").first()).n, 0);
    } finally {
      db.guardedBatch = originalGuardedBatch;
    }
  });
});
