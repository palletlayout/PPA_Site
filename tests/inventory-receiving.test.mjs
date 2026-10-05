import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("production receiving persists inventory independently of demand", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cartflow-receiving-store-"));
  const databasePath = join(directory, "receiving.sqlite");
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
  const request = {
    captureId: randomUUID(), receiptSessionId: randomUUID(),
    rawValues: ["1SCONT-RECEIVING-1", "PPART-RECEIVING", "2PBLACK", "Q24"],
    operatorName: "Receiving operator", operatorId: "receiver-1",
  };
  const count = async (table) => Number((await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count);
  const assertNoDemand = async () => {
    for (const table of ["cart_lines", "demand_headers", "demand_details", "import_batches", "inventory_demand_projections"]) {
      assert.equal(await count(table), 0, `${table} must not be manufactured by a receipt`);
    }
    assert.equal((await store.getAppState()).lines.length, 0);
  };
  let first;
  let testCaptureId;
  const duplicateCaptureId = randomUUID();

  await t.test("a receipt on an empty database stores the physical label and its original operator", async () => {
    first = await store.receiveInventoryFromPhysicalLabel(request);
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.duplicate, false);
    assert.deepEqual(first.inventory, {
      id: request.captureId, serial: "CONT-RECEIVING-1", partNumber: "PART-RECEIVING",
      partMark: "BLACK", partLevel: "", color: "BLACK", quantity: 24, status: "available", isTest: false,
      unitOfMeasure: "EA", supplierId: "", receiptKind: "received", fulfillmentStage: "available", loadedAt: null, dispatchedAt: null,
      loadedQuantity: 0, dispatchedQuantity: 0,
      consumedFlag: "N", consumedQuantity: 0, remainingQuantity: 24, consumedAt: null, weight: null, unitCost: null, receiveDate: "", fulfilledDemandId: null, fulfilledDemandIds: [],
      receivedBy: request.operatorName, receivedAt: first.inventory.receivedAt,
      acquisitionMethod: "scanner_capture", sourceFile: "", sourceImportId: "", sourceRow: null,
      recordedAt: first.inventory.receivedAt,
      scannedValuesJson: JSON.stringify({ aiagSerial: request.rawValues[0], partNumber: request.rawValues[1], color: request.rawValues[2], quantity: request.rawValues[3] }),
    });
    assert.ok(Number.isFinite(Date.parse(first.inventory.receivedAt)));
    const raw = await db.prepare("SELECT raw_aiag_serial, raw_part_number, raw_part_level, raw_quantity, is_test FROM inventory_items WHERE id = ?")
      .bind(first.inventory.id).first();
    assert.deepEqual({ ...raw }, {
      raw_aiag_serial: request.rawValues[0], raw_part_number: request.rawValues[1],
      raw_part_level: request.rawValues[2], raw_quantity: request.rawValues[3], is_test: 0,
    });
    await assertNoDemand();
  });

  await t.test("network retries and a later scan of the same container cannot inflate quantity", async () => {
    const replay = await store.receiveInventoryFromPhysicalLabel({ ...request, operatorName: "Second operator" });
    const repeatedScan = await store.receiveInventoryFromPhysicalLabel({
      ...request, captureId: duplicateCaptureId, receiptSessionId: randomUUID(),
      rawValues: ["1Scont-receiving-1", "Ppart-receiving", "2Pblack", "Q024"], operatorName: "Third operator",
    });
    for (const result of [replay, repeatedScan]) {
      assert.equal(result.created, false);
      assert.equal(result.duplicate, true);
      assert.deepEqual(result.inventory, first.inventory, "receipt provenance must remain the original receipt");
    }
    assert.equal(await count("inventory_items"), 1);
    assert.equal(await count("inventory_capture_receipts"), 2);
    const inventory = await store.listInventory({});
    assert.deepEqual(inventory.summary, { containers: 1, units: 24, quantitiesByUnit: { EA: 24 } });
    const events = await db.prepare("SELECT action, actor_id, actor_name FROM demand_audit_events WHERE action IN ('inventory_received', 'inventory_duplicate') ORDER BY action").all();
    assert.equal(events.results.length, 2, "replaying the same request must not duplicate its audit event");
    assert.deepEqual(events.results.map((event) => event.action), ["inventory_duplicate", "inventory_received"]);
    assert.equal(events.results.find((event) => event.action === "inventory_received").actor_id, "receiver-1");
    await assertNoDemand();
  });

  await t.test("conflicting labels and reused capture identifiers cannot change received inventory", async () => {
    const conflictingCaptureId = randomUUID();
    const conflicts = [
      { ...request, captureId: conflictingCaptureId, rawValues: ["1SCONT-RECEIVING-1", "PPART-RECEIVING", "2PBLACK", "Q25"] },
      { ...request, captureId: randomUUID(), rawValues: ["1SCONT-RECEIVING-1", "POTHER-PART", "2PBLACK", "Q24"] },
      { ...request, captureId: randomUUID(), rawValues: ["1SCONT-RECEIVING-1", "PPART-RECEIVING", "2PWHITE", "Q24"] },
      { ...request, rawValues: ["1SOTHER-CONTAINER", "PPART-RECEIVING", "2PBLACK", "Q24"] },
      { ...request, receiptSessionId: randomUUID() },
      { ...request, captureId: duplicateCaptureId, rawValues: ["1SNEW-CONTAINER", "PPART-RECEIVING", "2PBLACK", "Q25"] },
    ];
    for (const input of conflicts) {
      await assert.rejects(store.receiveInventoryFromPhysicalLabel(input),
        (error) => error instanceof store.DemandAppendError && error.code === "conflict" && error.status === 409);
    }
    assert.equal(await count("inventory_items"), 1);
    assert.deepEqual((await store.listInventory({})).items, [first.inventory]);
    await assertNoDemand();
  });

  await t.test("concurrent retries and separate scanners each create a container exactly once", async () => {
    const oneRequest = { ...request, captureId: randomUUID(), rawValues: ["1SCONCURRENT-RETRY", "PPART-RECEIVING", "2PBLACK", "Q7"] };
    const retries = await Promise.all(Array.from({ length: 12 }, () => store.receiveInventoryFromPhysicalLabel(oneRequest)));
    assert.equal(retries.filter((result) => result.created).length, 1);
    assert.equal(new Set(retries.map((result) => result.inventory.id)).size, 1);
    const separateScanners = await Promise.all(Array.from({ length: 12 }, () => store.receiveInventoryFromPhysicalLabel({
      ...request, captureId: randomUUID(), receiptSessionId: randomUUID(),
      rawValues: ["1SCONCURRENT-SCANNERS", "PPART-RECEIVING", "2PBLACK", "Q11"],
    })));
    assert.equal(separateScanners.filter((result) => result.created).length, 1);
    assert.equal(new Set(separateScanners.map((result) => result.inventory.id)).size, 1);
    assert.deepEqual((await store.listInventory({})).summary, { containers: 3, units: 42, quantitiesByUnit: { EA: 42 } });
    await assertNoDemand();
  });

  await t.test("test labels have a separate serial namespace and never appear in production inventory", async () => {
    testCaptureId = randomUUID();
    const testReceipt = await store.appendTestDemandFromPhysicalLabel({
      captureId: testCaptureId, testSessionId: randomUUID(), operatorName: "Test operator",
      rawValues: ["1SCONT-RECEIVING-1", "PTEST-PART", "2PTEST", "Q99"],
    });
    assert.equal(testReceipt.inventoryCreated, true);
    assert.notEqual(testReceipt.inventory.id, first.inventory.id);
    const rows = await db.prepare("SELECT is_test, quantity FROM inventory_items WHERE normalized_serial = ? ORDER BY is_test")
      .bind("CONT-RECEIVING-1").all();
    assert.deepEqual(rows.results.map((row) => [row.is_test, row.quantity]), [[0, 24], [1, 99]]);
    assert.deepEqual((await store.listInventory({})).summary, { containers: 3, units: 42, quantitiesByUnit: { EA: 42 } });
    assert.deepEqual((await store.listInventory({ q: "CONT-RECEIVING-1" })).items, [first.inventory]);
    assert.equal((await store.getInventoryExport()).every((item) => item.isTest === false), true);
    assert.equal((await store.getInventoryExport()).length, 3);
    const projectionCount = await count("inventory_demand_projections");
    await store.receiveInventoryFromPhysicalLabel({ ...request, captureId: randomUUID() });
    assert.equal(await count("inventory_demand_projections"), projectionCount);
  });

  await t.test("a capture identifier cannot cross the test and production boundary", async () => {
    await assert.rejects(store.receiveInventoryFromPhysicalLabel({ ...request, captureId: testCaptureId }),
      (error) => error instanceof store.DemandAppendError && error.code === "conflict");
    await assert.rejects(store.appendTestDemandFromPhysicalLabel({
      captureId: request.captureId, testSessionId: request.receiptSessionId,
      rawValues: request.rawValues, operatorName: "Test operator",
    }), (error) => error instanceof store.DemandAppendError && error.code === "conflict");
    assert.deepEqual((await store.listInventory({})).summary, { containers: 3, units: 42, quantitiesByUnit: { EA: 42 } });
  });

  await t.test("inventory and its receipt evidence survive opening an independent database connection", async () => {
    const reopened = new Database({ sqlitePath: databasePath });
    try {
      const persisted = await reopened.prepare("SELECT quantity, operator_name, captured_at FROM inventory_items WHERE id = ?")
        .bind(first.inventory.id).first();
      assert.equal(persisted.quantity, 24);
      assert.equal(persisted.operator_name, request.operatorName);
      assert.equal(persisted.captured_at, first.inventory.receivedAt);
      const receipt = await reopened.prepare("SELECT inventory_item_id FROM inventory_capture_receipts WHERE capture_id = ?")
        .bind(request.captureId).first();
      assert.equal(receipt.inventory_item_id, first.inventory.id);
    } finally { reopened.close(); }
  });

  await t.test("an audit write failure rolls back the receipt and inventory, allowing a safe retry", async () => {
    const failedRequest = {
      ...request, captureId: randomUUID(), rawValues: ["1SATOMIC-RECEIPT", "PPART-RECEIVING", "2PBLACK", "Q13"],
    };
    const before = (await store.listInventory({})).summary;
    await db.prepare(`CREATE TRIGGER receiving_test_reject_audit
      BEFORE INSERT ON demand_audit_events WHEN NEW.action = 'inventory_received'
      BEGIN SELECT RAISE(ABORT, 'Receiving test: audit unavailable'); END`).run();
    try {
      await assert.rejects(store.receiveInventoryFromPhysicalLabel(failedRequest), /audit unavailable/);
      assert.equal(await db.prepare("SELECT id FROM inventory_items WHERE id = ?").bind(failedRequest.captureId).first(), null);
      assert.equal(await db.prepare("SELECT capture_id FROM inventory_capture_receipts WHERE capture_id = ?").bind(failedRequest.captureId).first(), null);
      assert.deepEqual((await store.listInventory({})).summary, before);
    } finally {
      await db.prepare("DROP TRIGGER receiving_test_reject_audit").run();
    }
    const retried = await store.receiveInventoryFromPhysicalLabel(failedRequest);
    assert.equal(retried.created, true);
    assert.equal(retried.inventory.quantity, 13);
    assert.deepEqual((await store.listInventory({})).summary, {
      containers: before.containers + 1, units: before.units + 13,
      quantitiesByUnit: { ...before.quantitiesByUnit, EA: before.quantitiesByUnit.EA + 13 },
    });
  });
  await t.test("only serials are unique; part, quantity and color can repeat", async () => {
    const receipt = await store.receiveInventoryFromPhysicalLabel({ ...request, captureId: randomUUID(),
      rawValues: ["1SSECOND-SAME-VALUES", ...request.rawValues.slice(1)] });
    assert.equal(receipt.created, true);
    assert.equal(receipt.duplicate, false);
    assert.equal(receipt.inventory.partNumber, first.inventory.partNumber);
    assert.equal(receipt.inventory.quantity, first.inventory.quantity);
    assert.equal(receipt.inventory.partLevel, first.inventory.partLevel);
  });
  await t.test("both color identifiers survive receipt, retry, listing and export", async () => {
    const colorRequest = { ...request, captureId: randomUUID(), rawValues: ["PPART-RECEIVING", "Q24", "CBLACK", "1SCOLOR-RECEIPT"] };
    const receipt = await store.receiveInventoryFromPhysicalLabel(colorRequest);
    assert.equal(receipt.inventory.color, "BLACK");
    assert.equal(receipt.inventory.partLevel, "");
    assert.deepEqual((await store.receiveInventoryFromPhysicalLabel(colorRequest)).inventory, receipt.inventory);
    assert.deepEqual((await store.listInventory({ q: "COLOR-RECEIPT" })).items, [receipt.inventory]);
    assert.equal((await store.getInventoryExport()).find((item) => item.id === receipt.inventory.id).color, "BLACK");
    assert.equal((await store.receiveInventoryFromPhysicalLabel({ ...colorRequest, rawValues: ["PPART-RECEIVING", "Q24", "2PBLACK", "1SCOLOR-RECEIPT"] })).duplicate, true);
    assert.equal((await store.receiveInventoryFromPhysicalLabel({ ...colorRequest, captureId: randomUUID(), rawValues: ["PPART-RECEIVING", "Q24", "2PBLACK", "1SCOLOR-RECEIPT"] })).duplicate, true);
  });

});
