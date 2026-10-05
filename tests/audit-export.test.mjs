import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const fixture = {
  plant: "AUDIT", zone: "A", areaType: "onsite", shipCategory: "AA",
  loadNumber: "", trainNumber: "TRAIN-1", picklistNumber: "PICK-1", cartNumber: "CART-1",
  masterBarcode: "MASTER-1", movementBarcode: "MOVEMENT-1",
  cartId: "CART-ID-1", palletId: "PALLET-1", sequence: "001", partNumber: "PART-1",
  description: "Original, quoted \"description\"", color: "BLUE", quantity: 2, aiagSerial: "SERIAL-1",
};

function csvRecords(text) {
  const records = [];
  let record = [], cell = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const value = text[index];
    if (value === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (value === "," && !quoted) { record.push(cell); cell = ""; }
    else if (value === "\r" && text[index + 1] === "\n" && !quoted) {
      record.push(cell); records.push(record); record = []; cell = ""; index += 1;
    } else cell += value;
  }
  record.push(cell); records.push(record);
  return records;
}

test("audit export preserves immutable maintenance history and exposes complete pagination", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cartflow-audit-export-"));
  const environmentKeys = ["CARTFLOW_DATABASE_PATH", "DATABASE_URL", "POSTGRES_URL", "VERCEL"];
  const previous = Object.fromEntries(environmentKeys.map((name) => [name, process.env[name]]));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "audit.sqlite");
  for (const name of environmentKeys.slice(1)) delete process.env[name];
  const store = await import("../db/cart-store.ts");
  const { getDemandAuditExport, serializeDemandAuditCsv, MAX_AUDIT_EXPORT_ROWS } = await import("../db/audit-export.ts");
  const db = await store.ensureDatabase();
  t.after(async () => {
    db.close();
    for (const name of environmentKeys) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  });

  await t.test("empty history exports a consistent header without invented audit rows", async () => {
    const page = await getDemandAuditExport();
    assert.deepEqual(page, { rows: [], hasOlderRecords: false, nextBefore: null });
    const records = csvRecords(serializeDemandAuditCsv(page));
    assert.equal(records.length, 1);
    assert.equal(records[0].includes("Before (JSON)"), true);
  });

  await t.test("attributed update and delete snapshots survive current demand removal", async () => {
    await store.replaceImport("audit.csv", [fixture]);
    const line = (await store.getAppState()).lines[0];
    await store.updateDemandLine(line.id, { description: "New description" }, { id: "supervisor-1", name: '=CMD("unsafe")' });
    await store.deleteDemandLine(line.id, { id: "supervisor-2", name: "Second supervisor" });
    assert.equal((await store.getAppState()).lines.length, 0);
    const page = await getDemandAuditExport();
    assert.equal(page.rows.length, 3);
    assert.equal(page.rows.filter((event) => event.action === "reconcile_add").length, 1);
    const update = page.rows.find((event) => event.action === "update");
    const deletion = page.rows.find((event) => event.action === "delete");
    assert.equal(update.actor_id, "supervisor-1");
    assert.equal(JSON.parse(update.before_json).description, fixture.description);
    assert.equal(JSON.parse(update.after_json).description, "New description");
    assert.equal(deletion.actor_id, "supervisor-2");
    assert.equal(JSON.parse(deletion.before_json).description, "New description");
    assert.equal(deletion.after_json, "{}");
    assert.equal(update.line_id, line.id);
    assert.equal(update.batch_id, line.batchId);
    assert.equal(Boolean(update.header_id), true);
    const [headers, ...rows] = csvRecords(serializeDemandAuditCsv(page));
    const exportedUpdate = rows.find((row) => row[headers.indexOf("Action")] === "update");
    assert.equal(exportedUpdate[headers.indexOf("Actor Name")], '\'=CMD("unsafe")');
    assert.equal(exportedUpdate[headers.indexOf("Before (JSON)")], update.before_json);
    assert.equal(exportedUpdate[headers.indexOf("After (JSON)")], update.after_json);
    assert.equal(exportedUpdate[headers.indexOf("Export Has Older Records")], "No");
  });

  await t.test("malformed cursors fail explicitly instead of selecting unexpected history", async () => {
    for (const cursor of ["garbage!", "x".repeat(513), Buffer.from('["not-a-date","id"]').toString("base64url")]) {
      await assert.rejects(getDemandAuditExport(cursor), (error) => error.status === 400 && /cursor is invalid/.test(error.message));
    }
  });

  await t.test("more than 10000 equal-timestamp legacy non-UUID records are discoverable without omissions", async () => {
    await db.prepare("DELETE FROM demand_audit_events").run();
    const timestamp = "2026-09-04T12:00:00.000Z";
    const statements = Array.from({ length: MAX_AUDIT_EXPORT_ROWS + 1 }, (_, index) => {
      const id = `inventory-migration:${index.toString(16).padStart(8, "0")}`;
      return db.prepare(`INSERT INTO demand_audit_events
        (id, batch_id, header_id, line_id, action, before_json, after_json, actor_id, actor_name, created_at)
        VALUES (?, 'batch', 'header', 'line', 'update', '{}', '{}', 'actor', 'Supervisor', ?)`)
        .bind(id, timestamp);
    });
    for (let index = 0; index < statements.length; index += 500) await db.batch(statements.slice(index, index + 500));
    const first = await getDemandAuditExport();
    assert.equal(first.rows.length, MAX_AUDIT_EXPORT_ROWS);
    assert.equal(first.hasOlderRecords, true);
    assert.ok(first.nextBefore);
    const [headers, top] = csvRecords(serializeDemandAuditCsv(first, "https://cartflow.example"));
    assert.equal(top[headers.indexOf("Export Has Older Records")], "Yes");
    assert.equal(top[headers.indexOf("Next Export URL")], `https://cartflow.example/api/audit/export?before=${first.nextBefore}`);
    const second = await getDemandAuditExport(first.nextBefore);
    assert.equal(second.rows.length, 1);
    assert.equal(second.hasOlderRecords, false);
    assert.equal(second.nextBefore, null);
    assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, MAX_AUDIT_EXPORT_ROWS + 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM demand_audit_events").first()).count, MAX_AUDIT_EXPORT_ROWS + 1);
  });
});
