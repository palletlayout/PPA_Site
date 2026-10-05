import { getDatabase, type Database, type PreparedStatement, type DatabaseResult, DatabaseConflictError } from "./index.ts";
import { MAX_IMPORT_ROWS, parseImportWholeNumber, validateImportRows } from "../lib/import-validation.ts";
import {
  cleanScannerPayload,
  normalizeScanValue,
  type DemandScanField,
} from "../lib/scan-values.ts";
import { createRetryableInitializer } from "../lib/retryable-initializer.ts";
import {
  buildTestDemandContext,
  DemandCaptureValidationError,
  nextCapturedSequence,
  parseCaptureId,
  parseDemandCaptureValues,
} from "../lib/demand-capture.ts";
import {
  cartBarcodeForHeaderId,
  expectedMovementNumber,
  movementBarcodeMatches,
  normalizeIdentityBarcode,
  picklistBarcodeMatches,
  picklistIdentityKey,
} from "../lib/cart-identity.ts";
import type { AppState, CartLine, CartLock, DemandLinePatch, ImportRow, ScanEvent } from "../lib/types.ts";
import type { InventoryItem, InventoryListResult, InventoryReceiveResult, InventoryProvenance, InventoryAcquisitionMethod } from "../lib/inventory-types.ts";
import { normalizeUnitOfMeasure, parseQuantity, quantityToScaled, QUANTITY_SCALE } from "../lib/quantity.ts";
import { initializeFulfillmentLedger, readFulfillmentSettings, fulfillmentSettingsFromRow, linesWithAllocations, comparePackingLines } from "./fulfillment-ledger.ts";
import { validateFulfillmentSettings, type FulfillmentSettings } from "../lib/fulfillment-settings.ts";
import { checkPackingDemand, packingDemandDifferences } from "../lib/packing-demand.ts";
import { fulfillmentFingerprint, legacyFulfillmentFingerprints, resolveFulfillmentSerial, type SerialFormat } from "../lib/fulfillment-request.ts";
import { prepareWriteGuards } from "./write-guards.ts";
import { initializeReadinessSchema } from "./readiness-schema.ts";

import { activateReconciledImport, type ReconciledImportInput } from "./import-activation.ts";

import { availablePicklistGuard, backfillPicklistIdentity, hasPicklistConflict, uniquePicklistSql, PICKLIST_CONFLICT_MESSAGE } from "./picklist-identity.ts";

type DatabaseRecord = Record<string, string | number | null>;
type StoredCartLock = Omit<CartLock, "isOwned" | "isOwnedByOperator"> & { sessionId: string; operatorId: string };

const IMPORT_RETENTION_LIMIT = 37;
const IMPORT_RETENTION_MS = 56 * 60 * 60 * 1000;
// Version 17 adds stable ownership and receipt provenance.
export const DATABASE_SCHEMA_VERSION = 17;

const DETAIL_LOT_METADATA_COLUMNS = {
  containerSequence: "container_sequence",
  fromModel: "from_model", fromType: "from_type", fromOption: "from_option",
  fromColor: "from_color", fromInteriorColor: "from_interior_color", fromUnits: "from_units",
  toModel: "to_model", toType: "to_type", toOption: "to_option",
  toColor: "to_color", toInteriorColor: "to_interior_color", toUnits: "to_units",
} as const;

const FLATTENED_LINE_SELECT = `SELECT
  d.id, d.header_id, h.batch_id, h.plant, h.zone, h.area_type, h.ship_category,
  h.load_number, h.train_number, h.picklist_number, h.cart_number, h.cart_id, h.pallet_id,
  h.cart_barcode, h.loaded_at, h.loaded_by, h.dispatched_at, h.dispatched_by, h.short_closed_at, h.option_text,
  h.production_quantity, h.cart_max_quantity, h.interior_color, h.exterior_color, h.vehicle_color,
  h.program_id, h.total_carts, h.pymtc, h.checksheet_number,
  d.sequence, d.pack_sequence, d.fulfilled_at, d.fulfilled_by, d.part_number, d.description, d.color, d.quantity, d.aiag_serial,
  d.unit_of_measure, d.source_line_id, d.source_scope, d.preferred_supplier_id,
  h.master_barcode, h.movement_barcode, h.case_code, h.outgoing_serial,
  h.cart_sequence_number, h.from_lot, h.to_lot, h.model, h.cart_type,
  h.scheduled_dispatch_date, h.scheduled_dispatch_time, h.delivery_location,
  d.delivery_location AS detail_delivery_location,
  d.container_position, d.container_type, d.picking_location, d.mcid, d.container_total,
  ${Object.values(DETAIL_LOT_METADATA_COLUMNS).map((column) => `d.${column}`).join(", ")},
  h.chassis_number, h.order_number, h.batch_number, h.loading_sequence,
  d.status, d.verified_at, d.fulfilled_quantity, d.inventory_item_id, h.revision AS header_revision, d.revision AS detail_revision
FROM demand_details d
JOIN demand_headers h ON h.id = d.header_id`;

function getStoreDatabase() {
  return getDatabase();
}

function cartKeyForLine(line: Pick<CartLine | ImportRow,
  "plant" | "areaType" | "loadNumber" | "trainNumber" | "picklistNumber" | "cartNumber" | "cartId"
>) {
  const movement = line.areaType === "offsite" ? line.loadNumber : line.trainNumber;
  return [line.plant, line.areaType, movement, line.picklistNumber, line.cartNumber, line.cartId].join("::");
}

function picklistKeyFromCartKey(cartKey: string) {
  return cartKey.split("::").slice(0, 4).join("::");
}

function optionalWholeNumber(value: unknown, label: string, rowNumber: number) {
  if (value === undefined || value === null || String(value).trim() === "") return 0;
  const parsed = parseImportWholeNumber(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Row ${rowNumber} ${label} must be a non-negative whole number.`);
  }
  return parsed;
}

function withSupplementalFields(validated: ImportRow, source: ImportRow, rowNumber: number): ImportRow {
  return {
    ...validated,
    programId: String(source.programId || "ODG303R").trim() || "ODG303R",
    totalCarts: optionalWholeNumber(source.totalCarts, "Total Carts", rowNumber),
    pymtc: String(source.pymtc || "").trim(),
    checksheetNumber: String(source.checksheetNumber || "").trim(),
    containerTotal: optionalWholeNumber(source.containerTotal, "Container Total", rowNumber),
  };
}

function supplementalHeaderSignature(row: ImportRow) {
  return [row.programId || "ODG303R", row.totalCarts || 0, row.pymtc || "", row.checksheetNumber || ""].join("\u0000");
}

const APPEND_CART_LEVEL_FIELDS: (keyof ImportRow)[] = [
  "productionQuantity", "cartMaxQuantity", "interiorColor", "exteriorColor", "vehicleColor",
  "palletId", "zone", "shipCategory", "programId", "totalCarts", "pymtc", "checksheetNumber",
  "masterBarcode", "movementBarcode", "caseCode", "outgoingSerial", "cartSequenceNumber",
  "fromLot", "toLot", "model", "cartType", "scheduledDispatchDate", "scheduledDispatchTime",
  "deliveryLocation", "chassisNumber", "orderNumber", "batchNumber", "loadingSequence",
];

const APPEND_LOAD_LEVEL_FIELDS: (keyof ImportRow)[] = [
  "chassisNumber", "orderNumber", "batchNumber", "loadingSequence", "movementBarcode",
];

function isGeneratedTestDemand(row: Pick<CartLine | ImportRow, "plant" | "programId" | "pymtc">) {
  return row.plant === "TEST"
    && row.programId === "TESTSCAN"
    && String(row.pymtc || "").startsWith("TEST:");
}

function importFieldDiffers(
  current: CartLine | ImportRow,
  incoming: ImportRow,
  fields: readonly (keyof ImportRow)[],
) {
  return fields.some((field) => String(current[field] ?? "") !== String(incoming[field] ?? ""));
}

function prepareHeaderInsert(db: Database, batchId: string, headerId: string, row: ImportRow, orIgnore = false) {
  return db.prepare(`INSERT INTO demand_headers (
    id, batch_id, cart_key, picklist_identity, plant, zone, area_type, ship_category, load_number, train_number,
    picklist_number, cart_number, cart_id, pallet_id, cart_barcode, loaded_at, loaded_by,
    program_id, total_carts, pymtc,
    checksheet_number, master_barcode, movement_barcode,
    case_code, outgoing_serial, cart_sequence_number, from_lot, to_lot, model, cart_type,
    scheduled_dispatch_date, scheduled_dispatch_time, delivery_location, chassis_number,
    order_number, batch_number, loading_sequence, production_quantity, cart_max_quantity, interior_color, exterior_color, vehicle_color, option_text
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${orIgnore ? " ON CONFLICT DO NOTHING" : ""}`).bind(
    headerId, batchId, cartKeyForLine(row), orIgnore ? "" : picklistIdentityKey(row), row.plant, row.zone, row.areaType, row.shipCategory,
    row.loadNumber, row.trainNumber, row.picklistNumber, row.cartNumber, row.cartId, row.palletId,
    cartBarcodeForHeaderId(headerId), null, "",
    row.programId || "ODG303R", Number.isInteger(row.totalCarts) ? row.totalCarts : 0,
    row.pymtc || "", row.checksheetNumber || "",
    row.masterBarcode || "", row.movementBarcode || "", row.caseCode || "", row.outgoingSerial || "",
    row.cartSequenceNumber || "", row.fromLot || "", row.toLot || "", row.model || "", row.cartType || "",
    row.scheduledDispatchDate || "", row.scheduledDispatchTime || "", row.deliveryLocation || "",
    row.chassisNumber || "", row.orderNumber || "", row.batchNumber || "", row.loadingSequence || "",
    row.productionQuantity ?? null, row.cartMaxQuantity ?? null, row.interiorColor || "", row.exteriorColor || "",
    row.vehicleColor || "", row.option || "",
  );
}

function prepareDetailInsert(
  db: Database,
  headerId: string,
  detailId: string,
  row: ImportRow,
  status: CartLine["status"] = "pending",
  verifiedAt: string | null = null,
  orIgnore = false,
) {
  return db.prepare(`INSERT INTO demand_details (
    id, header_id, sequence, part_number, description, color, quantity, aiag_serial,
    delivery_location, container_position, container_type, picking_location, mcid,
    container_total, status, verified_at, unit_of_measure, source_line_id, source_scope, preferred_supplier_id, pack_sequence,
    ${Object.values(DETAIL_LOT_METADATA_COLUMNS).join(", ")}
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${Object.keys(DETAIL_LOT_METADATA_COLUMNS).map(() => "?").join(", ")})${orIgnore ? " ON CONFLICT DO NOTHING" : ""}`).bind(
    detailId, headerId, row.sequence, row.partNumber, row.description || "", row.color, row.quantity,
    status === "verified" ? row.aiagSerial : "", row.detailDeliveryLocation || "", row.containerPosition || "",
    row.containerType || "", row.pickingLocation || "",
    row.mcid || "", Number.isInteger(row.containerTotal) ? row.containerTotal : 0, status, verifiedAt,
    normalizeUnitOfMeasure(row.unitOfMeasure), row.sourceLineId || "", row.sourceScope || "", row.preferredSupplierId || "", row.packSequence || "",
    ...Object.keys(DETAIL_LOT_METADATA_COLUMNS).map((field) => row[field as keyof typeof DETAIL_LOT_METADATA_COLUMNS] || ""),
  );
}

async function runStatementChunks(db: Database, statements: PreparedStatement[], size = 75) {
  for (let index = 0; index < statements.length; index += size) {
    await db.batch(statements.slice(index, index + size));
  }
}

async function databaseColumns(db: Database, tableName: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(tableName)) {
    throw new Error("Invalid database table name.");
  }
  if (db.dialect === "sqlite") {
    const result = await db.prepare(`PRAGMA table_info("${tableName}")`)
      .all<{ name: string }>();
    return new Set(result.results.map((column) => column.name));
  }
  const result = await db.prepare(`SELECT column_name AS name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ?`)
    .bind(tableName).all<{ name: string }>();
  return new Set(result.results.map((column) => column.name));
}

async function initializeDatabase() {
  const db = getStoreDatabase();
  await db.batch([db.prepare(`CREATE TABLE IF NOT EXISTS cartflow_schema (
    name TEXT PRIMARY KEY,
    version INTEGER NOT NULL
  )`)]);
  const schemaState = await db.prepare("SELECT version FROM cartflow_schema WHERE name = 'primary'")
    .first<{ version: number }>();
  if (Number(schemaState?.version || 0) > DATABASE_SCHEMA_VERSION) throw new Error("The database schema requires a newer application version.");
  if (Number(schemaState?.version || 0) === DATABASE_SCHEMA_VERSION) return db;
  if (Number(schemaState?.version || 0) === 16) {
    // This release is additive. Do not rerun historical business-data backfills
    // during a rolling upgrade of an already-current installation.
    await initializeReadinessSchema(db);
    await db.prepare("UPDATE cartflow_schema SET version=? WHERE name='primary' AND version=16")
      .bind(DATABASE_SCHEMA_VERSION).run();
    return db;
  }

  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS cartflow_write_guards (
      id TEXT PRIMARY KEY,
      valid INTEGER NOT NULL CONSTRAINT cartflow_write_guard_valid CHECK (valid = 1)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS demand_audit_events (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      header_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      actor_id TEXT NOT NULL DEFAULT '',
      actor_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS integration_imports (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      idempotency_key TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      file_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      batch_id TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS cart_lines (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      plant TEXT NOT NULL,
      zone TEXT NOT NULL,
      area_type TEXT NOT NULL,
      ship_category TEXT NOT NULL,
      load_number TEXT NOT NULL,
      train_number TEXT NOT NULL,
      picklist_number TEXT NOT NULL,
      cart_number TEXT NOT NULL,
      cart_id TEXT NOT NULL,
      pallet_id TEXT NOT NULL,
      cart_barcode TEXT NOT NULL DEFAULT '',
      loaded_at TEXT,
      loaded_by TEXT NOT NULL DEFAULT '',
      program_id TEXT NOT NULL DEFAULT 'ODG303R',
      total_carts INTEGER NOT NULL DEFAULT 0,
      pymtc TEXT NOT NULL DEFAULT '',
      checksheet_number TEXT NOT NULL DEFAULT '',
      sequence TEXT NOT NULL,
      part_number TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      aiag_serial TEXT NOT NULL,
      master_barcode TEXT NOT NULL DEFAULT '',
      movement_barcode TEXT NOT NULL DEFAULT '',
      case_code TEXT NOT NULL DEFAULT '',
      outgoing_serial TEXT NOT NULL DEFAULT '',
      cart_sequence_number TEXT NOT NULL DEFAULT '',
      from_lot TEXT NOT NULL DEFAULT '',
      to_lot TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      cart_type TEXT NOT NULL DEFAULT '',
      scheduled_dispatch_date TEXT NOT NULL DEFAULT '',
      scheduled_dispatch_time TEXT NOT NULL DEFAULT '',
      delivery_location TEXT NOT NULL DEFAULT '',
      container_position TEXT NOT NULL DEFAULT '',
      container_type TEXT NOT NULL DEFAULT '',
      picking_location TEXT NOT NULL DEFAULT '',
      mcid TEXT NOT NULL DEFAULT '',
      chassis_number TEXT NOT NULL DEFAULT '',
      order_number TEXT NOT NULL DEFAULT '',
      batch_number TEXT NOT NULL DEFAULT '',
      loading_sequence TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      verified_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS demand_headers (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      cart_key TEXT NOT NULL,
      plant TEXT NOT NULL,
      zone TEXT NOT NULL,
      area_type TEXT NOT NULL,
      ship_category TEXT NOT NULL,
      load_number TEXT NOT NULL,
      train_number TEXT NOT NULL,
      picklist_number TEXT NOT NULL,
      cart_number TEXT NOT NULL,
      cart_id TEXT NOT NULL,
      pallet_id TEXT NOT NULL,
      master_barcode TEXT NOT NULL DEFAULT '',
      movement_barcode TEXT NOT NULL DEFAULT '',
      case_code TEXT NOT NULL DEFAULT '',
      outgoing_serial TEXT NOT NULL DEFAULT '',
      cart_sequence_number TEXT NOT NULL DEFAULT '',
      from_lot TEXT NOT NULL DEFAULT '',
      to_lot TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      cart_type TEXT NOT NULL DEFAULT '',
      scheduled_dispatch_date TEXT NOT NULL DEFAULT '',
      scheduled_dispatch_time TEXT NOT NULL DEFAULT '',
      delivery_location TEXT NOT NULL DEFAULT '',
      chassis_number TEXT NOT NULL DEFAULT '',
      order_number TEXT NOT NULL DEFAULT '',
      batch_number TEXT NOT NULL DEFAULT '',
      loading_sequence TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS demand_details (
      id TEXT PRIMARY KEY,
      header_id TEXT NOT NULL REFERENCES demand_headers(id) ON DELETE CASCADE,
      sequence TEXT NOT NULL,
      part_number TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      aiag_serial TEXT NOT NULL DEFAULT '',
      delivery_location TEXT NOT NULL DEFAULT '',
      container_position TEXT NOT NULL DEFAULT '',
      container_type TEXT NOT NULL DEFAULT '',
      picking_location TEXT NOT NULL DEFAULT '',
      mcid TEXT NOT NULL DEFAULT '',
      container_total INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      verified_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      capture_session_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'physical_label',
      aiag_serial TEXT NOT NULL,
      normalized_serial TEXT NOT NULL,
      part_number TEXT NOT NULL,
      part_level TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      raw_aiag_serial TEXT NOT NULL DEFAULT '',
      raw_part_number TEXT NOT NULL DEFAULT '',
      raw_part_level TEXT NOT NULL DEFAULT '',
      raw_quantity TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'available',
      is_test INTEGER NOT NULL DEFAULT 0,
      operator_name TEXT NOT NULL,
      captured_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS inventory_capture_receipts (
      capture_id TEXT PRIMARY KEY,
      capture_session_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      is_test INTEGER NOT NULL DEFAULT 1,
      inventory_item_id TEXT REFERENCES inventory_items(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS inventory_demand_projections (
      id TEXT PRIMARY KEY,
      inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      test_session_id TEXT NOT NULL,
      demand_detail_id TEXT REFERENCES demand_details(id) ON DELETE SET NULL,
      projection_type TEXT NOT NULL DEFAULT 'test_demand',
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      completed_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS cart_locks (
      cart_key TEXT PRIMARY KEY,
      picklist_key TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      operator_name TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      inventory_available INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS scan_events (
      id TEXT PRIMARY KEY,
      line_id TEXT NOT NULL,
      cart_key TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      field TEXT NOT NULL,
      scanned_value TEXT NOT NULL,
      matched INTEGER NOT NULL,
      is_test INTEGER NOT NULL DEFAULT 0,
      operator_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS load_confirmations (
      id TEXT PRIMARY KEY,
      header_id TEXT NOT NULL REFERENCES demand_headers(id) ON DELETE CASCADE,
      cart_barcode TEXT NOT NULL,
      movement_type TEXT NOT NULL,
      movement_number TEXT NOT NULL,
      scanned_movement TEXT NOT NULL,
      is_test INTEGER NOT NULL DEFAULT 0,
      operator_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS scan_events_created_idx ON scan_events (created_at DESC)"),
  ]);

  const auditColumns = await databaseColumns(db, "demand_audit_events");
  const auditUpgrades = [
    ["actor_id", "ALTER TABLE demand_audit_events ADD COLUMN actor_id TEXT NOT NULL DEFAULT ''"],
    ["actor_name", "ALTER TABLE demand_audit_events ADD COLUMN actor_name TEXT NOT NULL DEFAULT ''"],
  ].filter(([column]) => !auditColumns.has(column));
  if (auditUpgrades.length) await db.batch(auditUpgrades.map(([, sql]) => db.prepare(sql)));
  const columns = await databaseColumns(db, "cart_lines");
  const upgrades = [
    ["area_type", "ALTER TABLE cart_lines ADD COLUMN area_type TEXT NOT NULL DEFAULT 'onsite'"],
    ["picklist_number", "ALTER TABLE cart_lines ADD COLUMN picklist_number TEXT NOT NULL DEFAULT 'UNASSIGNED'"],
    ["cart_id", "ALTER TABLE cart_lines ADD COLUMN cart_id TEXT NOT NULL DEFAULT 'UNASSIGNED'"],
    ["pallet_id", "ALTER TABLE cart_lines ADD COLUMN pallet_id TEXT NOT NULL DEFAULT 'UNASSIGNED'"],
    ["description", "ALTER TABLE cart_lines ADD COLUMN description TEXT NOT NULL DEFAULT ''"],
    ["master_barcode", "ALTER TABLE cart_lines ADD COLUMN master_barcode TEXT NOT NULL DEFAULT ''"],
    ["movement_barcode", "ALTER TABLE cart_lines ADD COLUMN movement_barcode TEXT NOT NULL DEFAULT ''"],
    ["case_code", "ALTER TABLE cart_lines ADD COLUMN case_code TEXT NOT NULL DEFAULT ''"],
    ["outgoing_serial", "ALTER TABLE cart_lines ADD COLUMN outgoing_serial TEXT NOT NULL DEFAULT ''"],
    ["cart_sequence_number", "ALTER TABLE cart_lines ADD COLUMN cart_sequence_number TEXT NOT NULL DEFAULT ''"],
    ["from_lot", "ALTER TABLE cart_lines ADD COLUMN from_lot TEXT NOT NULL DEFAULT ''"],
    ["to_lot", "ALTER TABLE cart_lines ADD COLUMN to_lot TEXT NOT NULL DEFAULT ''"],
    ["model", "ALTER TABLE cart_lines ADD COLUMN model TEXT NOT NULL DEFAULT ''"],
    ["cart_type", "ALTER TABLE cart_lines ADD COLUMN cart_type TEXT NOT NULL DEFAULT ''"],
    ["scheduled_dispatch_date", "ALTER TABLE cart_lines ADD COLUMN scheduled_dispatch_date TEXT NOT NULL DEFAULT ''"],
    ["scheduled_dispatch_time", "ALTER TABLE cart_lines ADD COLUMN scheduled_dispatch_time TEXT NOT NULL DEFAULT ''"],
    ["delivery_location", "ALTER TABLE cart_lines ADD COLUMN delivery_location TEXT NOT NULL DEFAULT ''"],
    ["container_position", "ALTER TABLE cart_lines ADD COLUMN container_position TEXT NOT NULL DEFAULT ''"],
    ["container_type", "ALTER TABLE cart_lines ADD COLUMN container_type TEXT NOT NULL DEFAULT ''"],
    ["picking_location", "ALTER TABLE cart_lines ADD COLUMN picking_location TEXT NOT NULL DEFAULT ''"],
    ["mcid", "ALTER TABLE cart_lines ADD COLUMN mcid TEXT NOT NULL DEFAULT ''"],
    ["chassis_number", "ALTER TABLE cart_lines ADD COLUMN chassis_number TEXT NOT NULL DEFAULT ''"],
    ["order_number", "ALTER TABLE cart_lines ADD COLUMN order_number TEXT NOT NULL DEFAULT ''"],
    ["batch_number", "ALTER TABLE cart_lines ADD COLUMN batch_number TEXT NOT NULL DEFAULT ''"],
    ["loading_sequence", "ALTER TABLE cart_lines ADD COLUMN loading_sequence TEXT NOT NULL DEFAULT ''"],
  ].filter(([column]) => !columns.has(column));
  if (upgrades.length) {
    await db.batch(upgrades.map(([, sql]) => db.prepare(sql)));
  }
  const importColumns = await databaseColumns(db, "import_batches");
  if (!importColumns.has("is_active")) {
    await db.prepare("ALTER TABLE import_batches ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0").run();
  }
  const headerColumns = await databaseColumns(db, "demand_headers");
  const headerUpgrades = [
    ["picklist_identity", "ALTER TABLE demand_headers ADD COLUMN picklist_identity TEXT NOT NULL DEFAULT ''"],
    ["dispatched_at", "ALTER TABLE demand_headers ADD COLUMN dispatched_at TEXT"],
    ["dispatched_by", "ALTER TABLE demand_headers ADD COLUMN dispatched_by TEXT NOT NULL DEFAULT ''"],
    ["production_quantity", "ALTER TABLE demand_headers ADD COLUMN production_quantity NUMERIC(20,6)"],
    ["cart_max_quantity", "ALTER TABLE demand_headers ADD COLUMN cart_max_quantity NUMERIC(20,6)"],
    ["interior_color", "ALTER TABLE demand_headers ADD COLUMN interior_color TEXT NOT NULL DEFAULT ''"],
    ["exterior_color", "ALTER TABLE demand_headers ADD COLUMN exterior_color TEXT NOT NULL DEFAULT ''"],
    ["vehicle_color", "ALTER TABLE demand_headers ADD COLUMN vehicle_color TEXT NOT NULL DEFAULT ''"],
    ["revision", "ALTER TABLE demand_headers ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"],
    ["program_id", "ALTER TABLE demand_headers ADD COLUMN program_id TEXT NOT NULL DEFAULT 'ODG303R'"],
    ["total_carts", "ALTER TABLE demand_headers ADD COLUMN total_carts INTEGER NOT NULL DEFAULT 0"],
    ["pymtc", "ALTER TABLE demand_headers ADD COLUMN pymtc TEXT NOT NULL DEFAULT ''"],
    ["checksheet_number", "ALTER TABLE demand_headers ADD COLUMN checksheet_number TEXT NOT NULL DEFAULT ''"],
    ["cart_barcode", "ALTER TABLE demand_headers ADD COLUMN cart_barcode TEXT NOT NULL DEFAULT ''"],
    ["loaded_at", "ALTER TABLE demand_headers ADD COLUMN loaded_at TEXT"],
    ["loaded_by", "ALTER TABLE demand_headers ADD COLUMN loaded_by TEXT NOT NULL DEFAULT ''"],
  ].filter(([column]) => !headerColumns.has(column));
  if (headerUpgrades.length) await db.batch(headerUpgrades.map(([, sql]) => db.prepare(sql)));
  const blankCartBarcodes = await db.prepare("SELECT id FROM demand_headers WHERE TRIM(cart_barcode) = ''")
    .all<{ id: string }>();
  if (blankCartBarcodes.results.length) {
    await runStatementChunks(db, blankCartBarcodes.results.map((header) =>
      db.prepare("UPDATE demand_headers SET cart_barcode = ? WHERE id = ? AND TRIM(cart_barcode) = ''")
        .bind(cartBarcodeForHeaderId(header.id), header.id)
    ));
  }
  const detailColumns = await databaseColumns(db, "demand_details");
  const detailUpgrades = [
    ...Object.values(DETAIL_LOT_METADATA_COLUMNS).map((column) => [column, `ALTER TABLE demand_details ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`]),
    ["unit_of_measure", "ALTER TABLE demand_details ADD COLUMN unit_of_measure TEXT NOT NULL DEFAULT 'EA'"],
    ["source_line_id", "ALTER TABLE demand_details ADD COLUMN source_line_id TEXT NOT NULL DEFAULT ''"],
    ["source_scope", "ALTER TABLE demand_details ADD COLUMN source_scope TEXT NOT NULL DEFAULT ''"],
    ["preferred_supplier_id", "ALTER TABLE demand_details ADD COLUMN preferred_supplier_id TEXT NOT NULL DEFAULT ''"],
    ["revision", "ALTER TABLE demand_details ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"],
    ["legacy_expected_serial", "ALTER TABLE demand_details ADD COLUMN legacy_expected_serial TEXT NOT NULL DEFAULT ''"],
    ["fulfilled_quantity", "ALTER TABLE demand_details ADD COLUMN fulfilled_quantity INTEGER NOT NULL DEFAULT 0"],
    ["inventory_item_id", "ALTER TABLE demand_details ADD COLUMN inventory_item_id TEXT REFERENCES inventory_items(id)"],
    ["delivery_location", "ALTER TABLE demand_details ADD COLUMN delivery_location TEXT NOT NULL DEFAULT ''"],
    ["container_total", "ALTER TABLE demand_details ADD COLUMN container_total INTEGER NOT NULL DEFAULT 0"],
  ].filter(([column]) => !detailColumns.has(column));
  if (detailUpgrades.length) await db.batch(detailUpgrades.map(([, sql]) => db.prepare(sql)));
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS demand_details_source_identity_idx
    ON demand_details (source_scope, source_line_id) WHERE source_line_id <> ''`).run();
  const inventoryColumns = await databaseColumns(db, "inventory_items");
  const inventoryUpgrades = [
    ["pallet_id", "ALTER TABLE inventory_items ADD COLUMN pallet_id TEXT NOT NULL DEFAULT ''"],
    ["supplier_id", "ALTER TABLE inventory_items ADD COLUMN supplier_id TEXT NOT NULL DEFAULT ''"],
    ["unit_of_measure", "ALTER TABLE inventory_items ADD COLUMN unit_of_measure TEXT NOT NULL DEFAULT 'EA'"],
    ["consumed_quantity", "ALTER TABLE inventory_items ADD COLUMN consumed_quantity INTEGER NOT NULL DEFAULT 0"],
    ["consumed_at", "ALTER TABLE inventory_items ADD COLUMN consumed_at TEXT"],
    ["weight", "ALTER TABLE inventory_items ADD COLUMN weight DOUBLE PRECISION"],
    ["unit_cost", "ALTER TABLE inventory_items ADD COLUMN unit_cost DOUBLE PRECISION"],
    ["receive_date", "ALTER TABLE inventory_items ADD COLUMN receive_date TEXT NOT NULL DEFAULT ''"],
  ].filter(([column]) => !inventoryColumns.has(column));
  if (inventoryUpgrades.length) await db.batch(inventoryUpgrades.map(([, sql]) => db.prepare(sql)));
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS demand_import_rows (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      row_json TEXT NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS demand_import_rows_batch_idx ON demand_import_rows (batch_id)"),
    db.prepare("DROP INDEX IF EXISTS inventory_items_scope_serial_idx"),
    db.prepare("CREATE UNIQUE INDEX inventory_items_scope_serial_idx ON inventory_items (is_test, supplier_id, normalized_serial)"),
  ]);
  if (db.dialect === "postgres") {
    await db.batch([
      db.prepare("ALTER TABLE demand_details ALTER COLUMN quantity TYPE NUMERIC(20,6)"),
      db.prepare("ALTER TABLE demand_details ALTER COLUMN fulfilled_quantity TYPE NUMERIC(20,6)"),
      db.prepare("ALTER TABLE demand_details ALTER COLUMN aiag_serial SET DEFAULT ''"),
      db.prepare("ALTER TABLE inventory_items ALTER COLUMN quantity TYPE NUMERIC(20,6)"),
      db.prepare("ALTER TABLE inventory_items ALTER COLUMN consumed_quantity TYPE NUMERIC(20,6)"),
    ]);
  }
  const lockColumns = await databaseColumns(db, "cart_locks");
  if (!lockColumns.has("lease_id")) {
    await db.prepare("ALTER TABLE cart_locks ADD COLUMN lease_id TEXT NOT NULL DEFAULT ''").run();
  }
  if (!lockColumns.has("inventory_available")) {
    await db.prepare("ALTER TABLE cart_locks ADD COLUMN inventory_available INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!lockColumns.has("picklist_key")) {
    await db.prepare("DELETE FROM cart_locks").run();
    await db.prepare("ALTER TABLE cart_locks ADD COLUMN picklist_key TEXT NOT NULL DEFAULT ''").run();
  }
  await db.prepare("DELETE FROM cart_locks WHERE picklist_key = ''").run();
  const eventColumns = await databaseColumns(db, "scan_events");
  if (!eventColumns.has("session_id")) {
    await db.prepare("ALTER TABLE scan_events ADD COLUMN session_id TEXT NOT NULL DEFAULT ''").run();
  }
  if (!eventColumns.has("is_test")) {
    await db.prepare("ALTER TABLE scan_events ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!eventColumns.has("operator_id")) {
    await db.prepare("ALTER TABLE scan_events ADD COLUMN operator_id TEXT NOT NULL DEFAULT ''").run();
  }
  if (!eventColumns.has("lease_id")) {
    await db.prepare("ALTER TABLE scan_events ADD COLUMN lease_id TEXT NOT NULL DEFAULT ''").run();
  }
  if (!eventColumns.has("invalidated_at")) {
    await db.prepare("ALTER TABLE scan_events ADD COLUMN invalidated_at TEXT").run();
  }
  const confirmationColumns = await databaseColumns(db, "load_confirmations");
  if (!confirmationColumns.has("operator_id")) {
    await db.prepare("ALTER TABLE load_confirmations ADD COLUMN operator_id TEXT NOT NULL DEFAULT ''").run();
  }
  if (!confirmationColumns.has("is_test")) {
    await db.prepare("ALTER TABLE load_confirmations ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0").run();
  }
  const projectionColumns = await databaseColumns(db, "inventory_demand_projections");
  const projectionUpgrades = [
    ["test_session_id", "ALTER TABLE inventory_demand_projections ADD COLUMN test_session_id TEXT NOT NULL DEFAULT ''"],
    ["status", "ALTER TABLE inventory_demand_projections ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'"],
    ["error_message", "ALTER TABLE inventory_demand_projections ADD COLUMN error_message TEXT NOT NULL DEFAULT ''"],
    ["completed_at", "ALTER TABLE inventory_demand_projections ADD COLUMN completed_at TEXT"],
  ].filter(([column]) => !projectionColumns.has(column));
  if (projectionUpgrades.length) await db.batch(projectionUpgrades.map(([, sql]) => db.prepare(sql)));
  await db.prepare(`UPDATE inventory_demand_projections
    SET test_session_id = COALESCE((
      SELECT capture_session_id FROM inventory_items
      WHERE inventory_items.id = inventory_demand_projections.inventory_item_id
    ), '')
    WHERE test_session_id = ''`).run();
  await db.prepare(`UPDATE inventory_demand_projections
    SET status = 'completed', error_message = '', completed_at = COALESCE(completed_at, created_at)
    WHERE demand_detail_id IS NOT NULL AND status <> 'completed'`).run();
  const receiptColumns = await databaseColumns(db, "inventory_capture_receipts");
  if (!receiptColumns.has("is_test")) {
    await db.prepare("ALTER TABLE inventory_capture_receipts ADD COLUMN is_test INTEGER NOT NULL DEFAULT 1").run();
  }
  await db.prepare(`UPDATE inventory_capture_receipts SET is_test = COALESCE((
    SELECT is_test FROM inventory_items WHERE id = inventory_item_id
  ), is_test)`).run();
  const inventoryWithoutReceipts = await db.prepare(`SELECT i.id, i.capture_session_id,
    i.aiag_serial, i.part_number, i.part_level, i.quantity, i.captured_at, i.is_test
    FROM inventory_items i
    LEFT JOIN inventory_capture_receipts r ON r.capture_id = i.id
    WHERE r.capture_id IS NULL`).all<{
      id: string;
      capture_session_id: string;
      aiag_serial: string;
      part_number: string;
      part_level: string;
      quantity: number;
      captured_at: string;
      is_test: number;
    }>();
  if (inventoryWithoutReceipts.results.length) {
    await runStatementChunks(db, inventoryWithoutReceipts.results.map((item) =>
      db.prepare(`INSERT INTO inventory_capture_receipts (
        capture_id, capture_session_id, request_fingerprint, inventory_item_id, outcome, created_at, is_test
      ) VALUES (?, ?, ?, ?, 'created', ?, ?)
      ON CONFLICT(capture_id) DO NOTHING`).bind(
        item.id,
        item.capture_session_id,
        inventoryCaptureFingerprint(item.capture_session_id, {
          aiagSerial: item.aiag_serial,
          partNumber: item.part_number,
          partLevel: item.part_level,
          quantity: item.quantity,
        }),
        item.id,
        item.captured_at,
        item.is_test,
      )
    ));
  }
  const activeBatch = await db.prepare("SELECT id FROM import_batches WHERE is_active = 1 ORDER BY imported_at DESC LIMIT 1")
    .first<{ id: string }>();
  if (!activeBatch) {
    await db.prepare(`UPDATE import_batches SET is_active = 1
      WHERE id = (SELECT b.id FROM import_batches b
        WHERE NOT EXISTS (SELECT 1 FROM integration_imports r WHERE r.batch_id = b.id AND r.status = 'processing')
          AND b.row_count = (SELECT COUNT(*) FROM demand_details d JOIN demand_headers h ON h.id = d.header_id WHERE h.batch_id = b.id)
        ORDER BY b.imported_at DESC, b.id DESC LIMIT 1)`).run();
  }
  await db.batch([
    db.prepare("CREATE INDEX IF NOT EXISTS scan_events_evidence_idx ON scan_events (line_id, session_id, is_test, invalidated_at, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS demand_audit_events_batch_idx ON demand_audit_events (batch_id, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS cart_lines_work_idx ON cart_lines (plant, area_type, picklist_number, cart_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS import_batches_imported_idx ON import_batches (imported_at DESC)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS import_batches_one_active_idx ON import_batches (is_active) WHERE is_active = 1"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS demand_headers_batch_cart_idx ON demand_headers (batch_id, cart_key)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS demand_headers_cart_barcode_idx ON demand_headers (cart_barcode)"),
    db.prepare("CREATE INDEX IF NOT EXISTS demand_headers_work_idx ON demand_headers (batch_id, plant, area_type, picklist_number, cart_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS demand_details_inventory_item_lookup_idx ON demand_details (inventory_item_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS demand_details_header_status_idx ON demand_details (header_id, status, sequence)"),
    db.prepare("DROP INDEX IF EXISTS inventory_items_serial_idx"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_scope_serial_idx ON inventory_items (is_test, supplier_id, normalized_serial)"),
    db.prepare("CREATE INDEX IF NOT EXISTS inventory_items_lookup_idx ON inventory_items (status, part_number, part_level)"),
    db.prepare("CREATE INDEX IF NOT EXISTS inventory_capture_receipts_item_idx ON inventory_capture_receipts (inventory_item_id, created_at)"),
    db.prepare("DROP INDEX IF EXISTS inventory_demand_projections_item_idx"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS inventory_demand_projections_item_session_idx ON inventory_demand_projections (inventory_item_id, test_session_id)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS inventory_demand_projections_detail_idx ON inventory_demand_projections (demand_detail_id)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS cart_locks_picklist_key_idx ON cart_locks (picklist_key) WHERE picklist_key <> ''"),
    db.prepare("DROP INDEX IF EXISTS integration_imports_source_content_idx"),
    db.prepare("CREATE INDEX IF NOT EXISTS integration_imports_source_content_idx ON integration_imports (source, content_hash)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS integration_imports_source_key_idx ON integration_imports (source, idempotency_key) WHERE idempotency_key <> ''"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS integration_imports_one_processing_idx ON integration_imports (status) WHERE status = 'processing'"),
    db.prepare("CREATE INDEX IF NOT EXISTS integration_imports_status_expiry_idx ON integration_imports (status, expires_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS load_confirmations_header_idx ON load_confirmations (header_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS load_confirmations_created_idx ON load_confirmations (created_at DESC)"),
  ]);
  await db.prepare(`UPDATE cart_lines SET
    area_type = CASE WHEN ship_category = 'Service' THEN 'offsite' ELSE 'onsite' END,
    picklist_number = 'PL-' || REPLACE(cart_number, 'CT-', '2100'),
    cart_id = 'CART-' || REPLACE(cart_number, 'CT-', '') || '-A',
    pallet_id = 'PAL-' || REPLACE(cart_number, 'CT-', '')
    WHERE picklist_number = 'UNASSIGNED'
      AND batch_id IN (SELECT id FROM import_batches WHERE file_name = 'demo-pick-list.xlsx')`).run();
  const knownDemoLabels = [
    ["CT-1001", "010", "7793030A B010M4", "Sensor assy, front crash", "11-M4", 12, "02145000-Z2000918"],
    ["CT-1001", "020", "1971064A A010M4", "Intercooler comp", "12-M4", 30, "59524202-22694949"],
    ["CT-1001", "030", "7793042A B010M4", "", "10-M4", 12, "02145000-Z2000919"],
    ["CT-1002", "010", "6841207A A020M4", "Service bracket kit", "08-M4", 8, "02145000-Z2000920"],
    ["CT-1002", "020", "6841211A A020M4", "Mounting bracket kit", "09-M4", 16, "02145000-Z2000921"],
    ["CT-1003", "010", "1971064A A010M4", "Intercooler component", "12-M4", 30, "59524202-22694949"],
    ["CT-1003", "020", "1971088A A010M4", "Cooling module assembly", "13-M4", 30, "59524202-22694950"],
    ["CT-0187", "010", "7793030A B010M4", "Sensor assy, front crash", "11-M4", 12, "02145000-Z2000918"],
    ["CT-0187", "020", "1971064A A010M4", "Intercooler comp", "12-M4", 30, "59524202-22694949"],
    ["CT-0191", "010", "6841207A A020M4", "Service bracket kit", "08-M4", 8, "02145000-Z2000920"],
    ["CT-0194", "010", "1971064A A010M4", "Cooling module assembly", "12-M4", 30, "59524202-22694949"],
    ["CT-0194", "020", "1971088A A010M4", "Intercooler component", "13-M4", 30, "59524202-22694950"],
  ] as const;
  await db.batch(knownDemoLabels.map(([cartNumber, sequence, partNumber, description, color, quantity, serial]) =>
    db.prepare(`UPDATE cart_lines SET
      part_number = ?, description = ?, color = ?, quantity = ?, aiag_serial = ?
      WHERE cart_number = ? AND sequence = ?
        AND batch_id IN (
          SELECT id FROM import_batches
          WHERE file_name IN ('cartflow-demo-pick-list.csv', 'demo-pick-list.xlsx')
        )`).bind(partNumber, description, color, quantity, serial, cartNumber, sequence)
  ));
  await db.batch([
    db.prepare(`UPDATE cart_lines SET
      master_barcode = CASE WHEN TRIM(master_barcode) = '' THEN CASE train_number
        WHEN 'TR-204' THEN 'Z101AATE30977101'
        WHEN 'TR-208' THEN 'DEMO-TR208-CT0194'
        WHEN 'TR-301' THEN 'DEMO-TR301-CT1001'
        WHEN 'TR-303' THEN 'DEMO-TR303-CT1003'
        ELSE master_barcode END ELSE master_barcode END,
      movement_barcode = CASE WHEN TRIM(movement_barcode) = '' THEN CASE train_number
        WHEN 'TR-204' THEN 'AE1TE309771X5AA'
        WHEN 'TR-208' THEN 'DEMO-TR208-C02'
        WHEN 'TR-301' THEN 'DEMO-TR301-A12'
        WHEN 'TR-303' THEN 'DEMO-TR303-C02'
        ELSE movement_barcode END ELSE movement_barcode END
      WHERE area_type = 'onsite' AND (master_barcode = '' OR movement_barcode = '')
        AND ((train_number = 'TR-204' AND cart_number = 'CT-0187' AND picklist_number = 'PL-21006789')
          OR (train_number = 'TR-208' AND cart_number = 'CT-0194' AND picklist_number = 'PL-21006803')
          OR (train_number = 'TR-301' AND cart_number = 'CT-1001' AND picklist_number = 'PL-21006789')
          OR (train_number = 'TR-303' AND cart_number = 'CT-1003' AND picklist_number = 'PL-21006803'))
        AND batch_id IN (SELECT id FROM import_batches
          WHERE file_name IN ('cartflow-demo-pick-list.csv', 'demo-pick-list.xlsx'))`),
    db.prepare(`UPDATE demand_headers SET
      master_barcode = CASE WHEN TRIM(master_barcode) = '' THEN CASE train_number
        WHEN 'TR-204' THEN 'Z101AATE30977101'
        WHEN 'TR-208' THEN 'DEMO-TR208-CT0194'
        WHEN 'TR-301' THEN 'DEMO-TR301-CT1001'
        WHEN 'TR-303' THEN 'DEMO-TR303-CT1003'
        ELSE master_barcode END ELSE master_barcode END,
      movement_barcode = CASE WHEN TRIM(movement_barcode) = '' THEN CASE train_number
        WHEN 'TR-204' THEN 'AE1TE309771X5AA'
        WHEN 'TR-208' THEN 'DEMO-TR208-C02'
        WHEN 'TR-301' THEN 'DEMO-TR301-A12'
        WHEN 'TR-303' THEN 'DEMO-TR303-C02'
        ELSE movement_barcode END ELSE movement_barcode END
      WHERE area_type = 'onsite' AND (master_barcode = '' OR movement_barcode = '')
        AND ((train_number = 'TR-204' AND cart_number = 'CT-0187' AND picklist_number = 'PL-21006789')
          OR (train_number = 'TR-208' AND cart_number = 'CT-0194' AND picklist_number = 'PL-21006803')
          OR (train_number = 'TR-301' AND cart_number = 'CT-1001' AND picklist_number = 'PL-21006789')
          OR (train_number = 'TR-303' AND cart_number = 'CT-1003' AND picklist_number = 'PL-21006803'))
        AND batch_id IN (SELECT id FROM import_batches
          WHERE file_name IN ('cartflow-demo-pick-list.csv', 'demo-pick-list.xlsx'))`),
  ]);
  await initializeFulfillmentLedger(db);
  await backfillLegacyData(db);
  if (Number(schemaState?.version || 0) < 9) {
    // Previous serials described expected labels; they were not stock allocations.
    // Keep that source data and historical evidence, and reopen active, unloaded work.
    await db.batch([
      db.prepare(`INSERT INTO demand_audit_events
        (id, batch_id, header_id, line_id, action, before_json, after_json, actor_id, actor_name, created_at)
        SELECT 'fulfillment-v9-' || d.id, h.batch_id, h.id, d.id, 'fulfillment_migration',
          '{"status":"verified"}', '{"status":"pending","reason":"Inventory fulfillment required"}',
          'schema-migration', 'PPA migration', ?
        FROM demand_details d JOIN demand_headers h ON h.id = d.header_id
        JOIN import_batches b ON b.id = h.batch_id
        WHERE d.inventory_item_id IS NULL AND d.status = 'verified' AND h.loaded_at IS NULL AND b.is_active = 1
        ON CONFLICT DO NOTHING`).bind(new Date().toISOString()),
      db.prepare(`UPDATE demand_details SET legacy_expected_serial = aiag_serial, aiag_serial = ''
        WHERE inventory_item_id IS NULL AND legacy_expected_serial = ''`),
      db.prepare(`UPDATE demand_details SET status = 'pending', verified_at = NULL, revision = revision + 1
        WHERE inventory_item_id IS NULL AND status = 'verified' AND header_id IN
          (SELECT h.id FROM demand_headers h JOIN import_batches b ON b.id = h.batch_id
           WHERE h.loaded_at IS NULL AND b.is_active = 1)`),
    ]);
  }
  await initializeFulfillmentLedger(db);
  await initializeReadinessSchema(db);
  await backfillPicklistIdentity(db);
  await pruneImportHistory(db, new Date());
  await db.prepare(`INSERT INTO cartflow_schema (name, version) VALUES ('primary', ?)
    ON CONFLICT(name) DO UPDATE SET version = excluded.version`)
    .bind(DATABASE_SCHEMA_VERSION).run();
  return db;
}

const initializeDatabaseOnce = createRetryableInitializer(initializeDatabase);

export function ensureDatabase() {
  return initializeDatabaseOnce();
}

async function backfillLegacyData(db: Database) {
  const legacyResult = await db.prepare(`SELECT cl.* FROM cart_lines cl
    LEFT JOIN demand_details d ON d.id = cl.id
    WHERE d.id IS NULL
    ORDER BY cl.batch_id, cl.cart_number, cl.sequence`).all<DatabaseRecord>();
  if (!legacyResult.results.length) return;

  const existingHeaders = await db.prepare("SELECT id, batch_id, cart_key FROM demand_headers")
    .all<{ id: string; batch_id: string; cart_key: string }>();
  const headerIds = new Map(existingHeaders.results.map((header) => [
    `${header.batch_id}::${header.cart_key}`,
    header.id,
  ]));
  const headerStatements: PreparedStatement[] = [];
  const detailStatements: PreparedStatement[] = [];

  for (const storedRow of legacyResult.results) {
    const line = lineFromRow(storedRow);
    const row: ImportRow = { ...line };
    const key = `${line.batchId}::${cartKeyForLine(row)}`;
    let headerId = headerIds.get(key);
    if (!headerId) {
      headerId = `legacy-header:${line.id}`;
      headerIds.set(key, headerId);
      headerStatements.push(prepareHeaderInsert(db, line.batchId, headerId, row, true));
    }
    detailStatements.push(prepareDetailInsert(
      db,
      headerId,
      line.id,
      row,
      line.status,
      line.verifiedAt,
      true,
    ));
    detailStatements.push(db.prepare(`UPDATE demand_details SET legacy_expected_serial = ?
      WHERE id = ? AND legacy_expected_serial = '' AND inventory_item_id IS NULL`)
      .bind(line.aiagSerial, line.id));
  }

  await runStatementChunks(db, headerStatements);
  await runStatementChunks(db, detailStatements);
}

async function pruneImportHistory(db: Database, now: Date) {
  const batches = await db.prepare(`SELECT id, imported_at, is_active FROM import_batches
    ORDER BY imported_at DESC, id DESC`).all<{ id: string; imported_at: string; is_active: number }>();
  const cutoff = now.getTime() - IMPORT_RETENTION_MS;
  const obsolete = batches.results.filter((batch, index) =>
    batch.is_active !== 1 && (index >= IMPORT_RETENTION_LIMIT || Date.parse(batch.imported_at) < cutoff)
  );

  for (const batch of obsolete) {
    // Retention applies only to unused snapshots. Scans, confirmed loads,
    // maintenance history, and capture projections must remain reconstructable.
    // The guard is evaluated inside the same serialized transaction as deletion.
    const condition = db.prepare(`EXISTS (
      SELECT 1 FROM import_batches b WHERE b.id = ? AND b.is_active = 0
    ) AND NOT EXISTS (
      SELECT 1 FROM integration_imports WHERE batch_id = ? AND status = 'processing'
    ) AND NOT EXISTS (
      SELECT 1 FROM scan_events e JOIN demand_details d ON d.id = e.line_id
      JOIN demand_headers h ON h.id = d.header_id WHERE h.batch_id = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM load_confirmations lc JOIN demand_headers h ON h.id = lc.header_id
      WHERE h.batch_id = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM demand_audit_events WHERE batch_id = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM inventory_demand_projections p JOIN demand_details d ON d.id = p.demand_detail_id
      JOIN demand_headers h ON h.id = d.header_id WHERE h.batch_id = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM demand_details d JOIN demand_headers h ON h.id = d.header_id
      WHERE h.batch_id = ? AND (d.status <> 'pending' OR EXISTS (SELECT 1 FROM fulfillment_allocations a WHERE a.demand_detail_id=d.id))
    )`).bind(batch.id, batch.id, batch.id, batch.id, batch.id, batch.id, batch.id);
    try {
      await db.guardedBatch([
        db.prepare("DELETE FROM integration_imports WHERE batch_id = ? AND idempotency_key = ''").bind(batch.id),
        db.prepare("DELETE FROM cart_lines WHERE batch_id = ?").bind(batch.id),
        db.prepare("DELETE FROM import_batches WHERE id = ? AND is_active = 0").bind(batch.id),
      ], condition);
    } catch (error) {
      if (!(error instanceof DatabaseConflictError)) throw error;
    }
  }
}

function lineFromRow(row: DatabaseRecord): CartLine {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    plant: String(row.plant),
    zone: String(row.zone),
    areaType: row.area_type === "offsite" ? "offsite" : "onsite",
    shipCategory: String(row.ship_category),
    loadNumber: String(row.load_number),
    trainNumber: String(row.train_number),
    picklistNumber: String(row.picklist_number),
    cartNumber: String(row.cart_number),
    cartId: String(row.cart_id),
    palletId: String(row.pallet_id),
    cartBarcode: String(row.cart_barcode || ""),
    loadedAt: row.loaded_at ? String(row.loaded_at) : null,
    loadedBy: String(row.loaded_by || ""),
    dispatchedAt: row.dispatched_at ? String(row.dispatched_at) : null,
    dispatchedBy: String(row.dispatched_by || ""),
    productionQuantity: row.production_quantity == null ? undefined : Number(row.production_quantity),
    cartMaxQuantity: row.cart_max_quantity == null ? undefined : Number(row.cart_max_quantity),
    interiorColor: String(row.interior_color || ""),
    exteriorColor: String(row.exterior_color || ""),
    vehicleColor: String(row.vehicle_color || ""),
    programId: String(row.program_id || "ODG303R"),
    totalCarts: Number(row.total_carts || 0),
    pymtc: String(row.pymtc || ""),
    checksheetNumber: String(row.checksheet_number || ""),
    sequence: String(row.sequence),
    packSequence: String(row.pack_sequence || ""),
    ...Object.fromEntries(Object.entries(DETAIL_LOT_METADATA_COLUMNS).map(([field, column]) => [field, String(row[column] || "")])),
    option: String(row.option_text || ""),
    shortClosedAt: row.short_closed_at ? String(row.short_closed_at) : null,
    fulfilledAt: row.fulfilled_at ? String(row.fulfilled_at) : null,
    fulfilledBy: String(row.fulfilled_by || ""),
    remainingQuantity: Math.max(0, Number((Number(row.quantity) - Number(row.fulfilled_quantity || 0)).toFixed(6))),
    partNumber: String(row.part_number),
    description: String(row.description || ""),
    color: String(row.color),
    quantity: Number(row.quantity),
    unitOfMeasure: String(row.unit_of_measure || "EA"),
    sourceLineId: String(row.source_line_id || ""),
    sourceScope: String(row.source_scope || ""),
    preferredSupplierId: String(row.preferred_supplier_id || ""),
    aiagSerial: String(row.aiag_serial || ""),
    fulfilledQuantity: Number(row.fulfilled_quantity || 0),
    inventoryItemId: row.inventory_item_id ? String(row.inventory_item_id) : null,
    masterBarcode: String(row.master_barcode || ""),
    movementBarcode: String(row.movement_barcode || ""),
    caseCode: String(row.case_code || ""),
    outgoingSerial: String(row.outgoing_serial || ""),
    cartSequenceNumber: String(row.cart_sequence_number || ""),
    fromLot: String(row.from_lot || ""),
    toLot: String(row.to_lot || ""),
    model: String(row.model || ""),
    cartType: String(row.cart_type || ""),
    scheduledDispatchDate: String(row.scheduled_dispatch_date || ""),
    scheduledDispatchTime: String(row.scheduled_dispatch_time || ""),
    deliveryLocation: String(row.delivery_location || ""),
    detailDeliveryLocation: String(row.detail_delivery_location || ""),
    containerPosition: String(row.container_position || ""),
    containerType: String(row.container_type || ""),
    pickingLocation: String(row.picking_location || ""),
    mcid: String(row.mcid || ""),
    containerTotal: Number(row.container_total || 0),
    chassisNumber: String(row.chassis_number || ""),
    orderNumber: String(row.order_number || ""),
    batchNumber: String(row.batch_number || ""),
    loadingSequence: String(row.loading_sequence || ""),
    status: row.status === "verified" ? "verified" : row.status === "active" ? "active" : row.status === "short" ? "short" : "pending",
    verifiedAt: row.verified_at ? String(row.verified_at) : null,
  };
}

function lockFromRow(row: DatabaseRecord): StoredCartLock {
  return {
    cartKey: String(row.cart_key),
    picklistKey: String(row.picklist_key || picklistKeyFromCartKey(String(row.cart_key))),
    sessionId: String(row.session_id),
    operatorId: String(row.operator_id || ""),
    operatorName: String(row.operator_name),
    acquiredAt: String(row.acquired_at),
    expiresAt: String(row.expires_at),
  };
}

function lockForClient(lock: StoredCartLock, sessionId: string, operatorId = ""): CartLock {
  return {
    cartKey: lock.cartKey,
    picklistKey: lock.picklistKey,
    operatorName: lock.operatorName,
    acquiredAt: lock.acquiredAt,
    expiresAt: lock.expiresAt,
    isOwned: Boolean(sessionId) && lock.sessionId === sessionId,
    isOwnedByOperator: Boolean(operatorId) && lock.operatorId === operatorId,
  };
}

function eventFromRow(row: DatabaseRecord): ScanEvent {
  return {
    id: String(row.id),
    lineId: String(row.line_id),
    cartKey: String(row.cart_key),
    field: String(row.field),
    scannedValue: String(row.scanned_value),
    matched: Number(row.matched),
    isTest: Number(row.is_test || 0),
    operatorName: String(row.operator_name),
    createdAt: String(row.created_at),
  };
}

const DATA_TABLES = [
  "fulfillment_allocations",
  "demand_audit_events",
  "inventory_demand_projections",
  "inventory_capture_receipts",
  "load_confirmations",
  "scan_events",
  "cart_locks",
  "demand_details",
  "inventory_items",
  "demand_headers",
  "cart_lines",
  "integration_imports",
  "demand_import_rows",
  "import_batches",
] as const;

export async function clearAllData(actor?: { id: string; name: string }) {
  const db = await ensureDatabase();
  const auditId=crypto.randomUUID();
  const countResults = await db.batch([
    ...DATA_TABLES.map((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`)),
    // Deliberately outside DATA_TABLES: even a local reset retains its actor and
    // exact pre-deletion table counts in the same atomic transaction.
    db.prepare(`INSERT INTO maintenance_audit_events(id,action,actor_id,actor_name,created_at,detail)
      SELECT ?, 'local_data_reset', ?, ?, ?, ${db.dialect==="postgres" ? "json_build_object" : "json_object"}(
        ${DATA_TABLES.map((table)=>`'${table}',(SELECT COUNT(*) FROM ${table})`).join(",")})${db.dialect==="postgres" ? "::text" : ""}`)
      .bind(auditId,actor?.id || "local-maintenance",actor?.name || "Local maintenance",new Date().toISOString()),
    ...DATA_TABLES.map((table) => db.prepare(`DELETE FROM ${table}`)),
  ]);

  const deletedByTable = Object.fromEntries(DATA_TABLES.map((table, index) => [
    table,
    Number((countResults[index].results[0] as DatabaseRecord | undefined)?.count ?? 0),
  ]));
  return {
    deleted: Object.values(deletedByTable).reduce((total, count) => total + count, 0),
    deletedByTable,
  };
}

export async function getAppState(sessionId = "", operatorId = ""): Promise<AppState> {
  const db = await ensureDatabase();
  const now = new Date().toISOString();
  const activeBatch = "SELECT id FROM import_batches WHERE is_active = 1 ORDER BY imported_at DESC, id DESC LIMIT 1";
  const [imports, settingsResult, linesResult, locksResult, eventsResult, allocations] = await db.readBatch([
    db.prepare(`SELECT id, file_name, row_count, imported_at FROM import_batches
      WHERE is_active = 1 ORDER BY imported_at DESC, id DESC LIMIT 1`),
    db.prepare("SELECT packing_mode, inventory_mode, part_attribute FROM fulfillment_settings WHERE id='primary'"),
    db.prepare(`${FLATTENED_LINE_SELECT}
      WHERE h.batch_id = (${activeBatch})
      ORDER BY h.load_number, h.train_number, h.cart_number, d.sequence`),
    db.prepare(`SELECT * FROM cart_locks
      WHERE expires_at > ? AND cart_key IN (SELECT cart_key FROM demand_headers WHERE batch_id = (${activeBatch}))
      ORDER BY acquired_at DESC`).bind(now),
    db.prepare(`WITH active_events AS (
        SELECT e.* FROM scan_events e
        JOIN demand_details d ON d.id = e.line_id
        JOIN demand_headers h ON h.id = d.header_id
        WHERE h.batch_id = (${activeBatch}) AND e.invalidated_at IS NULL
      ), unmatched_events AS (
        SELECT * FROM active_events WHERE matched = 0 ORDER BY created_at DESC LIMIT 5000
      ), recent_events AS (
        SELECT * FROM active_events ORDER BY created_at DESC LIMIT 12
      )
      SELECT * FROM unmatched_events
      UNION
      SELECT * FROM recent_events
      ORDER BY created_at DESC`),
    db.prepare(`SELECT a.* FROM fulfillment_allocations a JOIN demand_details d ON d.id=a.demand_detail_id
      JOIN demand_headers h ON h.id=d.header_id WHERE h.batch_id=(${activeBatch}) AND a.reversed_at IS NULL ORDER BY a.packed_at,a.id`),
  ]);
  const lastImportRow = imports.results[0];
  return {
    settings: fulfillmentSettingsFromRow(settingsResult.results[0]),
    lines: linesWithAllocations((linesResult.results as DatabaseRecord[]).map(lineFromRow), allocations.results),
    locks: (locksResult.results as DatabaseRecord[]).map((row) => lockForClient(lockFromRow(row), sessionId, operatorId)),
    events: (eventsResult.results as DatabaseRecord[]).map(eventFromRow),
    lastImport: lastImportRow ? {
      fileName: String(lastImportRow.file_name),
      rowCount: Number(lastImportRow.row_count),
      importedAt: String(lastImportRow.imported_at),
    } : null,
  };
}

/** Rows, allocation evidence and identity conflicts share the same snapshot. */
async function readPdfLines(db: Database, filter: PreparedStatement): Promise<CartLine[]> {
  const [lines, allocations, conflicts] = await db.readBatch([
    db.prepare(`${FLATTENED_LINE_SELECT} WHERE ${filter.query}
      ORDER BY h.plant,h.load_number,h.train_number,h.picklist_number,h.cart_sequence_number,h.cart_number,h.cart_id,d.sequence,d.part_number`).bind(...filter.values),
    db.prepare(`SELECT a.* FROM fulfillment_allocations a JOIN demand_details d ON d.id=a.demand_detail_id
      JOIN demand_headers h ON h.id=d.header_id WHERE ${filter.query} AND a.reversed_at IS NULL ORDER BY a.packed_at,a.id`).bind(...filter.values),
    db.prepare(`SELECT h.id FROM demand_headers h WHERE ${filter.query} AND NOT (${uniquePicklistSql()}) LIMIT 1`).bind(...filter.values),
  ]);
  if (conflicts.results.length) throw new DemandMutationError(PICKLIST_CONFLICT_MESSAGE, "conflict", 409);
  return linesWithAllocations((lines.results as DatabaseRecord[]).map(lineFromRow), allocations.results);
}

function pdfSourceFilter(db: Database, lineId: string, wholeMovement: boolean) {
  return db.prepare(`h.id IN (SELECT peer.id FROM demand_headers peer
    JOIN demand_headers source ON source.id=(SELECT header_id FROM demand_details WHERE id=?)
    JOIN import_batches b ON b.id=source.batch_id
    WHERE b.is_active=1 AND peer.batch_id=source.batch_id AND peer.plant=source.plant AND peer.area_type=source.area_type
      AND (CASE WHEN peer.area_type='offsite' THEN peer.load_number ELSE peer.train_number END)
        = (CASE WHEN source.area_type='offsite' THEN source.load_number ELSE source.train_number END)
      ${wholeMovement ? "" : "AND peer.picklist_number=source.picklist_number"})`).bind(lineId);
}

export async function getPicklistPdfLines(lineId: string): Promise<CartLine[]> {
  const db = await ensureDatabase();
  return readPdfLines(db, pdfSourceFilter(db, lineId, false));
}

export async function getMovementPdfLines(lineId: string): Promise<CartLine[]> {
  const db = await ensureDatabase();
  return readPdfLines(db, pdfSourceFilter(db, lineId, true));
}

export async function getSectionPdfLines(
  areaType: CartLine["areaType"],
  workScope: "production" | "test",
): Promise<CartLine[]> {
  const db = await ensureDatabase();
  const testScope = "(h.plant='TEST' AND h.program_id='TESTSCAN' AND SUBSTR(h.pymtc,1,5)='TEST:')";
  return readPdfLines(db, db.prepare(`h.batch_id=(SELECT id FROM import_batches
    WHERE is_active=1 ORDER BY imported_at DESC,id DESC LIMIT 1) AND h.area_type=?
    AND ${workScope === "test" ? testScope : `NOT ${testScope}`}`).bind(areaType));
}

function validatedImportRows(rows: ImportRow[]) {
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new Error(`Import must contain between 0 and ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows.`);
  }
  const validated = validateImportRows(rows).map((row, index) =>
    withSupplementalFields(row, rows[index], index + 2)
  );
  const signatures = new Map<string, string>();
  for (const row of validated) {
    const key = cartKeyForLine(row);
    const signature = supplementalHeaderSignature(row);
    if (signatures.has(key) && signatures.get(key) !== signature) {
      throw new Error(`Rows for cart ${row.cartNumber} must use the same program, cart total, P/Y/MTC, and checksheet values.`);
    }
    signatures.set(key, signature);
  }
  return validated;
}

async function activateImport(db: Database, input: ReconciledImportInput) {
  let result;
  try {
    result = await activateReconciledImport(db, input, {
      selectSql: FLATTENED_LINE_SELECT, lineFromRow, prepareHeaderInsert, prepareDetailInsert,
      headerColumns: HEADER_PATCH_COLUMNS, detailColumns: DETAIL_PATCH_COLUMNS, databaseNow,
    });
  } catch (error) {
    if (error instanceof DatabaseConflictError) {
      throw new IntegrationImportError("Demand activation was blocked by a concurrent change, a lease on changed demand, or an expired import claim. Refresh and retry; unchanged reserved picklists can remain in the snapshot.", "active_locks");
    }
    throw error;
  }
  try { await pruneImportHistory(db, new Date(result.importedAt)); }
  catch (error) { console.error("PPA import retention failed", error instanceof Error ? error.name : "Database error"); }
  return result;
}

export async function replaceImport(fileName: string, rows: ImportRow[], detailIds?: string[], actor?: { id: string; name: string }, options: { allowShrink?: boolean } = {}) {
  const validatedRows = validatedImportRows(rows);
  const db = await ensureDatabase();
  const receiptId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const claimExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await db.prepare("DELETE FROM integration_imports WHERE status = 'processing' AND expires_at <= ?")
    .bind(nowIso).run();
  const claim = await db.prepare(`INSERT INTO integration_imports (
    id, source, idempotency_key, content_hash, file_name, status, batch_id,
    row_count, imported_at, created_at, expires_at
  ) SELECT ?, 'manual', '', ?, ?, 'processing', ?, 0, NULL, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM integration_imports WHERE status = 'processing' AND expires_at > ?
    )
    ON CONFLICT DO NOTHING`).bind(
      receiptId, `manual:${receiptId}`, fileName.slice(0, 180), batchId,
      nowIso, claimExpiresAt, nowIso,
    ).run();
  if (Number(claim.meta.changes || 0) !== 1) {
    throw new IntegrationImportError(
      "Another demand activation is already in progress. Retry shortly.",
      "import_in_progress",
    );
  }
  return activateImport(db, {
    batchId,
    fileName,
    rows: validatedRows,
    integrationReceiptId: receiptId,
    detailIds, actorId: actor?.id, actorName: actor?.name,
    allowShrink: options.allowShrink,
  });
}

type IntegrationReceiptRow = {
  id: string;
  source: string;
  idempotency_key: string;
  content_hash: string;
  status: string;
  batch_id: string;
  row_count: number;
  imported_at: string | null;
  expires_at: string;
};

export class IntegrationImportError extends Error {
  readonly code: "active_locks" | "idempotency_conflict" | "import_in_progress";
  readonly status: number;

  constructor(
    message: string,
    code: "active_locks" | "idempotency_conflict" | "import_in_progress",
    status = 409,
  ) {
    super(message);
    this.name = "IntegrationImportError";
    this.code = code;
    this.status = status;
  }
}

export class DemandAppendError extends Error {
  readonly code: "locked" | "conflict";
  readonly status: number;

  constructor(
    message: string,
    code: "locked" | "conflict",
    status = 409,
  ) {
    super(message);
    this.name = "DemandAppendError";
    this.code = code;
    this.status = status;
  }
}

type ActiveImportBatch = {
  id: string;
  file_name: string;
  row_count: number;
  imported_at: string;
};

async function activeImportBatch(db: Database) {
  return db.prepare(`SELECT id, file_name, row_count, imported_at FROM import_batches
    WHERE is_active = 1 ORDER BY imported_at DESC, id DESC LIMIT 1`).first<ActiveImportBatch>();
}

async function acquireDemandAppendLock(db: Database, row: ImportRow, actor = "Manual demand import") {
  const cartKey = cartKeyForLine(row);
  const picklistKey = picklistKeyFromCartKey(cartKey);
  const sessionId = `demand-append:${crypto.randomUUID()}`;
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 2 * 60_000).toISOString();

  await db.prepare("DELETE FROM cart_locks WHERE expires_at <= ?").bind(nowIso).run();
  const claim = await db.prepare(`INSERT INTO cart_locks (
    cart_key, picklist_key, session_id, operator_name, acquired_at, expires_at, inventory_available
  ) SELECT ?, ?, ?, ?, ?, ?, 0
  WHERE NOT EXISTS (
    SELECT 1 FROM cart_locks WHERE picklist_key = ? AND expires_at > ?
  ) AND NOT EXISTS (
    SELECT 1 FROM integration_imports WHERE status = 'processing' AND expires_at > ?
  ) ON CONFLICT DO NOTHING`).bind(
    cartKey, picklistKey, sessionId, actor.slice(0, 120), nowIso, expiresAt,
    picklistKey, nowIso, nowIso,
  ).run();

  if (Number(claim.meta.changes || 0) !== 1) {
    const refreshInProgress = await db.prepare(`SELECT 1 FROM integration_imports
      WHERE status = 'processing' AND expires_at > ? LIMIT 1`).bind(nowIso).first();
    if (refreshInProgress) {
      throw new IntegrationImportError(
        "Another demand activation is already in progress. Retry shortly.",
        "import_in_progress",
      );
    }
    throw new DemandAppendError(
      "This picklist is currently being scanned or maintained. Release it before adding demand.",
      "locked",
    );
  }

  return { cartKey, picklistKey, sessionId };
}

async function releaseDemandAppendLock(
  db: Database,
  lock: { cartKey: string; sessionId: string },
) {
  try {
    await db.prepare("DELETE FROM cart_locks WHERE cart_key = ? AND session_id = ?")
      .bind(lock.cartKey, lock.sessionId).run();
  } catch {
    // The short append lease is self-expiring; cleanup must not mask a
    // successful insert or the actionable validation error that blocked it.
  }
}

export async function appendImportRow(fileName: string, inputRow: ImportRow, projectionDetailId?: string, actor?: { id: string; name: string }) {
  const [row] = validatedImportRows([inputRow]);
  const db = await ensureDatabase();
  const initialBatch = await activeImportBatch(db);
  if (!initialBatch) {
    const created = await replaceImport(fileName, [row], projectionDetailId ? [projectionDetailId] : undefined, actor);
    return {
      ...created,
      totalRowCount: created.rowCount,
      appended: true as const,
      createdBatch: true as const,
    };
  }

  const appendLock = await acquireDemandAppendLock(db, row);
  try {
    const batch = await activeImportBatch(db);
    if (!batch || batch.id !== initialBatch.id) {
      throw new DemandAppendError(
        "The active demand changed before this row could be added. Review the queue and try again.",
        "conflict",
      );
    }

    if (row.sourceLineId && await db.prepare(`SELECT id FROM demand_details
      WHERE source_scope = ? AND source_line_id = ? LIMIT 1`)
      .bind(row.sourceScope || "", row.sourceLineId).first()) {
      throw new DemandAppendError(
        "This Source Line ID already identifies existing or historical demand in this source scope. Reconcile the source snapshot instead of adding it again.",
        "conflict",
      );
    }

    const existingRow = await db.prepare(`${FLATTENED_LINE_SELECT}
      WHERE h.batch_id = ? AND h.cart_key = ?
      ORDER BY d.sequence, d.id LIMIT 1`)
      .bind(batch.id, appendLock.cartKey).first<DatabaseRecord>();
    const existingCart = existingRow ? lineFromRow(existingRow) : null;
    const headerId = existingRow ? String(existingRow.header_id) : crypto.randomUUID();
    const picklistGuard = availablePicklistGuard(db, batch.id, row, existingRow ? headerId : "");
    if (!(await db.prepare(`SELECT 1 WHERE ${picklistGuard.query}`).bind(...picklistGuard.values).first())) {
      throw new DemandAppendError(PICKLIST_CONFLICT_MESSAGE, "conflict");
    }


    if (existingCart) {
      if (existingCart.loadedAt) {
        throw new DemandAppendError(
          `Cart ${row.cartNumber} is already loaded and cannot accept additional demand.`,
          "conflict",
        );
      }
      const verifiedDetail = await db.prepare(`SELECT 1 FROM demand_details
        WHERE header_id = ? AND status <> 'pending' LIMIT 1`).bind(headerId).first();
      if (verifiedDetail) {
        throw new DemandAppendError(
          `Cart ${row.cartNumber} already has verified demand and cannot accept another row.`,
          "conflict",
        );
      }
      if (importFieldDiffers(existingCart, row, APPEND_CART_LEVEL_FIELDS)) {
        throw new DemandAppendError(
          `The new row conflicts with cart-level data already stored for cart ${row.cartNumber}.`,
          "conflict",
        );
      }
      const siblings = await db.prepare("SELECT sequence, aiag_serial FROM demand_details WHERE header_id = ?")
        .bind(headerId).all<{ sequence: string; aiag_serial: string }>();
      const duplicateSequence = siblings.results.some((sibling) => normalizeScanValue(sibling.sequence) === normalizeScanValue(row.sequence));
      if (duplicateSequence) {
        throw new DemandAppendError(
          `Sequence ${row.sequence} already exists for cart ${row.cartNumber}.`,
          "conflict",
        );
      }
    }

    if (row.areaType === "offsite") {
      const existingLoadRow = await db.prepare(`${FLATTENED_LINE_SELECT}
        WHERE h.batch_id = ? AND h.plant = ? AND h.area_type = 'offsite'
          AND h.load_number = ? AND h.picklist_number = ?
        ORDER BY h.cart_number, d.sequence LIMIT 1`)
        .bind(batch.id, row.plant, row.loadNumber, row.picklistNumber)
        .first<DatabaseRecord>();
      if (existingLoadRow && importFieldDiffers(
        lineFromRow(existingLoadRow),
        row,
        APPEND_LOAD_LEVEL_FIELDS,
      )) {
        throw new DemandAppendError(
          `The new row conflicts with trailer-load data already stored for load ${row.loadNumber}.`,
          "conflict",
        );
      }
    }

    const detailId = projectionDetailId || crypto.randomUUID();
    const statements: PreparedStatement[] = [];
    if (!existingCart) statements.push(prepareHeaderInsert(db, batch.id, headerId, row));
    statements.push(
      prepareDetailInsert(db, headerId, detailId, row),
      db.prepare(`UPDATE import_batches SET row_count = row_count + 1
        WHERE id = ? AND is_active = 1`).bind(batch.id),
    );
    if (existingCart) {
      statements.push(db.prepare("UPDATE demand_headers SET revision = revision + 1 WHERE id = ?").bind(headerId));
    }
    const countUpdateIndex = existingCart ? statements.length - 2 : statements.length - 1;
    statements.push(
      db.prepare("INSERT INTO demand_import_rows (id, batch_id, row_json) VALUES (?, ?, ?)")
        .bind(crypto.randomUUID(), batch.id, JSON.stringify(row)),
      db.prepare(`INSERT INTO demand_audit_events
        (id, batch_id, header_id, line_id, action, before_json, after_json, actor_id, actor_name, created_at)
        VALUES (?, ?, ?, ?, 'manual_append', '{}', ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), batch.id, headerId, detailId,
          JSON.stringify({ ...row, sourceFile: fileName.slice(0, 180) }), actor?.id || "", actor?.name || "Demand append", new Date().toISOString()),
    );
    // Check every condition under the write lock before any insert is committed.
    const results = await db.guardedBatch(statements, db.prepare(`EXISTS (
      SELECT 1 FROM import_batches WHERE id = ? AND is_active = 1
    ) AND EXISTS (SELECT 1 FROM cart_locks WHERE cart_key = ? AND session_id = ?
      AND expires_at > ${databaseNow(db)})
    AND NOT EXISTS (SELECT 1 FROM demand_details WHERE header_id = ? AND status <> 'pending')
    AND NOT EXISTS (SELECT 1 FROM demand_headers WHERE id = ? AND loaded_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM demand_details WHERE header_id = ? AND sequence = ?)
    AND (? = '' OR NOT EXISTS (SELECT 1 FROM demand_details WHERE source_scope = ? AND source_line_id = ?))
    AND ${picklistGuard.query}
    ${existingRow ? "AND EXISTS (SELECT 1 FROM demand_headers WHERE id = ? AND revision = ?)" : ""}`)
      .bind(batch.id, appendLock.cartKey, appendLock.sessionId, headerId, headerId, headerId, row.sequence,
        row.sourceLineId || "", row.sourceScope || "", row.sourceLineId || "",
        ...picklistGuard.values, ...(existingRow ? [headerId, Number(existingRow.header_revision || 0)] : [])));
    const countUpdate = results[countUpdateIndex];
    if (Number(countUpdate?.meta.changes || 0) !== 1) {
      const cleanup = [db.prepare("DELETE FROM demand_details WHERE id = ?").bind(detailId)];
      if (!existingCart) {
        cleanup.push(db.prepare("DELETE FROM demand_headers WHERE id = ?").bind(headerId));
      }
      await db.batch(cleanup);
      throw new DemandAppendError(
        "The active demand changed before this row could be added. Review the queue and try again.",
        "conflict",
      );
    }

    const storedBatch = await db.prepare(`SELECT row_count, imported_at FROM import_batches
      WHERE id = ? LIMIT 1`).bind(batch.id).first<{ row_count: number; imported_at: string }>();
    return {
      batchId: batch.id,
      rowCount: Number(storedBatch?.row_count ?? batch.row_count + 1),
      totalRowCount: Number(storedBatch?.row_count ?? batch.row_count + 1),
      importedAt: storedBatch?.imported_at || batch.imported_at,
      lineId: detailId,
      appended: true as const,
      createdBatch: false as const,
      createdCart: !existingCart,
    };
  } catch (error) {
    if (error instanceof Error && /demand_details_source_identity_idx|UNIQUE constraint failed: demand_details\.source_scope, demand_details\.source_line_id/.test(error.message)) {
      throw new DemandAppendError("This Source Line ID was assigned to another demand while the row was being added. Refresh and reconcile the source snapshot.", "conflict");
    }
    if (error instanceof DatabaseConflictError) throw new DemandAppendError(error.message, "conflict");
    throw error;
  } finally {
    await releaseDemandAppendLock(db, appendLock);
  }
}

type CapturedDetailRow = {
  id: string;
  sequence: string;
  part_number: string;
  color: string;
  quantity: number;
  aiag_serial: string;
  status: string;
};

type StoredInventoryItem = {
  id: string;
  capture_session_id: string;
  source: string;
  acquisition_method?: InventoryAcquisitionMethod;
  source_file?: string;
  source_import_id?: string;
  source_row?: number | null;
  scanned_values_json?: string;
  recorded_at?: string;
  aiag_serial: string;
  normalized_serial: string;
  supplier_id?: string;
  pallet_id?: string;
  unit_of_measure?: string;
  loaded_at?: string | null;
  dispatched_at?: string | null;
  loaded_quantity?: number | string;
  dispatched_quantity?: number | string;
  part_number: string;
  part_level: string;
  raw_part_level?: string;
  consumed_quantity?: number;
  consumed_at?: string | null;
  fulfilled_demand_id?: string | null;
  weight?: number | null;
  unit_cost?: number | null;
  receive_date?: string;
  quantity: number;
  status: string;
  is_test: number;
  operator_name: string;
  captured_at: string;
};

type StoredInventoryCaptureReceipt = {
  capture_id: string;
  capture_session_id: string;
  request_fingerprint: string;
  is_test: number;
  inventory_item_id: string | null;
  outcome: "pending" | "created" | "existing_serial";
  created_at: string;
};

type StoredInventoryProjection = {
  id: string;
  inventory_item_id: string;
  test_session_id: string;
  demand_detail_id: string | null;
  status: string;
  error_message: string;
  created_at: string;
  completed_at: string | null;
};

function inventoryLabelMatches(
  stored: StoredInventoryItem,
  captured: ReturnType<typeof parseDemandCaptureValues>,
) {
  return normalizeScanValue(stored.aiag_serial) === normalizeScanValue(captured.values.aiagSerial)
    && normalizeScanValue(stored.part_number) === normalizeScanValue(captured.values.partNumber)
    && normalizeScanValue(stored.part_level) === normalizeScanValue(captured.values.color)
    && Number(stored.quantity) === Number(captured.values.quantity);
}

function inventoryCaptureFingerprint(
  captureSessionId: string,
  values: {
    aiagSerial: string;
    partNumber: string;
    partLevel: string;
    cardColor?: boolean;
    quantity: string | number;
  },
) {
  return JSON.stringify({
    version: 1,
    captureSessionId: captureSessionId.trim().toLowerCase(),
    aiagSerial: normalizeScanValue(values.aiagSerial),
    partNumber: normalizeScanValue(values.partNumber),
    partLevel: normalizeScanValue(values.partLevel),
    quantity: Number(values.quantity),
    ...(values.cardColor ? { cardColor: true } : {}),
  });
}

async function inventoryItemById(db: Database, id: string) {
  return db.prepare(`${INVENTORY_SELECT} WHERE id = ? LIMIT 1`)
    .bind(id).first<StoredInventoryItem>();
}

async function inventoryItemBySerial(db: Database, normalizedSerial: string, isTest: boolean, supplierId = "") {
  return db.prepare(`${INVENTORY_SELECT} WHERE normalized_serial = ? AND is_test = ? AND supplier_id = ? LIMIT 1`)
    .bind(normalizedSerial, isTest ? 1 : 0, supplierId).first<StoredInventoryItem>();
}

async function inventoryCaptureReceiptById(db: Database, captureId: string) {
  return db.prepare(`SELECT capture_id, capture_session_id, request_fingerprint,
    inventory_item_id, outcome, created_at, is_test
    FROM inventory_capture_receipts WHERE capture_id = ? LIMIT 1`)
    .bind(captureId).first<StoredInventoryCaptureReceipt>();
}

function assertInventoryCaptureReceiptMatches(
  receipt: StoredInventoryCaptureReceipt,
  captureSessionId: string,
  requestFingerprint: string,
  isTest: boolean,
) {
  if (receipt.capture_session_id !== captureSessionId
    || !inventoryFingerprintsMatch(receipt.request_fingerprint, requestFingerprint)
    || Number(receipt.is_test) !== (isTest ? 1 : 0)) {
    throw new DemandAppendError(
      "That capture identifier was already used for a different physical label.",
      "conflict",
    );
  }
}

// Older receipts distinguished C from 2P even though both identify color.
// Preserve every identity and metadata constraint when comparing those retries.
function inventoryFingerprintsMatch(left: string, right: string) {
  if (left === right) return true;
  const normalize = (fingerprint: string): string => {
    const value = JSON.parse(fingerprint);
    if (value?.version === 1) delete value.cardColor;
    if (typeof value?.label === "string") value.label = normalize(value.label);
    return JSON.stringify(value);
  };
  try { return normalize(left) === normalize(right); }
  catch { return false; }
}

async function capturePhysicalInventoryItem(
  db: Database,
  input: {
    captureId: string;
    captureSessionId: string;
    captured: ReturnType<typeof parseDemandCaptureValues>;
    operatorName: string;
    isTest: boolean;
  },
) {
  const requestFingerprint = inventoryCaptureFingerprint(
    input.captureSessionId,
    {
      aiagSerial: input.captured.values.aiagSerial,
      partNumber: input.captured.values.partNumber,
      partLevel: input.captured.values.color,
      quantity: input.captured.values.quantity,
    },
  );
  const capturedAt = new Date().toISOString();
  const claimInsert = await db.prepare(`INSERT INTO inventory_capture_receipts (
    capture_id, capture_session_id, request_fingerprint, inventory_item_id, outcome, created_at, is_test
  ) VALUES (?, ?, ?, NULL, 'pending', ?, ?)
  ON CONFLICT(capture_id) DO NOTHING`).bind(
    input.captureId,
    input.captureSessionId,
    requestFingerprint,
    capturedAt,
    input.isTest ? 1 : 0,
  ).run();
  const claimedReceipt = await inventoryCaptureReceiptById(db, input.captureId);
  if (!claimedReceipt) throw new Error("The physical inventory capture identifier could not be reserved.");
  assertInventoryCaptureReceiptMatches(
    claimedReceipt,
    input.captureSessionId,
    requestFingerprint,
    input.isTest,
  );
  if (claimedReceipt.inventory_item_id) {
    const existingCapture = await inventoryItemById(db, claimedReceipt.inventory_item_id);
    if (!existingCapture || Number(existingCapture.is_test) !== (input.isTest ? 1 : 0)
      || !inventoryLabelMatches(existingCapture, input.captured)) {
      throw new Error("The physical inventory capture receipt is inconsistent with its inventory item.");
    }
    return {
      item: existingCapture,
      created: false,
      idempotentReplay: true,
      existingSerial: claimedReceipt.outcome === "existing_serial",
    };
  }

  const normalizedSerial = normalizeScanValue(input.captured.values.aiagSerial);
  const inserted = await db.prepare(`INSERT INTO inventory_items (
    id, capture_session_id, source, aiag_serial, normalized_serial,
    part_number, part_level, quantity,
    raw_aiag_serial, raw_part_number, raw_part_level, raw_quantity,
    status, is_test, operator_name, captured_at
  ) VALUES (?, ?, 'physical_label', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)
  ON CONFLICT DO NOTHING`).bind(
    input.captureId,
    input.captureSessionId,
    input.captured.values.aiagSerial,
    normalizedSerial,
    input.captured.values.partNumber,
    input.captured.values.color,
    Number(input.captured.values.quantity),
    input.captured.rawValues.aiagSerial,
    input.captured.rawValues.partNumber,
    input.captured.rawValues.color,
    input.captured.rawValues.quantity,
    input.isTest ? 1 : 0,
    input.operatorName.trim() || "PPA operator",
    capturedAt,
  ).run();
  const storedByCapture = await inventoryItemById(db, input.captureId);
  let stored: StoredInventoryItem;
  let created = false;
  let idempotentReplay = false;
  let existingSerial = false;
  let outcome: Exclude<StoredInventoryCaptureReceipt["outcome"], "pending"> = "created";
  if (storedByCapture) {
    if (storedByCapture.capture_session_id !== input.captureSessionId
      || Number(storedByCapture.is_test) !== (input.isTest ? 1 : 0)
      || !inventoryLabelMatches(storedByCapture, input.captured)) {
      throw new DemandAppendError(
        "That capture identifier was already used for a different physical label.",
        "conflict",
      );
    }
    stored = storedByCapture;
    created = Number(inserted.meta.changes || 0) === 1;
    idempotentReplay = !created;
  } else {
    const storedBySerial = await inventoryItemBySerial(db, normalizedSerial, input.isTest);
    if (!storedBySerial) {
      throw new Error("The physical inventory label could not be stored.");
    }
    if (!inventoryLabelMatches(storedBySerial, input.captured)) {
      throw new DemandAppendError(
        `Inventory serial ${input.captured.values.aiagSerial} was already captured with different label values.`,
        "conflict",
      );
    }
    stored = storedBySerial;
    existingSerial = true;
    outcome = "existing_serial";
  }

  await db.prepare(`UPDATE inventory_capture_receipts
    SET inventory_item_id = ?, outcome = ?
    WHERE capture_id = ? AND capture_session_id = ? AND request_fingerprint = ?
      AND inventory_item_id IS NULL`).bind(
    stored.id,
    outcome,
    input.captureId,
    input.captureSessionId,
    requestFingerprint,
  ).run();
  const receipt = await inventoryCaptureReceiptById(db, input.captureId);
  if (!receipt) throw new Error("The physical inventory capture receipt could not be stored.");
  assertInventoryCaptureReceiptMatches(receipt, input.captureSessionId, requestFingerprint, input.isTest);
  if (receipt.inventory_item_id !== stored.id || receipt.outcome !== outcome) {
    throw new DemandAppendError(
      "That capture identifier was already used for a different physical label.",
      "conflict",
    );
  }

  return {
    item: stored,
    created,
    idempotentReplay: idempotentReplay || (!created && Number(claimInsert.meta.changes || 0) === 0),
    existingSerial,
  };
}

function productionInventoryItem(item: StoredInventoryItem): InventoryItem {
  if (Number(item.is_test) !== 0) throw new Error("Test inventory cannot be returned as a production receipt.");
  const unit = item.unit_of_measure || "EA";
  const quantity = Number(item.quantity);
  const loadedQuantity = Number(item.loaded_quantity || 0);
  const dispatchedQuantity = Number(item.dispatched_quantity || 0);
  const originalQuantity = quantityToScaled(quantity, unit);
  const fullyLoaded = originalQuantity > 0n && quantityToScaled(loadedQuantity, unit) === originalQuantity;
  const fullyDispatched = originalQuantity > 0n && quantityToScaled(dispatchedQuantity, unit) === originalQuantity;
  return {
    id: item.id,
    serial: item.aiag_serial,
    partNumber: item.part_number,
    partMark: item.part_level,
    partLevel: "",
    color: item.part_level,
    quantity,
    unitOfMeasure: unit,
    supplierId: item.supplier_id || "",
    ...(item.pallet_id ? { palletId: item.pallet_id } : {}),
    receiptKind: item.status === "expected" ? "expected" : "received",
    fulfillmentStage: item.status === "consumed"
      ? fullyDispatched ? "dispatched" : fullyLoaded ? "loaded" : "packed"
      : item.status === "partially_consumed" ? "partially_consumed" : item.status === "expected" ? "expected" : item.status === "deleted" ? "deleted" : "available",
    loadedQuantity,
    dispatchedQuantity,
    loadedAt: fullyLoaded ? item.loaded_at || null : null,
    dispatchedAt: fullyDispatched ? item.dispatched_at || null : null,
    status: item.status,
    consumedFlag: item.status === "consumed" ? "Y" : "N",
    consumedQuantity: Number(item.consumed_quantity || 0),
    remainingQuantity: Math.max(0, Number((Number(item.quantity) - Number(item.consumed_quantity || 0)).toFixed(6))),
    consumedAt: item.consumed_at || null,
    fulfilledDemandId: item.fulfilled_demand_id || null,
    fulfilledDemandIds: item.fulfilled_demand_id ? [item.fulfilled_demand_id] : [],
    weight: item.weight ?? null,
    unitCost: item.unit_cost ?? null,
    receiveDate: item.receive_date || "",
    receivedAt: item.status === "expected" ? "" : item.captured_at,
    receivedBy: item.operator_name,
    acquisitionMethod: item.acquisition_method || "legacy_unknown",
    sourceFile: item.source_file || "",
    sourceImportId: item.source_import_id || "",
    sourceRow: item.source_row ?? null,
    recordedAt: item.recorded_at || item.captured_at,
    scannedValuesJson: item.scanned_values_json || "{}",
    isTest: false,
  };
}

/** Receive physical stock independently of demand, verification, and test projections. */
export async function receiveInventoryFromPhysicalLabel(input: {
  captureId: unknown;
  receiptSessionId: unknown;
  rawValues: unknown;
  operatorName: string;
  operatorId?: string;
  weight?: number;
  unitCost?: number;
  receiveDate?: string;
  unitOfMeasure?: string;
  supplierId?: string;
  palletId?: string;
  receiptKind?: "received" | "expected";
  /** Assigned by the server route, never taken from an untrusted request body. */
  provenance?: InventoryProvenance;
}): Promise<InventoryReceiveResult> {
  const captureId = parseCaptureId(input.captureId);
  let receiptSessionId: string;
  try { receiptSessionId = parseCaptureId(input.receiptSessionId); }
  catch { throw new DemandCaptureValidationError("A valid receiving session identifier is required."); }
  let unitOfMeasure: string;
  try { unitOfMeasure = normalizeUnitOfMeasure(input.unitOfMeasure); }
  catch (error) { throw new DemandCaptureValidationError(error instanceof Error ? error.message : "Invalid unit of measure."); }
  if (input.supplierId !== undefined && typeof input.supplierId !== "string") throw new DemandCaptureValidationError("Supplier ID must be text.");
  const supplierId = normalizeScanValue(input.supplierId || "");
  if (supplierId.length > 180) throw new DemandCaptureValidationError("Supplier ID must be no more than 180 characters.");
  if (input.palletId !== undefined && typeof input.palletId !== "string") throw new DemandCaptureValidationError("Pallet ID must be text.");
  if (input.palletId && /[\u0000-\u001f\u007f-\u009f]/.test(input.palletId)) throw new DemandCaptureValidationError("Pallet ID contains unsupported control characters.");
  const palletId = input.palletId?.trim() || "";
  if (palletId.length > 180) throw new DemandCaptureValidationError("Pallet ID must be no more than 180 characters.");
  if (input.receiptKind && !["received", "expected"].includes(input.receiptKind)) {
    throw new DemandCaptureValidationError("Inventory must be received stock or an expected shipment.");
  }
  const receiptKind = input.receiptKind || "received";
  const provenance: InventoryProvenance = input.provenance || { method: "scanner_capture" };
  if (!["scanner_capture", "spreadsheet_import", "explicit_confirmation"].includes(provenance.method)
    || (provenance.sourceFile !== undefined && (typeof provenance.sourceFile !== "string" || provenance.sourceFile.length > 180 || /[\u0000-\u001f\u007f]/.test(provenance.sourceFile)))
    || (provenance.method === "spreadsheet_import" && (!Number.isSafeInteger(provenance.rowNumber) || Number(provenance.rowNumber) < 2))) {
    throw new DemandCaptureValidationError("Inventory provenance is invalid.");
  }
  if (provenance.method === "spreadsheet_import") parseCaptureId(provenance.importId);
  const captured = parseDemandCaptureValues(input.rawValues, unitOfMeasure);
  const scannedValues: Partial<typeof captured.rawValues> = provenance.method === "scanner_capture" ? captured.rawValues : {};
  // Receiving requires serial, part and quantity; color is optional. The legacy
  // capture utility continues to support its historical barcode aliases.
  if (!(input.rawValues as string[]).every((value) => /^(?:1S|2P|P|Q|C)/i.test(cleanScannerPayload(value)))) {
    throw new DemandCaptureValidationError("Receive inventory using serial (1S), part (P), quantity (Q), and color (C or 2P) when present.");
  }
  const operatorName = typeof input.operatorName === "string" ? input.operatorName.trim() : "";
  if (!operatorName || operatorName.length > 120) {
    throw new DemandCaptureValidationError("Provide an operator name of no more than 120 characters.");
  }
  for (const [label, value] of [["Weight", input.weight], ["Unit cost", input.unitCost]] as const) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new DemandCaptureValidationError(`${label} must be a non-negative number.`);
    }
  }
  if (input.receiveDate !== undefined && (typeof input.receiveDate !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.receiveDate)
    || !Number.isFinite(Date.parse(input.receiveDate))
    || new Date(input.receiveDate).toISOString().slice(0, 10) !== input.receiveDate)) {
    throw new DemandCaptureValidationError("Receive date must be a valid YYYY-MM-DD date.");
  }
  const metadataMatches = (item: StoredInventoryItem) =>
    (item.unit_of_measure || "EA") === unitOfMeasure
    && (item.supplier_id || "") === supplierId
    && (!palletId || (item.pallet_id || "").trim().toUpperCase() === palletId.toUpperCase())
    &&
    (input.weight === undefined || input.weight === item.weight)
    && (input.unitCost === undefined || input.unitCost === item.unit_cost)
    && (input.receiveDate === undefined || input.receiveDate === item.receive_date);
  const assertMetadata = (item: StoredInventoryItem) => {
    if (!metadataMatches(item)) throw new DemandAppendError("This serial number was received with different inventory metadata.", "conflict");
  };
  const db = await ensureDatabase();
  const normalizedSerial = normalizeScanValue(captured.values.aiagSerial);
  const baseFingerprint = inventoryCaptureFingerprint(receiptSessionId, {
    aiagSerial: captured.values.aiagSerial,
    partNumber: captured.values.partNumber,
    partLevel: captured.values.color,
    cardColor: /^C/i.test(captured.rawValues.color),
    quantity: captured.values.quantity,
  });
  // Preserve legacy receipt fingerprints for the default EA/unspecified supplier contract.
  const legacyRequestFingerprint = supplierId || unitOfMeasure !== "EA" || receiptKind === "expected"
    ? JSON.stringify({ label: baseFingerprint, supplierId, unitOfMeasure, receiptKind }) : baseFingerprint;
  const requestFingerprint = provenance.method === "scanner_capture" ? legacyRequestFingerprint
    : JSON.stringify({ version: 2, label: legacyRequestFingerprint, provenance });

  // Read snapshots are guarded again under the database's transaction lock.
  // Concurrent requests converge on a single container and one audit per receipt.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const receipt = await inventoryCaptureReceiptById(db, captureId);
    if (receipt) {
      // An in-flight receipt created before acquisition metadata existed may
      // replay its original fingerprint. Its historical provenance stays unknown.
      const acceptedFingerprint = inventoryFingerprintsMatch(receipt.request_fingerprint, legacyRequestFingerprint)
        ? legacyRequestFingerprint : requestFingerprint;
      assertInventoryCaptureReceiptMatches(receipt, receiptSessionId, acceptedFingerprint, false);
      if (receipt.inventory_item_id) {
        const saved = await inventoryItemById(db, receipt.inventory_item_id);
        if (!saved || Number(saved.is_test) !== 0 || !inventoryLabelMatches(saved, captured)) {
          throw new Error("The inventory receipt is inconsistent with its stored container.");
        }
        assertMetadata(saved);
        if (saved.status === "deleted") throw new DemandAppendError("This container was deleted by a supervisor. Restore it from Deleted inventory before receiving it again.", "conflict");
        const [inventory] = await attachInventoryDemandIds(db, [productionInventoryItem(saved)]);
        return { ok: true, created: false, duplicate: true, inventory };
      }
    }
    const existing = await inventoryItemBySerial(db, normalizedSerial, false, supplierId);
    if (existing) assertMetadata(existing);
    if (existing?.status === "deleted") throw new DemandAppendError("This container was deleted by a supervisor. Restore it from Deleted inventory before receiving it again.", "conflict");
    if (existing && !inventoryLabelMatches(existing, captured)) {
      throw new DemandAppendError(
        `Inventory serial ${captured.values.aiagSerial} was already received with different label values.`,
        "conflict",
      );
    }
    const capturedAt = new Date().toISOString();
    const confirming = existing?.status === "expected" && receiptKind === "received";
    const item: StoredInventoryItem = existing ? { ...existing,
      ...(confirming ? { status: "available", captured_at: capturedAt, operator_name: operatorName } : {}),
    } : {
      id: captureId,
      capture_session_id: receiptSessionId,
      source: provenance.method === "spreadsheet_import" ? "spreadsheet_import" : receiptKind === "expected" ? "expected_shipment" : "physical_label",
      acquisition_method: provenance.method,
      source_file: provenance.sourceFile || "",
      source_import_id: provenance.importId || "",
      source_row: provenance.rowNumber ?? null,
      scanned_values_json: JSON.stringify(scannedValues),
      recorded_at: capturedAt,
      aiag_serial: captured.values.aiagSerial,
      normalized_serial: normalizedSerial,
      supplier_id: supplierId,
      pallet_id: palletId,
      unit_of_measure: unitOfMeasure,
      part_number: captured.values.partNumber,
      part_level: captured.values.color,
      raw_part_level: captured.rawValues.color,
      quantity: Number(captured.values.quantity),
      status: receiptKind === "expected" ? "expected" : "available",
      is_test: 0,
      operator_name: operatorName,
      captured_at: capturedAt,
      weight: input.weight ?? null,
      unit_cost: input.unitCost ?? null,
      receive_date: input.receiveDate || "",
    };
    const guardParts = [receipt
      ? "EXISTS (SELECT 1 FROM inventory_capture_receipts WHERE capture_id = ? AND capture_session_id = ? AND request_fingerprint = ? AND is_test = 0 AND inventory_item_id IS NULL)"
      : "NOT EXISTS (SELECT 1 FROM inventory_capture_receipts WHERE capture_id = ?)"];
    const guardValues: (string | number)[] = receipt
      ? [captureId, receiptSessionId, requestFingerprint] : [captureId];
    if (existing) {
      guardParts.push(`EXISTS (SELECT 1 FROM inventory_items WHERE id = ? AND is_test = 0
        AND normalized_serial = ? AND part_number = ? AND part_level = ? AND quantity = ? AND status = ?
        AND supplier_id = ? AND unit_of_measure = ?)`);
      guardValues.push(existing.id, normalizedSerial, existing.part_number, existing.part_level, existing.quantity, existing.status, supplierId, unitOfMeasure);
    } else {
      guardParts.push("NOT EXISTS (SELECT 1 FROM inventory_items WHERE (is_test = 0 AND normalized_serial = ? AND supplier_id = ?) OR id = ?)");
      guardValues.push(normalizedSerial, supplierId, captureId);
    }
    const statements: PreparedStatement[] = [];
    if (!existing) {
      statements.push(db.prepare(`INSERT INTO inventory_items (
        id, capture_session_id, aiag_serial, normalized_serial,
        part_number, part_level, quantity, raw_aiag_serial, raw_part_number,
        raw_part_level, raw_quantity, status, is_test, operator_name, captured_at, weight, unit_cost, receive_date, supplier_id, unit_of_measure, source, pallet_id,
        acquisition_method, source_file, source_import_id, source_row, scanned_values_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(captureId, receiptSessionId, item.aiag_serial, normalizedSerial,
          item.part_number, item.part_level, item.quantity, scannedValues.aiagSerial || "",
          scannedValues.partNumber || "", scannedValues.color || "", scannedValues.quantity || "",
          item.status, operatorName, capturedAt, item.weight, item.unit_cost, item.receive_date, supplierId, unitOfMeasure, item.source, palletId,
          item.acquisition_method, item.source_file, item.source_import_id, item.source_row, item.scanned_values_json, item.recorded_at));
    }
    if (confirming) statements.push(db.prepare(`UPDATE inventory_items SET status = 'available',
      operator_name = ?, captured_at = ? WHERE id = ? AND status = 'expected'`)
      .bind(operatorName, capturedAt, item.id));
    const outcome = existing && existing.id !== captureId ? "existing_serial" : "created";
    statements.push(receipt
      ? db.prepare(`UPDATE inventory_capture_receipts SET inventory_item_id = ?, outcome = ?
          WHERE capture_id = ?`).bind(item.id, outcome, captureId)
      : db.prepare(`INSERT INTO inventory_capture_receipts (
          capture_id, capture_session_id, request_fingerprint, inventory_item_id, outcome, created_at, is_test
        ) VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .bind(captureId, receiptSessionId, requestFingerprint, item.id, outcome, capturedAt));
    statements.push(db.prepare(`INSERT INTO demand_audit_events (
      id, batch_id, header_id, line_id, action, before_json, after_json, actor_id, actor_name, created_at
    ) VALUES (?, '', '', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), item.id,
        confirming ? "inventory_received" : existing ? "inventory_duplicate" : receiptKind === "expected" ? "inventory_expected" : "inventory_received",
        JSON.stringify(existing ? productionInventoryItem(existing) : {}),
        JSON.stringify({ captureId, receiptSessionId, inventory: productionInventoryItem(item), provenance,
          rawValues: scannedValues, ...(provenance.method !== "scanner_capture" ? { suppliedValues: captured.values } : {}) }),
        input.operatorId || "", operatorName, capturedAt));
    try {
      await db.guardedBatch(statements, db.prepare(guardParts.join(" AND ")).bind(...guardValues));
      const saved = await inventoryItemById(db, item.id);
      if (!saved) throw new Error("The saved inventory receipt could not be read.");
      const [inventory] = await attachInventoryDemandIds(db, [productionInventoryItem(saved)]);
      return { ok: true, created: !existing || confirming, duplicate: Boolean(existing) && !confirming, inventory };
    } catch (error) {
      if (!(error instanceof DatabaseConflictError)) throw error;
    }
  }
  throw new DemandAppendError("Inventory changed while saving. Retry this receipt to confirm its result.", "conflict");
}

/** Confirm arrival of a known expected container using its stored, trusted label. */
export async function receiveExpectedInventory(input: {
  inventoryId: unknown; captureId: unknown; receiptSessionId: unknown; operatorName: string; operatorId?: string;
}) {
  const id = parseCaptureId(input.inventoryId);
  const db = await ensureDatabase();
  const item = await inventoryItemById(db, id);
  if (!item || Number(item.is_test) !== 0) throw new DemandAppendError("Expected inventory was not found.", "conflict", 404);
  const raw = await db.prepare(`SELECT raw_aiag_serial, raw_part_number, raw_part_level, raw_quantity
    FROM inventory_items WHERE id = ?`).bind(id).first<DatabaseRecord>();
  if (!raw) throw new DemandAppendError("Expected inventory was not found.", "conflict", 404);
  return receiveInventoryFromPhysicalLabel({ ...input, receiptKind: "received",
    provenance: { method: "explicit_confirmation" },
    supplierId: item.supplier_id, unitOfMeasure: item.unit_of_measure, palletId: item.pallet_id,
    rawValues: [raw.raw_aiag_serial || `1S${item.aiag_serial}`, raw.raw_part_number || `P${item.part_number}`,
      raw.raw_part_level || `C${item.part_level}`, raw.raw_quantity || `Q${item.quantity}`],
  });
}

/** Deletion removes stock from active totals while preserving serial identity and receipt history. */
export async function setInventoryDeleted(input: { id: unknown; deleted: boolean; operatorName: string; operatorId: string }) {
  let id: string;
  try { id = parseCaptureId(input.id); }
  catch { throw new DemandCaptureValidationError("A valid inventory identifier is required."); }
  const actor = input.operatorName.trim();
  if (!actor || actor.length > 120) throw new DemandCaptureValidationError("A valid supervisor name is required.");
  const db = await ensureDatabase();
  const status = input.deleted ? "deleted" : "available";
  for (let attempt = 0; attempt < 5; attempt++) {
    const item = await inventoryItemById(db, id);
    if (!item || Number(item.is_test) !== 0) throw new DemandAppendError("Inventory container not found.", "conflict", 404);
    if (item.status === status) return { ok: true, changed: false, inventory: productionInventoryItem(item) };
    if (!["available", "deleted"].includes(item.status)) throw new DemandAppendError("This container cannot be changed in its current status.", "conflict");
    const updated = { ...item, status };
    try {
      await db.guardedBatch([
        db.prepare("UPDATE inventory_items SET status = ? WHERE id = ? AND is_test = 0").bind(status, id),
        db.prepare(`INSERT INTO demand_audit_events (
          id, batch_id, header_id, line_id, action, before_json, after_json, actor_id, actor_name, created_at
        ) VALUES (?, '', '', ?, ?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), id, input.deleted ? "inventory_deleted" : "inventory_restored",
            JSON.stringify(productionInventoryItem(item)), JSON.stringify(productionInventoryItem(updated)),
            input.operatorId, actor, new Date().toISOString()),
      ], db.prepare("EXISTS (SELECT 1 FROM inventory_items WHERE id = ? AND is_test = 0 AND status = ?)").bind(id, item.status));
      return { ok: true, changed: true, inventory: productionInventoryItem(updated) };
    } catch (error) {
      if (!(error instanceof DatabaseConflictError)) throw error;
    }
  }
  throw new DemandAppendError("Inventory changed during this action. Check its current status and try again.", "conflict");
}

function inventorySearchFilter(query = "", deleted = false) {
  if (typeof query !== "string" || query.trim().length > 256) {
    throw new DemandCaptureValidationError("Inventory search must be no more than 256 characters.");
  }
  const search = query.trim().toUpperCase();
  const pattern = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  const scope = `is_test = 0 AND status ${deleted ? "=" : "<>"} 'deleted'`;
  return search ? {
    sql: `${scope} AND (UPPER(aiag_serial) LIKE ? ESCAPE '\\'
      OR UPPER(part_number) LIKE ? ESCAPE '\\' OR UPPER(part_level) LIKE ? ESCAPE '\\' OR UPPER(pallet_id) LIKE ? ESCAPE '\\')`,
    values: [pattern, pattern, pattern, pattern],
  } : { sql: scope, values: [] };
}

const INVENTORY_SELECT = `SELECT id, capture_session_id, source, aiag_serial,
  acquisition_method,source_file,source_import_id,source_row,scanned_values_json,recorded_at,
  normalized_serial, supplier_id, pallet_id, unit_of_measure, part_number, part_level, raw_part_level, quantity, status, is_test, operator_name, captured_at,
  consumed_quantity, consumed_at, weight, unit_cost, receive_date,
  (SELECT MIN(demand_detail_id) FROM fulfillment_allocations WHERE inventory_item_id=inventory_items.id AND reversed_at IS NULL) AS fulfilled_demand_id,
  (SELECT ROUND(COALESCE(SUM(a.quantity), 0), 6) FROM fulfillment_allocations a JOIN demand_details d ON d.id=a.demand_detail_id JOIN demand_headers h ON h.id=d.header_id WHERE a.inventory_item_id=inventory_items.id AND a.reversed_at IS NULL AND h.loaded_at IS NOT NULL) AS loaded_quantity,
  (SELECT ROUND(COALESCE(SUM(a.quantity), 0), 6) FROM fulfillment_allocations a JOIN demand_details d ON d.id=a.demand_detail_id JOIN demand_headers h ON h.id=d.header_id WHERE a.inventory_item_id=inventory_items.id AND a.reversed_at IS NULL AND h.dispatched_at IS NOT NULL) AS dispatched_quantity,
  (SELECT MAX(h.loaded_at) FROM fulfillment_allocations a JOIN demand_details d ON d.id=a.demand_detail_id JOIN demand_headers h ON h.id=d.header_id WHERE a.inventory_item_id=inventory_items.id AND a.reversed_at IS NULL) AS loaded_at,
  (SELECT MAX(h.dispatched_at) FROM fulfillment_allocations a JOIN demand_details d ON d.id=a.demand_detail_id JOIN demand_headers h ON h.id=d.header_id WHERE a.inventory_item_id=inventory_items.id AND a.reversed_at IS NULL) AS dispatched_at
  FROM inventory_items`;

export async function listInventory(query: { q?: string; page?: number; pageSize?: number; deleted?: boolean } = {}): Promise<InventoryListResult> {
  const page = query.page ?? 1;
  const requestedPageSize = query.pageSize ?? 50;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000
    || !Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1) {
    throw new DemandCaptureValidationError("Inventory page and page size must be positive whole numbers within the supported range.");
  }
  const pageSize = Math.min(requestedPageSize, 100);
  const filter = inventorySearchFilter(query.q, query.deleted);
  const db = await ensureDatabase();
  const selector = db.prepare(`SELECT id FROM inventory_items WHERE ${filter.sql} ORDER BY captured_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...filter.values, pageSize, (page - 1) * pageSize);
  const [summary, unitTotals, ...snapshot] = await db.readBatch([
    db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status IN (${query.deleted ? "'deleted'" : "'available','partially_consumed'"}) THEN 1 ELSE 0 END), 0) AS containers,
      COALESCE(SUM(CASE WHEN status IN (${query.deleted ? "'deleted'" : "'available','partially_consumed'"}) AND unit_of_measure = 'EA' THEN quantity-consumed_quantity ELSE 0 END), 0) AS units
      FROM inventory_items WHERE ${filter.sql}`)
      .bind(...filter.values),
    db.prepare(`SELECT unit_of_measure, SUM(quantity-consumed_quantity) AS quantity FROM inventory_items
      WHERE ${filter.sql} AND status IN (${query.deleted ? "'deleted'" : "'available','partially_consumed'"}) GROUP BY unit_of_measure`)
      .bind(...filter.values),
    ...inventorySnapshotStatements(db, selector),
  ]);
  const totals = summary.results[0];
  return {
    items: inventorySnapshotItems(snapshot),
    total: Number(totals.total), page, pageSize,
    summary: { containers: Number(totals.containers), units: Number(totals.units),
      quantitiesByUnit: Object.fromEntries(unitTotals.results.map((row) => [String(row.unit_of_measure), Number(Number(row.quantity).toFixed(6))])),
    },
  };
}

export async function getInventoryExport(query = ""): Promise<InventoryItem[]> {
  const filter = inventorySearchFilter(query);
  const db = await ensureDatabase();
  return inventorySnapshotItems(await db.readBatch(inventorySnapshotStatements(db,
    db.prepare(`SELECT id FROM inventory_items WHERE ${filter.sql}`).bind(...filter.values))));
}

async function ensureInventoryDemandProjection(db: Database, inventoryId: string, testSessionId: string) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO inventory_demand_projections (
    id, inventory_item_id, test_session_id, demand_detail_id, projection_type,
    status, error_message, created_at, completed_at
  ) VALUES (?, ?, ?, NULL, 'test_demand', 'pending', '', ?, NULL)
  ON CONFLICT(inventory_item_id, test_session_id) DO NOTHING`)
    .bind(crypto.randomUUID(), inventoryId, testSessionId, now).run();
  const stored = await db.prepare(`SELECT id, inventory_item_id, test_session_id,
    demand_detail_id, status, error_message, created_at, completed_at
    FROM inventory_demand_projections
    WHERE inventory_item_id = ? AND test_session_id = ? LIMIT 1`)
    .bind(inventoryId, testSessionId).first<StoredInventoryProjection>();
  if (!stored) throw new Error("The inventory test-demand projection could not be prepared.");
  return stored;
}

async function completeInventoryDemandProjection(
  db: Database,
  projectionId: string,
  demandDetailId: string,
) {
  const completedAt = new Date().toISOString();
  await db.prepare(`UPDATE inventory_demand_projections
    SET demand_detail_id = ?, status = 'completed', error_message = '', completed_at = ?
    WHERE id = ?`)
    .bind(demandDetailId, completedAt, projectionId).run();
}

async function failInventoryDemandProjection(db: Database, projectionId: string, message: string) {
  await db.prepare(`UPDATE inventory_demand_projections
    SET status = 'failed', error_message = ?, completed_at = NULL
    WHERE id = ? AND demand_detail_id IS NULL`)
    .bind(message.slice(0, 1_000), projectionId).run();
}

async function recoverInventoryDemandProjection(
  db: Database,
  projectionId: string,
  expected: ImportRow,
) {
  expected = validatedCapturedImportRow(expected);
  const projection = await db.prepare(`SELECT id, inventory_item_id, test_session_id,
    demand_detail_id, status, error_message, created_at, completed_at
    FROM inventory_demand_projections WHERE id = ? LIMIT 1`)
    .bind(projectionId).first<StoredInventoryProjection>();
  if (!projection) return null;

  const projected = projection.demand_detail_id
    ? await db.prepare(`${FLATTENED_LINE_SELECT}
        WHERE d.id = ? AND h.batch_id IN (
          SELECT id FROM import_batches WHERE is_active = 1
        ) LIMIT 1`)
      .bind(projection.demand_detail_id).first<DatabaseRecord>()
    : await db.prepare(`${FLATTENED_LINE_SELECT}
        WHERE h.batch_id IN (
          SELECT id FROM import_batches WHERE is_active = 1
        ) AND h.cart_key = ? AND d.id = ?
        ORDER BY d.sequence, d.id LIMIT 1`)
      .bind(cartKeyForLine(expected), projection.id).first<DatabaseRecord>();
  if (!projected) return null;

  const line = lineFromRow(projected);
  if (!isGeneratedTestDemand(line)
    || cartKeyForLine(line) !== cartKeyForLine(expected)
    || importFieldDiffers(line, expected, APPEND_CART_LEVEL_FIELDS)
    || normalizeScanValue(line.partNumber) !== normalizeScanValue(expected.partNumber)
    || normalizeScanValue(line.color) !== normalizeScanValue(expected.color)
    || Number(line.quantity) !== Number(expected.quantity)) {
    return null;
  }
  await completeInventoryDemandProjection(db, projectionId, line.id);
  return line;
}

function isProjectionContention(error: unknown) {
  return (error instanceof IntegrationImportError && error.code === "import_in_progress")
    || (error instanceof DemandAppendError && error.code === "locked");
}

async function waitForInventoryDemandProjection(
  db: Database,
  projectionId: string,
  expected: ImportRow,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const projected = await recoverInventoryDemandProjection(db, projectionId, expected);
    if (projected) return projected;
    if (attempt < 19) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return null;
}

function validatedCapturedImportRow(row: ImportRow) {
  try {
    return validatedImportRows([row])[0];
  } catch (error) {
    throw new DemandCaptureValidationError(
      error instanceof Error ? error.message : "The inventory label cannot be projected into test demand.",
    );
  }
}

function capturedImportRow(template: CartLine, captured: ReturnType<typeof parseDemandCaptureValues>["values"], sequence: string): ImportRow {
  const generatedTestRow = isGeneratedTestDemand(template);
  return {
    plant: template.plant,
    zone: template.zone,
    areaType: "offsite",
    shipCategory: template.shipCategory,
    loadNumber: template.loadNumber,
    trainNumber: "",
    picklistNumber: template.picklistNumber,
    cartNumber: template.cartNumber,
    cartId: template.cartId,
    palletId: template.palletId,
    programId: template.programId,
    totalCarts: template.totalCarts,
    pymtc: template.pymtc,
    checksheetNumber: template.checksheetNumber,
    sequence,
    partNumber: captured.partNumber,
    description: generatedTestRow ? "Physical label test scan" : "",
    color: captured.color,
    quantity: Number(captured.quantity),
    aiagSerial: captured.aiagSerial,
    masterBarcode: template.masterBarcode,
    movementBarcode: template.movementBarcode,
    caseCode: template.caseCode,
    outgoingSerial: template.outgoingSerial,
    cartSequenceNumber: template.cartSequenceNumber,
    fromLot: template.fromLot,
    toLot: template.toLot,
    model: template.model,
    cartType: template.cartType,
    scheduledDispatchDate: template.scheduledDispatchDate,
    scheduledDispatchTime: template.scheduledDispatchTime,
    deliveryLocation: template.deliveryLocation,
    detailDeliveryLocation: generatedTestRow ? "TEST DOCK" : "",
    containerPosition: generatedTestRow ? sequence : "",
    containerType: generatedTestRow ? "TEST" : "",
    pickingLocation: generatedTestRow ? "TEST" : "",
    mcid: generatedTestRow ? "TEST" : "",
    containerTotal: 0,
    chassisNumber: template.chassisNumber,
    orderNumber: template.orderNumber,
    batchNumber: template.batchNumber,
    loadingSequence: template.loadingSequence,
  };
}

function testCapturedImportRow(
  context: ReturnType<typeof buildTestDemandContext>,
  captured: ReturnType<typeof parseDemandCaptureValues>["values"],
  sequence: string,
): ImportRow {
  return {
    plant: "TEST",
    zone: "TEST",
    areaType: "offsite",
    shipCategory: "TEST",
    loadNumber: context.loadNumber,
    trainNumber: "",
    picklistNumber: context.picklistNumber,
    cartNumber: context.cartNumber,
    cartId: context.cartId,
    palletId: context.palletId,
    programId: "TESTSCAN",
    totalCarts: 1,
    pymtc: `TEST:${context.sessionId.toUpperCase()}`,
    checksheetNumber: context.checksheetNumber,
    sequence,
    partNumber: captured.partNumber,
    description: "Physical label test scan",
    color: captured.color,
    quantity: Number(captured.quantity),
    aiagSerial: captured.aiagSerial,
    masterBarcode: context.checksheetNumber,
    movementBarcode: context.loadNumber,
    caseCode: "TEST",
    outgoingSerial: context.token,
    cartSequenceNumber: "001",
    fromLot: "TEST-FROM",
    toLot: "TEST-TO",
    model: "TEST",
    cartType: "TEST",
    scheduledDispatchDate: "2099-12-31",
    scheduledDispatchTime: "12:00",
    deliveryLocation: "TEST DOCK",
    detailDeliveryLocation: "TEST DOCK",
    containerPosition: sequence,
    containerType: "TEST",
    pickingLocation: "TEST",
    mcid: "TEST",
    containerTotal: 0,
    chassisNumber: `TCHS-${context.token}`,
    orderNumber: context.orderNumber,
    batchNumber: context.batchNumber,
    loadingSequence: "001",
  };
}

export async function appendTestDemandFromPhysicalLabel(input: {
  captureId: unknown;
  testSessionId: unknown;
  rawValues: unknown;
  operatorName: string;
}) {
  const captureId = parseCaptureId(input.captureId);
  const context = buildTestDemandContext(input.testSessionId);
  const captured = parseDemandCaptureValues(input.rawValues);
  const proposedFirstRow = testCapturedImportRow(context, captured.values, "001");
  const db = await ensureDatabase();
  const inventory = await capturePhysicalInventoryItem(db, {
    captureId,
    captureSessionId: context.sessionId.toLowerCase(),
    captured,
    operatorName: input.operatorName,
    isTest: true,
  });
  const inventoryResult = {
    id: inventory.item.id,
    created: inventory.created,
    idempotentReplay: inventory.idempotentReplay,
    existingSerial: inventory.existingSerial,
    status: inventory.item.status,
    source: inventory.item.source,
    aiagSerial: inventory.item.aiag_serial,
    partNumber: inventory.item.part_number,
    partLevel: inventory.item.part_level,
    quantity: Number(inventory.item.quantity),
    capturedAt: inventory.item.captured_at,
  };
  const responseBase = {
    ok: true as const,
    duplicate: !inventory.created,
    testMode: true as const,
    inventoryId: inventory.item.id,
    inventoryCreated: inventory.created,
    inventory: inventoryResult,
  };

  let projectionId = "";
  try {
    const inventoryProjection = await ensureInventoryDemandProjection(
      db,
      inventory.item.id,
      context.sessionId.toLowerCase(),
    );
    projectionId = inventoryProjection.id;
    const firstRow = validatedCapturedImportRow(proposedFirstRow);
    const batch = await activeImportBatch(db);
    if (inventoryProjection.demand_detail_id) {
      const projected = await db.prepare(`${FLATTENED_LINE_SELECT}
        WHERE d.id = ? LIMIT 1`)
        .bind(inventoryProjection.demand_detail_id).first<DatabaseRecord>();
      if (projected && batch && String(projected.batch_id) === batch.id) {
        const projectedLine = lineFromRow(projected);
        if (isGeneratedTestDemand(projectedLine)
          && cartKeyForLine(projectedLine) === cartKeyForLine(firstRow)) {
          await completeInventoryDemandProjection(db, inventoryProjection.id, projectedLine.id);
          return {
            ...responseBase,
            projectionStatus: "existing" as const,
            lineId: projectedLine.id,
            sequence: projectedLine.sequence,
            loadNumber: projectedLine.loadNumber,
            picklistNumber: projectedLine.picklistNumber,
            checksheetNumber: projectedLine.checksheetNumber,
            cartNumber: projectedLine.cartNumber,
            partNumber: projectedLine.partNumber,
            orderNumber: projectedLine.orderNumber,
            batchNumber: projectedLine.batchNumber,
            cartBarcode: projectedLine.cartBarcode,
            testProjection: {
              status: "existing" as const,
              demandDetailId: projectedLine.id,
              loadNumber: projectedLine.loadNumber,
              sequence: projectedLine.sequence,
            },
          };
        }
        throw new DemandAppendError(
          "The captured inventory item is linked to unexpected demand.",
          "conflict",
        );
      }
      if (projected) {
        throw new DemandAppendError(
          "The inventory was saved, but this test projection belongs to an older demand batch. Start a new test load.",
          "conflict",
        );
      }
    }

    if (batch) {
      const existing = await db.prepare(`${FLATTENED_LINE_SELECT}
        WHERE h.batch_id = ? AND h.cart_key = ?
        ORDER BY d.sequence, d.id LIMIT 1`)
        .bind(batch.id, cartKeyForLine(firstRow)).first<DatabaseRecord>();
      if (existing) {
        const existingLine = lineFromRow(existing);
        if (!isGeneratedTestDemand(existingLine) || importFieldDiffers(
          existingLine,
          firstRow,
          APPEND_CART_LEVEL_FIELDS,
        )) {
          throw new DemandAppendError(
            "The generated test destination conflicts with existing non-test demand. Start a new test-load session.",
            "conflict",
          );
        }
        const appended = await appendTestProjectionDetail({
          targetLineId: String(existing.id),
          projectionId: inventoryProjection.id,
          rawValues: input.rawValues,
          operatorName: input.operatorName,
        });
        await completeInventoryDemandProjection(db, inventoryProjection.id, appended.lineId);
        return {
          ...responseBase,
          ...appended,
          duplicate: !inventory.created,
          testMode: true as const,
          inventoryId: inventory.item.id,
          inventoryCreated: inventory.created,
          inventory: inventoryResult,
          projectionStatus: appended.duplicate ? "existing" as const : "created" as const,
          checksheetNumber: context.checksheetNumber,
          orderNumber: context.orderNumber,
          batchNumber: context.batchNumber,
          cartBarcode: String(existing.cart_barcode || ""),
          testProjection: {
            status: appended.duplicate ? "existing" as const : "created" as const,
            demandDetailId: appended.lineId,
            loadNumber: context.loadNumber,
            sequence: appended.sequence,
          },
        };
      }
    }

    const retiredSession = await db.prepare(`SELECT 1 FROM demand_headers h
      JOIN import_batches b ON b.id = h.batch_id
      WHERE h.cart_key = ? AND h.program_id = 'TESTSCAN' AND h.pymtc = ?
        AND b.is_active = 0
      LIMIT 1`)
      .bind(cartKeyForLine(firstRow), firstRow.pymtc).first();
    if (retiredSession) {
      throw new DemandAppendError(
        "The inventory was saved, but this test-load session belongs to an older demand batch. Start a new test load.",
        "conflict",
      );
    }

    // Inventory is already committed above. This adapter creates pending test
    // demand only so the existing verification flow can be exercised.
    const created = await appendImportRow(
      `Physical label test load ${context.loadNumber}`,
      firstRow,
      inventoryProjection.id,
    );
    const stored = await db.prepare(`${FLATTENED_LINE_SELECT}
      WHERE h.batch_id IN (
        SELECT id FROM import_batches WHERE is_active = 1
      ) AND h.cart_key = ? AND d.id = ?
      ORDER BY d.sequence, d.id LIMIT 1`)
      .bind(cartKeyForLine(firstRow), inventoryProjection.id).first<DatabaseRecord>();
    if (!stored) {
      throw new DemandAppendError(
        "The generated test load was superseded before it could be opened. Start a new test-load session.",
        "conflict",
      );
    }
    await completeInventoryDemandProjection(db, inventoryProjection.id, String(stored.id));
    return {
      ...responseBase,
      projectionStatus: "created" as const,
      lineId: String(stored.id),
      sequence: firstRow.sequence,
      loadNumber: context.loadNumber,
      picklistNumber: context.picklistNumber,
      checksheetNumber: context.checksheetNumber,
      cartNumber: context.cartNumber,
      partNumber: firstRow.partNumber,
      orderNumber: context.orderNumber,
      batchNumber: context.batchNumber,
      cartBarcode: String(stored.cart_barcode || ""),
      totalRowCount: created.totalRowCount,
      testProjection: {
        status: "created" as const,
        demandDetailId: String(stored.id),
        loadNumber: context.loadNumber,
        sequence: firstRow.sequence,
      },
    };
  } catch (error) {
    let recoveredProjection: CartLine | null = null;
    if (projectionId) {
      try {
        recoveredProjection = await recoverInventoryDemandProjection(
          db,
          projectionId,
          proposedFirstRow,
        );
        if (!recoveredProjection && isProjectionContention(error)) {
          recoveredProjection = await waitForInventoryDemandProjection(
            db,
            projectionId,
            proposedFirstRow,
          );
        }
      } catch {
        // Recovery is best-effort. The inventory record remains durable and a
        // later retry can finish the test-only demand projection.
      }
    }
    if (recoveredProjection) {
      return {
        ...responseBase,
        projectionStatus: "existing" as const,
        lineId: recoveredProjection.id,
        sequence: recoveredProjection.sequence,
        loadNumber: recoveredProjection.loadNumber,
        picklistNumber: recoveredProjection.picklistNumber,
        checksheetNumber: recoveredProjection.checksheetNumber,
        cartNumber: recoveredProjection.cartNumber,
        partNumber: recoveredProjection.partNumber,
        orderNumber: recoveredProjection.orderNumber,
        batchNumber: recoveredProjection.batchNumber,
        cartBarcode: recoveredProjection.cartBarcode,
        testProjection: {
          status: "existing" as const,
          demandDetailId: recoveredProjection.id,
          loadNumber: recoveredProjection.loadNumber,
          sequence: recoveredProjection.sequence,
        },
      };
    }
    const projectionError = error instanceof DemandAppendError || error instanceof DemandCaptureValidationError
      ? error.message
      : "Inventory was saved, but its test-demand projection could not be created. Retry shortly.";
    try {
      if (projectionId) await failInventoryDemandProjection(db, projectionId, projectionError);
    } catch {
      // The inventory item remains the durable result even if projection audit
      // status cannot be updated during a transient database failure.
    }
    return {
      ...responseBase,
      projectionStatus: "failed" as const,
      partNumber: inventory.item.part_number,
      testProjection: {
        status: "failed" as const,
        error: projectionError,
      },
    };
  }
}

async function appendTestProjectionDetail(input: {
  targetLineId: string;
  projectionId: string;
  rawValues: unknown;
  operatorName: string;
}) {
  const captured = parseDemandCaptureValues(input.rawValues);
  const db = await ensureDatabase();
  const sourceRow = await db.prepare(`${FLATTENED_LINE_SELECT}
    WHERE d.id = ? AND h.batch_id IN (
      SELECT id FROM import_batches WHERE is_active = 1
    ) LIMIT 1`).bind(input.targetLineId).first<DatabaseRecord>();
  if (!sourceRow) {
    throw new DemandAppendError(
      "The selected load/checksheet is no longer part of the active demand.",
      "conflict",
    );
  }

  const source = lineFromRow(sourceRow);
  if (source.areaType !== "offsite" || !isGeneratedTestDemand(source)) {
    throw new DemandAppendError(
      "Inventory labels can only be projected into a generated TEST load.",
      "conflict",
    );
  }

  const appendLock = await acquireDemandAppendLock(
    db,
    source,
    `Label intake · ${input.operatorName.trim() || "PPA operator"}`,
  );
  try {
    const currentRow = await db.prepare(`${FLATTENED_LINE_SELECT}
      WHERE d.id = ? AND h.batch_id = ? AND h.batch_id IN (
        SELECT id FROM import_batches WHERE is_active = 1
      ) LIMIT 1`).bind(input.targetLineId, source.batchId).first<DatabaseRecord>();
    if (!currentRow) {
      throw new DemandAppendError(
        "The active demand changed before the physical label could be added.",
        "conflict",
      );
    }

    const current = lineFromRow(currentRow);
    const headerId = String(currentRow.header_id);
    const details = await db.prepare(`SELECT id, sequence, part_number, color, quantity, aiag_serial, status
      FROM demand_details WHERE header_id = ? ORDER BY sequence, id`)
      .bind(headerId).all<CapturedDetailRow>();
    const matchingProjection = details.results.find((detail) => detail.id === input.projectionId);
    if (matchingProjection) return {
      ok: true as const, duplicate: true as const, lineId: matchingProjection.id,
      sequence: matchingProjection.sequence, loadNumber: current.loadNumber,
      picklistNumber: current.picklistNumber, cartNumber: current.cartNumber,
      partNumber: matchingProjection.part_number,
    };

    if (current.loadedAt) {
      throw new DemandAppendError(
        `Cart ${current.cartNumber} is already loaded and cannot accept physical-label demand.`,
        "conflict",
      );
    }
    if (details.results.some((detail) => detail.status === "verified")) {
      throw new DemandAppendError(
        `Cart ${current.cartNumber} already has verified demand and cannot accept a physical label.`,
        "conflict",
      );
    }

    const sequence = nextCapturedSequence(details.results.map((detail) => detail.sequence));
    const row = validatedCapturedImportRow(capturedImportRow(current, captured.values, sequence));
    const detailId = input.projectionId;
    const baseGuard = demandSnapshotGuard(db, currentRow, appendLock);
    const results = await db.guardedBatch([
      prepareDetailInsert(db, headerId, detailId, row),
      db.prepare(`UPDATE import_batches SET row_count = row_count + 1
        WHERE id = ? AND is_active = 1`).bind(current.batchId),
      db.prepare("UPDATE demand_headers SET revision = revision + 1 WHERE id = ?").bind(headerId),
    ], db.prepare(`${baseGuard.query} AND NOT EXISTS (
      SELECT 1 FROM demand_details WHERE header_id = ? AND status <> 'pending'
    )`).bind(...baseGuard.values, headerId));
    if (Number(results[1]?.meta.changes || 0) !== 1) {
      await db.prepare("DELETE FROM demand_details WHERE id = ?").bind(detailId).run();
      throw new DemandAppendError(
        "The active demand changed before the physical label could be added.",
        "conflict",
      );
    }

    return {
      ok: true as const,
      duplicate: false as const,
      lineId: detailId,
      sequence,
      loadNumber: current.loadNumber,
      picklistNumber: current.picklistNumber,
      cartNumber: current.cartNumber,
      partNumber: row.partNumber,
    };
  } finally {
    await releaseDemandAppendLock(db, appendLock);
  }
}

async function findIntegrationReceipt(
  db: Database,
  source: string,
  idempotencyKey: string,
  contentHash: string,
) {
  if (idempotencyKey) {
    const byKey = await db.prepare(`SELECT * FROM integration_imports
      WHERE source = ? AND idempotency_key = ? LIMIT 1`)
      .bind(source, idempotencyKey).first<IntegrationReceiptRow>();
    if (byKey) {
      if (byKey.content_hash !== contentHash) {
        throw new IntegrationImportError(
          "This Idempotency-Key was already used for different demand content.",
          "idempotency_conflict",
        );
      }
      return byKey;
    }
    // An explicit new key is a new operation. Preserve each key's immutable
    // content binding, including when its content matches an older snapshot.
    return null;
  }
  return db.prepare(`SELECT * FROM integration_imports
    WHERE source = ? AND content_hash = ? AND idempotency_key = ''
    ORDER BY created_at DESC, id DESC LIMIT 1`)
    .bind(source, contentHash).first<IntegrationReceiptRow>();
}

function completedIntegrationResult(receipt: IntegrationReceiptRow) {
  if (receipt.status !== "complete" || !receipt.imported_at) {
    throw new IntegrationImportError(
      "An identical automated demand import is already being processed. Retry shortly.",
      "import_in_progress",
    );
  }
  return {
    batchId: receipt.batch_id,
    rowCount: Number(receipt.row_count),
    importedAt: receipt.imported_at,
    idempotentReplay: true,
  };
}

async function integrationReceiptBatchIsActive(db: Database, receipt: IntegrationReceiptRow) {
  const batch = await db.prepare("SELECT is_active FROM import_batches WHERE id = ? LIMIT 1")
    .bind(receipt.batch_id).first<{ is_active: number }>();
  return batch?.is_active === 1;
}

export async function replaceIntegrationImport(input: {
  source: string;
  fileName: string;
  rows: ImportRow[];
  idempotencyKey: string;
  contentHash: string;
  allowShrink?: boolean;
}) {
  const db = await ensureDatabase();
  const rows = validatedImportRows(input.rows);
  const now = new Date();
  const nowIso = now.toISOString();
  const claimExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();

  await pruneImportHistory(db, now);
  await db.prepare("DELETE FROM integration_imports WHERE status = 'processing' AND expires_at <= ?")
    .bind(nowIso).run();
  const existing = await findIntegrationReceipt(
    db,
    input.source,
    input.idempotencyKey,
    input.contentHash,
  );
  if (existing) {
    const matchedExplicitKey = Boolean(
      input.idempotencyKey && existing.idempotency_key === input.idempotencyKey,
    );
    if (matchedExplicitKey || existing.status !== "complete" ||
        await integrationReceiptBatchIsActive(db, existing)) {
      return completedIntegrationResult(existing);
    }
    // Content equality deduplicates retries of the active snapshot only. If an
    // intervening activation made this batch historical, the same content is a
    // legitimate new snapshot and must be allowed to activate again.
    await db.prepare("DELETE FROM integration_imports WHERE id = ? AND status = 'complete'")
      .bind(existing.id).run();
  }

  const receiptId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  try {
    const claim = await db.prepare(`INSERT INTO integration_imports (
      id, source, idempotency_key, content_hash, file_name, status, batch_id,
      row_count, imported_at, created_at, expires_at
    ) SELECT ?, ?, ?, ?, ?, 'processing', ?, 0, NULL, ?, ?
    WHERE NOT EXISTS (
        SELECT 1 FROM integration_imports WHERE status = 'processing' AND expires_at > ?
      ) ON CONFLICT DO NOTHING`)
      .bind(
        receiptId, input.source, input.idempotencyKey, input.contentHash,
        input.fileName.slice(0, 180), batchId, nowIso, claimExpiresAt, nowIso,
      ).run();
    if (Number(claim.meta.changes || 0) !== 1) {
      throw new IntegrationImportError(
        "Another automated demand activation is already in progress. Retry shortly.",
        "import_in_progress",
      );
    }
  } catch (error) {
    if (error instanceof IntegrationImportError) throw error;
    const concurrent = await findIntegrationReceipt(
      db,
      input.source,
      input.idempotencyKey,
      input.contentHash,
    );
    if (concurrent) return completedIntegrationResult(concurrent);
    throw error;
  }

  const result = await activateImport(db, {
    batchId,
    fileName: input.fileName,
    rows,
    sourceScope: input.source, actorId: `integration:${input.source}`, actorName: input.source,
    integrationReceiptId: receiptId, allowShrink: input.allowShrink,
  });
  return { ...result, idempotentReplay: false };
}

export async function manageLock(input: {
  action: "acquire" | "renew" | "release" | "release_own";
  cartKey: string;
  picklistKey?: string;
  sessionId: string;
  operatorName: string;
  operatorId?: string;
  inventoryAvailable?: boolean;
}) {
  const db = await ensureDatabase();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const requestedPicklistKey = input.picklistKey?.trim() || picklistKeyFromCartKey(input.cartKey);
  await db.prepare("DELETE FROM cart_locks WHERE expires_at <= ?").bind(nowIso).run();

  if (input.action === "release") {
    const [release, remaining] = await db.batch([
      db.prepare("DELETE FROM cart_locks WHERE cart_key = ? AND session_id = ?")
        .bind(input.cartKey, input.sessionId),
      db.prepare("SELECT 1 FROM cart_locks WHERE cart_key = ? AND session_id = ?")
        .bind(input.cartKey, input.sessionId),
    ]);
    // Repeating an acknowledged release is successful; another operator's
    // lease is never removed or represented as owned by this session.
    return { released: Number(release.meta.changes || 0) === 1 || remaining.results.length === 0 };
  }

  if (input.action === "release_own") {
    // Display names are not identities. Legacy leases without an authenticated
    // owner expire normally or can be released by their exact scanner session.
    if (!input.operatorId) return { released: false };
    const released = await db.prepare(
      "DELETE FROM cart_locks WHERE picklist_key = ? AND operator_id = ?"
    ).bind(requestedPicklistKey, input.operatorId).run();
    return { released: Number(released.meta.changes || 0) > 0 };
  }

  const demandCart = await db.prepare(`SELECT h.id, h.cart_key FROM demand_headers h
    JOIN import_batches b ON b.id = h.batch_id
    WHERE b.is_active = 1 AND h.cart_key = ? LIMIT 1`)
    .bind(input.cartKey).first<{ id: string; cart_key: string }>();
  if (!demandCart) {
    return {
      locked: false,
      reason: "cart_missing" as const,
      error: "Cart is not available in the active demand batch.",
      lock: null,
    };
  }
  const closure = await db.prepare("SELECT short_closed_at FROM demand_headers WHERE id=?").bind(demandCart.id).first();
  if (closure?.short_closed_at) return { locked: false, reason: "picklist_closed" as const, error: "This picklist is closed with shortages. A supervisor must reset it before packing.", lock: null };
  if (await hasPicklistConflict(db, demandCart.id)) {
    return { locked: false, reason: "reconciliation_required" as const, error: PICKLIST_CONFLICT_MESSAGE, lock: null };
  }
  if (picklistKeyFromCartKey(demandCart.cart_key) !== requestedPicklistKey) {
    return {
      locked: false,
      reason: "picklist_mismatch" as const,
      error: "Cart does not belong to the requested picklist.",
      lock: null,
    };
  }

  const picklistLockRow = await db.prepare("SELECT * FROM cart_locks WHERE picklist_key = ?")
    .bind(requestedPicklistKey).first<DatabaseRecord>();
  const picklistLock = picklistLockRow ? lockFromRow(picklistLockRow) : null;
  if (picklistLock && picklistLock.sessionId !== input.sessionId) {
    return { locked: false, lock: lockForClient(picklistLock, input.sessionId, input.operatorId) };
  }
  if (picklistLock && picklistLock.cartKey !== input.cartKey) {
    if (input.action !== "acquire") {
      return { locked: false, lock: lockForClient(picklistLock, input.sessionId, input.operatorId) };
    }
    await db.prepare("DELETE FROM cart_locks WHERE picklist_key = ? AND session_id = ?")
      .bind(requestedPicklistKey, input.sessionId).run();
  }

  // Renew is also a safe reacquire. A sleeping handheld can miss its heartbeat,
  // but it may resume the same cart as long as another session has not claimed it.
  await db.prepare(`INSERT INTO cart_locks (
    cart_key, picklist_key, session_id, operator_name, acquired_at, expires_at, inventory_available, lease_id, operator_id
  ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE EXISTS (
    SELECT 1 FROM demand_headers h
    JOIN import_batches b ON b.id = h.batch_id
    WHERE b.is_active = 1 AND h.cart_key = ? AND h.short_closed_at IS NULL AND ${uniquePicklistSql()}
  ) AND NOT EXISTS (
    SELECT 1 FROM cart_locks WHERE picklist_key = ? AND session_id <> ? AND expires_at > ?
  )
  ON CONFLICT(cart_key) DO UPDATE SET
    picklist_key = excluded.picklist_key,
    session_id = excluded.session_id,
    operator_name = excluded.operator_name,
    operator_id = CASE WHEN excluded.operator_id <> '' THEN excluded.operator_id ELSE cart_locks.operator_id END,
    lease_id = CASE WHEN cart_locks.session_id = excluded.session_id AND cart_locks.expires_at > excluded.acquired_at
      THEN cart_locks.lease_id ELSE excluded.lease_id END,
    acquired_at = CASE
      WHEN cart_locks.session_id = excluded.session_id THEN cart_locks.acquired_at
      ELSE excluded.acquired_at
    END,
    expires_at = excluded.expires_at,
    inventory_available = CASE
      WHEN cart_locks.session_id = excluded.session_id THEN cart_locks.inventory_available
      ELSE excluded.inventory_available
    END
  WHERE cart_locks.session_id = excluded.session_id
     OR cart_locks.expires_at <= excluded.acquired_at`).bind(
    input.cartKey, requestedPicklistKey, input.sessionId, input.operatorName, nowIso, expiresAt,
    0, crypto.randomUUID(), input.operatorId || "", input.cartKey, requestedPicklistKey, input.sessionId, nowIso,
  ).run();

  const row = await db.prepare("SELECT * FROM cart_locks WHERE cart_key = ?")
    .bind(input.cartKey).first<DatabaseRecord>();
  const lock = row ? lockFromRow(row) : null;
  if (!lock || lock.sessionId !== input.sessionId) {
    const conflictingRow = lock ? null : await db.prepare("SELECT * FROM cart_locks WHERE picklist_key = ?")
      .bind(requestedPicklistKey).first<DatabaseRecord>();
    const conflict = lock || (conflictingRow ? lockFromRow(conflictingRow) : null);
    if (!conflict) {
      return {
        locked: false,
        reason: "cart_missing" as const,
        error: "Cart is no longer available in the active demand batch.",
        lock: null,
      };
    }
    return { locked: false, lock: conflict ? lockForClient(conflict, input.sessionId, input.operatorId) : null };
  }
  return { locked: true, lock: lockForClient(lock, input.sessionId, input.operatorId) };
}

function databaseNow(db: Database) {
  return db.dialect === "sqlite"
    ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
    : `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function demandSnapshotGuard(db: Database, row: DatabaseRecord, lock?: { cartKey: string; sessionId: string; acquiredAt?: string; leaseId?: string }) {
  const values: Array<string | number | null> = [String(row.id), Number(row.header_revision || 0), Number(row.detail_revision || 0)];
  let lease = "";
  if (lock) {
    lease = `AND EXISTS (SELECT 1 FROM cart_locks l WHERE l.cart_key = ?
      AND l.session_id = ? AND l.expires_at > ${databaseNow(db)}${lock.acquiredAt ? " AND l.acquired_at = ?" : ""}${lock.leaseId !== undefined ? " AND l.lease_id = ?" : ""})`;
    values.push(lock.cartKey, lock.sessionId);
    if (lock.acquiredAt) values.push(lock.acquiredAt);
    if (lock.leaseId !== undefined) values.push(lock.leaseId);
  }
  return db.prepare(`EXISTS (
    SELECT 1 FROM demand_details d JOIN demand_headers h ON h.id = d.header_id
    JOIN import_batches b ON b.id = h.batch_id
    WHERE d.id = ? AND h.revision = ? AND d.revision = ?
      AND b.is_active = 1 AND h.loaded_at IS NULL AND h.short_closed_at IS NULL AND d.status IN ('pending', 'active') AND ${uniquePicklistSql()} ${lease}
  )`).bind(...values);
}

/** Stored identity fields are printable ASCII. Mirror scanner AIM framing and
 * case normalization in SQL so the uniqueness check can run at commit time. */
function identityBarcodeSql(column: string) {
  const value = `TRIM(${column})`;
  return `UPPER(TRIM(CASE WHEN SUBSTR(${value},1,1)=']'
    AND UPPER(SUBSTR(${value},2,1)) BETWEEN 'A' AND 'Z' AND SUBSTR(${value},3,1) BETWEEN '0' AND '9'
    THEN SUBSTR(${value},4) ELSE ${value} END))`;
}

function uniqueScannedPicklistGuard(db: Database, line: CartLine, barcode: string) {
  const movementColumn = line.areaType === "offsite" ? "peer.load_number" : "peer.train_number";
  const candidates = ["cart_barcode", "picklist_number", "checksheet_number", "master_barcode", "order_number"];
  return db.prepare(`(SELECT COUNT(*) FROM demand_headers peer JOIN import_batches active ON active.id=peer.batch_id
    WHERE active.is_active=1 AND ${identityBarcodeSql("peer.plant") }=? AND peer.area_type=?
      AND ${identityBarcodeSql(movementColumn)}=?
      AND (${candidates.map((column) => `${identityBarcodeSql(`peer.${column}`)}=?`).join(" OR ")}))=1`)
    .bind(normalizeIdentityBarcode(line.plant), line.areaType, normalizeIdentityBarcode(expectedMovementNumber(line)),
      ...candidates.map(() => normalizeIdentityBarcode(barcode)));
}

export async function recordScan(input: {
  lineId: string; cartKey: string; field: string; value: string; rawValue?: string;
  sessionId: string; operatorName: string; operatorId?: string; formatOnly?: boolean; testMode?: boolean;
}) {
  // Packing now resolves a container from inventory; field scans cannot fulfil demand.
  if (input.field !== "cartBarcode" || input.testMode || input.formatOnly) {
    return { ok: false, reason: "invalid_field" as const, error: "Scan the cart, then fulfil demand using an inventory serial number.", verified: false, matched: false };
  }
  const db = await ensureDatabase();
  const lockRow = await db.prepare(`SELECT * FROM cart_locks
    WHERE cart_key = ? AND session_id = ? AND expires_at > ${databaseNow(db)}`)
    .bind(input.cartKey, input.sessionId).first<DatabaseRecord>();
  if (!lockRow) return { ok: false, reason: "lock_lost" as const };
  const lineRow = await getActiveDemandRow(db, input.lineId);
  const line = lineRow ? lineFromRow(lineRow) : null;
  if (!lineRow || !line || cartKeyForLine(line) !== input.cartKey) return { ok: false, reason: "line_missing" as const };
  if (await hasPicklistConflict(db, String(lineRow.header_id))) return { ok: false, reason: "reconciliation_required" as const, error: PICKLIST_CONFLICT_MESSAGE };
  const isTest = isGeneratedTestDemand(line);
  const rawValue = cleanScannerPayload(input.rawValue || input.value);
  if (!rawValue || rawValue.length > 512) return { ok: false, reason: "empty_scan" as const };
  const matched = picklistBarcodeMatches(line, rawValue);
  const uniqueness = uniqueScannedPicklistGuard(db, line, rawValue);
  if (matched && !Number((await db.prepare(`SELECT CASE WHEN (${uniqueness.query}) THEN 1 ELSE 0 END AS valid`)
    .bind(...uniqueness.values).first<{ valid: number }>())?.valid)) {
    return { ok: false, matched: false, verified: false, reason: "ambiguous_picklist" as const,
      error: "This label identifies more than one outbound card, including completed work. Scan a unique PPA Cart ID or have a supervisor correct the source labels." };
  }
  const snapshot = demandSnapshotGuard(db, lineRow, { cartKey: input.cartKey, sessionId: input.sessionId, leaseId: String(lockRow.lease_id || "") });
  try {
    await db.guardedBatch([db.prepare(`INSERT INTO scan_events
      (id, line_id, cart_key, session_id, field, scanned_value, matched, is_test, operator_name, created_at, lease_id, operator_id)
      VALUES (?, ?, ?, ?, 'cartBarcode', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), line.id, input.cartKey, input.sessionId, rawValue, matched ? 1 : 0,
        isTest ? 1 : 0, input.operatorName, new Date().toISOString(), String(lockRow.lease_id || ""), input.operatorId || "")],
      db.prepare(`${snapshot.query}${matched ? ` AND (${uniqueness.query})` : ""}`)
        .bind(...snapshot.values, ...(matched ? uniqueness.values : [])));
  } catch (error) {
    if (error instanceof DatabaseConflictError) return { ok: false, reason: "lock_lost" as const };
    throw error;
  }
  return { ok: true, matched, expected: line.cartBarcode, verified: false, missingFields: ["aiagSerial"] };
}

type FulfillmentInput = {
  lineId?: string; cartKey: string; serial: string; sessionId: string; operatorName: string; operatorId?: string;
  serialFormat?: SerialFormat; supplierId?: string; requestId?: string; quantity?: unknown;
};

/** Read a committed receipt even when the completed picklist is no longer open. */
export async function getFulfillmentReceipt(input: Pick<FulfillmentInput, "cartKey" | "serial" | "serialFormat" | "supplierId" | "requestId">) {
  const identity = input.serialFormat && resolveFulfillmentSerial(input.serial, input.serialFormat);
  if (!identity || !input.requestId?.trim()) return { ok: false, reason: "invalid_request", error: "Provide the saved packing request and its explicit serial format." };
  const db = await ensureDatabase();
  const receipt = await db.prepare(`SELECT a.*, h.cart_key AS receipt_cart_key, i.normalized_serial AS receipt_serial,
    i.supplier_id AS receipt_supplier FROM fulfillment_allocations a
    JOIN demand_details d ON d.id=a.demand_detail_id JOIN demand_headers h ON h.id=d.header_id
    JOIN inventory_items i ON i.id=a.inventory_item_id WHERE a.request_id=?`).bind(input.requestId).first<DatabaseRecord>();
  if (!receipt) return { ok: false, reason: "receipt_unconfirmed", error: "The previous scan is not confirmed. Reopen its picklist and retry the same container before starting another scan." };
  const matches = receipt.request_fingerprint === fulfillmentFingerprint(input, identity.canonicalSerial)
    || legacyFulfillmentFingerprints(input, identity.canonicalSerial).includes(String(receipt.request_fingerprint));
  if (!matches || receipt.receipt_serial !== identity.canonicalSerial
    || (input.supplierId !== undefined && (receipt.receipt_supplier || "") !== normalizeScanValue(input.supplierId))) {
    return { ok: false, reason: "reconciliation_required", error: "The saved packing receipt does not match this pending container. Ask a supervisor to reconcile it." };
  }
  if (receipt.reversed_at) return { ok: false, reason: "allocation_reversed", error: "The previous packing contribution was unpacked. Acknowledge the reset before starting a new scan." };
  if (receipt.receipt_cart_key !== input.cartKey) return { ok: false, reason: "reconciliation_required", error: "The saved packing receipt's current picklist no longer matches. Ask a supervisor to reconcile it." };
  return { ok: true, recorded: true, requestId: input.requestId, inventoryItemId: String(receipt.inventory_item_id),
    lineId: String(receipt.demand_detail_id), serial: String(receipt.serial), allocatedQuantity: Number(receipt.quantity) };
}

/** Each contribution is an immutable receipt; balances and demand change together. */
export async function fulfillDemand(input: FulfillmentInput) {
  const db = await ensureDatabase();
  const rawSerial = cleanScannerPayload(input.serial);
  if (!rawSerial || rawSerial.length > 512) return { ok: false, reason: "invalid_serial", error: "Scan a valid inventory serial number." };
  const identity = input.serialFormat === undefined ? null : resolveFulfillmentSerial(rawSerial, input.serialFormat);
  if (input.serialFormat !== undefined && !identity) return { ok: false, reason: "invalid_serial", error: "Scan the container serial barcode beginning with 1S, or provide an explicit canonical serial." };
  const suppliedRequestId = input.requestId?.trim();
  if (input.requestId !== undefined && (!suppliedRequestId || suppliedRequestId.length > 180 || /[\u0000-\u001f]/.test(suppliedRequestId))) {
    return { ok: false, reason: "invalid_request", error: "A valid packing request identifier is required." };
  }
  const legacyFingerprints = legacyFulfillmentFingerprints(input, identity?.canonicalSerial);
  const fingerprint = identity ? fulfillmentFingerprint(input, identity.canonicalSerial) : null;
  const updateRequired = { ok: false as const, reason: "client_update_required", error: "Refresh this station to update its serial scanner. Keep the pending request so an interrupted scan can be checked safely." };
  if (!identity && !suppliedRequestId) return updateRequired;
  for (let attempt = 0; attempt < 5; attempt++) {
    const settings = await readFulfillmentSettings(db);
    if (settings.packingMode === "multiple" && !suppliedRequestId) return { ok: false, reason: "invalid_request", error: "Multiple-container packing requires a request identifier so retries cannot consume stock twice." };
    const lockRow = await db.prepare(`SELECT * FROM cart_locks WHERE cart_key = ? AND session_id = ? AND expires_at > ${databaseNow(db)}`)
      .bind(input.cartKey, input.sessionId).first<DatabaseRecord>();
    if (!lockRow) return { ok: false, reason: "lock_lost", error: "The cart lease expired. Scan the cart again." };
    const requested = suppliedRequestId ? await db.prepare("SELECT * FROM fulfillment_allocations WHERE request_id = ?").bind(suppliedRequestId).first<DatabaseRecord>() : null;
    // Only the server can distinguish a rejected new contribution from an
    // existing or uncertain receipt that the browser must preserve.
    const retryDisposition = requested ? "unconfirmed" as const : "not_allocated" as const;
    if (!requested && !identity) return updateRequired;
    if (requested && requested.request_fingerprint !== fingerprint && !legacyFingerprints.includes(String(requested.request_fingerprint))) return { ok: false, reason: "request_conflict", error: "This packing request identifier was used with different values." };
    if (requested?.reversed_at) return { ok: false, reason: "allocation_reversed", error: "This packing contribution was unpacked. Start a new scan." };
    const rows = (await db.prepare(`${FLATTENED_LINE_SELECT} WHERE h.cart_key = ? AND h.batch_id IN (SELECT id FROM import_batches WHERE is_active = 1)`)
      .bind(input.cartKey).all<DatabaseRecord>()).results;
    const lines = rows.map(lineFromRow).sort(comparePackingLines);
    const explicitLine = input.lineId ? lines.find((line) => line.id === input.lineId) : undefined;
    if (!lines.length || (input.lineId && !explicitLine)) return { ok: false, retryDisposition, reason: "line_missing", error: "This demand is no longer available in the selected picklist." };
    if (await hasPicklistConflict(db, String(rows[0].header_id))) return { ok: false, retryDisposition, reason: "reconciliation_required", error: PICKLIST_CONFLICT_MESSAGE };
    const isTest = isGeneratedTestDemand(lines[0]);
    const supplierId = input.supplierId !== undefined ? normalizeScanValue(input.supplierId)
      : explicitLine?.preferredSupplierId ? normalizeScanValue(explicitLine.preferredSupplierId) : undefined;
    // A saved request replays its immutable allocation; stock lookups can never
    // redirect it to a newly received container with a similar serial.
    const candidates = requested
      ? await db.prepare(`${INVENTORY_SELECT} WHERE id = ? AND is_test = ?`).bind(requested.inventory_item_id, isTest ? 1 : 0).all<StoredInventoryItem>()
      : await db.prepare(`${INVENTORY_SELECT} WHERE normalized_serial = ? AND is_test = ? ${supplierId !== undefined ? "AND supplier_id = ?" : ""}`)
        .bind(identity!.canonicalSerial, isTest ? 1 : 0, ...(supplierId !== undefined ? [supplierId] : [])).all<StoredInventoryItem>();
    if (candidates.results.length > 1) return { ok: false, retryDisposition, reason: "ambiguous_serial", suppliers: [...new Set(candidates.results.map((item) => item.supplier_id || ""))], error: "This serial identifies more than one container. Select its supplier, or scan the complete supplier label." };
    const item = candidates.results[0];
    if (requested && (!item || !lines.some((line) => line.id === requested.demand_detail_id)
      || (identity && item.normalized_serial !== identity.canonicalSerial)
      || (supplierId !== undefined && (item.supplier_id || "") !== supplierId))) {
      return { ok: false, reason: "reconciliation_required", error: "The saved packing receipt belongs to a different container or demand. Ask a supervisor to reconcile it before scanning again." };
    }
    if (!item) {
      return { ok: false, retryDisposition, reason: "inventory_not_found", serial: identity!.canonicalSerial, inventoryMode: settings.inventoryMode,
        error: "Serial number not found in inventory. Scan this container's part, color and quantity to receive and match it to the picklist." };
    }
    const contributions = (await db.prepare("SELECT * FROM fulfillment_allocations WHERE inventory_item_id = ? AND reversed_at IS NULL").bind(item.id).all<DatabaseRecord>()).results;
    const previous = requested || contributions.find((entry) => input.lineId ? entry.demand_detail_id === input.lineId : settings.packingMode === "exact" && lines.some((line) => line.id === entry.demand_detail_id));
    const actual = { partNumber: item.part_number, color: item.part_level, quantity: Number(item.quantity), unitOfMeasure: item.unit_of_measure || "EA", supplierId: item.supplier_id || "" };
    // The physical container chooses demand by contents. Pack sequence breaks
    // ties between matching rows but never blocks a different matching part.
    const selection = checkPackingDemand(lines, actual, settings.packingMode, settings.partAttribute);
    const firstRemaining = lines.find((candidate) => candidate.status === "pending" || candidate.status === "active");
    const line = previous ? lines.find((candidate) => candidate.id === previous.demand_detail_id)
      : explicitLine || selection.line || firstRemaining;
    const replay = previous || (line && contributions.find((entry) => entry.demand_detail_id === line.id));
    if (replay && line) {
      if (Number(item.consumed_quantity || 0) < Number(replay.quantity) || !["consumed", "partially_consumed"].includes(item.status)) {
        return { ok: false, reason: "demand_fulfilled", error: "This demand has already fulfilled stock whose balance needs supervisor review." };
      }
      return { ok: true, verified: line.status === "verified", alreadyFulfilled: true, lineId: line.id,
        inventoryItemId: item.id, serial: item.aiag_serial, fulfilledQuantity: line.fulfilledQuantity,
        remainingQuantity: Math.max(0, Number((line.quantity - line.fulfilledQuantity).toFixed(6))), allocatedQuantity: Number(replay.quantity) };
    }
    if (item.status === "consumed" || Number(item.consumed_quantity || 0) >= Number(item.quantity)) return { ok: false, retryDisposition, reason: "inventory_consumed", error: "This container has already been consumed." };
    if (lines[0].shortClosedAt || lines.some((candidate) => candidate.status === "short")) return { ok: false, retryDisposition, reason: "picklist_closed", error: "This picklist was closed with shortages. A supervisor must reset it before packing." };
    if (!line) return { ok: false, retryDisposition, reason: "demand_fulfilled", error: "All demand on this picklist has already been fulfilled." };
    if (line.status === "verified" || line.loadedAt) return { ok: false, retryDisposition, reason: "demand_fulfilled", error: "This demand line is already fulfilled or loaded." };
    if (item.status === "expected") return { ok: false, retryDisposition, reason: "inventory_expected", inventory: productionInventoryItem(item), error: "This container is expected but has not been received. Confirm its physical arrival before packing." };
    if (!["available", "partially_consumed"].includes(item.status)) return { ok: false, retryDisposition, reason: "inventory_unavailable", error: "This container is deleted or unavailable." };
    if (settings.packingMode === "exact" && (Number(item.consumed_quantity || 0) > 0 || contributions.length)) return { ok: false, retryDisposition, reason: "inventory_consumed", error: "Exact packing requires a complete unused container." };
    const lineRow = rows.find((row) => row.id === line.id)!;
    const legacyScans = await db.prepare(`SELECT e.scanned_value FROM scan_events e
      JOIN demand_details d ON d.id = e.line_id JOIN demand_headers h ON h.id = d.header_id
      WHERE h.loaded_at IS NOT NULL AND d.inventory_item_id IS NULL
      AND e.field = 'aiagSerial' AND e.matched = 1 AND e.is_test = ? AND e.invalidated_at IS NULL
      AND (UPPER(TRIM(d.legacy_expected_serial)) = ? OR UPPER(TRIM(e.scanned_value)) IN (?, ?))`)
      .bind(isTest ? 1 : 0, item.normalized_serial, item.normalized_serial, `1S${item.normalized_serial}`).all<{ scanned_value: string }>();
    if (legacyScans.results.some((scan) => normalizeScanValue(cleanScannerPayload(scan.scanned_value).replace(/^(?:[1-9]S|S)/i, "")) === item.normalized_serial
      || normalizeScanValue(cleanScannerPayload(scan.scanned_value)) === item.normalized_serial)) return { ok: false, retryDisposition, reason: "inventory_legacy_review", error: "This serial has scan evidence on a previously loaded cart. A supervisor must reconcile its historical use." };
    const leaseId = String(lockRow.lease_id || "");
    const cartEvidence = `EXISTS (SELECT 1 FROM scan_events e JOIN demand_details ed ON ed.id = e.line_id
      WHERE e.cart_key = ? AND e.session_id = ? AND e.lease_id = ? AND e.field = 'cartBarcode'
      AND e.matched = 1 AND e.is_test = ? AND e.invalidated_at IS NULL AND ed.header_id = ?)`;
    const evidenceValues = [input.cartKey, input.sessionId, leaseId, isTest ? 1 : 0, String(lineRow.header_id)];
    if (!(await db.prepare(`SELECT 1 WHERE ${cartEvidence}`).bind(...evidenceValues).first())) return { ok: false, retryDisposition, reason: "cart_not_scanned", error: "Scan the picklist label before scanning inventory." };
    const differences = packingDemandDifferences(actual, line, settings.packingMode);
    const baseGuard = demandSnapshotGuard(db, lineRow, { cartKey: input.cartKey, sessionId: input.sessionId, leaseId });
    const now = new Date().toISOString();
    if (differences.length) {
      try {
        await db.guardedBatch([db.prepare(`INSERT INTO scan_events
          (id,line_id,cart_key,session_id,field,scanned_value,matched,is_test,operator_name,created_at,lease_id,operator_id)
          VALUES (?,?,?,?,'aiagSerial',?,0,?,?,?,?,?)`).bind(crypto.randomUUID(), line.id, input.cartKey, input.sessionId, rawSerial, isTest ? 1 : 0, input.operatorName, now, leaseId, input.operatorId || "")],
          db.prepare(`${baseGuard.query} AND ${cartEvidence}`).bind(...baseGuard.values, ...evidenceValues));
      } catch (error) { if (error instanceof DatabaseConflictError) continue; throw error; }
      return { ok: false, retryDisposition, reason: "inventory_mismatch", expected: { partNumber: line.partNumber, color: line.color, quantity: line.quantity, unitOfMeasure: line.unitOfMeasure || "EA" }, actual, error: !input.lineId && !selection.line ? selection.message : `Container mismatch: ${differences.join("; ")}.` };
    }
    const unit = line.unitOfMeasure || "EA";
    const demandRemaining = quantityToScaled(line.quantity, unit) - quantityToScaled(line.fulfilledQuantity, unit);
    // Neon returns NUMERIC(20,6) as decimal text, including "20.000000" for EA.
    // Normalize database values before applying the whole-piece quantity rules.
    const stockConsumed = quantityToScaled(Number(item.consumed_quantity || 0), unit);
    const stockRemaining = quantityToScaled(Number(item.quantity), unit) - stockConsumed;
    let contribution = settings.packingMode === "exact" ? demandRemaining : demandRemaining < stockRemaining ? demandRemaining : stockRemaining;
    if (input.quantity !== undefined) {
      const parsed = parseQuantity(input.quantity, unit);
      if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false, retryDisposition, reason: "invalid_quantity", error: "Packing quantity must be positive and valid for the unit of measure." };
      const specified = quantityToScaled(parsed, unit);
      if (specified !== contribution) return { ok: false, retryDisposition, reason: "invalid_quantity", error: "Packing quantity must equal the smaller of remaining demand and available container quantity." };
      contribution = specified;
    }
    if (contribution <= 0n || contribution > stockRemaining) return { ok: false, retryDisposition, reason: "inventory_consumed", error: "This container has no available quantity." };
    const allocatedQuantity = Number(contribution) / Number(QUANTITY_SCALE);
    const fulfilledQuantity = Number(quantityToScaled(line.fulfilledQuantity, unit) + contribution) / Number(QUANTITY_SCALE);
    const consumedQuantity = Number(stockConsumed + contribution) / Number(QUANTITY_SCALE);
    const remainingQuantity = Number(demandRemaining - contribution) / Number(QUANTITY_SCALE);
    const verified = remainingQuantity === 0;
    const inventoryStatus = contribution === stockRemaining ? "consumed" : "partially_consumed";
    const allocationId = crypto.randomUUID();
    const requestId = suppliedRequestId || allocationId;
    const condition = db.prepare(`${baseGuard.query} AND ${cartEvidence}
      AND EXISTS (SELECT 1 FROM fulfillment_settings WHERE id='primary' AND packing_mode=? AND inventory_mode=?)
      AND EXISTS (SELECT 1 FROM inventory_items WHERE id=? AND status=? AND consumed_quantity=? AND quantity=? AND is_test=? AND part_number=? AND part_level=? AND unit_of_measure=? AND supplier_id=?)
      AND NOT EXISTS (SELECT 1 FROM fulfillment_allocations WHERE request_id=? OR (demand_detail_id=? AND inventory_item_id=? AND reversed_at IS NULL))`)
      .bind(...baseGuard.values, ...evidenceValues, settings.packingMode, settings.inventoryMode, item.id, item.status,
        Number(item.consumed_quantity || 0), item.quantity, isTest ? 1 : 0, item.part_number, item.part_level, item.unit_of_measure || "EA", item.supplier_id || "", requestId, line.id, item.id);
    try {
      await db.guardedBatch([
        db.prepare(`INSERT INTO fulfillment_allocations (id,request_id,request_fingerprint,demand_detail_id,inventory_item_id,quantity,serial,packed_at,packed_by,operator_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(allocationId, requestId, fingerprint, line.id, item.id, allocatedQuantity, item.aiag_serial, now, input.operatorName, input.operatorId || ""),
        db.prepare("UPDATE inventory_items SET status=?, consumed_quantity=?, consumed_at=? WHERE id=?").bind(inventoryStatus, consumedQuantity, now, item.id),
        db.prepare(`UPDATE demand_details SET inventory_item_id=COALESCE(inventory_item_id,?), aiag_serial=?, fulfilled_quantity=?, status=?, verified_at=?, fulfilled_at=?, fulfilled_by=?, revision=revision+1 WHERE id=?`)
          .bind(item.id, line.aiagSerial ? `${line.aiagSerial}, ${item.aiag_serial}` : item.aiag_serial, fulfilledQuantity, verified ? "verified" : "active", verified ? now : null, now, input.operatorName, line.id),
        db.prepare(`INSERT INTO scan_events (id,line_id,cart_key,session_id,field,scanned_value,matched,is_test,operator_name,created_at,lease_id,operator_id)
          VALUES (?,?,?,?,'aiagSerial',?,1,?,?,?,?,?)`).bind(crypto.randomUUID(), line.id, input.cartKey, input.sessionId, rawSerial, isTest ? 1 : 0, input.operatorName, now, leaseId, input.operatorId || ""),
        db.prepare(`INSERT INTO demand_audit_events (id,batch_id,header_id,line_id,action,before_json,after_json,actor_id,actor_name,created_at)
          VALUES (?,?,?,?,'fulfill',?,?,?,?,?)`).bind(crypto.randomUUID(), line.batchId, String(lineRow.header_id), line.id,
          JSON.stringify({ status: line.status, fulfilledQuantity: line.fulfilledQuantity }),
          JSON.stringify({ allocationId, inventoryItemId: item.id, serial: item.aiag_serial, quantity: allocatedQuantity, fulfilledQuantity, status: verified ? "verified" : "active", packingMode: settings.packingMode }), input.operatorId || "", input.operatorName, now),
      ], condition);
      return { ok: true, verified, alreadyFulfilled: false, lineId: line.id, inventoryItemId: item.id, serial: item.aiag_serial, fulfilledQuantity, remainingQuantity, allocatedQuantity };
    } catch (error) { if (!(error instanceof DatabaseConflictError)) throw error; }
  }
  return { ok: false, reason: "conflict", error: "Demand or inventory changed during packing. Refresh and retry the same scan." };
}

/** Legacy camera endpoint accepts only one serial; it uses the same stock transaction. */
export async function recordScanBatch(input: {
  lineId: string; cartKey: string; scans: Array<{ field: DemandScanField; rawValue: string }>;
  sessionId: string; operatorName: string; operatorId?: string; formatOnly?: boolean; testMode?: boolean;
}) {
  if (input.scans.length !== 1 || input.scans[0].field !== "aiagSerial" || input.formatOnly || input.testMode) {
    return { ok: false, matched: false, verified: false, scans: [], reason: "invalid_field", error: "Scan one inventory serial. Four-field and simulated verification have been retired." };
  }
  const result = await fulfillDemand({ ...input, serial: input.scans[0].rawValue, serialFormat: "barcode" });
  return { ...result, matched: result.ok, scans: result.ok ? input.scans : [] };
}

async function matchingPicklistHeaders(db: Database, barcode: string, movement: string) {
  const rows = await db.prepare(`${FLATTENED_LINE_SELECT} WHERE h.batch_id IN
    (SELECT id FROM import_batches WHERE is_active = 1) ORDER BY d.sequence`).all<DatabaseRecord>();
  const unique = new Map<string, DatabaseRecord>();
  for (const row of rows.results) if (picklistBarcodeMatches(lineFromRow(row), barcode)) unique.set(String(row.header_id), row);
  const all = [...unique.values()];
  const destinationMatches = all.filter((row) => movementBarcodeMatches(lineFromRow(row), movement));
  return destinationMatches.length ? destinationMatches : all;
}

export async function confirmCartLoading(input: {
  movementValue: string;
  cartBarcode: string;
  operatorName: string;
  operatorId?: string;
}) {
  const db = await ensureDatabase();
  const cartBarcode = normalizeIdentityBarcode(input.cartBarcode);
  const movementValue = normalizeIdentityBarcode(input.movementValue);
  const operatorName = String(input.operatorName || "").trim().slice(0, 120);
  if (!cartBarcode || !movementValue || !operatorName) {
    return { ok: false, reason: "invalid" as const, error: "Destination, PPA Cart ID, and operator are required." };
  }
  if (cartBarcode.length > 512 || movementValue.length > 512) {
    return { ok: false, reason: "invalid" as const, error: "A scanned loading value is too long." };
  }

  const candidates = await matchingPicklistHeaders(db, cartBarcode, movementValue);
  if (candidates.length > 1) return { ok: false, reason: "ambiguous_picklist" as const,
    error: "This label is ambiguous. Reconcile conflicting outbound cards or use a label unique to one valid picklist." };
  const row = candidates[0];
  if (!row) {
    return { ok: false, reason: "cart_missing" as const, error: "That PPA Cart ID is not in the active demand batch." };
  }

  if (await hasPicklistConflict(db, String(row.header_id))) return { ok: false, reason: "reconciliation_required" as const, error: PICKLIST_CONFLICT_MESSAGE };
  const line = lineFromRow(row);
  const movementNumber = expectedMovementNumber(line);
  if (!movementBarcodeMatches(line, movementValue)) {
    return {
      ok: false,
      reason: "wrong_movement" as const,
      error: `Blocked: cart ${line.cartNumber} is assigned to ${movementNumber}, not the scanned destination.`,
      expectedMovement: movementNumber,
    };
  }

  const headerId = String(row.header_id);
  const pending = await db.prepare(`SELECT COUNT(*) AS count FROM demand_details
    WHERE header_id = ? AND status <> 'verified'`).bind(headerId).first<{ count: number }>();
  if (Number(pending?.count || 0) > 0) {
    return {
      ok: false,
      reason: "not_packed" as const,
      error: `Cart ${line.cartNumber} is not fully packed. Finish every part scan before loading it.`,
    };
  }

  const testScan = await db.prepare(`SELECT COUNT(*) AS count
    FROM scan_events e JOIN demand_details d ON d.id = e.line_id
    WHERE d.header_id = ? AND e.matched = 1 AND e.is_test = 1`)
    .bind(headerId).first<{ count: number }>();
  const testMode = isGeneratedTestDemand(line);
  if (!testMode && Number(testScan?.count || 0) > 0) {
    return { ok: false, reason: "not_packed" as const, error: "This production cart contains test scan evidence and cannot be released for loading." };
  }
  const allocationEvidence = `d.fulfilled_quantity <> d.quantity
    OR (SELECT ROUND(COALESCE(SUM(a.quantity),0),6) FROM fulfillment_allocations a WHERE a.demand_detail_id=d.id AND a.reversed_at IS NULL) <> d.quantity
    OR NOT EXISTS (SELECT 1 FROM fulfillment_allocations a WHERE a.demand_detail_id=d.id AND a.reversed_at IS NULL)
    OR EXISTS (SELECT 1 FROM fulfillment_allocations a JOIN inventory_items i ON i.id=a.inventory_item_id
      WHERE a.demand_detail_id=d.id AND a.reversed_at IS NULL AND (i.status NOT IN ('consumed','partially_consumed') OR i.is_test <> ?
        OR i.consumed_quantity < (SELECT ROUND(COALESCE(SUM(allocation.quantity),0),6) FROM fulfillment_allocations allocation WHERE allocation.inventory_item_id=i.id AND allocation.reversed_at IS NULL)))
    OR NOT EXISTS (SELECT 1 FROM scan_events e WHERE e.line_id=d.id AND e.field='aiagSerial' AND e.matched=1 AND e.is_test=? AND e.invalidated_at IS NULL)`;
  const missingEvidence = await db.prepare(`SELECT 1 FROM demand_details d WHERE d.header_id=? AND (${allocationEvidence}) LIMIT 1`)
    .bind(headerId, testMode ? 1 : 0, testMode ? 1 : 0).first();
  if (missingEvidence && !line.loadedAt) {
    return { ok: false, reason: "not_packed" as const, error: "Every demand line requires a fulfilled inventory container before loading." };
  }

  const cartResult = (alreadyLoaded: boolean, loadedAt: string, loadedBy: string, loadingIsTest = testMode) => ({
    ok: true as const,
    alreadyLoaded,
    cart: {
      cartNumber: line.cartNumber,
      picklistNumber: line.picklistNumber,
      cartBarcode: line.cartBarcode,
      areaType: line.areaType,
      movementNumber,
      loadedAt,
      loadedBy,
      dispatchedAt: line.dispatchedAt || null,
      dispatchedBy: line.dispatchedBy || "",
      testMode: loadingIsTest,
    },
  });
  if (line.loadedAt) return cartResult(true, line.loadedAt, line.loadedBy);

  const now = new Date().toISOString();
  const confirmationId = crypto.randomUUID();
  try {
  await db.guardedBatch([
    db.prepare(`UPDATE demand_headers SET loaded_at = COALESCE(loaded_at, ?),
      loaded_by = CASE WHEN loaded_at IS NULL THEN ? ELSE loaded_by END
      WHERE id = ? AND batch_id = (
        SELECT id FROM import_batches WHERE is_active = 1 ORDER BY imported_at DESC, id DESC LIMIT 1
      ) AND NOT EXISTS (
        SELECT 1 FROM demand_details d WHERE d.header_id = demand_headers.id AND d.status <> 'verified'
      )`).bind(now, operatorName, headerId),
    db.prepare(`INSERT INTO load_confirmations (
      id, header_id, cart_barcode, movement_type, movement_number,
      scanned_movement, is_test, operator_name, created_at, operator_id
    ) SELECT ?, h.id, h.cart_barcode, ?, ?, ?, ?, ?, ?, ?
      FROM demand_headers h
      WHERE h.id = ? AND h.loaded_at = ? AND h.batch_id = (
        SELECT id FROM import_batches WHERE is_active = 1 ORDER BY imported_at DESC, id DESC LIMIT 1
      ) AND NOT EXISTS (
        SELECT 1 FROM demand_details d WHERE d.header_id = h.id AND d.status <> 'verified'
      ) ON CONFLICT DO NOTHING`).bind(
      confirmationId, line.areaType === "onsite" ? "train" : "load", movementNumber,
      movementValue, testMode ? 1 : 0, operatorName, now, input.operatorId || "", headerId, now,
    ),
  ], db.prepare(`EXISTS (SELECT 1 FROM demand_headers h JOIN import_batches b ON b.id = h.batch_id
    WHERE h.id = ? AND h.revision = ? AND b.is_active = 1 AND ${uniquePicklistSql()})
    AND NOT EXISTS (SELECT 1 FROM demand_details d WHERE d.header_id=? AND (d.status <> 'verified' OR ${allocationEvidence}))`)
    .bind(headerId, Number(row.header_revision || 0), headerId, testMode ? 1 : 0, testMode ? 1 : 0));
  } catch (error) {
    if (error instanceof DatabaseConflictError) {
      return { ok: false, reason: "not_packed" as const, error: "The cart changed before loading could be recorded. Refresh and scan again." };
    }
    throw error;
  }
  const stored = await db.prepare(`SELECT h.loaded_at, h.loaded_by,
      lc.id AS confirmation_id, COALESCE(lc.is_test, 0) AS loading_is_test
    FROM demand_headers h LEFT JOIN load_confirmations lc ON lc.header_id = h.id
    WHERE h.id = ? AND h.batch_id = (
      SELECT id FROM import_batches WHERE is_active = 1 ORDER BY imported_at DESC, id DESC LIMIT 1
    )`).bind(headerId).first<{
      loaded_at: string | null;
      loaded_by: string;
      confirmation_id: string | null;
      loading_is_test: number;
    }>();
  if (!stored?.loaded_at || !stored.confirmation_id) {
    return { ok: false, reason: "cart_missing" as const, error: "The active demand changed before loading could be recorded. Scan again." };
  }
  return cartResult(stored.confirmation_id !== confirmationId, stored.loaded_at, stored.loaded_by, Boolean(stored.loading_is_test));
}

/** Dispatch is a separate physical milestone; stock was already unavailable at packing. */
export async function confirmPicklistDispatch(input: {
  movementValue: string; cartBarcode: string; operatorName: string; operatorId?: string;
}) {
  const db = await ensureDatabase();
  const barcode = normalizeIdentityBarcode(input.cartBarcode);
  const movement = normalizeIdentityBarcode(input.movementValue);
  const actor = input.operatorName.trim();
  if (!barcode || barcode.length > 512 || !movement || movement.length > 512 || !actor || actor.length > 120) {
    return { ok: false, reason: "invalid", error: "A valid destination, picklist, and operator are required." };
  }
  const candidates = await matchingPicklistHeaders(db, barcode, movement);
  if (candidates.length !== 1) return { ok: false, reason: candidates.length ? "ambiguous_picklist" : "cart_missing",
    error: "Scan a unique picklist or master label in the active demand." };
  const row = candidates[0];
  if (await hasPicklistConflict(db, String(row.header_id))) return { ok: false, reason: "reconciliation_required", error: PICKLIST_CONFLICT_MESSAGE };
  const line = lineFromRow(row);
  if (!movementBarcodeMatches(line, movement)) return { ok: false, reason: "wrong_movement", error: "The picklist belongs to a different destination." };
  if (!line.loadedAt) return { ok: false, reason: "not_loaded", error: "Confirm loading before recording dispatch." };
  if (!line.dispatchedAt) {
    const now = new Date().toISOString();
    try {
      await db.guardedBatch([
        db.prepare("UPDATE demand_headers SET dispatched_at = ?, dispatched_by = ?, revision = revision + 1 WHERE id = ?")
          .bind(now, actor, String(row.header_id)),
        db.prepare(`INSERT INTO demand_audit_events (id, batch_id, header_id, line_id, action,
          before_json, after_json, actor_id, actor_name, created_at) VALUES (?, ?, ?, '', 'dispatch', ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), line.batchId, String(row.header_id), JSON.stringify({ dispatchedAt: null }),
            JSON.stringify({ dispatchedAt: now, destination: expectedMovementNumber(line), scannedBarcode: input.cartBarcode }),
            input.operatorId || "", actor, now),
      ], db.prepare(`EXISTS (SELECT 1 FROM demand_headers h JOIN import_batches b ON b.id = h.batch_id
        WHERE h.id = ? AND b.is_active = 1 AND h.loaded_at IS NOT NULL AND h.dispatched_at IS NULL AND h.revision = ? AND ${uniquePicklistSql()})
        AND EXISTS (SELECT 1 FROM load_confirmations WHERE header_id = ?)`)
        .bind(String(row.header_id), Number(row.header_revision || 0), String(row.header_id)));
    } catch (error) {
      if (!(error instanceof DatabaseConflictError)) throw error;
      const saved = await db.prepare("SELECT dispatched_at FROM demand_headers WHERE id = ?").bind(String(row.header_id)).first();
      if (!saved?.dispatched_at) return { ok: false, reason: "conflict", error: "The picklist changed. Refresh before dispatching." };
    }
  }
  const saved = await db.prepare("SELECT dispatched_at, dispatched_by FROM demand_headers WHERE id = ?")
    .bind(String(row.header_id)).first<{ dispatched_at: string; dispatched_by: string }>();
  return { ok: true, alreadyDispatched: Boolean(line.dispatchedAt), cart: {
    cartNumber: line.cartNumber, picklistNumber: line.picklistNumber, cartBarcode: line.cartBarcode,
    movementNumber: expectedMovementNumber(line), areaType: line.areaType, loadedAt: line.loadedAt, loadedBy: line.loadedBy,
    dispatchedAt: saved!.dispatched_at, dispatchedBy: saved!.dispatched_by, testMode: isGeneratedTestDemand(line),
  } };
}

const HEADER_PATCH_COLUMNS: Record<string, string> = {
  option: "option_text",
  productionQuantity: "production_quantity", cartMaxQuantity: "cart_max_quantity",
  interiorColor: "interior_color", exteriorColor: "exterior_color", vehicleColor: "vehicle_color",
  plant: "plant",
  zone: "zone",
  areaType: "area_type",
  shipCategory: "ship_category",
  loadNumber: "load_number",
  trainNumber: "train_number",
  picklistNumber: "picklist_number",
  cartNumber: "cart_number",
  cartId: "cart_id",
  palletId: "pallet_id",
  programId: "program_id",
  totalCarts: "total_carts",
  pymtc: "pymtc",
  checksheetNumber: "checksheet_number",
  masterBarcode: "master_barcode",
  movementBarcode: "movement_barcode",
  caseCode: "case_code",
  outgoingSerial: "outgoing_serial",
  cartSequenceNumber: "cart_sequence_number",
  fromLot: "from_lot",
  toLot: "to_lot",
  model: "model",
  cartType: "cart_type",
  scheduledDispatchDate: "scheduled_dispatch_date",
  scheduledDispatchTime: "scheduled_dispatch_time",
  deliveryLocation: "delivery_location",
  chassisNumber: "chassis_number",
  orderNumber: "order_number",
  batchNumber: "batch_number",
  loadingSequence: "loading_sequence",
};

const DETAIL_PATCH_COLUMNS: Record<string, string> = {
  ...DETAIL_LOT_METADATA_COLUMNS,
  packSequence: "pack_sequence",
  unitOfMeasure: "unit_of_measure", sourceLineId: "source_line_id", sourceScope: "source_scope", preferredSupplierId: "preferred_supplier_id",
  sequence: "sequence",
  partNumber: "part_number",
  description: "description",
  color: "color",
  quantity: "quantity",
  detailDeliveryLocation: "delivery_location",
  containerPosition: "container_position",
  containerType: "container_type",
  pickingLocation: "picking_location",
  mcid: "mcid",
  containerTotal: "container_total",
};

const CART_VERIFICATION_FIELDS = new Set([
  "plant", "areaType", "loadNumber", "trainNumber", "picklistNumber", "cartNumber", "cartId", "palletId",
]);
const DETAIL_VERIFICATION_FIELDS = new Set(["partNumber", "color", "quantity", "unitOfMeasure", "preferredSupplierId"]);

export class DemandMutationError extends Error {
  readonly code: "invalid" | "not_found" | "verified" | "locked" | "conflict";
  readonly status: number;

  constructor(
    message: string,
    code: "invalid" | "not_found" | "verified" | "locked" | "conflict",
    status: number,
  ) {
    super(message);
    this.name = "DemandMutationError";
    this.code = code;
    this.status = status;
  }
}

function cleanDemandPatch(changes: DemandLinePatch) {
  const entries = Object.entries(changes as Record<string, unknown>);
  if (!entries.length) throw new DemandMutationError("No demand fields were provided.", "invalid", 400);
  const cleaned: Record<string, string | number> = {};
  for (const [field, rawValue] of entries) {
    if (!(field in HEADER_PATCH_COLUMNS) && !(field in DETAIL_PATCH_COLUMNS)) {
      throw new DemandMutationError(`Demand field ${field} cannot be edited.`, "invalid", 400);
    }
    if (field === "quantity") {
      const quantity = Number(rawValue);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new DemandMutationError("Quantity must be a positive number in the specified unit.", "invalid", 400);
      }
      cleaned[field] = quantity;
    } else if (field === "productionQuantity" || field === "cartMaxQuantity") {
      cleaned[field] = rawValue == null || rawValue === "" ? "" : Number(rawValue);
    } else if (field === "totalCarts" || field === "containerTotal") {
      const count = Number(rawValue);
      if (!Number.isInteger(count) || count < 0) {
        throw new DemandMutationError(`${field === "totalCarts" ? "Total Carts" : "Container Total"} must be a non-negative whole number.`, "invalid", 400);
      }
      cleaned[field] = count;
    } else if (field === "areaType") {
      const areaType = String(rawValue || "").trim().toLowerCase();
      if (areaType !== "onsite" && areaType !== "offsite") {
        throw new DemandMutationError("Area must be Onsite or Offsite.", "invalid", 400);
      }
      cleaned[field] = areaType;
    } else {
      cleaned[field] = String(rawValue ?? "").trim();
    }
  }
  return cleaned;
}

async function getActiveDemandRow(db: Database, lineId: string) {
  return db.prepare(`${FLATTENED_LINE_SELECT}
    WHERE d.id = ? AND h.batch_id = (
      SELECT id FROM import_batches WHERE is_active = 1 ORDER BY imported_at DESC, id DESC LIMIT 1
    )`).bind(lineId).first<DatabaseRecord>();
}

async function acquireDemandMutationLock(line: CartLine, action: "edited" | "deleted") {
  const cartKey = cartKeyForLine(line);
  const sessionId = `demand-maintenance:${crypto.randomUUID()}`;
  const lock = await manageLock({
    action: "acquire",
    cartKey,
    picklistKey: picklistKeyFromCartKey(cartKey),
    sessionId,
    operatorName: "Demand maintenance",
    inventoryAvailable: false,
  });
  if (!lock.locked) {
    throw new DemandMutationError(
      lock.error || `This picklist is currently being scanned or refreshed and cannot be ${action}.`,
      "locked",
      409,
    );
  }
  return { cartKey, sessionId };
}

async function releaseDemandMutationLock(lock: { cartKey: string; sessionId: string }) {
  try {
    await manageLock({
      action: "release",
      cartKey: lock.cartKey,
      sessionId: lock.sessionId,
      operatorName: "Demand maintenance",
    });
  } catch {
    // The short lease is self-expiring; a cleanup failure must not mask a
    // demand mutation that already committed successfully.
  }
}

export async function updateDemandLine(lineId: string, changes: DemandLinePatch, actor?: { id: string; name: string }) {
  const db = await ensureDatabase();
  const storedRow = await getActiveDemandRow(db, lineId);
  if (!storedRow) throw new DemandMutationError("Demand line was not found in the active import.", "not_found", 404);
  const initial = lineFromRow(storedRow);
  if (initial.status !== "pending" || initial.fulfilledQuantity > 0) {
    throw new DemandMutationError("Packed, active, or short demand cannot be edited. Reset the picklist first.", "verified", 409);
  }
  const mutationLock = await acquireDemandMutationLock(initial, "edited");
  try {
  const lockedRow = await getActiveDemandRow(db, lineId);
  if (!lockedRow) throw new DemandMutationError("Demand line was not found in the active import.", "not_found", 404);
  const current = lineFromRow(lockedRow);
  if (current.status !== "pending" || current.fulfilledQuantity > 0) {
    throw new DemandMutationError("Packed, active, or short demand cannot be edited. Reset the picklist first.", "verified", 409);
  }

  const cleaned = cleanDemandPatch(changes);
  const operational = new Set(["allocations", "remainingQuantity", "fulfilledQuantity", "inventoryItemId", "status", "verifiedAt", "fulfilledAt", "fulfilledBy", "shortClosedAt"]);
  const candidate = { ...Object.fromEntries(Object.entries(current).filter(([key]) => !operational.has(key))), ...cleaned, aiagSerial: "" } as ImportRow;
  let validated: ImportRow;
  try {
    validated = withSupplementalFields(validateImportRows([candidate])[0], candidate, 1);
  } catch (error) {
    throw new DemandMutationError(
      error instanceof Error ? error.message.replace(/^Row 2 /, "") : "Demand data is invalid.",
      "invalid",
      400,
    );
  }

  const headerId = String(lockedRow.header_id);
  if (validated.sourceLineId && await db.prepare(`SELECT id FROM demand_details
    WHERE source_scope = ? AND source_line_id = ? AND id <> ? LIMIT 1`)
    .bind(validated.sourceScope || "", validated.sourceLineId, lineId).first()) {
    throw new DemandMutationError(
      "This Source Line ID already identifies existing or historical demand in this source scope. Use that demand record or reconcile the source snapshot.",
      "conflict", 409,
    );
  }
  const picklistGuard = availablePicklistGuard(db, current.batchId, validated, headerId);
  if (!(await db.prepare(`SELECT 1 WHERE ${picklistGuard.query}`).bind(...picklistGuard.values).first())) {
    throw new DemandMutationError(PICKLIST_CONFLICT_MESSAGE, "conflict", 409);
  }
  const headerFields = Object.keys(cleaned).filter((field) => field in HEADER_PATCH_COLUMNS);
  const detailFields = Object.keys(cleaned).filter((field) => field in DETAIL_PATCH_COLUMNS);
  if (headerFields.length) {
    const verifiedSibling = await db.prepare(`SELECT 1 FROM demand_details
      WHERE header_id = ? AND status <> 'pending' LIMIT 1`).bind(headerId).first();
    if (verifiedSibling) {
      throw new DemandMutationError("Cart-level fields cannot be edited after any part in the cart is verified.", "verified", 409);
    }
    const nextCartKey = cartKeyForLine(validated);
    const duplicateHeader = await db.prepare(`SELECT 1 FROM demand_headers
      WHERE batch_id = ? AND cart_key = ? AND id <> ? LIMIT 1`)
      .bind(current.batchId, nextCartKey, headerId).first();
    if (duplicateHeader) {
      throw new DemandMutationError("Those cart fields duplicate another cart in the active import.", "conflict", 409);
    }
  }

  const siblings = await db.prepare("SELECT id, sequence, aiag_serial FROM demand_details WHERE header_id = ? AND id <> ?")
    .bind(headerId, lineId).all<{ id: string; sequence: string; aiag_serial: string }>();
  if (siblings.results.some((sibling) => normalizeScanValue(sibling.sequence) === normalizeScanValue(validated.sequence)
)) {
    throw new DemandMutationError("The sequence duplicates another line in this cart.", "conflict", 409);
  }

  const auditTime = new Date().toISOString();
  const statements: PreparedStatement[] = [db.prepare(`INSERT INTO demand_audit_events (
    id, batch_id, header_id, line_id, action, before_json, after_json, actor_id, actor_name, created_at
  ) VALUES (?, ?, ?, ?, 'update', ?, ?, ?, ?, ?)`).bind(
    crypto.randomUUID(), current.batchId, headerId, lineId,
    JSON.stringify(current), JSON.stringify(validated), actor?.id || "", actor?.name || "Demand maintenance", auditTime,
  )];
  const clearsCartScans = headerFields.some((field) => CART_VERIFICATION_FIELDS.has(field));
  const clearsLineScans = detailFields.some((field) => DETAIL_VERIFICATION_FIELDS.has(field));
  if (clearsCartScans) {
    statements.push(db.prepare(`UPDATE scan_events SET invalidated_at = ?
      WHERE line_id IN (SELECT id FROM demand_details WHERE header_id = ?)
        AND invalidated_at IS NULL`).bind(auditTime, headerId));
  } else if (clearsLineScans) {
    statements.push(db.prepare("UPDATE scan_events SET invalidated_at = ? WHERE line_id = ? AND invalidated_at IS NULL").bind(auditTime, lineId));
  }
  if (headerFields.length) {
    const assignments = headerFields.map((field) => `${HEADER_PATCH_COLUMNS[field]} = ?`);
    const values = headerFields.map((field) => validated[field as keyof ImportRow] ?? (["productionQuantity", "cartMaxQuantity"].includes(field) ? null : ""));
    assignments.push("revision = revision + 1", "cart_key = ?", "picklist_identity = ?");
    values.push(cartKeyForLine(validated), picklistIdentityKey(validated));
    statements.push(db.prepare(`UPDATE demand_headers SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...values, headerId));
  }
  if (detailFields.length) {
    const assignments = detailFields.map((field) => `${DETAIL_PATCH_COLUMNS[field]} = ?`);
    const values = detailFields.map((field) => validated[field as keyof ImportRow] ?? "");
    assignments.push("revision = revision + 1");
    statements.push(db.prepare(`UPDATE demand_details SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...values, lineId));
  }
  const baseGuard = demandSnapshotGuard(db, lockedRow, mutationLock);
  await db.guardedBatch(statements, db.prepare(`${baseGuard.query}
    ${headerFields.length ? "AND NOT EXISTS (SELECT 1 FROM demand_details WHERE header_id = ? AND status <> 'pending')" : ""}
    AND NOT EXISTS (SELECT 1 FROM demand_details WHERE header_id = ? AND sequence = ? AND id <> ?)
    AND (? = '' OR NOT EXISTS (SELECT 1 FROM demand_details WHERE source_scope = ? AND source_line_id = ? AND id <> ?))
    AND ${picklistGuard.query}`)
    .bind(...baseGuard.values, ...(headerFields.length ? [headerId] : []), headerId, validated.sequence, lineId,
      validated.sourceLineId || "", validated.sourceScope || "", validated.sourceLineId || "", lineId, ...picklistGuard.values));

  const updatedRow = await getActiveDemandRow(db, lineId);
  if (!updatedRow) throw new DemandMutationError("Demand line could not be reloaded.", "not_found", 404);
  return {
    line: lineFromRow(updatedRow),
    headerFieldsUpdated: headerFields.length > 0,
    scanEventsCleared: clearsCartScans || clearsLineScans,
  };
  } catch (error) {
    if (error instanceof Error && /demand_details_source_identity_idx|UNIQUE constraint failed: demand_details\.source_scope, demand_details\.source_line_id/.test(error.message)) {
      throw new DemandMutationError("This Source Line ID was assigned to another demand while the change was being saved. Refresh and reconcile the source snapshot.", "conflict", 409);
    }
    throw error;
  } finally {
    await releaseDemandMutationLock(mutationLock);
  }
}

export async function deleteDemandLine(lineId: string, actor?: { id: string; name: string }) {
  const db = await ensureDatabase();
  const storedRow = await getActiveDemandRow(db, lineId);
  if (!storedRow) throw new DemandMutationError("Demand line was not found in the active import.", "not_found", 404);
  const line = lineFromRow(storedRow);
  if (line.status !== "pending" || line.fulfilledQuantity > 0) {
    throw new DemandMutationError("Packed, active, or short demand cannot be deleted. Reset the picklist first.", "verified", 409);
  }

  const mutationLock = await acquireDemandMutationLock(line, "deleted");
  try {
  const lockedRow = await getActiveDemandRow(db, lineId);
  if (!lockedRow) throw new DemandMutationError("Demand line was not found in the active import.", "not_found", 404);
  const lockedLine = lineFromRow(lockedRow);
  if (lockedLine.status !== "pending" || lockedLine.fulfilledQuantity > 0) {
    throw new DemandMutationError("Packed, active, or short demand cannot be deleted. Reset the picklist first.", "verified", 409);
  }
  const headerId = String(lockedRow.header_id);

  if (await db.prepare("SELECT 1 FROM scan_events WHERE line_id = ? LIMIT 1").bind(lineId).first()) {
    throw new DemandMutationError("Scanned demand is retained for audit and cannot be deleted. Correct its fields instead.", "conflict", 409);
  }
  const baseGuard = demandSnapshotGuard(db, lockedRow, mutationLock);
  await db.guardedBatch([
    db.prepare(`INSERT INTO demand_audit_events (
      id, batch_id, header_id, line_id, action, before_json, after_json, actor_id, actor_name, created_at
    ) VALUES (?, ?, ?, ?, 'delete', ?, '{}', ?, ?, ?)`).bind(
      crypto.randomUUID(), lockedLine.batchId, headerId, lineId, JSON.stringify(lockedLine), actor?.id || "", actor?.name || "Demand maintenance", new Date().toISOString(),
    ),
    db.prepare("DELETE FROM demand_details WHERE id = ?").bind(lineId),
    db.prepare("UPDATE demand_headers SET revision = revision + 1 WHERE id = ?").bind(headerId),
    db.prepare(`UPDATE import_batches SET row_count = CASE
      WHEN row_count > 0 THEN row_count - 1 ELSE 0 END WHERE id = ?`).bind(lockedLine.batchId),
    db.prepare(`DELETE FROM demand_headers WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM demand_details WHERE header_id = ?)`)
      .bind(headerId, headerId),
  ], db.prepare(`${baseGuard.query}
    AND NOT EXISTS (SELECT 1 FROM scan_events WHERE line_id = ?)`)
    .bind(...baseGuard.values, lineId));
  const headerRemoved = !(await db.prepare("SELECT 1 FROM demand_headers WHERE id = ?").bind(headerId).first());
  return { deleted: true, lineId, headerRemoved };
  } finally {
    await releaseDemandMutationLock(mutationLock);
  }
}

export async function getScannedDemandExport(scope: "active" | "history" = "active") {
  const db = await ensureDatabase();
  const scopeClause = scope === "history" ? "" : "AND b.is_active = 1";
  const [result, allocations] = await db.readBatch([db.prepare(`SELECT
    b.id AS import_batch_id, b.file_name, b.imported_at, b.is_active,
    h.program_id, h.plant, h.zone, h.area_type, h.ship_category,
    h.load_number, h.train_number, h.picklist_number, h.cart_number, h.cart_id, h.pallet_id,
    h.cart_barcode, h.loaded_at, h.loaded_by, h.dispatched_at, h.dispatched_by, h.short_closed_at, h.option_text,
    h.production_quantity, h.cart_max_quantity, h.interior_color, h.exterior_color, h.vehicle_color,
    h.total_carts, h.pymtc, h.checksheet_number, h.master_barcode, h.movement_barcode,
    h.case_code, h.outgoing_serial, h.cart_sequence_number, h.from_lot, h.to_lot,
    h.model, h.cart_type, h.scheduled_dispatch_date, h.scheduled_dispatch_time,
    h.delivery_location, h.chassis_number, h.order_number, h.batch_number, h.loading_sequence,
    d.unit_of_measure, d.source_line_id, d.source_scope, d.preferred_supplier_id,
    (SELECT supplier_id FROM inventory_items WHERE id = d.inventory_item_id) AS inventory_supplier_id,
    d.id AS line_id, d.sequence, d.pack_sequence, d.fulfilled_at, d.fulfilled_by, d.part_number, d.description, d.color, d.quantity,
    d.aiag_serial, d.legacy_expected_serial, d.fulfilled_quantity, (d.quantity-d.fulfilled_quantity) AS remaining_quantity, d.inventory_item_id, d.delivery_location AS detail_delivery_location,
    d.container_position, d.container_type, d.picking_location, d.mcid,
    ${Object.values(DETAIL_LOT_METADATA_COLUMNS).map((column) => `d.${column}`).join(", ")},
    d.container_total, d.status, d.verified_at,
    e.id AS scan_event_id, e.field AS scan_field, e.scanned_value, e.matched,
    e.is_test, e.invalidated_at AS scan_invalidated_at,
    e.operator_name, e.operator_id, e.created_at AS scanned_at,
    lc.scanned_movement AS loaded_destination_scan, lc.is_test AS loading_is_test,
    lc.operator_id AS loading_operator_id, lc.created_at AS loading_confirmed_at
  FROM demand_details d
  JOIN demand_headers h ON h.id = d.header_id
  JOIN import_batches b ON b.id = h.batch_id
  LEFT JOIN scan_events e ON e.line_id = d.id
  LEFT JOIN load_confirmations lc ON lc.header_id = h.id
  WHERE (d.status IN ('active','verified','short') OR e.id IS NOT NULL) ${scopeClause}
  ORDER BY b.imported_at DESC, h.plant, h.area_type, h.picklist_number,
    h.cart_number, d.sequence, e.created_at`),
    db.prepare(`SELECT a.*,i.supplier_id FROM fulfillment_allocations a
      JOIN inventory_items i ON i.id=a.inventory_item_id
      JOIN demand_details d ON d.id=a.demand_detail_id JOIN demand_headers h ON h.id=d.header_id
      JOIN import_batches b ON b.id=h.batch_id
      WHERE a.reversed_at IS NULL ${scopeClause} ORDER BY a.packed_at,a.id`),
  ]);
  const byLine = new Map<string, Array<Record<string, unknown>>>();
  for (const allocation of allocations.results) { const lineId=String(allocation.demand_detail_id); const entries=byLine.get(lineId)||[]; entries.push(allocation); byLine.set(lineId,entries); }
  return result.results.map((row) => ({ ...row, allocations_json: JSON.stringify(byLine.get(String(row.line_id)) || []) }));
}

export async function getFulfillmentSettings() {
  return readFulfillmentSettings(await ensureDatabase());
}

export async function updateFulfillmentSettings(value: unknown, actor: { id: string; name: string }) {
  let settings: FulfillmentSettings;
  try { settings = validateFulfillmentSettings(value); }
  catch (error) { throw new DemandMutationError(error instanceof Error ? error.message : "Invalid settings.", "invalid", 400); }
  const db = await ensureDatabase();
  const before = await readFulfillmentSettings(db);
  // Older clients update only the two original settings.
  if ((value as Record<string, unknown>).partAttribute === undefined) settings.partAttribute = before.partAttribute;
  if (settings.packingMode === before.packingMode && settings.inventoryMode === before.inventoryMode && settings.partAttribute === before.partAttribute) return settings;
  const condition = db.prepare(`NOT EXISTS (SELECT 1 FROM cart_locks WHERE expires_at > ${databaseNow(db)})
    AND NOT EXISTS (SELECT 1 FROM demand_details d JOIN demand_headers h ON h.id=d.header_id JOIN import_batches b ON b.id=h.batch_id
      WHERE b.is_active=1 AND (d.status IN ('active','short') OR h.short_closed_at IS NOT NULL))
    AND (? <> 'exact' OR NOT EXISTS (
      SELECT 1 FROM demand_details d JOIN demand_headers h ON h.id=d.header_id JOIN import_batches b ON b.id=h.batch_id
      WHERE b.is_active=1 AND h.dispatched_at IS NULL AND d.fulfilled_quantity>0 AND (
        (SELECT COUNT(*) FROM fulfillment_allocations a WHERE a.demand_detail_id=d.id AND a.reversed_at IS NULL) <> 1
        OR EXISTS (SELECT 1 FROM fulfillment_allocations a JOIN inventory_items i ON i.id=a.inventory_item_id
          WHERE a.demand_detail_id=d.id AND a.reversed_at IS NULL AND (a.quantity<>d.quantity OR a.quantity<>i.quantity))
      )))
    AND EXISTS (SELECT 1 FROM fulfillment_settings WHERE id='primary' AND packing_mode=? AND inventory_mode=?)`)
    .bind(settings.packingMode, before.packingMode, before.inventoryMode);
  const now = new Date().toISOString();
  try {
    await db.guardedBatch([
      db.prepare("UPDATE fulfillment_settings SET packing_mode=?,inventory_mode=?,part_attribute=?,revision=revision+1,updated_at=?,updated_by=? WHERE id='primary'")
        .bind(settings.packingMode, settings.inventoryMode, settings.partAttribute, now, actor.id),
      db.prepare(`INSERT INTO demand_audit_events (id,batch_id,header_id,line_id,action,before_json,after_json,actor_id,actor_name,created_at)
        VALUES (?,'','','','settings_update',?,?,?,?,?)`).bind(crypto.randomUUID(), JSON.stringify(before), JSON.stringify(settings), actor.id, actor.name, now),
    ], condition);
  } catch (error) {
    if (error instanceof DatabaseConflictError) throw new DemandMutationError("Release active scanning sessions and reset partial or short picklists before changing settings. Exact mode also requires whole-container allocations for current work.", "conflict", 409);
    throw error;
  }
  return settings;
}

/** Close remaining demand explicitly; shortages are terminal until a supervisor reset. */
export async function closePicklist(input: { cartKey: string; sessionId: string; operatorName: string; operatorId?: string }) {
  const db = await ensureDatabase();
  const header = await db.prepare(`SELECT h.* FROM demand_headers h JOIN import_batches b ON b.id=h.batch_id WHERE b.is_active=1 AND h.cart_key=?`).bind(input.cartKey).first<DatabaseRecord>();
  if (!header) throw new DemandMutationError("The picklist is no longer active.", "not_found", 404);
  if (header.short_closed_at) return { ok: true, alreadyClosed: true, shortClosedAt: String(header.short_closed_at) };
  if (header.loaded_at || header.dispatched_at) throw new DemandMutationError("Loaded or dispatched picklists cannot be closed short.", "conflict", 409);
  const headerId = String(header.id);
  const pending = await db.prepare("SELECT id,status,quantity,fulfilled_quantity,revision FROM demand_details WHERE header_id=? AND status IN ('pending','active')").bind(headerId).all();
  if (!pending.results.length) throw new DemandMutationError("This picklist is already completely packed.", "conflict", 409);
  const now = new Date().toISOString();
  const condition = db.prepare(`EXISTS (SELECT 1 FROM demand_headers h JOIN import_batches b ON b.id=h.batch_id
      WHERE h.id=? AND h.revision=? AND h.loaded_at IS NULL AND h.dispatched_at IS NULL AND h.short_closed_at IS NULL AND b.is_active=1 AND ${uniquePicklistSql()})
    AND EXISTS (SELECT 1 FROM cart_locks WHERE cart_key=? AND session_id=? AND expires_at>${databaseNow(db)})
    AND (SELECT COUNT(*) FROM demand_details WHERE header_id=? AND status IN ('pending','active'))=?`)
    .bind(headerId, Number(header.revision || 0), input.cartKey, input.sessionId, headerId, pending.results.length);
  const guards = prepareWriteGuards(db, pending.results.map((row) => db.prepare(
    "EXISTS (SELECT 1 FROM demand_details WHERE id=? AND header_id=? AND revision=? AND status=?)",
  ).bind(String(row.id), headerId, Number(row.revision || 0), String(row.status))));
  await db.guardedBatch([
    ...guards.statements,
    db.prepare("UPDATE demand_details SET status='short',revision=revision+1 WHERE header_id=? AND status IN ('pending','active')").bind(headerId),
    db.prepare("UPDATE demand_headers SET short_closed_at=?,revision=revision+1 WHERE id=?").bind(now, headerId),
    db.prepare(`INSERT INTO demand_audit_events (id,batch_id,header_id,line_id,action,before_json,after_json,actor_id,actor_name,created_at)
      VALUES (?,?,?,'','close_short',?,?,?,?,?)`).bind(crypto.randomUUID(), String(header.batch_id), headerId,
        JSON.stringify(pending.results), JSON.stringify({ shortClosedAt: now, shortLines: pending.results.length }), input.operatorId || "", input.operatorName, now),
    db.prepare("DELETE FROM cart_locks WHERE cart_key=? AND session_id=?").bind(input.cartKey, input.sessionId),
    ...guards.cleanup,
  ], condition);
  return { ok: true, alreadyClosed: false, shortClosedAt: now, shortLines: pending.results.length };
}

/** Reverse only this picklist's active contributions, preserving immutable receipts. */
export async function resetPicklist(input: { cartKey: string; sessionId?: string; operatorName: string; operatorId: string }) {
  const db = await ensureDatabase();
  for (let attempt = 0; attempt < 4; attempt++) {
    const header = await db.prepare(`SELECT h.* FROM demand_headers h JOIN import_batches b ON b.id=h.batch_id WHERE b.is_active=1 AND h.cart_key=?`).bind(input.cartKey).first<DatabaseRecord>();
    if (!header) throw new DemandMutationError("The picklist is no longer active.", "not_found", 404);
    if (header.dispatched_at) throw new DemandMutationError("Dispatched picklists cannot be reset.", "conflict", 409);
    const headerId = String(header.id);
    const foreignLease = await db.prepare(`SELECT 1 FROM cart_locks WHERE picklist_key=? AND session_id<>? AND expires_at>${databaseNow(db)}`)
      .bind(picklistKeyFromCartKey(input.cartKey), input.sessionId || "").first();
    if (foreignLease) throw new DemandMutationError("Another scanner owns this picklist. Release its lease before resetting.", "conflict", 409);
    const details = await db.prepare("SELECT * FROM demand_details WHERE header_id=? ORDER BY id").bind(headerId).all<DatabaseRecord>();
    const allocations = await db.prepare(`SELECT a.*,i.quantity AS inventory_quantity,i.consumed_quantity,i.status AS inventory_status,i.unit_of_measure
      FROM fulfillment_allocations a JOIN demand_details d ON d.id=a.demand_detail_id JOIN inventory_items i ON i.id=a.inventory_item_id
      WHERE d.header_id=? AND a.reversed_at IS NULL`).bind(headerId).all<DatabaseRecord>();
    const released = new Map<string, { quantity: bigint; consumed: bigint; original: bigint; status: string }>();
    for (const allocation of allocations.results) {
      const id = String(allocation.inventory_item_id);
      const unit = String(allocation.unit_of_measure || "EA");
      const entry = released.get(id) || { quantity: 0n, consumed: quantityToScaled(Number(allocation.consumed_quantity), unit), original: quantityToScaled(Number(allocation.inventory_quantity), unit), status: String(allocation.inventory_status) };
      entry.quantity += quantityToScaled(Number(allocation.quantity), unit);
      released.set(id, entry);
    }
    for (const entry of released.values()) if (entry.quantity > entry.consumed || !["consumed", "partially_consumed"].includes(entry.status)) throw new DemandMutationError("Inventory balances do not match packing allocations. Reconcile inventory before resetting.", "conflict", 409);
    const now = new Date().toISOString();
    const statements: PreparedStatement[] = [];
    for (const [id, entry] of released) {
      const remainingConsumed = entry.consumed - entry.quantity;
      statements.push(db.prepare("UPDATE inventory_items SET consumed_quantity=?,status=?,consumed_at=CASE WHEN ?=0 THEN NULL ELSE consumed_at END WHERE id=?")
        .bind(Number(remainingConsumed) / Number(QUANTITY_SCALE), remainingConsumed === 0n ? "available" : remainingConsumed === entry.original ? "consumed" : "partially_consumed", remainingConsumed === 0n ? 0 : 1, id));
    }
    statements.push(
      db.prepare(`UPDATE fulfillment_allocations SET reversed_at=?,reversed_by=? WHERE reversed_at IS NULL AND demand_detail_id IN (SELECT id FROM demand_details WHERE header_id=?)`).bind(now, input.operatorId, headerId),
      db.prepare("UPDATE demand_details SET inventory_item_id=NULL,aiag_serial='',fulfilled_quantity=0,status='pending',verified_at=NULL,fulfilled_at=NULL,fulfilled_by='',revision=revision+1 WHERE header_id=?").bind(headerId),
      db.prepare("UPDATE demand_headers SET short_closed_at=NULL,loaded_at=NULL,loaded_by='',revision=revision+1 WHERE id=?").bind(headerId),
      db.prepare("DELETE FROM load_confirmations WHERE header_id=?").bind(headerId),
      db.prepare("UPDATE scan_events SET invalidated_at=? WHERE invalidated_at IS NULL AND line_id IN (SELECT id FROM demand_details WHERE header_id=?)").bind(now, headerId),
      db.prepare(`INSERT INTO demand_audit_events (id,batch_id,header_id,line_id,action,before_json,after_json,actor_id,actor_name,created_at)
        VALUES (?,?,?,'','unpack_reset',?,?,?,?,?)`).bind(crypto.randomUUID(), String(header.batch_id), headerId,
          JSON.stringify({ header, details: details.results, allocations: allocations.results }), JSON.stringify({ status: "pending", releasedContainers: released.size }), input.operatorId, input.operatorName, now),
      db.prepare("DELETE FROM cart_locks WHERE cart_key=? AND session_id=?").bind(input.cartKey, input.sessionId || ""),
    );
    const checks = [`EXISTS (SELECT 1 FROM demand_headers h JOIN import_batches b ON b.id=h.batch_id WHERE h.id=? AND h.revision=? AND b.is_active=1 AND h.dispatched_at IS NULL AND ${uniquePicklistSql()})`,
      `NOT EXISTS (SELECT 1 FROM cart_locks WHERE picklist_key=? AND session_id<>? AND expires_at>${databaseNow(db)})`,
      "(SELECT COUNT(*) FROM fulfillment_allocations a JOIN demand_details d ON d.id=a.demand_detail_id WHERE d.header_id=? AND a.reversed_at IS NULL)=?",
      "(SELECT COUNT(*) FROM demand_details WHERE header_id=?)=?"];
    const values: Array<string | number> = [headerId, Number(header.revision || 0), picklistKeyFromCartKey(input.cartKey), input.sessionId || "", headerId, allocations.results.length, headerId, details.results.length];
    const guards = prepareWriteGuards(db, [
      ...details.results.map((detail) => db.prepare("EXISTS (SELECT 1 FROM demand_details WHERE id=? AND header_id=? AND revision=?)")
        .bind(String(detail.id), headerId, Number(detail.revision || 0))),
      ...[...released].map(([id, entry]) => db.prepare("EXISTS (SELECT 1 FROM inventory_items WHERE id=? AND consumed_quantity=? AND status=?)")
        .bind(id, Number(entry.consumed) / Number(QUANTITY_SCALE), entry.status)),
    ]);
    try {
      await db.guardedBatch([...guards.statements, ...statements, ...guards.cleanup], db.prepare(checks.join(" AND ")).bind(...values));
      return { ok: true, resetLines: details.results.length, releasedContainers: released.size };
    } catch (error) { if (!(error instanceof DatabaseConflictError)) throw error; }
  }
  throw new DemandMutationError("The picklist changed while resetting. Refresh and try again.", "conflict", 409);
}

function inventorySnapshotStatements(db: Database, selector: PreparedStatement) {
  return [
    db.prepare(`${INVENTORY_SELECT} WHERE id IN (${selector.query}) ORDER BY captured_at DESC,id DESC`).bind(...selector.values),
    db.prepare(`SELECT inventory_item_id,demand_detail_id FROM fulfillment_allocations WHERE inventory_item_id IN (${selector.query}) AND reversed_at IS NULL ORDER BY packed_at,id`).bind(...selector.values),
  ];
}

function inventorySnapshotItems([items, allocations]: DatabaseResult[]) {
  const groups = new Map<string, Set<string>>();
  for (const row of allocations.results) {
    const group = groups.get(String(row.inventory_item_id)) || new Set<string>();
    group.add(String(row.demand_detail_id));
    groups.set(String(row.inventory_item_id), group);
  }
  return (items.results as StoredInventoryItem[]).map(productionInventoryItem).map((item) => ({
    ...item,
    fulfilledDemandIds: [...(groups.get(item.id) || [])],
  }));
}

async function attachInventoryDemandIds(db: Database, items: InventoryItem[]) {
  if (!items.length) return [];
  const ids = items.map((item) => item.id);
  return inventorySnapshotItems(await db.readBatch(inventorySnapshotStatements(db,
    db.prepare(`SELECT id FROM inventory_items WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids))));
}
