import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  assessSnapshotShrink,
  SHRINK_GUARD_FRACTION,
  SHRINK_GUARD_MIN_LINES,
  SnapshotShrinkError,
} from "../db/demand-reconciliation.ts";
import { readDemandImportRequest } from "../lib/demand-import-request.ts";

const row = (name, changes = {}) => ({
  sourceScope: "erp", sourceLineId: `order-${name}`, plant: "P1", zone: "A", areaType: "onsite",
  shipCategory: "Production", loadNumber: "", trainNumber: "TRAIN", picklistNumber: `PICK-${name}`,
  cartNumber: `CART-${name}`, cartId: `CART-${name}`, palletId: `PAL-${name}`, sequence: "010",
  partNumber: "PART", description: "Part", color: "BLUE", quantity: 10, aiagSerial: "",
  masterBarcode: `MASTER-${name}`, movementBarcode: "DESTINATION", ...changes,
});
const rowsNamed = (count, prefix = "R") => Array.from({ length: count }, (_, index) => row(`${prefix}${String(index).padStart(3, "0")}`));

test("the threshold rule: empty deliveries and large removals need confirmation, small ones do not", () => {
  assert.equal(SHRINK_GUARD_MIN_LINES, 10);
  assert.equal(SHRINK_GUARD_FRACTION, 0.5);
  const assess = (unworkedLines, removedLines, incomingLines) => assessSnapshotShrink({ unworkedLines, removedLines, incomingLines });
  assert.equal(assess(50, 0, 50), null, "nothing removed");
  assert.equal(assess(0, 0, 0), null, "an empty feed with no open demand is normal");
  assert.deepEqual(assess(3, 3, 0), { reason: "empty_snapshot", unworkedLines: 3, removedLines: 3, incomingLines: 0 }, "an empty feed is refused at any size");
  assert.deepEqual(assess(1, 1, 0)?.reason, "empty_snapshot");
  assert.equal(assess(10, 9, 1), null, "below the 10-line floor");
  assert.equal(assess(20, 9, 11), null);
  assert.deepEqual(assess(20, 10, 10), { reason: "large_removal", unworkedLines: 20, removedLines: 10, incomingLines: 10 }, "exactly 50% at the floor is refused");
  assert.equal(assess(21, 10, 11), null, "just under 50%");
  assert.equal(assess(1000, 499, 501), null);
  assert.equal(assess(1000, 500, 500)?.reason, "large_removal");
  assert.equal(assess(200, 197, 3)?.reason, "large_removal", "a 200-line snapshot followed by a 3-line one");
});

test("the refusal names the counts and how to confirm, and carries the details", () => {
  const empty = new SnapshotShrinkError({ reason: "empty_snapshot", unworkedLines: 40, removedLines: 40, incomingLines: 0 });
  assert.equal(empty.status, 409);
  assert.equal(empty.code, "shrink_confirmation_required");
  assert.match(empty.message, /no demand rows.*remove 40 of 40 demand lines that have no scan, packing or loading activity yet.*No demand or inventory was changed.*allowShrink/);
  const large = new SnapshotShrinkError({ reason: "large_removal", unworkedLines: 200, removedLines: 197, incomingLines: 3 });
  assert.match(large.message, /remove 197 of 200 demand lines that have no scan, packing or loading activity yet \(99%\)/);
  assert.deepEqual(large.shrink, { reason: "large_removal", unworkedLines: 200, removedLines: 197, incomingLines: 3 });
});

test("full snapshots that retire most open demand are refused, change nothing, and can be confirmed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-shrink-guard-"));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "test.sqlite");
  for (const name of ["DATABASE_URL", "POSTGRES_URL", "VERCEL"]) delete process.env[name];
  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const actor = { id: "supervisor", name: "Supervisor" };
  const activeIds = async () => (await store.getAppState()).lines.map((line) => line.id).sort();
  const seed = async (count) => {
    await store.clearAllData();
    await store.replaceImport("seed.json", rowsNamed(count), undefined, actor);
    return activeIds();
  };

  await t.test("a truncated snapshot is refused with details and leaves demand untouched", async () => {
    const before = await seed(20);
    assert.equal(before.length, 20);
    const auditBefore = (await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events").first()).n;
    await assert.rejects(store.replaceImport("truncated.json", rowsNamed(5), undefined, actor), (error) => {
      assert.equal(error instanceof SnapshotShrinkError, true);
      assert.equal(error.code, "shrink_confirmation_required");
      assert.deepEqual(error.shrink, { reason: "large_removal", unworkedLines: 20, removedLines: 15, incomingLines: 5 });
      return true;
    });
    assert.deepEqual(await activeIds(), before, "the same 20 lines, with the same IDs, remain active");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events").first()).n, auditBefore, "no audit rows were written");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM import_batches").first()).n, 1, "no new batch was created");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM integration_imports WHERE status='processing'").first()).n, 0, "the processing claim was released");
  });

  await t.test("confirming with allowShrink applies the snapshot and records every removal", async () => {
    const before = await seed(20);
    const result = await store.replaceImport("confirmed.json", rowsNamed(5), undefined, actor, { allowShrink: true });
    assert.equal(result.rowCount, 5);
    assert.equal((await activeIds()).length, 5);
    assert.equal(before.length - 5, (await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events WHERE action='reconcile_remove'").first()).n);
  });

  await t.test("the boundary: 10 of 20 is refused, 9 of 20 is not", async () => {
    await seed(20);
    await assert.rejects(store.replaceImport("half.json", rowsNamed(10), undefined, actor), (error) => error.code === "shrink_confirmation_required");
    assert.equal((await activeIds()).length, 20);
    const result = await store.replaceImport("nine.json", rowsNamed(11), undefined, actor);
    assert.equal(result.rowCount, 11);
    assert.equal((await activeIds()).length, 11);
  });

  await t.test("small sites are not blocked by a proportional removal below the floor", async () => {
    await seed(8);
    const result = await store.replaceImport("small.json", rowsNamed(2), undefined, actor);
    assert.equal(result.rowCount, 2);
  });

  await t.test("an empty snapshot is refused while open demand exists, at any size", async () => {
    await seed(2);
    await assert.rejects(store.replaceImport("empty.json", [], undefined, actor), (error) => error.shrink?.reason === "empty_snapshot");
    assert.equal((await activeIds()).length, 2);
    assert.equal((await store.replaceImport("empty.json", [], undefined, actor, { allowShrink: true })).rowCount, 0);
  });

  await t.test("the first import and growth are never refused", async () => {
    await store.clearAllData();
    assert.equal((await store.replaceImport("first.json", rowsNamed(3), undefined, actor)).rowCount, 3);
    assert.equal((await store.replaceImport("grown.json", rowsNamed(30), undefined, actor)).rowCount, 30);
    assert.equal((await store.replaceImport("same.json", rowsNamed(30), undefined, actor)).rowCount, 30);
  });

  await t.test("a refused automated delivery can be retried with the same Idempotency-Key once confirmed", async () => {
    await seed(20);
    const delivery = { source: "erp", fileName: "open-demand.json", rows: rowsNamed(4), idempotencyKey: "delivery-2026-09-28", contentHash: "hash-of-four-rows" };
    await assert.rejects(store.replaceIntegrationImport(delivery), (error) => error.code === "shrink_confirmation_required");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM integration_imports WHERE idempotency_key=?").bind(delivery.idempotencyKey).first()).n, 0,
      "a refusal must not leave a receipt that would block or replay the retry");
    assert.equal((await activeIds()).length, 20);
    const applied = await store.replaceIntegrationImport({ ...delivery, allowShrink: true });
    assert.equal(applied.idempotentReplay, false);
    assert.equal(applied.rowCount, 4);
    assert.equal((await activeIds()).length, 4);
    const replay = await store.replaceIntegrationImport(delivery);
    assert.equal(replay.idempotentReplay, true, "the same key still replays the applied delivery");
    assert.equal((await activeIds()).length, 4);
  });

  await t.test("worked lines do not dilute the share of unstarted demand a snapshot removes", async () => {
    // 100 lines, 60 of them already scanned. A file that keeps the 60 worked lines and
    // drops all 40 unstarted ones is a 100% removal of what could be removed, not 40%.
    await seed(100);
    const lines = (await store.getAppState()).lines;
    const workedIds = new Set(lines.slice(0, 60).map((line) => line.sourceLineId));
    for (const line of lines.slice(0, 60)) {
      await db.prepare("INSERT INTO scan_events (id, line_id, cart_key, session_id, field, scanned_value, matched, operator_name, created_at) VALUES (?, ?, 'k', 's', 'cartBarcode', 'x', 1, 'op', ?)")
        .bind(crypto.randomUUID(), line.id, new Date().toISOString()).run();
    }
    const kept = rowsNamed(100).filter((row) => workedIds.has(row.sourceLineId));
    assert.equal(kept.length, 60);
    await assert.rejects(store.replaceImport("keep-worked-only.json", kept, undefined, actor), (error) => {
      assert.equal(error.code, "shrink_confirmation_required");
      assert.deepEqual(error.shrink, { reason: "large_removal", unworkedLines: 40, removedLines: 40, incomingLines: 60 });
      return true;
    });
    assert.equal((await activeIds()).length, 100, "nothing was removed");
    assert.equal((await store.replaceImport("keep-worked-only.json", kept, undefined, actor, { allowShrink: true })).rowCount, 60);
  });

  await t.test("generated TEST work is carried forward and never counts toward a reduction", async () => {
    await seed(20);
    const testRow = row("TESTONLY", { plant: "TEST", programId: "TESTSCAN", pymtc: "TEST:ONE", sourceScope: "" });
    await store.replaceImport("with-test.json", [...rowsNamed(20), testRow], undefined, actor);
    const before = (await store.getAppState()).lines.length;
    assert.equal(before, 21);
    // Removing every production line still triggers the guard; the TEST line neither
    // dilutes the denominator nor is it removed.
    await assert.rejects(store.replaceImport("drop-production.json", rowsNamed(5), undefined, actor), (error) => error.shrink?.unworkedLines === 20 && error.shrink?.removedLines === 15);
  });

  await t.test("a confirmed snapshot still cannot retire worked demand", async () => {
    const lines = await seed(20);
    const worked = (await store.getAppState()).lines[0];
    await db.prepare("UPDATE demand_details SET status='in_progress', fulfilled_quantity=1 WHERE id=?").bind(worked.id).run();
    await assert.rejects(
      store.replaceImport("drop-worked.json", rowsNamed(20).filter((line) => line.sourceLineId !== worked.sourceLineId).slice(0, 4), undefined, actor, { allowShrink: true }),
      (error) => error.code === "reconciliation_required",
    );
    assert.equal((await activeIds()).length, lines.length);
  });
});

const json = (body) => new Request("https://ppa.test/api/integrations/demand", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("JSON deliveries: allowShrink must be a real boolean and expectedRows must match the rows sent", async () => {
  const rows = rowsNamed(3);
  assert.equal((await readDemandImportRequest(json({ rows }))).allowShrink, false, "absent means not confirmed");
  assert.equal((await readDemandImportRequest(json({ rows, allowShrink: true }))).allowShrink, true);
  assert.equal((await readDemandImportRequest(json({ rows, allowShrink: false }))).allowShrink, false);
  for (const bad of ["yes", 1, 0, {}, []]) {
    await assert.rejects(readDemandImportRequest(json({ rows, allowShrink: bad })), /allowShrink must be true or false/);
  }
  assert.equal((await readDemandImportRequest(json({ rows, expectedRows: 3 }))).rows.length, 3);
  assert.equal((await readDemandImportRequest(json({ rows, expectedRows: "3" }))).rows.length, 3);
  await assert.rejects(readDemandImportRequest(json({ rows, expectedRows: 4 })), (error) => {
    assert.equal(error.status, 422);
    assert.match(error.message, /expectedRows is 4 but this delivery contains 3 demand rows.*Nothing was imported/);
    return true;
  });
  await assert.rejects(readDemandImportRequest(json({ rows: [], expectedRows: 3 })), (error) => error.status === 422);
  assert.equal((await readDemandImportRequest(json({ rows: [], expectedRows: 0 }))).rows.length, 0, "an explicit zero control total matches an empty delivery");
  for (const bad of [-1, 1.5, "abc", "3.0", 10_001, {}, true]) {
    await assert.rejects(readDemandImportRequest(json({ rows, expectedRows: bad })), /expectedRows must be a whole number from 0 to 10,000/);
  }
});

function multipart(fields, csvRows) {
  const form = new FormData();
  const sheet = XLSX.utils.json_to_sheet(csvRows);
  form.set("file", new File([XLSX.utils.sheet_to_csv(sheet)], "demand.csv", { type: "text/csv" }));
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return new Request("https://ppa.test/api/import", { method: "POST", body: form });
}

const demandRecord = (sequence) => ({
  "PR OGPLCD": "01", "R DVZONE": "R", Area: "Onsite", "Ship Category": "Production",
  "Train #": "TE309771", Picklist: "Z101AHTE31014603", "Cart #": "1", "Cart ID": "SH059R21",
  "PI CNTPSQ": sequence, "PI MBPN": "46674-30B-A000-", "PI QTY": "30", "Total Carts": "1",
  "Checksheet Number": "Z101AHTE31014603", "Movement Barcode": "AE1TE309771X5AA",
  "Container Total": "1", "Part Color": "NE900L",
});

test("spreadsheet deliveries accept the same allowShrink and expectedRows form fields", async () => {
  const records = [demandRecord("001"), demandRecord("002")];
  const plain = await readDemandImportRequest(multipart({ action: "replace" }, records));
  assert.equal(plain.allowShrink, false);
  assert.equal(plain.rows.length, 2);
  const confirmed = await readDemandImportRequest(multipart({ action: "replace", allowShrink: "TRUE", expectedRows: "2" }, records));
  assert.equal(confirmed.allowShrink, true);
  await assert.rejects(readDemandImportRequest(multipart({ expectedRows: "3" }, records)), (error) => error.status === 422 && /contains 2 demand rows/.test(error.message));
  await assert.rejects(readDemandImportRequest(multipart({ allowShrink: "maybe" }, records)), /allowShrink must be true or false/);
  await assert.rejects(readDemandImportRequest(multipart({ expectedRows: "two" }, records)), /expectedRows must be a whole number/);
  const doubled = new FormData();
  doubled.set("file", new File(["x"], "demand.csv"));
  doubled.append("allowShrink", "true");
  doubled.append("allowShrink", "true");
  await assert.rejects(readDemandImportRequest(new Request("https://ppa.test/api/import", { method: "POST", body: doubled })), /allowShrink field only once/);
});
