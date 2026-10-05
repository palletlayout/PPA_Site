import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("uses normalized Postgres demand headers and details while preserving flattened application reads", async () => {
  const [schema, store, migration] = await Promise.all([
    source("../db/schema.ts"),
    source("../db/cart-store.ts"),
    source("../drizzle-postgres/0000_new_butterfly.sql"),
  ]);

  assert.match(schema, /pgTable\("demand_headers"/);
  assert.match(schema, /pgTable\("demand_details"/);
  assert.match(schema, /headerId: text\("header_id"\)/);
  assert.match(schema, /programId: text\("program_id"\).*ODG303R/);
  assert.match(schema, /containerTotal: integer\("container_total"\)/);
  assert.match(schema, /deliveryLocation: text\("delivery_location"\).*default\(""\)/);
  assert.match(migration, /CREATE TABLE "demand_headers"/);
  assert.match(migration, /CREATE TABLE "demand_details"/);
  assert.match(migration, /"delivery_location" text DEFAULT '' NOT NULL/);
  assert.match(store, /FROM demand_details d\s+JOIN demand_headers h ON h\.id = d\.header_id/);
  assert.match(store, /d\.id, d\.header_id, h\.batch_id/);
  assert.match(store, /backfillLegacyData/);
  assert.match(store, /prepareHeaderInsert/);
  assert.match(store, /prepareDetailInsert/);
  assert.match(store, /d\.delivery_location AS detail_delivery_location/);
  assert.match(store, /detailDeliveryLocation: String\(row\.detail_delivery_location/);
});

test("repairs only blank barcode payloads in deployed demo data", async () => {
  const store = await source("../db/cart-store.ts");

  assert.match(store, /CASE WHEN TRIM\(master_barcode\) = ''/);
  assert.match(store, /CASE WHEN TRIM\(movement_barcode\) = ''/);
  assert.match(store, /'DEMO-TR301-CT1001'/);
  assert.match(store, /'DEMO-TR303-CT1003'/);
  assert.match(store, /'DEMO-TR208-CT0194'/);
  assert.match(store, /'Z101AATE30977101'/);
});

test("keeps bounded import history and exposes only the active batch to the dashboard", async () => {
  const [store, activation] = await Promise.all([
    source("../db/cart-store.ts"), source("../db/import-activation.ts"),
  ]);

  assert.match(store, /IMPORT_RETENTION_LIMIT = 37/);
  assert.match(store, /IMPORT_RETENTION_MS = 56 \* 60 \* 60 \* 1000/);
  assert.match(store, /activateReconciledImport\(db/);
  assert.match(activation, /UPDATE import_batches SET is_active = 0 WHERE is_active = 1/);
  assert.match(activation, /INSERT INTO demand_import_rows/);
  assert.match(store, /WHERE is_active = 1 ORDER BY imported_at DESC/);
  assert.match(store, /unmatched_events AS \([\s\S]*matched = 0[\s\S]*LIMIT 5000/);
  assert.match(store, /recent_events AS \([\s\S]*LIMIT 12/);
  assert.match(store, /SELECT \* FROM unmatched_events\s+UNION\s+SELECT \* FROM recent_events/);
  assert.match(store, /await pruneImportHistory\(db/);
  assert.doesNotMatch(store, /DELETE FROM scan_events"\),\s+db\.prepare\("DELETE FROM cart_locks"\),\s+db\.prepare\("DELETE FROM cart_lines"\)/);
});

test("movement PDFs select every picklist in exactly one trusted load or train", async () => {
  const [store, route] = await Promise.all([
    source("../db/cart-store.ts"),
    source("../app/api/picklists/pdf/route.ts"),
  ]);
  const start = store.indexOf("async function readPdfLines");
  const end = store.indexOf("export async function getSectionPdfLines", start);
  assert.ok(start >= 0 && end > start);
  const movementQuery = store.slice(start, end);
  assert.match(movementQuery, /await db\.readBatch/);
  assert.match(movementQuery, /peer\.batch_id=source\.batch_id AND peer\.plant=source\.plant AND peer\.area_type=source\.area_type/);
  assert.match(movementQuery, /WHEN peer\.area_type='offsite' THEN peer\.load_number ELSE peer\.train_number/);
  assert.match(movementQuery, /pdfSourceFilter\(db, lineId, true\)/);
  assert.match(movementQuery, /ORDER BY h\.plant,h\.load_number,h\.train_number,h\.picklist_number/);
  assert.match(route, /scope === "movement"[\s\S]*getMovementPdfLines\(lineId\)/);
  assert.match(route, /generatePicklistPdf\(lines, \{ scope \}\)/);
});

test("supports pre-processing demand maintenance and scanned-demand CSV export", async () => {
  const [store, demandRoute, exportRoute] = await Promise.all([
    source("../db/cart-store.ts"),
    source("../app/api/demand/route.ts"),
    source("../app/api/scans/export/route.ts"),
  ]);

  assert.match(store, /export async function updateDemandLine/);
  assert.match(store, /export async function deleteDemandLine/);
  assert.match(store, /Packed, active, or short demand cannot be edited/);
  assert.match(store, /Packed, active, or short demand cannot be deleted/);
  assert.match(store, /const headerId = String\(lockedRow\.header_id\)/);
  assert.match(store, /await acquireDemandMutationLock\(initial, "edited"\)/);
  assert.match(store, /await acquireDemandMutationLock\(line, "deleted"\)/);
  assert.match(store, /finally \{\s*await releaseDemandMutationLock\(mutationLock\)/);
  assert.match(store, /DETAIL_VERIFICATION_FIELDS = new Set\(\["partNumber", "color", "quantity", "unitOfMeasure", "preferredSupplierId"\]\)/);
  assert.match(store, /UPDATE scan_events SET invalidated_at = \?\s+WHERE line_id IN \(SELECT id FROM demand_details WHERE header_id = \?\)/);
  assert.match(store, /scanEventsCleared: clearsCartScans \|\| clearsLineScans/);
  const updateSection = store.slice(
    store.indexOf("export async function updateDemandLine"),
    store.indexOf("export async function deleteDemandLine"),
  );
  assert.ok(updateSection.indexOf("await acquireDemandMutationLock") < updateSection.indexOf("const cleaned"));
  assert.match(demandRoute, /export async function PATCH/);
  assert.match(demandRoute, /export async function DELETE/);
  assert.match(exportRoute, /export async function GET/);
  assert.match(exportRoute, /text\/csv; charset=utf-8/);
  assert.match(exportRoute, /ppa-scans-\$\{scope\}/);
  assert.match(store, /LEFT JOIN scan_events e ON e\.line_id = d\.id/);
});

test("supports a confirmed full reset without automatic demo seeding", async () => {
  const [store, dataRoute, app, database] = await Promise.all([
    source("../db/cart-store.ts"),
    source("../app/api/data/route.ts"),
    source("../app/cartflow-app.tsx"),
    source("../db/index.ts"),
  ]);

  assert.match(store, /export async function clearAllData/);
  for (const table of [
    "inventory_demand_projections",
    "inventory_capture_receipts",
    "inventory_items",
    "load_confirmations",
    "scan_events",
    "cart_locks",
    "demand_details",
    "demand_headers",
    "cart_lines",
    "integration_imports",
    "import_batches",
  ]) {
    assert.ok(store.includes(`"${table}"`));
  }
  assert.doesNotMatch(store, /function seedDemoData/);
  assert.doesNotMatch(store, /await seedDemoData\(db\)/);
  assert.match(dataRoute, /DELETE_ALL_CARTFLOW_DATA/);
  assert.match(dataRoute, /export async function DELETE/);
  assert.match(app, /Clear all data/);
  assert.match(app, /permanently removes every import batch/);
  assert.match(database, /process\.env\.DATABASE_URL \|\| process\.env\.POSTGRES_URL/);
  assert.match(database, /@neondatabase\/serverless/);
  assert.doesNotMatch(database, /cloudflare:workers|D1Database/);
});

test("enforces one live cart per picklist across scanner sessions", async () => {
  const [schema, store, migration] = await Promise.all([
    source("../db/schema.ts"),
    source("../db/cart-store.ts"),
    source("../drizzle-postgres/0000_new_butterfly.sql"),
  ]);

  assert.match(schema, /picklistKey: text\("picklist_key"\)/);
  assert.match(schema, /uniqueIndex\("cart_locks_picklist_key_idx"\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "cart_locks_picklist_key_idx"/);
  assert.match(store, /SELECT \* FROM cart_locks WHERE picklist_key = \?/);
  assert.match(store, /picklistLock\.sessionId !== input\.sessionId/);
  assert.match(store, /SELECT h\.id, h\.cart_key FROM demand_headers h\s+JOIN import_batches b ON b\.id = h\.batch_id/);
  assert.match(store, /reason: "cart_missing" as const/);
  assert.match(store, /reason: "picklist_mismatch" as const/);
  assert.match(store, /WHERE EXISTS \(\s+SELECT 1 FROM demand_headers h\s+JOIN import_batches b/);
  assert.match(store, /AND NOT EXISTS \(\s+SELECT 1 FROM cart_locks WHERE picklist_key = \?/);
  assert.match(store, /DELETE FROM cart_locks"\)\.run\(\);\s+await db\.prepare\("ALTER TABLE cart_locks ADD COLUMN picklist_key/);
  assert.match(store, /DELETE FROM cart_locks WHERE picklist_key = ''/);
  assert.match(store, /const picklistLockRow = await db\.prepare\("SELECT \* FROM cart_locks WHERE picklist_key = \?"\)/);
  assert.match(store, /const conflictingRow = lock \? null : await db\.prepare\("SELECT \* FROM cart_locks WHERE picklist_key = \?"\)/);
});

test("persists cart identity and immutable final destination confirmation", async () => {
  const [schema, store, migration, route, exportRoute] = await Promise.all([
    source("../db/schema.ts"),
    source("../db/cart-store.ts"),
    source("../drizzle-postgres/0000_new_butterfly.sql"),
    source("../app/api/loading/confirm/route.ts"),
    source("../app/api/scans/export/route.ts"),
  ]);
  assert.match(schema, /cartBarcode: text\("cart_barcode"\)/);
  assert.match(schema, /loadedAt: text\("loaded_at"\)/);
  assert.match(schema, /pgTable\("load_confirmations"/);
  assert.match(schema, /isTest: integer\("is_test"\)\.notNull\(\)\.default\(0\)/);
  assert.match(schema, /uniqueIndex\("load_confirmations_header_idx"\)/);
  assert.match(migration, /"cart_barcode" text DEFAULT '' NOT NULL/);
  assert.match(migration, /"is_test" integer DEFAULT 0 NOT NULL/);
  assert.match(migration, /CREATE UNIQUE INDEX "demand_headers_cart_barcode_idx"/);
  assert.match(store, /export async function confirmCartLoading/);
  assert.match(store, /status <> 'verified'/);
  assert.match(store, /INSERT INTO load_confirmations/);
  assert.match(store, /ON CONFLICT DO NOTHING/);
  assert.match(store, /h\.loaded_at = \?/);
  assert.match(store, /lc\.is_test AS loading_is_test/);
  assert.match(store, /UPDATE demand_headers SET loaded_at/);
  assert.match(route, /result\.reason === "invalid"/);
  assert.match(exportRoute, /\["cart_barcode", "PPA Cart ID"\]/);
  assert.match(exportRoute, /\["loaded_at", "Loaded At"\]/);
  assert.match(exportRoute, /\["loading_is_test", "Loading Test Record"\]/);
});
