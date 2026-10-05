import { picklistIdentityKey } from "../lib/cart-identity.ts";
import type { CartLine, ImportRow } from "../lib/types.ts";
import type { Database, DatabaseValue, PreparedStatement } from "./index.ts";
import { prepareWriteGuards } from "./write-guards.ts";
import {
  assessSnapshotShrink,
  demandHasWork,
  demandSourceIdentity,
  planDemandReconciliation,
  reconciliationCartKey,
  SnapshotShrinkError,
  type ReconciliationStoredLine,
} from "./demand-reconciliation.ts";

type StoredRecord = Record<string, string | number | null>;

export type ReconciledImportInput = {
  batchId: string;
  fileName: string;
  rows: ImportRow[];
  integrationReceiptId?: string;
  detailIds?: string[];
  sourceScope?: string;
  actorId?: string;
  actorName?: string;
  /** Confirms a snapshot that retires most open demand or is empty; see SnapshotShrinkError. */
  allowShrink?: boolean;
};

export type ImportActivationAdapters = {
  selectSql: string;
  lineFromRow: (raw: StoredRecord) => CartLine;
  prepareHeaderInsert: (db: Database, batchId: string, headerId: string, row: ImportRow) => PreparedStatement;
  prepareDetailInsert: (db: Database, headerId: string, detailId: string, row: ImportRow) => PreparedStatement;
  headerColumns: Record<string, string>;
  detailColumns: Record<string, string>;
  databaseNow: (db: Database) => string;
};

const runtimeFields = new Set([
  "allocations", "remainingQuantity", "fulfilledAt", "fulfilledBy", "shortClosedAt", "id", "headerId", "batchId", "cartBarcode", "loadedAt", "loadedBy", "dispatchedAt", "dispatchedBy",
  "status", "verifiedAt", "fulfilledQuantity", "inventoryItemId", "legacyExpectedSerial",
  "headerRevision", "detailRevision",
]);
const protectedColumns = new Set([
  "fulfilled_at", "fulfilled_by", "short_closed_at", "id", "header_id", "batch_id", "cart_key", "cart_barcode", "loaded_at", "loaded_by",
  "dispatched_at", "dispatched_by", "status", "verified_at", "fulfilled_quantity",
  "inventory_item_id", "aiag_serial", "legacy_expected_serial", "revision",
]);

function importRow(line: CartLine): ImportRow {
  return { ...Object.fromEntries(Object.entries(line).filter(([key]) => !runtimeFields.has(key))), aiagSerial: "" } as ImportRow;
}

function storedValue(row: ImportRow, field: string): DatabaseValue {
  const value = (row as unknown as Record<string, unknown>)[field];
  if (field === "programId") return String(value || "ODG303R");
  if (field === "unitOfMeasure") return String(value || "EA");
  if (field === "productionQuantity" || field === "cartMaxQuantity") return value == null || value === "" ? null : Number(value);
  if (field === "totalCarts" || field === "containerTotal") return Number(value || 0);
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error(`Unsupported demand value for ${field}.`);
}

function writableColumns(columns: Record<string, string>) {
  return Object.entries(columns).filter(([, column]) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(column)) throw new Error("Invalid demand column mapping.");
    return !protectedColumns.has(column);
  });
}

/**
 * Activates a complete demand snapshot without recreating retained demand.
 * All material writes, source snapshots, audits and the receipt commit together.
 * The caller must already hold the integration_imports processing claim.
 */
export async function activateReconciledImport(
  db: Database,
  input: ReconciledImportInput,
  adapters: ImportActivationAdapters,
) {
  try {
    return await applyImport(db, input, adapters);
  } catch (error) {
    // The activation transaction rolls back its new batch and every moved row.
    // Release only this still-processing claim; never remove completed receipts.
    if (input.integrationReceiptId) {
      try {
        await db.prepare("DELETE FROM integration_imports WHERE id = ? AND batch_id = ? AND status = 'processing'")
          .bind(input.integrationReceiptId, input.batchId).run();
      } catch {
        // A failed cleanup must not mask the reconciliation error. The claim expires.
      }
    }
    throw error;
  }
}

async function applyImport(db: Database, input: ReconciledImportInput, adapters: ImportActivationAdapters) {
  const now = new Date().toISOString();
  const sourceScope = String(input.sourceScope || "").trim();
  const submitted = input.rows.map((row) => ({ ...row, sourceScope: String(row.sourceScope || sourceScope).trim(), aiagSerial: "" }));
  const activeBatch = await db.prepare("SELECT id FROM import_batches WHERE is_active = 1 LIMIT 1")
    .first<{ id: string }>();
  // Include historical identities so a recurring source ID cannot reopen stock
  // already consumed in an older snapshot. Full siblings protect header evidence.
  const result = await db.prepare(`SELECT q.*, b.is_active AS import_active,
      (SELECT COUNT(*) FROM scan_events e WHERE e.line_id = q.id) AS scan_count,
      (SELECT COUNT(*) FROM load_confirmations lc WHERE lc.header_id = q.header_id) AS load_count,
      membership.sibling_count, q.dispatched_at AS snapshot_dispatched_at
    FROM (${adapters.selectSql}) q JOIN import_batches b ON b.id = q.batch_id
    JOIN (SELECT header_id, COUNT(*) AS sibling_count FROM demand_details GROUP BY header_id) membership
      ON membership.header_id = q.header_id`).all<StoredRecord>();
  const rawById = new Map(result.results.map((raw) => [String(raw.id), raw]));
  const existing: ReconciliationStoredLine[] = result.results.map((raw) => {
    const line = adapters.lineFromRow(raw);
    return {
      id: line.id, headerId: String(raw.header_id), batchId: line.batchId, active: Number(raw.import_active) === 1,
      row: importRow(line), detailRevision: Number(raw.detail_revision || 0), headerRevision: Number(raw.header_revision || 0),
      status: line.status, verifiedAt: line.verifiedAt, loadedAt: line.loadedAt, dispatchedAt: line.dispatchedAt,
      inventoryItemId: line.inventoryItemId, fulfilledQuantity: Number(line.fulfilledQuantity || 0),
      hasScanEvidence: Number(raw.scan_count) > 0, hasLoadConfirmation: Number(raw.load_count) > 0,
    };
  });
  // A production snapshot does not cancel generated TEST work. Carry its active
  // rows forward unchanged so their IDs, allocations and evidence remain usable
  // in the separate Test work queue. Explicitly supplied changes still reconcile.
  const submittedIdentities = new Set(submitted.map((row) => demandSourceIdentity(row, sourceScope).identityKey));
  const retainedTestRows = existing.filter((line) => line.active
    && line.row.plant === "TEST" && line.row.programId === "TESTSCAN"
    && String(line.row.pymtc || "").startsWith("TEST:")
    && !submittedIdentities.has(demandSourceIdentity(line.row, sourceScope).identityKey));
  const incoming = [...submitted, ...retainedTestRows.map((line) => line.row)];
  const plan = planDemandReconciliation({ incoming, existing, sourceScope });
  const oldRows = existing.filter((line) => line.active);
  if (!input.allowShrink) {
    // Only lines that could actually be retired count: generated TEST work is carried
    // forward, whole dispatched picklists normally leave the feed, and worked lines are
    // protected. Otherwise scanned lines would dilute the share of unstarted demand removed.
    const carriedIds = new Set(retainedTestRows.map((line) => line.id));
    const archivedIds = new Set(plan.archived.map((line) => line.id));
    const shrink = assessSnapshotShrink({
      unworkedLines: oldRows.filter((line) => !carriedIds.has(line.id) && !line.dispatchedAt && !demandHasWork(line)).length,
      removedLines: plan.removed.filter((line) => !archivedIds.has(line.id)).length,
      incomingLines: submitted.length,
    });
    if (shrink) throw new SnapshotShrinkError(shrink);
  }
  const snapshotCount = activeBatch ? Number((await db.prepare("SELECT COUNT(*) AS count FROM demand_import_rows WHERE batch_id = ?")
    .bind(activeBatch.id).first<{ count: number }>())?.count || 0) : 0;

  const headerColumns = writableColumns(adapters.headerColumns);
  const detailColumns = writableColumns({ ...adapters.detailColumns, sourceLineId: "source_line_id", sourceScope: "source_scope" });
  const headerIds = new Map(plan.headers.map((header) => [header.cartKey, header.existingHeaderId || crypto.randomUUID()]));
  const detailIds = new Map(plan.lines.map((line, index) => [line.identityKey,
    line.existing?.id || input.detailIds?.[index] || crypto.randomUUID()]));
  const incomingByStoredId = new Map(plan.lines.filter((line) => line.existing).map((line) => [line.existing!.id, line]));
  const plannedByIdentity = new Map(plan.lines.map((line) => [line.identityKey, line]));
  const removedById = new Map(plan.removed.map((line) => [line.id, line]));
  const existingByHeader = new Map<string, ReconciliationStoredLine[]>();
  for (const line of existing) {
    const siblings = existingByHeader.get(line.headerId) || [];
    siblings.push(line);
    existingByHeader.set(line.headerId, siblings);
  }
  const unchangedHeaderIds = new Set(plan.headers.filter((header) => {
    if (!header.existingHeaderId) return false;
    const siblings = existingByHeader.get(header.existingHeaderId) || [];
    return siblings.length === header.lines.length && siblings.every((line) => line.active)
      && header.lines.every((line) => line.kind === "preserve" && line.existing?.headerId === header.existingHeaderId
        && String(line.existing.row.sourceScope || "") === String(line.row.sourceScope || "")
        && String(line.existing.row.sourceLineId || "") === String(line.row.sourceLineId || ""));
  }).map((header) => header.existingHeaderId!));
  // A lease only prevents changes to its own source fields or membership. Check
  // both old and new picklist identities under the write lock, including leases
  // acquired after planning and append reservations for a not-yet-created card.
  const affectedPicklists = new Set<string>();
  for (const line of oldRows) if (!unchangedHeaderIds.has(line.headerId)) affectedPicklists.add(reconciliationCartKey(line.row));
  for (const header of plan.headers) if (!header.existingHeaderId || !unchangedHeaderIds.has(header.existingHeaderId)) affectedPicklists.add(header.cartKey);
  const currentTime = adapters.databaseNow(db);
  const guardedHeaderCounts = new Map(plan.guards.map((line) => [line.headerId, Number(rawById.get(line.id)!.sibling_count)]));

  // Bound individual SQL expressions/parameter lists for SQLite and PostgreSQL.
  // Every chunk is still part of the same transaction under the global write lock.
  const guards = prepareWriteGuards(db, [...plan.guards.map((line) => {
    const raw = rawById.get(line.id)!;
    return db.prepare(`EXISTS (SELECT 1 FROM demand_details d JOIN demand_headers h ON h.id = d.header_id
        WHERE d.id = ? AND d.header_id = ? AND h.batch_id = ? AND d.revision = ? AND h.revision = ?
          AND d.status = ? AND COALESCE(d.verified_at, '') = ? AND COALESCE(d.inventory_item_id, '') = ?
          AND d.fulfilled_quantity = ? AND COALESCE(h.loaded_at, '') = ? AND COALESCE(h.dispatched_at, '') = ?
          AND (SELECT COUNT(*) FROM scan_events e WHERE e.line_id = d.id) = ?
          AND (SELECT COUNT(*) FROM load_confirmations lc WHERE lc.header_id = h.id) = ?)`)
      .bind(line.id, line.headerId, line.batchId, line.detailRevision, line.headerRevision,
        line.status, line.verifiedAt || "", line.inventoryItemId || "", line.fulfilledQuantity,
        line.loadedAt || "", raw.snapshot_dispatched_at || "", Number(raw.scan_count), Number(raw.load_count));
  }), ...[...guardedHeaderCounts].map(([headerId, count]) => db.prepare(
    "(SELECT COUNT(*) FROM demand_details WHERE header_id = ?) = ?",
  ).bind(headerId, count)), ...[...affectedPicklists].map((cartKey) => db.prepare(`NOT EXISTS (
    SELECT 1 FROM cart_locks WHERE expires_at > ${currentTime} AND (picklist_key = ? OR cart_key = ?)
  )`).bind(cartKey.split("::").slice(0, 4).join("::"), cartKey))]);

  const statements: PreparedStatement[] = [...guards.statements];
  if (activeBatch && snapshotCount === 0) {
    for (const line of oldRows) statements.push(db.prepare("INSERT INTO demand_import_rows (id, batch_id, row_json) VALUES (?, ?, ?)")
      .bind(crypto.randomUUID(), activeBatch.id, JSON.stringify(line.row)));
  }
  statements.push(db.prepare("INSERT INTO import_batches (id, file_name, row_count, imported_at, is_active) VALUES (?, ?, ?, ?, 0)")
    .bind(input.batchId, input.fileName.slice(0, 180), incoming.length, now));
  for (const row of submitted) statements.push(db.prepare("INSERT INTO demand_import_rows (id, batch_id, row_json) VALUES (?, ?, ?)")
    .bind(crypto.randomUUID(), input.batchId, JSON.stringify(row)));

  // Move reused headers first. This frees their old (batch, cart_key) slot so
  // omitted, untouched siblings can remain in history under an archived header.
  for (const header of plan.headers) {
    const id = headerIds.get(header.cartKey)!;
    if (header.existingHeaderId) {
      statements.push(db.prepare(`UPDATE demand_headers SET batch_id = ?, picklist_identity = ?${unchangedHeaderIds.has(id) ? "" : ", revision = revision + 1"},
        ${headerColumns.map(([, column]) => `${column} = ?`).concat("cart_key = ?").join(", ")} WHERE id = ?`)
        .bind(input.batchId, picklistIdentityKey(header.row), ...headerColumns.map(([field]) => storedValue(header.row, field)), header.cartKey, id));
    } else {
      statements.push(adapters.prepareHeaderInsert(db, input.batchId, id, header.row));
    }
  }
  const archivedHeaderByLine = new Map<string, string>();
  for (const header of plan.headers.filter((candidate) => candidate.existingHeaderId)) {
    const omitted = (existingByHeader.get(header.existingHeaderId!) || []).filter((line) => !incomingByStoredId.has(line.id));
    if (!omitted.length) continue;
    const archiveId = crypto.randomUUID();
    statements.push(adapters.prepareHeaderInsert(db, omitted[0].batchId, archiveId, omitted[0].row));
    for (const line of omitted) {
      archivedHeaderByLine.set(line.id, archiveId);
      statements.push(db.prepare("UPDATE demand_details SET header_id = ?, revision = revision + 1 WHERE id = ?")
        .bind(archiveId, line.id));
    }
  }
  for (const line of plan.lines) {
    const headerId = headerIds.get(line.cartKey)!;
    const detailId = detailIds.get(line.identityKey)!;
    if (!line.existing) {
      statements.push(adapters.prepareDetailInsert(db, headerId, detailId, line.row));
    } else {
      // Write only source fields; never touch fulfillment, serial, evidence or loading.
      const fields = line.kind === "update" ? detailColumns : detailColumns.filter(([field]) => field === "sourceLineId" || field === "sourceScope");
      const identityChanged = String(line.existing.row.sourceScope || "") !== String(line.row.sourceScope || "")
        || String(line.existing.row.sourceLineId || "") !== String(line.row.sourceLineId || "");
      const changed = line.kind === "update" || line.existing.headerId !== headerId || identityChanged;
      statements.push(db.prepare(`UPDATE demand_details SET header_id = ?${changed ? ", revision = revision + 1" : ""},
        ${fields.map(([, column]) => `${column} = ?`).join(", ")} WHERE id = ?`)
        .bind(headerId, ...fields.map(([field]) => storedValue(line.row, field)), detailId));
      if (!line.existing.active || line.existing.headerId !== headerId) {
        statements.push(db.prepare(`INSERT INTO demand_audit_events
          (id, batch_id, header_id, line_id, action, before_json, after_json, actor_id, actor_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), input.batchId, headerId, detailId,
            line.existing.active ? "reconcile_reparent" : "reconcile_restore",
            JSON.stringify({ batchId: line.existing.batchId, headerId: line.existing.headerId, active: line.existing.active }),
            JSON.stringify({ batchId: input.batchId, headerId, active: true }), input.actorId || "",
            input.actorName || "Demand import", now));
      }
    }
  }
  for (const audit of plan.audits) {
    const line = plannedByIdentity.get(audit.identityKey);
    const removed = audit.action === "reconcile_remove" || audit.action === "reconcile_archive"
      ? removedById.get(audit.lineId!) : null;
    const headerId = removed ? archivedHeaderByLine.get(removed.id) || removed.headerId : headerIds.get(line!.cartKey)!;
    const lineId = audit.lineId || detailIds.get(audit.identityKey)!;
    statements.push(db.prepare(`INSERT INTO demand_audit_events
      (id, batch_id, header_id, line_id, action, before_json, after_json, actor_id, actor_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), removed?.batchId || input.batchId, headerId, lineId, audit.action,
        JSON.stringify(audit.before), JSON.stringify(audit.after), input.actorId || "",
        input.actorName || "Demand import", now));
  }
  statements.push(db.prepare("UPDATE import_batches SET is_active = 0 WHERE is_active = 1"),
    db.prepare("UPDATE import_batches SET is_active = 1 WHERE id = ?").bind(input.batchId));
  if (input.integrationReceiptId) statements.push(db.prepare(`UPDATE integration_imports SET status = 'complete',
    row_count = ?, imported_at = ?, expires_at = ? WHERE id = ? AND status = 'processing'`)
    .bind(incoming.length, now, new Date(Date.parse(now) + 56 * 60 * 60_000).toISOString(), input.integrationReceiptId));
  // Verify final membership before committing; moving a reused header must not
  // accidentally activate omitted old rows or leave a planned row historical.
  const finalGuardId = crypto.randomUUID();
  statements.push(db.prepare(`INSERT INTO cartflow_write_guards (id, valid) VALUES (?, CASE WHEN
    (SELECT COUNT(*) FROM demand_details d JOIN demand_headers h ON h.id = d.header_id WHERE h.batch_id = ?) = ?
    THEN 1 ELSE 0 END)`).bind(finalGuardId, input.batchId, incoming.length));
  statements.push(...guards.cleanup, db.prepare("DELETE FROM cartflow_write_guards WHERE id = ?").bind(finalGuardId));

  const conditions = [
    `EXISTS (SELECT 1 FROM integration_imports WHERE id = ? AND batch_id = ? AND status = 'processing' AND expires_at > ${currentTime})`,
    "COALESCE((SELECT id FROM import_batches WHERE is_active = 1 LIMIT 1), '') = ?",
    "(SELECT COUNT(*) FROM demand_details d JOIN demand_headers h ON h.id = d.header_id JOIN import_batches b ON b.id = h.batch_id WHERE b.is_active = 1) = ?",
  ];
  const values: DatabaseValue[] = [input.integrationReceiptId || "", input.batchId, activeBatch?.id || "", oldRows.length];
  if (activeBatch) {
    conditions.push("(SELECT COUNT(*) FROM demand_import_rows WHERE batch_id = ?) = ?");
    values.push(activeBatch.id, snapshotCount);
  }
  await db.guardedBatch(statements, db.prepare(conditions.join(" AND ")).bind(...values));
  return { batchId: input.batchId, rowCount: incoming.length, importedAt: now,
    reconciliation: {
      preserved: plan.lines.filter((line) => line.kind === "preserve").length,
      updated: plan.lines.filter((line) => line.kind === "update").length,
      added: plan.lines.filter((line) => line.kind === "insert").length,
      removed: plan.removed.length,
    },
  };
}
