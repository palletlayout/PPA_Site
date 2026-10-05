import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const row = (movement, changes = {}) => ({
  plant: "QA", zone: "A", areaType: "offsite", shipCategory: "AA",
  loadNumber: movement, trainNumber: "", picklistNumber: `PICK-${movement}`,
  cartNumber: "1", cartId: `CART-${movement}`, palletId: "",
  masterBarcode: `MASTER-${movement}`, movementBarcode: movement,
  sequence: "001", partNumber: "QA-PART", description: "", color: "", quantity: 2,
  aiagSerial: "", ...changes,
});

test("section PDF reads all active movements in one area and work environment without mutations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-section-pdf-"));
  const names = ["CARTFLOW_DATABASE_PATH", "DATABASE_URL", "POSTGRES_URL", "VERCEL"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "pdf.sqlite");
  for (const name of names.slice(1)) delete process.env[name];
  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => {
    db.close();
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  });
  await store.replaceImport("old.csv", [row("OLD-LOAD")]);
  await db.prepare("UPDATE import_batches SET is_active = 0").run();
  await store.replaceImport("current.csv", [
    row("L000001"), row("L000001", { sequence: "002" }), row("L000002"),
    row("TP00001", { areaType: "onsite", trainNumber: "TP00001", loadNumber: "" }),
    row("TP00002", { areaType: "onsite", trainNumber: "TP00002", loadNumber: "" }),
    row("TEST-LOAD", { plant: "TEST", programId: "TESTSCAN", pymtc: "TEST:load" }),
    row("TEST-TRAIN", { areaType: "onsite", trainNumber: "TEST-TRAIN", loadNumber: "", plant: "TEST", programId: "TESTSCAN", pymtc: "TEST:train" }),
  ]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_headers WHERE load_number = 'OLD-LOAD'").first()).n, 1,
    "the archived movement must still exist to verify active-batch isolation");
  await db.prepare("UPDATE demand_details SET status = 'verified' WHERE sequence = '002'").run();
  const snapshot = async () => {
    const tables = ["import_batches", "demand_headers", "demand_details", "scan_events", "cart_locks", "inventory_items"];
    return Promise.all(tables.map(async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results));
  };
  const before = await snapshot();
  const loads = await store.getSectionPdfLines("offsite", "production");
  assert.deepEqual(loads.map((line) => [line.loadNumber, line.sequence]), [["L000001", "001"], ["L000001", "002"], ["L000002", "001"]]);
  assert.equal(loads[1].status, "verified", "completed demand belongs in the checksheets too");
  const trains = await store.getSectionPdfLines("onsite", "production");
  assert.deepEqual(trains.map((line) => line.trainNumber), ["TP00001", "TP00002"]);
  assert.deepEqual((await store.getSectionPdfLines("offsite", "test")).map((line) => line.loadNumber), ["TEST-LOAD"]);
  assert.deepEqual((await store.getSectionPdfLines("onsite", "test")).map((line) => line.trainNumber), ["TEST-TRAIN"]);
  assert.deepEqual(await snapshot(), before, "exporting must not change demand, scans, locks or inventory");
  await db.prepare("UPDATE import_batches SET is_active = 0").run();
  assert.deepEqual(await store.getSectionPdfLines("offsite", "production"), []);
});
