import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, numeric, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const authSessions = pgTable("auth_sessions", {
  sessionHash: text("session_hash").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
}, (table) => [index("auth_sessions_expiry_idx").on(table.expiresAt)]);

export const authRateLimits = pgTable("auth_rate_limits", {
  keyHash: text("key_hash").primaryKey(), attempts: integer("attempts").notNull(),
  windowStart: text("window_start").notNull(), expiresAt: text("expires_at").notNull(),
}, (table) => [index("auth_rate_limits_expiry_idx").on(table.expiresAt)]);

export const maintenanceAuditEvents = pgTable("maintenance_audit_events", {
  id: text("id").primaryKey(), action: text("action").notNull(), actorId: text("actor_id").notNull(),
  actorName: text("actor_name").notNull(), createdAt: text("created_at").notNull(), detail: text("detail").notNull(),
});

export const rawCaptureScans = pgTable("raw_capture_scans", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  position: integer("position").notNull(),
  rawValue: text("raw_value").notNull(),
  scannedAt: text("scanned_at").notNull(),
  savedAt: text("saved_at").notNull(),
  operatorId: text("operator_id").notNull(),
  operatorName: text("operator_name").notNull(),
}, (table) => [uniqueIndex("raw_capture_owner_session_idx").on(table.operatorId, table.sessionId, table.position)]);

export const cartflowSchema = pgTable("cartflow_schema", {
  name: text("name").primaryKey(),
  version: integer("version").notNull(),
});

export const cartflowWriteGuards = pgTable("cartflow_write_guards", {
  id: text("id").primaryKey(),
  valid: integer("valid").notNull(),
}, (table) => [check("cartflow_write_guard_valid", sql`${table.valid} = 1`)]);

export const demandAuditEvents = pgTable("demand_audit_events", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull(),
  headerId: text("header_id").notNull(),
  lineId: text("line_id").notNull(),
  action: text("action").notNull(),
  beforeJson: text("before_json").notNull(),
  afterJson: text("after_json").notNull(),
  actorId: text("actor_id").notNull().default(""),
  actorName: text("actor_name").notNull().default(""),
  createdAt: text("created_at").notNull(),
}, (table) => [index("demand_audit_events_batch_idx").on(table.batchId, table.createdAt)]);

export const importBatches = pgTable("import_batches", {
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  rowCount: integer("row_count").notNull(),
  importedAt: text("imported_at").notNull(),
  isActive: integer("is_active").notNull().default(0),
}, (table) => [
  index("import_batches_imported_idx").on(table.importedAt),
  uniqueIndex("import_batches_one_active_idx").on(table.isActive).where(sql`${table.isActive} = 1`),
]);

export const demandImportRows = pgTable("demand_import_rows", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull().references(() => importBatches.id, { onDelete: "cascade" }),
  rowJson: text("row_json").notNull(),
}, (table) => [index("demand_import_rows_batch_idx").on(table.batchId)]);

export const integrationImports = pgTable("integration_imports", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  idempotencyKey: text("idempotency_key").notNull().default(""),
  contentHash: text("content_hash").notNull(),
  fileName: text("file_name").notNull(),
  status: text("status").notNull().default("processing"),
  batchId: text("batch_id").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  importedAt: text("imported_at"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [
  index("integration_imports_source_content_idx").on(table.source, table.contentHash),
  uniqueIndex("integration_imports_source_key_idx")
    .on(table.source, table.idempotencyKey)
    .where(sql`${table.idempotencyKey} <> ''`),
  uniqueIndex("integration_imports_one_processing_idx")
    .on(table.status)
    .where(sql`${table.status} = 'processing'`),
  index("integration_imports_status_expiry_idx").on(table.status, table.expiresAt),
]);

export const demandHeaders = pgTable("demand_headers", {
  option: text("option_text").notNull().default(""),
  shortClosedAt: text("short_closed_at"),
  revision: integer("revision").notNull().default(0),
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull().references(() => importBatches.id, { onDelete: "cascade" }),
  cartKey: text("cart_key").notNull(),
  picklistIdentity: text("picklist_identity").notNull().default(""),
  plant: text("plant").notNull(),
  zone: text("zone").notNull(),
  areaType: text("area_type").notNull(),
  shipCategory: text("ship_category").notNull(),
  loadNumber: text("load_number").notNull(),
  trainNumber: text("train_number").notNull(),
  picklistNumber: text("picklist_number").notNull(),
  cartNumber: text("cart_number").notNull(),
  cartId: text("cart_id").notNull(),
  palletId: text("pallet_id").notNull(),
  cartBarcode: text("cart_barcode").notNull().default(""),
  loadedAt: text("loaded_at"),
  loadedBy: text("loaded_by").notNull().default(""),
  dispatchedAt: text("dispatched_at"),
  dispatchedBy: text("dispatched_by").notNull().default(""),
  productionQuantity: numeric("production_quantity", { precision: 20, scale: 6 }),
  cartMaxQuantity: numeric("cart_max_quantity", { precision: 20, scale: 6 }),
  interiorColor: text("interior_color").notNull().default(""),
  exteriorColor: text("exterior_color").notNull().default(""),
  vehicleColor: text("vehicle_color").notNull().default(""),
  programId: text("program_id").notNull().default("ODG303R"),
  totalCarts: integer("total_carts").notNull().default(0),
  pymtc: text("pymtc").notNull().default(""),
  checksheetNumber: text("checksheet_number").notNull().default(""),
  masterBarcode: text("master_barcode").notNull().default(""),
  movementBarcode: text("movement_barcode").notNull().default(""),
  caseCode: text("case_code").notNull().default(""),
  outgoingSerial: text("outgoing_serial").notNull().default(""),
  cartSequenceNumber: text("cart_sequence_number").notNull().default(""),
  fromLot: text("from_lot").notNull().default(""),
  toLot: text("to_lot").notNull().default(""),
  model: text("model").notNull().default(""),
  cartType: text("cart_type").notNull().default(""),
  scheduledDispatchDate: text("scheduled_dispatch_date").notNull().default(""),
  scheduledDispatchTime: text("scheduled_dispatch_time").notNull().default(""),
  deliveryLocation: text("delivery_location").notNull().default(""),
  chassisNumber: text("chassis_number").notNull().default(""),
  orderNumber: text("order_number").notNull().default(""),
  batchNumber: text("batch_number").notNull().default(""),
  loadingSequence: text("loading_sequence").notNull().default(""),
}, (table) => [
  uniqueIndex("demand_headers_batch_picklist_idx").on(table.batchId, table.picklistIdentity)
    .where(sql`${table.picklistIdentity} <> ''`),
  uniqueIndex("demand_headers_batch_cart_idx").on(table.batchId, table.cartKey),
  uniqueIndex("demand_headers_cart_barcode_idx").on(table.cartBarcode),
  index("demand_headers_work_idx").on(table.batchId, table.plant, table.areaType, table.picklistNumber, table.cartId),
]);

export const demandDetails = pgTable("demand_details", {
  containerSequence: text("container_sequence").notNull().default(""),
  fromModel: text("from_model").notNull().default(""),
  fromType: text("from_type").notNull().default(""),
  fromOption: text("from_option").notNull().default(""),
  fromColor: text("from_color").notNull().default(""),
  fromInteriorColor: text("from_interior_color").notNull().default(""),
  fromUnits: text("from_units").notNull().default(""),
  toModel: text("to_model").notNull().default(""),
  toType: text("to_type").notNull().default(""),
  toOption: text("to_option").notNull().default(""),
  toColor: text("to_color").notNull().default(""),
  toInteriorColor: text("to_interior_color").notNull().default(""),
  toUnits: text("to_units").notNull().default(""),
  packSequence: text("pack_sequence").notNull().default(""),
  fulfilledAt: text("fulfilled_at"),
  fulfilledBy: text("fulfilled_by").notNull().default(""),
  revision: integer("revision").notNull().default(0),
  id: text("id").primaryKey(),
  headerId: text("header_id").notNull().references(() => demandHeaders.id, { onDelete: "cascade" }),
  sequence: text("sequence").notNull(),
  partNumber: text("part_number").notNull(),
  description: text("description").notNull().default(""),
  color: text("color").notNull(),
  quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
  unitOfMeasure: text("unit_of_measure").notNull().default("EA"),
  sourceLineId: text("source_line_id").notNull().default(""),
  sourceScope: text("source_scope").notNull().default(""),
  preferredSupplierId: text("preferred_supplier_id").notNull().default(""),
  aiagSerial: text("aiag_serial").notNull().default(""),
  legacyExpectedSerial: text("legacy_expected_serial").notNull().default(""),
  fulfilledQuantity: numeric("fulfilled_quantity", { precision: 20, scale: 6 }).notNull().default("0"),
  inventoryItemId: text("inventory_item_id").references(() => inventoryItems.id),
  deliveryLocation: text("delivery_location").notNull().default(""),
  containerPosition: text("container_position").notNull().default(""),
  containerType: text("container_type").notNull().default(""),
  pickingLocation: text("picking_location").notNull().default(""),
  mcid: text("mcid").notNull().default(""),
  containerTotal: integer("container_total").notNull().default(0),
  status: text("status").notNull().default("pending"),
  verifiedAt: text("verified_at"),
}, (table) => [
  index("demand_details_inventory_item_lookup_idx").on(table.inventoryItemId),
  uniqueIndex("demand_details_source_identity_idx").on(table.sourceScope, table.sourceLineId)
    .where(sql`${table.sourceLineId} <> ''`),
  index("demand_details_header_status_idx").on(table.headerId, table.status, table.sequence),
]);

export const inventoryItems = pgTable("inventory_items", {
  id: text("id").primaryKey(),
  captureSessionId: text("capture_session_id").notNull(),
  source: text("source").notNull().default("physical_label"),
  acquisitionMethod: text("acquisition_method").notNull().default("legacy_unknown"),
  sourceFile: text("source_file").notNull().default(""),
  sourceImportId: text("source_import_id").notNull().default(""),
  sourceRow: integer("source_row"),
  scannedValuesJson: text("scanned_values_json").notNull().default("{}"),
  recordedAt: text("recorded_at").notNull().default(""),
  aiagSerial: text("aiag_serial").notNull(),
  normalizedSerial: text("normalized_serial").notNull(),
  supplierId: text("supplier_id").notNull().default(""),
  palletId: text("pallet_id").notNull().default(""),
  unitOfMeasure: text("unit_of_measure").notNull().default("EA"),
  partNumber: text("part_number").notNull(),
  partLevel: text("part_level").notNull(),
  quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
  rawAiagSerial: text("raw_aiag_serial").notNull().default(""),
  rawPartNumber: text("raw_part_number").notNull().default(""),
  rawPartLevel: text("raw_part_level").notNull().default(""),
  rawQuantity: text("raw_quantity").notNull().default(""),
  status: text("status").notNull().default("available"),
  consumedQuantity: numeric("consumed_quantity", { precision: 20, scale: 6 }).notNull().default("0"),
  consumedAt: text("consumed_at"),
  weight: doublePrecision("weight"),
  unitCost: doublePrecision("unit_cost"),
  receiveDate: text("receive_date").notNull().default(""),
  isTest: integer("is_test").notNull().default(0),
  operatorName: text("operator_name").notNull(),
  capturedAt: text("captured_at").notNull(),
}, (table) => [
  uniqueIndex("inventory_items_scope_serial_idx").on(table.isTest, table.supplierId, table.normalizedSerial),
  index("inventory_items_lookup_idx").on(table.status, table.partNumber, table.partLevel),
]);

export const inventoryCaptureReceipts = pgTable("inventory_capture_receipts", {
  captureId: text("capture_id").primaryKey(),
  captureSessionId: text("capture_session_id").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  isTest: integer("is_test").notNull().default(1),
  inventoryItemId: text("inventory_item_id")
    .references(() => inventoryItems.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("inventory_capture_receipts_item_idx").on(table.inventoryItemId, table.createdAt),
]);

export const inventoryDemandProjections = pgTable("inventory_demand_projections", {
  id: text("id").primaryKey(),
  inventoryItemId: text("inventory_item_id").notNull()
    .references(() => inventoryItems.id, { onDelete: "cascade" }),
  testSessionId: text("test_session_id").notNull(),
  demandDetailId: text("demand_detail_id")
    .references(() => demandDetails.id, { onDelete: "set null" }),
  projectionType: text("projection_type").notNull().default("test_demand"),
  status: text("status").notNull().default("pending"),
  errorMessage: text("error_message").notNull().default(""),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  uniqueIndex("inventory_demand_projections_item_session_idx").on(table.inventoryItemId, table.testSessionId),
  uniqueIndex("inventory_demand_projections_detail_idx").on(table.demandDetailId),
]);

export const cartLines = pgTable("cart_lines", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull(),
  plant: text("plant").notNull(),
  zone: text("zone").notNull(),
  areaType: text("area_type").notNull().default("onsite"),
  shipCategory: text("ship_category").notNull(),
  loadNumber: text("load_number").notNull(),
  trainNumber: text("train_number").notNull(),
  picklistNumber: text("picklist_number").notNull().default("UNASSIGNED"),
  cartNumber: text("cart_number").notNull(),
  cartId: text("cart_id").notNull().default("UNASSIGNED"),
  palletId: text("pallet_id").notNull().default("UNASSIGNED"),
  sequence: text("sequence").notNull(),
  partNumber: text("part_number").notNull(),
  description: text("description").notNull().default(""),
  color: text("color").notNull(),
  quantity: integer("quantity").notNull(),
  aiagSerial: text("aiag_serial").notNull(),
  masterBarcode: text("master_barcode").notNull().default(""),
  movementBarcode: text("movement_barcode").notNull().default(""),
  caseCode: text("case_code").notNull().default(""),
  outgoingSerial: text("outgoing_serial").notNull().default(""),
  cartSequenceNumber: text("cart_sequence_number").notNull().default(""),
  fromLot: text("from_lot").notNull().default(""),
  toLot: text("to_lot").notNull().default(""),
  model: text("model").notNull().default(""),
  cartType: text("cart_type").notNull().default(""),
  scheduledDispatchDate: text("scheduled_dispatch_date").notNull().default(""),
  scheduledDispatchTime: text("scheduled_dispatch_time").notNull().default(""),
  deliveryLocation: text("delivery_location").notNull().default(""),
  containerPosition: text("container_position").notNull().default(""),
  containerType: text("container_type").notNull().default(""),
  pickingLocation: text("picking_location").notNull().default(""),
  mcid: text("mcid").notNull().default(""),
  chassisNumber: text("chassis_number").notNull().default(""),
  orderNumber: text("order_number").notNull().default(""),
  batchNumber: text("batch_number").notNull().default(""),
  loadingSequence: text("loading_sequence").notNull().default(""),
  status: text("status").notNull().default("pending"),
  verifiedAt: text("verified_at"),
}, (table) => [
  index("cart_lines_work_idx").on(table.plant, table.areaType, table.picklistNumber, table.cartId),
]);

export const cartLocks = pgTable("cart_locks", {
  operatorId: text("operator_id").notNull().default(""),
  leaseId: text("lease_id").notNull().default(""),
  cartKey: text("cart_key").primaryKey(),
  picklistKey: text("picklist_key").notNull().default(""),
  sessionId: text("session_id").notNull(),
  operatorName: text("operator_name").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  inventoryAvailable: integer("inventory_available").notNull().default(0),
}, (table) => [
  uniqueIndex("cart_locks_picklist_key_idx").on(table.picklistKey).where(sql`${table.picklistKey} <> ''`),
]);

export const scanEvents = pgTable("scan_events", {
  operatorId: text("operator_id").notNull().default(""),
  leaseId: text("lease_id").notNull().default(""),
  id: text("id").primaryKey(),
  lineId: text("line_id").notNull(),
  cartKey: text("cart_key").notNull(),
  sessionId: text("session_id").notNull().default(""),
  field: text("field").notNull(),
  scannedValue: text("scanned_value").notNull(),
  invalidatedAt: text("invalidated_at"),
  matched: integer("matched").notNull(),
  isTest: integer("is_test").notNull().default(0),
  operatorName: text("operator_name").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("scan_events_created_idx").on(table.createdAt),
  index("scan_events_evidence_idx").on(table.lineId, table.sessionId, table.isTest, table.invalidatedAt, table.createdAt),
]);

export const loadConfirmations = pgTable("load_confirmations", {
  operatorId: text("operator_id").notNull().default(""),
  id: text("id").primaryKey(),
  headerId: text("header_id").notNull().references(() => demandHeaders.id, { onDelete: "cascade" }),
  cartBarcode: text("cart_barcode").notNull(),
  movementType: text("movement_type").notNull(),
  movementNumber: text("movement_number").notNull(),
  scannedMovement: text("scanned_movement").notNull(),
  isTest: integer("is_test").notNull().default(0),
  operatorName: text("operator_name").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("load_confirmations_header_idx").on(table.headerId),
  index("load_confirmations_created_idx").on(table.createdAt),
]);

export const fulfillmentSettings = pgTable("fulfillment_settings", {
  id: text("id").primaryKey(),
  packingMode: text("packing_mode").notNull(),
  inventoryMode: text("inventory_mode").notNull(),
  partAttribute: text("part_attribute").notNull().default("color_or_part_level"),
  revision: integer("revision").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(""),
  updatedBy: text("updated_by").notNull().default(""),
});

export const fulfillmentAllocations = pgTable("fulfillment_allocations", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  requestFingerprint: text("request_fingerprint").notNull(),
  demandDetailId: text("demand_detail_id").notNull().references(() => demandDetails.id),
  inventoryItemId: text("inventory_item_id").notNull().references(() => inventoryItems.id),
  quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
  serial: text("serial").notNull(),
  packedAt: text("packed_at").notNull(),
  packedBy: text("packed_by").notNull(),
  operatorId: text("operator_id").notNull().default(""),
  reversedAt: text("reversed_at"),
  reversedBy: text("reversed_by").notNull().default(""),
}, (table) => [
  check("fulfillment_allocations_positive_quantity", sql`${table.quantity} > 0`),
  index("fulfillment_allocations_detail_idx").on(table.demandDetailId, table.reversedAt),
  index("fulfillment_allocations_inventory_idx").on(table.inventoryItemId, table.reversedAt),
  uniqueIndex("fulfillment_allocations_active_pair_idx").on(table.demandDetailId, table.inventoryItemId).where(sql`${table.reversedAt} IS NULL`),
]);
