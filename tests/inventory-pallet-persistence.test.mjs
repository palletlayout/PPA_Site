import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseInventorySpreadsheet } from "../lib/inventory-import.ts";

test("inventory file pallet IDs survive receipts, retries and restarts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-inventory-pallet-"));
  const databasePath = join(directory, "inventory.sqlite");
  const envNames = ["CARTFLOW_DATABASE_PATH", "DATABASE_URL", "POSTGRES_URL", "VERCEL"];
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  process.env.CARTFLOW_DATABASE_PATH = databasePath;
  for (const name of envNames.slice(1)) delete process.env[name];
  const store = await import("../db/cart-store.ts");
  const { getDatabase, Database } = await import("../db/index.ts");
  const db = await store.ensureDatabase();
  t.after(async () => {
    getDatabase().close();
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  });

  await t.test("version 15 inventory gains a blank pallet column without changing existing receipts", async () => {
    const original = await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(),
      operatorName: "Existing receiver", rawValues: ["1SLEGACY-PALLET-BLANK", "PLEGACY-PART", "Q4"] });
    await db.prepare("ALTER TABLE inventory_items DROP COLUMN pallet_id").run();
    await db.prepare("UPDATE cartflow_schema SET version=15 WHERE name='primary'").run();
    const restart = () => JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      const store = await import('./db/cart-store.ts');
      const inventory = await store.listInventory({ q: 'LEGACY-PALLET-BLANK' });
      const db = await store.ensureDatabase();
      const schema = await db.prepare("SELECT version FROM cartflow_schema WHERE name='primary'").first();
      const stored = await db.prepare("SELECT pallet_id FROM inventory_items WHERE aiag_serial='LEGACY-PALLET-BLANK'").first();
      console.log(JSON.stringify({ inventory: inventory.items[0], version: schema.version, palletId: stored.pallet_id }));
      db.close();
    `], { cwd: new URL("..", import.meta.url), env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const upgraded = restart();
    assert.equal(upgraded.version, 17);
    assert.equal(upgraded.palletId, "");
    assert.deepEqual(upgraded.inventory, original.inventory);
    assert.deepEqual(restart(), upgraded, "a second startup leaves the inventory intact");
  });

  const [row] = await parseInventorySpreadsheet(new TextEncoder().encode("Serial Number,Part Number,Quantity,Pallet ID\n000123,PART-A,30,000Mixed-Pallet").buffer, "inventory.csv");
  const request = {
    captureId: randomUUID(), receiptSessionId: randomUUID(), operatorName: "Pallet file import",
    rawValues: [`1S${row.aiagSerial}`, `P${row.partNumber}`, `C${row.color}`, `Q${row.quantity}`],
    unitOfMeasure: row.unitOfMeasure, supplierId: row.supplierId, palletId: row.palletId,
  };
  const first = await store.receiveInventoryFromPhysicalLabel(request);
  assert.equal(first.created, true);
  assert.equal(first.inventory.palletId, "000Mixed-Pallet");
  for (const next of [request, { ...request, captureId: randomUUID(), palletId: "000MIXED-PALLET" }, { ...request, captureId: randomUUID(), palletId: undefined }]) {
    const replay = await store.receiveInventoryFromPhysicalLabel(next);
    assert.equal(replay.created, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.inventory.id, first.inventory.id);
    assert.equal(replay.inventory.palletId, "000Mixed-Pallet", "the original file spelling is retained");
  }
  for (const captureId of [request.captureId, randomUUID()]) {
    await assert.rejects(store.receiveInventoryFromPhysicalLabel({ ...request, captureId, palletId: "ANOTHER-PALLET" }),
      (error) => error instanceof store.DemandAppendError && error.status === 409);
  }
  await t.test("plain file pallet IDs retain scanner-like prefixes during duplicate checks", async () => {
    const prefixed = { ...request, captureId: randomUUID(), palletId: "]C1PAL-REPLAY",
      rawValues: ["1SPALLET-AIM-PREFIX", ...request.rawValues.slice(1)] };
    const saved = await store.receiveInventoryFromPhysicalLabel(prefixed);
    assert.equal(saved.inventory.palletId, "]C1PAL-REPLAY");
    const same = await store.receiveInventoryFromPhysicalLabel({ ...prefixed, captureId: randomUUID(), palletId: "  ]c1pal-replay  " });
    assert.equal(same.duplicate, true);
    assert.equal(same.inventory.palletId, "]C1PAL-REPLAY");
    for (const captureId of [prefixed.captureId, randomUUID()]) {
      await assert.rejects(store.receiveInventoryFromPhysicalLabel({ ...prefixed, captureId, palletId: "PAL-REPLAY" }),
        (error) => error instanceof store.DemandAppendError && error.status === 409,
        "changing a literal pallet identifier must conflict, even if it resembles scanner framing");
    }
  });
  for (const palletId of [123, "PAL\nLET", "P".repeat(181)]) {
    await assert.rejects(store.receiveInventoryFromPhysicalLabel({ ...request, captureId: randomUUID(), palletId }), /Pallet ID/);
  }
  const listed = await store.listInventory({ q: "000mixed-pallet" });
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].palletId, "000Mixed-Pallet");
  assert.equal(listed.items[0].palletBarcode, undefined);
  assert.equal((await store.getInventoryExport("000mixed-pallet"))[0].palletId, "000Mixed-Pallet");
  const reopened = new Database({ sqlitePath: databasePath });
  try {
    assert.equal((await reopened.prepare("SELECT pallet_id FROM inventory_items WHERE id=?").bind(first.inventory.id).first()).pallet_id, "000Mixed-Pallet");
  } finally { reopened.close(); }

  const expected = await store.receiveInventoryFromPhysicalLabel({ ...request, captureId: randomUUID(), receiptKind: "expected",
    rawValues: ["1SEXPECTED-PALLET-CONTAINER", ...request.rawValues.slice(1)] });
  assert.equal(expected.inventory.palletId, "000Mixed-Pallet");
  const received = await store.receiveExpectedInventory({ inventoryId: expected.inventory.id,
    captureId: randomUUID(), receiptSessionId: randomUUID(), operatorName: "Receiver" });
  assert.equal(received.inventory.receiptKind, "received");
  assert.equal(received.inventory.palletId, "000Mixed-Pallet");
  assert.equal(received.inventory.palletBarcode, undefined);
});
