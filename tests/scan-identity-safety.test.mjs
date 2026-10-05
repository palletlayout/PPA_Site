import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("physical card scans require one identity in the selected movement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-scan-identity-"));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "isolated.sqlite");
  for (const key of ["DATABASE_URL", "POSTGRES_URL", "VERCEL"]) delete process.env[key];
  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const row = {
    plant: "P1", areaType: "onsite", trainNumber: "TRAIN-1", loadNumber: "", zone: "A", shipCategory: "Production",
    picklistNumber: "PICK-1", cartNumber: "1", cartId: "CART-1", palletId: "PAL-1", masterBarcode: "MASTER-1", movementBarcode: "MOVE-1",
    sequence: "010", partNumber: "PART", description: "", color: "", quantity: 10, aiagSerial: "",
  };
  const other = { ...row, picklistNumber: "PICK-2", cartNumber: "2", cartId: "CART-2", masterBarcode: "MASTER-2" };
  const context = (line) => ({
    lineId: line.id,
    cartKey: [line.plant, line.areaType, line.trainNumber, line.picklistNumber, line.cartNumber, line.cartId].join("::"),
    sessionId: `scanner-${line.id}`, operatorName: "Reviewer", operatorId: "reviewer",
  });
  const setup = async (rows) => {
    await store.clearAllData();
    await store.replaceImport("identity.csv", rows);
    return (await store.getAppState()).lines;
  };
  const start = async (line) => {
    const ctx = context(line);
    assert.equal((await store.manageLock({ ...ctx, action: "acquire" })).locked, true);
    return ctx;
  };
  const scan = (ctx, value) => store.recordScan({ ...ctx, field: "cartBarcode", value });
  const matchedEvents = async () => Number((await db.prepare("SELECT COUNT(*) AS count FROM scan_events WHERE field='cartBarcode' AND matched=1").first()).count);

  await t.test("manual selection cannot authorize a shared master, checksheet or cross-field alias", async () => {
    for (const [first, second, barcode] of [
      [{ ...row, masterBarcode: "SHARED" }, { ...other, masterBarcode: "SHARED" }, "SHARED"],
      [{ ...row, checksheetNumber: "CHECK-SHARED" }, { ...other, masterBarcode: "CHECK-SHARED" }, "CHECK-SHARED"],
      [{ ...row, orderNumber: "PICK-2" }, other, "PICK-2"],
    ]) {
      const lines = await setup([first, second]);
      const selected = lines.find((line) => line.picklistNumber === "PICK-1");
      const ctx = await start(selected);
      const result = await scan(ctx, `\r]C1${barcode.toLowerCase()}\r`);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "ambiguous_picklist");
      assert.equal(await matchedEvents(), 0);
      await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ["1SNO-CARD-EVIDENCE", "PPART", "Q10"], operatorName: "Reviewer" });
      assert.equal((await store.fulfillDemand({ ...ctx, serial: "1SNO-CARD-EVIDENCE", serialFormat: "barcode", requestId: randomUUID() })).reason, "cart_not_scanned");
      const unique = await scan(ctx, selected.cartBarcode);
      assert.equal(unique.ok, true); assert.equal(unique.matched, true);
    }
  });

  await t.test("a completed card keeps its physical alias ambiguous", async () => {
    const lines = await setup([{ ...row, masterBarcode: "SHARED" }, { ...other, masterBarcode: "SHARED" }]);
    const completed = lines.find((line) => line.picklistNumber === "PICK-1");
    const first = await start(completed);
    assert.equal((await scan(first, completed.cartBarcode)).matched, true);
    await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ["1SCOMPLETE", "PPART", "Q10"], operatorName: "Reviewer" });
    assert.equal((await store.fulfillDemand({ ...first, serial: "1SCOMPLETE", serialFormat: "barcode", requestId: randomUUID() })).verified, true);
    await store.manageLock({ ...first, action: "release" });
    const next = await start(lines.find((line) => line.picklistNumber === "PICK-2"));
    assert.equal((await scan(next, "SHARED")).reason, "ambiguous_picklist");
    assert.equal(await matchedEvents(), 1, "only the unique CF scan may be matched");
  });

  await t.test("identical aliases in another selected movement or plant remain separate", async () => {
    const lines = await setup([
      { ...row, masterBarcode: "SHARED" },
      { ...other, masterBarcode: "SHARED", trainNumber: "TRAIN-2", movementBarcode: "MOVE-2" },
      { ...other, masterBarcode: "SHARED", plant: "P2" },
    ]);
    const selected = lines.find((line) => line.plant === "P1" && line.trainNumber === "TRAIN-1");
    const result = await scan(await start(selected), "SHARED");
    assert.equal(result.ok, true); assert.equal(result.matched, true);
    assert.equal(await matchedEvents(), 1);
  });

  await t.test("a collision introduced after preflight cannot commit positive evidence", async () => {
    const lines = await setup([row, other]);
    const selected = lines.find((line) => line.picklistNumber === "PICK-1");
    const peer = lines.find((line) => line.picklistNumber === "PICK-2");
    const ctx = await start(selected);
    const guardedBatch = db.guardedBatch.bind(db);
    let injected = false;
    db.guardedBatch = async (statements, condition) => {
      if (!injected && statements.some((statement) => statement.query.includes("INSERT INTO scan_events"))) {
        injected = true;
        await store.updateDemandLine(peer.id, { masterBarcode: selected.masterBarcode }, { id: "supervisor", name: "Supervisor" });
      }
      return guardedBatch(statements, condition);
    };
    try {
      const result = await scan(ctx, selected.masterBarcode);
      assert.equal(injected, true);
      assert.equal(result.ok, false);
      assert.equal(await matchedEvents(), 0);
    } finally { db.guardedBatch = guardedBatch; }
  });
});
