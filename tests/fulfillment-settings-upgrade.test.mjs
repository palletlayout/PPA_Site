import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("existing version 12 databases upgrade the label setting without changing packing work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-settings-upgrade-"));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "existing.sqlite");
  for (const name of ["DATABASE_URL", "POSTGRES_URL", "VERCEL"]) delete process.env[name];
  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  await store.updateFulfillmentSettings({ packingMode: "multiple", inventoryMode: "scan" }, { id: "supervisor", name: "Supervisor" });
  await store.replaceImport("upgrade.json", [{ plant: "QA", areaType: "offsite", zone: "Z", shipCategory: "A",
    loadNumber: "LOAD", trainNumber: "", picklistNumber: "PICK", cartNumber: "CARD", cartId: "CARD-ID", palletId: "PALLET",
    sequence: "1", partNumber: "PART", color: "M4", quantity: 5, aiagSerial: "" }]);
  const line = (await store.getAppState()).lines[0];
  const context = { cartKey: [line.plant, line.areaType, line.loadNumber, line.picklistNumber, line.cartNumber, line.cartId].join("::"),
    lineId: line.id, sessionId: "upgrade-scanner", operatorName: "Packer" };
  await store.manageLock({ ...context, action: "acquire" });
  await store.recordScan({ ...context, field: "cartBarcode", value: line.cartBarcode });
  await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(),
    rawValues: ["1SEXISTING-STOCK", "PPART", "2PM4", "Q2"], operatorName: "Receiver" });
  const packed = await store.fulfillDemand({ ...context, serial: "1SEXISTING-STOCK", serialFormat: "barcode", requestId: randomUUID() });
  assert.equal(packed.fulfilledQuantity, 2);
  // Compare the same JSON representation returned by the queue API.
  const before = JSON.parse(JSON.stringify(await store.getAppState(context.sessionId)));
  const inventoryBefore = JSON.parse(JSON.stringify(await store.listInventory()));

  const restart = () => JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const store = await import('./db/cart-store.ts');
    const state = await store.getAppState('upgrade-scanner');
    const inventory = await store.listInventory();
    const db = await store.ensureDatabase();
    const schema = await db.prepare("SELECT version FROM cartflow_schema WHERE name='primary'").first();
    console.log(JSON.stringify({ state, inventory, version: schema.version }));
    db.close();
  `], { cwd: new URL("..", import.meta.url), env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

  // Reproduce a previously current installation that predates the new column.
  await db.prepare("ALTER TABLE fulfillment_settings DROP COLUMN part_attribute").run();
  await db.prepare("UPDATE cartflow_schema SET version=12 WHERE name='primary'").run();
  const upgraded = restart();
  assert.equal(upgraded.version, 17);
  assert.deepEqual(upgraded.state, before, "demand, locks, scan evidence and allocations survive the upgrade");
  assert.deepEqual(upgraded.inventory, inventoryBefore, "stock balances and receipts survive the upgrade");
  assert.deepEqual(restart(), upgraded, "restarting after migration is idempotent");

  // Fresh databases created by the prior build may already contain the column.
  await db.prepare("UPDATE fulfillment_settings SET part_attribute='part_level' WHERE id='primary'").run();
  await db.prepare("UPDATE cartflow_schema SET version=12 WHERE name='primary'").run();
  const alreadyAdded = restart();
  assert.equal(alreadyAdded.version, 17);
  assert.equal(alreadyAdded.state.settings.partAttribute, "color");
  assert.deepEqual(alreadyAdded.state.lines, before.lines);
  assert.deepEqual(alreadyAdded.inventory, inventoryBefore);
});
