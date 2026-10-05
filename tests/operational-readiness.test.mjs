import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

test("readiness detects ledger failures and a complete local backup restores operational evidence", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-readiness-"));
  const databasePath = join(directory, "working.sqlite");
  process.env.CARTFLOW_DATABASE_PATH = databasePath;
  for (const key of ["DATABASE_URL", "POSTGRES_URL", "VERCEL"]) delete process.env[key];
  const store = await import("../db/cart-store.ts");
  const { operationalHealth } = await import("../db/health.ts");
  const { registerSession } = await import("../lib/session-store.ts");
  const { saveRawScan } = await import("../db/raw-capture.ts");
  const db = await store.ensureDatabase();
  assert.deepEqual((await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'warehouse_*'").all()).results, [], "a fresh installation must not create the removed storage schema");
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const actor = { id: "readiness-operator", name: "Readiness Operator" };
  const fixture = { plant: "QA", zone: "A", areaType: "onsite", shipCategory: "Production", loadNumber: "", trainNumber: "HEALTH-TRAIN", picklistNumber: "HEALTH-PICK", cartNumber: "HEALTH-CART", cartId: "HEALTH-CART", palletId: "HEALTH-PALLET", sequence: "001", partNumber: "HEALTH-PART", description: "Disposable recovery fixture", color: "BLUE", quantity: 5, aiagSerial: "", masterBarcode: "HEALTH-MASTER", movementBarcode: "HEALTH-MOVEMENT" };
  await store.replaceImport("health.csv", [fixture], undefined, actor);
  const receipt = await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ["1SHEALTH-STOCK", "PHEALTH-PART", "CBLUE", "Q5"], operatorName: actor.name, operatorId: actor.id });
  const reserve = await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ["1SHEALTH-RESERVE", "PHEALTH-PART", "CBLUE", "Q6"], operatorName: actor.name, operatorId: actor.id });
  const expected = await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ["1SEXPECTED-STOCK", "PHEALTH-PART", "CBLUE", "Q3"], operatorName: actor.name, operatorId: actor.id, receiptKind: "expected", provenance: { method: "spreadsheet_import", sourceFile: "recovery-supplier.csv", importId: randomUUID(), rowNumber: 2 } });
  const line = (await store.getAppState()).lines[0];
  const context = { lineId: line.id, cartKey: [line.plant, line.areaType, line.trainNumber, line.picklistNumber, line.cartNumber, line.cartId].join("::"), sessionId: "health-scanner", operatorName: actor.name, operatorId: actor.id };
  await store.manageLock({ ...context, action: "acquire" });
  await store.recordScan({ ...context, field: "cartBarcode", value: line.cartBarcode });
  const packed = await store.fulfillDemand({ ...context, serial: "1SHEALTH-STOCK", serialFormat: "barcode" });
  assert.equal(packed.verified, true, JSON.stringify(packed));
  await store.manageLock({ ...context, action: "release" });
  assert.equal((await store.confirmCartLoading({ cartBarcode: line.cartBarcode, movementValue: fixture.movementBarcode, operatorName: actor.name, operatorId: actor.id })).ok, true);
  assert.equal((await store.confirmPicklistDispatch({ cartBarcode: line.cartBarcode, movementValue: fixture.movementBarcode, operatorName: actor.name, operatorId: actor.id })).ok, true);
  await registerSession({ ...actor, role: "operator", sessionId: randomUUID() });
  await saveRawScan({ id: randomUUID(), sessionId: randomUUID(), position: 1, rawValue: "1SRECOVERY-RAW", scannedAt: new Date().toISOString() }, actor);

  const tableSnapshot = async database => {
    const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return Object.fromEntries(await Promise.all(tables.results.map(async ({ name }) => [name, (await database.prepare(`SELECT * FROM "${name}"`).all()).results.map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])));
  };

  await t.test("healthy loaded and dispatched work is ready without durable probe mutations", async () => {
    const before = await tableSnapshot(db);
    const health = await operationalHealth();
    assert.equal(health.status, "ready");
    assert.equal(health.schemaReady, true);
    assert.equal(health.database, "read_write");
    assert.ok(Object.values(health.inconsistencies).every(value => value === 0));
    assert.deepEqual(await tableSnapshot(db), before);
  });

  await t.test("inventory and demand ledger mismatches report degraded", async () => {
    await db.prepare("UPDATE inventory_items SET consumed_quantity=4 WHERE id=?").bind(receipt.inventory.id).run();
    assert.equal((await operationalHealth()).inconsistencies.inventory, 1);
    await db.prepare("UPDATE inventory_items SET consumed_quantity=5 WHERE id=?").bind(receipt.inventory.id).run();
    await db.prepare("UPDATE demand_details SET fulfilled_quantity=4 WHERE id=?").bind(line.id).run();
    const demand = await operationalHealth();
    assert.equal(demand.status, "degraded");
    assert.equal(demand.inconsistencies.demand, 1);
    await db.prepare("UPDATE demand_details SET fulfilled_quantity=5 WHERE id=?").bind(line.id).run();
    assert.equal((await operationalHealth()).status, "ready");
  });

  await t.test("missing loading evidence and stale schema are not ready", async () => {
    const confirmation = await db.prepare("SELECT * FROM load_confirmations LIMIT 1").first();
    await db.prepare("DELETE FROM load_confirmations WHERE id=?").bind(confirmation.id).run();
    const health = await operationalHealth();
    assert.equal(health.status, "degraded");
    assert.equal(health.inconsistencies.loading, 1);
    const columns = Object.keys(confirmation);
    await db.prepare(`INSERT INTO load_confirmations (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).bind(...Object.values(confirmation)).run();
    await db.prepare("UPDATE cartflow_schema SET version=0 WHERE name='primary'").run();
    const stale = await operationalHealth();
    assert.equal(stale.status, "degraded");
    assert.equal(stale.schemaReady, false);
    await db.prepare("UPDATE cartflow_schema SET version=? WHERE name='primary'").bind(store.DATABASE_SCHEMA_VERSION).run();
    assert.equal((await operationalHealth()).status, "ready");
  });

  await t.test("normal inventory deletion and restoration retain ready health", async () => {
    await store.setInventoryDeleted({ id: reserve.inventory.id, deleted: true, operatorName: actor.name, operatorId: actor.id });
    assert.equal((await operationalHealth()).status, "ready");
    await store.setInventoryDeleted({ id: reserve.inventory.id, deleted: false, operatorName: actor.name, operatorId: actor.id });
    assert.equal((await operationalHealth()).status, "ready");
  });

  await t.test("readable but unwritable storage and missing operational tables fail closed", async () => {
    const original = console.error;
    const logs = [];
    console.error = message => logs.push(message);
    try {
      await db.prepare("CREATE TRIGGER reject_health_write BEFORE INSERT ON cartflow_write_guards BEGIN SELECT RAISE(ABORT,'private-backend-diagnostic'); END").run();
      assert.ok(await db.prepare("SELECT 1 AS ready").first());
      const unavailable = await operationalHealth();
      assert.equal(unavailable.status, "unavailable");
      assert.match(unavailable.requestId, /^[a-f0-9-]{36}$/);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cartflow_write_guards").first()).n, 0);
      await db.prepare("DROP TRIGGER reject_health_write").run();
      await db.prepare("ALTER TABLE demand_details RENAME TO temporarily_unavailable_details").run();
      assert.equal((await operationalHealth()).status, "unavailable");
      await db.prepare("ALTER TABLE temporarily_unavailable_details RENAME TO demand_details").run();
      assert.doesNotMatch(JSON.stringify(unavailable) + logs.join("\n"), /private-backend-diagnostic/);
      assert.equal((await operationalHealth()).status, "ready");
    } finally { console.error = original; }
  });

  await t.test("full application backup restores matching tables, usable state and ready health", async () => {
    const before = await tableSnapshot(db);
    const appState = await store.getAppState();
    const inventory = await store.getInventoryExport();
    assert.equal(inventory.find(item => item.id === expected.inventory.id).sourceFile, "recovery-supplier.csv");
    for (const table of ["scan_events", "fulfillment_allocations", "demand_audit_events", "load_confirmations", "auth_sessions", "raw_capture_scans"]) assert.ok(before[table].length > 0, `${table} must be exercised by recovery`);
    const snapshot = join(directory, "verified-backup.sqlite");
    const restored = join(directory, "restored.sqlite");
    const environment = { ...process.env, DATABASE_URL: "", POSTGRES_URL: "", VERCEL: "", CARTFLOW_TELEMETRY: "false" };
    const backup = await exec(process.execPath, ["scripts/backup-sqlite.mjs", databasePath, snapshot], { cwd: new URL("..", import.meta.url), env: environment });
    assert.match(backup.stdout, /Verified SQLite snapshot/);
    await copyFile(snapshot, restored);
    const code = `
      const store=await import(${JSON.stringify(new URL("../db/cart-store.ts", import.meta.url).href)});
      const {operationalHealth}=await import(${JSON.stringify(new URL("../db/health.ts", import.meta.url).href)});
      const db=await store.ensureDatabase();
      const health=await operationalHealth();
      const state=await store.getAppState();
      const inventory=await store.getInventoryExport();
      const snapshot=${tableSnapshot.toString()};
      const tables=await snapshot(db);
      console.log(JSON.stringify({health,state,inventory,tables})); db.close();
    `;
    const replay = await exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { env: { ...environment, CARTFLOW_DATABASE_PATH: restored }, maxBuffer: 8 * 1024 * 1024 });
    const recovered = JSON.parse(replay.stdout);
    assert.equal(recovered.health.status, "ready");
    assert.deepEqual(recovered.state, JSON.parse(JSON.stringify(appState)));
    assert.deepEqual(recovered.inventory, JSON.parse(JSON.stringify(inventory)));
    assert.deepEqual(recovered.tables, before);
    assert.deepEqual(await tableSnapshot(db), before, "backup and rehearsal never modify the source database");
  });

  await t.test("version 16 upgrade preserves existing business rows and leaves old provenance unknown", async () => {
    const legacyPath = join(directory, "version-16.sqlite");
    await copyFile(join(directory, "verified-backup.sqlite"), legacyPath);
    const provenanceColumns = ["acquisition_method", "source_file", "source_import_id", "source_row", "scanned_values_json", "recorded_at"];
    const environment = { ...process.env, DATABASE_URL: "", POSTGRES_URL: "", VERCEL: "", CARTFLOW_TELEMETRY: "false", CARTFLOW_DATABASE_PATH: legacyPath };
    const prepareLegacy = `
      const {DatabaseSync}=await import('node:sqlite');
      const db=new DatabaseSync(process.env.CARTFLOW_DATABASE_PATH);
      for(const name of ${JSON.stringify(provenanceColumns)}) db.exec('ALTER TABLE inventory_items DROP COLUMN '+name);
      db.exec('ALTER TABLE cart_locks DROP COLUMN operator_id');
      for(const name of ['maintenance_audit_events','auth_rate_limits']) db.exec('DROP TABLE '+name);
      db.exec("UPDATE cartflow_schema SET version=16 WHERE name='primary'");
      const tables=Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'"').all().map(row=>({...row})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
      console.log(JSON.stringify(tables)); db.close();
    `;
    const legacy = JSON.parse((await exec(process.execPath, ["--input-type=module", "-e", prepareLegacy], { env: environment })).stdout);
    const restart = `
      const store=await import(${JSON.stringify(new URL("../db/cart-store.ts", import.meta.url).href)});
      const db=await store.ensureDatabase();
      const snapshot=${tableSnapshot.toString()};
      console.log(JSON.stringify(await snapshot(db))); db.close();
    `;
    const upgraded = JSON.parse((await exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", restart], { env: environment, maxBuffer: 8 * 1024 * 1024 })).stdout);
    assert.equal(upgraded.cartflow_schema[0].version, store.DATABASE_SCHEMA_VERSION);
    assert.ok(upgraded.inventory_items.every(item => item.acquisition_method === "legacy_unknown" && item.scanned_values_json === "{}" && item.recorded_at === ""));
    const repeated = JSON.parse((await exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", restart], { env: environment, maxBuffer: 8 * 1024 * 1024 })).stdout);
    assert.deepEqual(repeated, upgraded, "migration is idempotent across a second application startup");
    for (const name of ["maintenance_audit_events", "auth_rate_limits"]) {
      assert.deepEqual(upgraded[name], []);
      delete upgraded[name];
    }
    for (const item of upgraded.inventory_items) for (const column of provenanceColumns) delete item[column];
    for (const lock of upgraded.cart_locks) delete lock.operator_id;
    upgraded.cartflow_schema[0].version = 16;
    assert.deepEqual(upgraded, legacy, "all preexisting business data survives the additive migration exactly");
  });
});

test("structured diagnostics reject forged stack lines containing credentials", async () => {
  const { reportFailure } = await import("../lib/observability.ts");
  const original = console.error;
  const logs = [];
  console.error = message => logs.push(message);
  try {
    const requestId = reportFailure("health_regression", new Error("hidden SQL SELECT *\n    at postgres://test-user:private-test-password@private-db/database\n    at SQL SELECT * FROM private_table"));
    assert.equal(JSON.parse(logs[0]).requestId, requestId);
    assert.doesNotMatch(logs.join("\n"), /private-test-password|private-db|private_table|SELECT \*/);
  } finally { console.error = original; }
});
