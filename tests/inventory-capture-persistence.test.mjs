import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("an existing-serial scan permanently reserves its capture identifier", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ppa-inventory-receipt-"));
  const databasePath = join(temporaryRoot, "cartflow.sqlite");
  const previousDatabasePath = process.env.CARTFLOW_DATABASE_PATH;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousPostgresUrl = process.env.POSTGRES_URL;
  const previousVercel = process.env.VERCEL;

  process.env.CARTFLOW_DATABASE_PATH = databasePath;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.VERCEL;

  const [{ appendTestDemandFromPhysicalLabel, DemandAppendError }, { getDatabase }] = await Promise.all([
    import("../db/cart-store.ts"),
    import("../db/index.ts"),
  ]);

  t.after(async () => {
    getDatabase().close();
    if (previousDatabasePath === undefined) delete process.env.CARTFLOW_DATABASE_PATH;
    else process.env.CARTFLOW_DATABASE_PATH = previousDatabasePath;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previousPostgresUrl;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const testSessionId = "123e4567-e89b-42d3-a456-426614174000";
  const firstCaptureId = "223e4567-e89b-42d3-a456-426614174000";
  const existingSerialCaptureId = "323e4567-e89b-42d3-a456-426614174000";
  const firstLabel = ["1SSERIAL-RECEIPT-A", "PPART-001", "2PLEVEL-A", "Q4"];

  const first = await appendTestDemandFromPhysicalLabel({
    captureId: firstCaptureId,
    testSessionId,
    rawValues: firstLabel,
    operatorName: "Receipt test",
  });
  assert.equal(first.inventoryCreated, true);

  const existingSerial = await appendTestDemandFromPhysicalLabel({
    captureId: existingSerialCaptureId,
    testSessionId,
    rawValues: firstLabel,
    operatorName: "Receipt test",
  });
  assert.equal(existingSerial.inventoryCreated, false);
  assert.equal(existingSerial.inventory.existingSerial, true);
  assert.equal(existingSerial.inventory.id, first.inventory.id);

  await assert.rejects(
    appendTestDemandFromPhysicalLabel({
      captureId: existingSerialCaptureId,
      testSessionId,
      rawValues: ["1SSERIAL-RECEIPT-B", "PPART-002", "2PLEVEL-B", "Q8"],
      operatorName: "Receipt test",
    }),
    (error) => error instanceof DemandAppendError
      && error.code === "conflict"
      && /capture identifier was already used/.test(error.message),
  );

  const database = getDatabase();
  const inventoryCount = await database.prepare("SELECT COUNT(*) AS count FROM inventory_items").first();
  const receiptCount = await database.prepare("SELECT COUNT(*) AS count FROM inventory_capture_receipts").first();
  const receipt = await database.prepare(`SELECT inventory_item_id, outcome
    FROM inventory_capture_receipts WHERE capture_id = ?`).bind(existingSerialCaptureId).first();

  assert.equal(inventoryCount?.count, 1);
  assert.equal(receiptCount?.count, 2);
  assert.equal(receipt?.inventory_item_id, first.inventory.id);
  assert.equal(receipt?.outcome, "existing_serial");

  const concurrentSessionId = "423e4567-e89b-42d3-a456-426614174000";
  const concurrentCaptureId = "523e4567-e89b-42d3-a456-426614174000";
  const concurrentLabel = ["1SSERIAL-CONCURRENT", "PPART-003", "2PLEVEL-C", "Q12"];
  const concurrentRequest = () => appendTestDemandFromPhysicalLabel({
    captureId: concurrentCaptureId,
    testSessionId: concurrentSessionId,
    rawValues: concurrentLabel,
    operatorName: "Receipt test",
  });
  const concurrentResults = await Promise.all([concurrentRequest(), concurrentRequest()]);

  assert.deepEqual(
    concurrentResults.map((result) => result.projectionStatus).sort(),
    ["created", "existing"],
  );
  assert.equal(concurrentResults.filter((result) => result.inventoryCreated).length, 1);
  assert.equal(concurrentResults[0].lineId, concurrentResults[1].lineId);
});
