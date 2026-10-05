import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_LIMIT = 10_000;
export const MAX_LIMIT = 100_000;

// This command deliberately does not import the application database adapter:
// opening the application store can initialize or migrate its schema.
const ALLOCATION_SELECT = `SELECT a.id AS allocation_id, a.request_id,
  a.request_fingerprint, a.demand_detail_id, a.inventory_item_id,
  a.serial AS allocation_serial, a.packed_at, a.reversed_at,
  i.id AS stored_inventory_id, i.normalized_serial AS inventory_serial,
  i.supplier_id AS inventory_supplier_id, i.is_test
  FROM fulfillment_allocations a
  LEFT JOIN inventory_items i ON i.id = a.inventory_item_id`;

const normalize = (value) => String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");

/** Legacy requests did not record whether serial text included a barcode identifier. */
export function inspectAllocation(row) {
  let fingerprint;
  try { fingerprint = JSON.parse(row.request_fingerprint); } catch { /* Migrated receipts can have the marker "legacy". */ }
  const finding = (classification, reasons, evidence = {}) => ({
    classification, reasons,
    allocationId: row.allocation_id, requestId: row.request_id,
    demandDetailId: row.demand_detail_id, inventoryItemId: row.inventory_item_id,
    packedAt: row.packed_at, reversedAt: row.reversed_at || null,
    isTest: row.is_test === null || row.is_test === undefined ? null : Boolean(Number(row.is_test)),
    inventorySerial: row.inventory_serial ?? null,
    inventorySupplierId: row.inventory_supplier_id ?? null,
    ...evidence,
  });
  if (!row.stored_inventory_id) return finding("MISMATCH", ["inventory_record_missing"]);

  const isV2 = Array.isArray(fingerprint) && fingerprint.length === 6 && fingerprint[0] === 2
    && typeof fingerprint[1] === "string" && typeof fingerprint[2] === "string"
    && typeof fingerprint[3] === "string" && fingerprint[3].length > 0
    && (fingerprint[4] === null || typeof fingerprint[4] === "string");
  if (isV2) {
    const [, , lineId, serial, supplierId] = fingerprint;
    const reasons = [];
    if (serial !== row.inventory_serial) reasons.push("canonical_serial_mismatch");
    if (supplierId !== null && supplierId !== (row.inventory_supplier_id || "")) reasons.push("specified_supplier_mismatch");
    if (lineId && lineId !== row.demand_detail_id) reasons.push("specified_demand_line_mismatch");
    return reasons.length ? finding("MISMATCH", reasons, { fingerprintVersion: 2,
      requestedSerial: serial, requestedSupplierId: supplierId }) : null;
  }

  const isLegacy = Array.isArray(fingerprint) && fingerprint.length === 5
    && fingerprint.slice(0, 4).every((value) => typeof value === "string") && fingerprint[2].length > 0;
  if (!isLegacy) return finding("REVIEW", ["identity_fingerprint_unavailable"]);
  const serial = normalize(fingerprint[2]);
  const supplierId = normalize(fingerprint[3]);
  const barcodeSerial = serial.startsWith("1S") ? serial.slice(2).trim() : null;
  const reasons = [];
  // A leading 1S can belong to the barcode or to the serial itself. A mismatch
  // against the barcode interpretation is evidence for review, never a repair.
  if (barcodeSerial !== null && barcodeSerial !== row.inventory_serial) reasons.push("legacy_serial_format_ambiguous");
  else if (barcodeSerial === null && serial !== row.inventory_serial) reasons.push("legacy_serial_mismatch");
  // Empty legacy suppliers meant either omitted or explicitly blank.
  if (supplierId && supplierId !== (row.inventory_supplier_id || "")) reasons.push("legacy_supplier_mismatch");
  if (fingerprint[1] && fingerprint[1] !== row.demand_detail_id) reasons.push("legacy_demand_line_mismatch");
  return reasons.length ? finding("REVIEW", reasons, { fingerprintVersion: "legacy",
    requestedSerial: serial, barcodeInterpretation: barcodeSerial, requestedSupplierId: supplierId || null }) : null;
}

export async function readAllocationPage({ sqlitePath, postgresUrl, limit = DEFAULT_LIMIT, after = "", neonFactory }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error("Invalid audit limit.");
  const values = [after, limit + 1];
  if (sqlitePath) {
    const db = new DatabaseSync(resolve(sqlitePath), { readOnly: true });
    try {
      return db.prepare(`${ALLOCATION_SELECT} WHERE a.id > ? ORDER BY a.id LIMIT ?`).all(...values);
    } finally { db.close(); }
  }
  if (!postgresUrl) throw new Error("An explicit database selection is required.");
  const factory = neonFactory || (await import("@neondatabase/serverless")).neon;
  const sql = factory(postgresUrl);
  // Query the configured provider directly; no connection URL appears in reports.
  return sql.query(`${ALLOCATION_SELECT} WHERE a.id > $1 ORDER BY a.id LIMIT $2`, values);
}

export function buildAuditReport(rows, { backend, limit = DEFAULT_LIMIT }) {
  const selected = rows.slice(0, limit);
  const findings = selected.map(inspectAllocation).filter(Boolean);
  const truncated = rows.length > limit;
  return {
    audit: "fulfillment-identity", version: 1, readOnly: true, backend,
    checkedAllocations: selected.length,
    reviewCount: findings.filter((finding) => finding.classification === "REVIEW").length,
    mismatchCount: findings.filter((finding) => finding.classification === "MISMATCH").length,
    noFindingCount: selected.length - findings.length,
    truncated, nextAfter: truncated ? selected.at(-1).allocation_id : null,
    scope: "Active and reversed allocations, including test records. Legacy matches cannot prove which physical barcode was scanned.",
    findings,
  };
}

function optionsFromArgs(args, env) {
  let sqlitePath;
  let limit = DEFAULT_LIMIT;
  let after = "";
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--limit") {
      const value = args[++index];
      if (!/^\d+$/.test(value || "")) throw new Error("Usage error.");
      limit = Number(value);
    } else if (argument === "--after") {
      after = args[++index];
      if (typeof after !== "string" || !after || after.length > 512 || /[\u0000-\u001f]/.test(after)) throw new Error("Usage error.");
    } else if (argument.startsWith("--") || sqlitePath) throw new Error("Usage error.");
    else sqlitePath = argument;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error("Usage error.");
  const postgresUrl = sqlitePath ? undefined : env.DATABASE_URL || env.POSTGRES_URL;
  if (!sqlitePath && !postgresUrl) sqlitePath = env.CARTFLOW_DATABASE_PATH?.trim();
  if (!sqlitePath && !postgresUrl) throw new Error("Usage error.");
  return { sqlitePath, postgresUrl, limit, after };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let options;
  try { options = optionsFromArgs(args, env); }
  catch {
    console.error(JSON.stringify({ error: "Specify an existing SQLite path or configured DATABASE_URL, POSTGRES_URL, or CARTFLOW_DATABASE_PATH. Usage: node scripts/audit-fulfillment-identity.mjs [existing.sqlite] [--limit 1..100000] [--after allocation-id]." }));
    return 1;
  }
  try {
    const rows = await readAllocationPage(options);
    console.log(JSON.stringify(buildAuditReport(rows, { backend: options.sqlitePath ? "sqlite" : "postgres", limit: options.limit }), null, 2));
    return 0;
  } catch {
    // Driver errors can contain credentials, URLs, SQL, or server details.
    console.error(JSON.stringify({ error: "Unable to read the selected database. Verify read access and that its existing fulfillment ledger schema is available. No initialization, migration, or repair was attempted." }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
