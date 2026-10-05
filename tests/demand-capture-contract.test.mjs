import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("physical-label capture exposes an inventory-first, test-only API", async () => {
  const [route, legacyAlias, component] = await Promise.all([
    source("../app/api/inventory/capture/route.ts"),
    source("../app/api/demand/capture/route.ts"),
    source("../app/load-demand-scanner.tsx"),
  ]);

  assert.match(route, /appendTestDemandFromPhysicalLabel/);
  assert.match(route, /captureId/);
  assert.match(route, /testSessionId/);
  assert.match(route, /projectionStatus === "failed"[\s\S]*\? 202/);
  assert.match(route, /result\.inventoryCreated \? 201 : 200/);
  assert.doesNotMatch(route, /targetLineId|appendDemandFromPhysicalLabel/);
  assert.doesNotMatch(route, /recordScan|recordScanBatch|\/api\/scan/);
  assert.match(legacyAlias, /inventory\/capture\/route/);
  assert.doesNotMatch(legacyAlias, /targetLineId|appendDemandFromPhysicalLabel/);
  assert.match(component, /fetch\("\/api\/inventory\/capture"/);
  assert.match(component, /captureId/);
  assert.match(component, /Inventory first · test demand second/);
  assert.match(component, /Never appended to an existing production load/);
  assert.doesNotMatch(component, /targetLineId|Scan load, checksheet, or PPA Cart ID/);
  assert.doesNotMatch(component, /fetch\("\/api\/scan/);
});

test("inventory commits before the retryable generated-demand projection", async () => {
  const store = await source("../db/cart-store.ts");
  const start = store.indexOf("export async function appendTestDemandFromPhysicalLabel");
  const end = store.indexOf("async function appendTestProjectionDetail", start);
  assert.ok(start >= 0 && end > start);
  const capture = store.slice(start, end);

  assert.match(capture, /parseCaptureId\(input\.captureId\)/);
  assert.match(capture, /buildTestDemandContext\(input\.testSessionId\)/);
  assert.match(capture, /testCapturedImportRow/);
  assert.match(capture, /capturePhysicalInventoryItem/);
  assert.match(capture, /ensureInventoryDemandProjection/);
  assert.match(capture, /appendTestProjectionDetail/);
  assert.match(capture, /appendImportRow/);
  assert.ok(capture.indexOf("capturePhysicalInventoryItem") < capture.indexOf("ensureInventoryDemandProjection"));
  assert.ok(capture.indexOf("capturePhysicalInventoryItem") < capture.indexOf("validatedCapturedImportRow"));
  assert.ok(capture.indexOf("capturePhysicalInventoryItem") < capture.indexOf("appendImportRow"));
  assert.match(capture, /!isGeneratedTestDemand\(existingLine\)/);
  assert.match(capture, /older demand batch/);
  assert.match(capture, /cartBarcode/);
  assert.match(capture, /projectionStatus: "failed"/);
  assert.match(capture, /testProjection/);
  assert.match(capture, /inventory: inventoryResult/);
  assert.match(store, /programId: "TESTSCAN"/);
  assert.match(store, /plant: "TEST"/);
  assert.match(store, /status: CartLine\["status"\] = "pending"/);
});

test("inventory identity, capture receipts, and projection audits are independent", async () => {
  const [schema, store, inventoryMigration, receiptMigration] = await Promise.all([
    source("../db/schema.ts"),
    source("../db/cart-store.ts"),
    source("../drizzle-postgres/0002_late_power_man.sql"),
    source("../drizzle-postgres/0003_curly_liz_osborn.sql"),
  ]);

  assert.match(schema, /pgTable\("inventory_items"/);
  assert.match(schema, /uniqueIndex\("inventory_items_scope_serial_idx"\)\.on\(table\.isTest, table\.supplierId, table\.normalizedSerial\)/);
  assert.match(schema, /pgTable\("inventory_capture_receipts"/);
  assert.match(schema, /captureId: text\("capture_id"\)\.primaryKey\(\)/);
  assert.match(schema, /requestFingerprint: text\("request_fingerprint"\)/);
  assert.match(schema, /pgTable\("inventory_demand_projections"/);
  assert.match(schema, /testSessionId: text\("test_session_id"\)/);
  assert.match(schema, /status: text\("status"\).*pending/);
  assert.match(schema, /completedAt: text\("completed_at"\)/);
  assert.match(schema, /item_session_idx/);
  assert.match(store, /ON CONFLICT DO NOTHING/);
  assert.match(store, /INSERT INTO inventory_capture_receipts/);
  assert.match(store, /inventoryCaptureFingerprint/);
  assert.match(store, /outcome = \?/);
  assert.match(store, /That capture identifier was already used for a different physical label/);
  assert.match(store, /Inventory serial \$\{input\.captured\.values\.aiagSerial\} was already captured with different label values/);
  assert.match(store, /status = 'failed'/);
  assert.match(store, /status = 'completed'/);
  assert.match(store, /recoverInventoryDemandProjection/);
  assert.match(store, /importFieldDiffers\(line, expected, APPEND_CART_LEVEL_FIELDS\)/);
  assert.match(inventoryMigration, /CREATE TABLE "inventory_items"/);
  assert.match(inventoryMigration, /CREATE TABLE "inventory_demand_projections"/);
  assert.match(inventoryMigration, /inventory_demand_projections_item_session_idx/);
  assert.match(receiptMigration, /CREATE TABLE "inventory_capture_receipts"/);
  assert.match(receiptMigration, /inventory_capture_receipts_item_idx/);
});

test("load and handheld surfaces expose the inventory testing utility", async () => {
  const [app, component, styles] = await Promise.all([
    source("../app/cartflow-app.tsx"),
    source("../app/load-demand-scanner.tsx"),
    source("../app/globals.css"),
  ]);

  assert.match(app, /testToolsEnabled/);
  assert.match(app, /Capture test inventory/);
  assert.match(app, /setLoadDemandOpen\(true\)/);
  assert.match(app, /<LoadDemandScanner/);
  assert.match(component, /Start a test inventory session/);
  assert.match(component, /startNewTestLoad/);
  assert.match(component, /destinationReady/);
  assert.match(component, /Save inventory \+ create test demand/);
  assert.match(component, /DEMAND_SCAN_ORDER\.map/);
  assert.match(component, /mode="capture"/);
  assert.match(styles, /\.demand-capture-backdrop/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.demand-capture-backdrop/);
});
