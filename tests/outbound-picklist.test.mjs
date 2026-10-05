import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const row = (patch = {}) => ({ plant: "DEMO", zone: "A", areaType: "onsite", shipCategory: "Production",
  loadNumber: "", trainNumber: "TRAIN-1", picklistNumber: "PICK-1", cartNumber: "1", cartId: "OUTBOUND-1",
  palletId: "PALLET-1", orderNumber: "ORDER-1", masterBarcode: "MASTER-1", movementBarcode: "TRAIN-1",
  sequence: "010", partNumber: "DEMO-PART", color: "", quantity: 2, aiagSerial: "", ...patch });
const key = (line) => [line.plant, line.areaType, line.trainNumber, line.picklistNumber, line.cartNumber, line.cartId].join("::");

test("each picklist owns one outbound card while inbound containers stay independent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ppa-outbound-"));
  const env = ["CARTFLOW_DATABASE_PATH", "DATABASE_URL", "POSTGRES_URL", "VERCEL"];
  const previous = Object.fromEntries(env.map((name) => [name, process.env[name]]));
  process.env.CARTFLOW_DATABASE_PATH = join(dir, "check.sqlite");
  for (const name of env.slice(1)) delete process.env[name];
  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => { db.close(); for (const name of env) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } await rm(dir, { recursive: true, force: true }); });
  const setup = async (rows = [row()]) => { await store.clearAllData(); await store.replaceImport("outbound.json", rows); return (await store.getAppState()).lines; };
  const alternate = () => row({ picklistNumber: "PICK-2", cartNumber: "2", cartId: "OUTBOUND-2", palletId: "PALLET-2", orderNumber: "ORDER-2", masterBarcode: "MASTER-2" });

  await t.test("one outbound header accepts many demand lines and distinct inbound containers", async () => {
    const lines = await setup([row(), row({ sequence: "020" })]);
    assert.equal(new Set(lines.map((line) => line.cartBarcode)).size, 1);
    for (const serial of ["INBOUND-1", "INBOUND-2"]) await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(), operatorName: "Receiver", rawValues: [`1S${serial}`, "PDEMO-PART", "C", "Q2"] });
    assert.equal((await store.listInventory()).total, 2);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_headers").first()).n, 1);
    const marker = await db.prepare("SELECT picklist_identity FROM demand_headers").first();
    assert.ok(marker.picklist_identity);
  });
  await t.test("append and edit cannot introduce a second outbound card", async () => {
    const lines = await setup([row(), alternate()]);
    await assert.rejects(store.appendImportRow("append", row({ sequence: "020", cartId: "OTHER-CARD" })), /one outbound card/);
    const other = lines.find((line) => line.picklistNumber === "PICK-2");
    await assert.rejects(store.updateDemandLine(other.id, { picklistNumber: "PICK-1" }), /one outbound card/);
    await store.appendImportRow("append", row({ sequence: "020" }));
    assert.equal((await store.getAppState()).lines.length, 3);
    await assert.rejects(db.prepare("UPDATE demand_headers SET picklist_identity=(SELECT picklist_identity FROM demand_headers WHERE picklist_number='PICK-1') WHERE picklist_number='PICK-2'").run(), /UNIQUE/);
  });
  await t.test("upgrade preserves conflicting legacy cards and blocks every operational alias", async () => {
    const lines = await setup([row(), alternate()]);
    const first = lines.find((line) => line.picklistNumber === "PICK-1");
    const context = { lineId: first.id, cartKey: key(first), sessionId: "old-session", operatorName: "Operator" };
    await store.manageLock({ ...context, action: "acquire" });
    await store.recordScan({ ...context, field: "cartBarcode", value: first.cartBarcode });
    await db.prepare("DROP INDEX demand_headers_batch_picklist_idx").run();
    await db.prepare("UPDATE demand_headers SET picklist_identity='',picklist_number='PICK-1' WHERE picklist_number='PICK-2'").run();
    await db.prepare("UPDATE cartflow_schema SET version=10 WHERE name='primary'").run();
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", "const store = await import('./db/cart-store.ts'); const db=await store.ensureDatabase(); db.close();"], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_headers").first()).n, 2);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM scan_events").first()).n, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_headers WHERE picklist_identity<>''").first()).n, 0);
    assert.equal((await store.manageLock({ ...context, action: "renew" })).reason, "reconciliation_required");
    assert.equal((await store.recordScan({ ...context, field: "cartBarcode", value: first.cartBarcode })).reason, "reconciliation_required");
    assert.equal((await store.fulfillDemand({ ...context, serial: "UNUSED", serialFormat: "canonical" })).reason, "reconciliation_required");
    for (const operation of [store.confirmCartLoading, store.confirmPicklistDispatch]) {
      assert.equal((await operation({ movementValue: "TRAIN-1", cartBarcode: first.cartBarcode, operatorName: "Loader" })).reason, "reconciliation_required");
    }
    await assert.rejects(store.getPicklistPdfLines(first.id), /one outbound card/);
    await assert.rejects(store.updateDemandLine(first.id, { description: "Changed" }), /one outbound card/);
    await store.manageLock({ ...context, action: "release" });
    await assert.rejects(store.replaceImport("repair.json", [row()]), (error) => error.code === "reconciliation_required");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM scan_events").first()).n, 1);
  });
  await t.test("a duplicate introduced after a scan snapshot cannot commit evidence", async () => {
    const lines = await setup([row(), alternate()]);
    const first = lines.find((line) => line.picklistNumber === "PICK-1");
    const context = { lineId: first.id, cartKey: key(first), sessionId: "race", operatorName: "Operator" };
    await store.manageLock({ ...context, action: "acquire" });
    const original = db.guardedBatch.bind(db); let injected = false;
    db.guardedBatch = async (statements, guard) => {
      if (!injected && statements.some((statement) => statement.query.includes("INSERT INTO scan_events"))) {
        injected = true;
        await db.prepare("UPDATE demand_headers SET picklist_identity='',picklist_number='PICK-1' WHERE picklist_number='PICK-2'").run();
      }
      return original(statements, guard);
    };
    try {
      assert.equal((await store.recordScan({ ...context, field: "cartBarcode", value: first.cartBarcode })).ok, false);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM scan_events").first()).n, 0);
    } finally { db.guardedBatch = original; }
  });
});
