import { picklistIdentityKey } from "../lib/cart-identity.ts";
import type { ImportRow } from "../lib/types.ts";

/** A consistent read of one stored line, including every sibling of a reused header. */
export type ReconciliationStoredLine = {
  id: string;
  headerId: string;
  batchId: string;
  active: boolean;
  row: ImportRow;
  detailRevision: number;
  headerRevision: number;
  status: string;
  verifiedAt: string | null;
  loadedAt: string | null;
  dispatchedAt?: string | null;
  inventoryItemId: string | null;
  fulfilledQuantity: number;
  /** Include invalidated and unsuccessful scans: they are still operational history. */
  hasScanEvidence: boolean;
  hasLoadConfirmation: boolean;
};

export type ReconciliationIssue = {
  reason: "duplicate_source_identity" | "ambiguous_history" | "worked_line_changed"
    | "worked_line_removed" | "worked_cart_changed" | "ambiguous_header"
    | "inconsistent_header" | "terminal_demand_reintroduced";
  sourceLineId: string;
  sourceScope: string;
  lineId?: string;
  headerId?: string;
  fields?: string[];
  message: string;
};

export class DemandReconciliationError extends Error {
  readonly status = 409;
  readonly code = "reconciliation_required";
  readonly issues: ReconciliationIssue[];

  constructor(issues: ReconciliationIssue[]) {
    super(`Demand reconciliation required: ${issues[0]?.message || "Review the source demand."} No demand or inventory was changed.`);
    this.name = "DemandReconciliationError";
    this.issues = issues;
  }
}

/**
 * A full snapshot may retire open demand, but a delivery that retires most of it is
 * far more likely to be a truncated export, an empty file or the wrong file than a
 * real change. Such a snapshot is refused unless the sender explicitly confirms it.
 */
export const SHRINK_GUARD_MIN_LINES = 10;
export const SHRINK_GUARD_FRACTION = 0.5;

export type SnapshotShrinkDetails = {
  reason: "empty_snapshot" | "large_removal";
  /**
   * Production lines that could be retired: not dispatched and with no scan, packing or
   * loading activity. Worked lines are excluded because a snapshot can never remove them,
   * so counting them would let a large truncation of the rest pass.
   */
  unworkedLines: number;
  /** Unworked lines the snapshot would retire. Whole dispatched picklists are excluded. */
  removedLines: number;
  incomingLines: number;
};

export class SnapshotShrinkError extends Error {
  readonly status = 409;
  readonly code = "shrink_confirmation_required";
  readonly shrink: SnapshotShrinkDetails;

  constructor(shrink: SnapshotShrinkDetails) {
    const counts = `remove ${shrink.removedLines} of ${shrink.unworkedLines} demand lines that have no scan, packing or loading activity yet`;
    super(shrink.reason === "empty_snapshot"
      ? `This snapshot contains no demand rows but would ${counts}. An empty file usually means an export failed. No demand or inventory was changed. Resend with allowShrink only if no demand is really open.`
      : `This snapshot would ${counts} (${Math.round(shrink.removedLines / Math.max(1, shrink.unworkedLines) * 100)}%). A truncated or wrong file usually causes this. No demand or inventory was changed. Resend with allowShrink only if the file is meant to be the complete list of open demand.`);
    this.name = "SnapshotShrinkError";
    this.shrink = shrink;
  }
}

/** Returns details when the snapshot must be confirmed, otherwise null. */
export function assessSnapshotShrink(input: { unworkedLines: number; removedLines: number; incomingLines: number }): SnapshotShrinkDetails | null {
  const { unworkedLines, removedLines, incomingLines } = input;
  if (removedLines <= 0) return null;
  const details = { unworkedLines, removedLines, incomingLines };
  if (incomingLines === 0) return { reason: "empty_snapshot", ...details };
  if (removedLines >= SHRINK_GUARD_MIN_LINES && removedLines >= unworkedLines * SHRINK_GUARD_FRACTION) {
    return { reason: "large_removal", ...details };
  }
  return null;
}

export type ReconciliationLine = {
  row: ImportRow;
  identityKey: string;
  cartKey: string;
  kind: "insert" | "preserve" | "update";
  existing: ReconciliationStoredLine | null;
  changedFields: string[];
};

export type ReconciliationHeader = {
  cartKey: string;
  row: ImportRow;
  existingHeaderId: string | null;
  /** Reused header IDs remain authoritative for barcodes and loading history. */
  lines: ReconciliationLine[];
};

export type ReconciliationAudit = {
  action: "reconcile_add" | "reconcile_update" | "reconcile_remove" | "reconcile_archive";
  lineId: string | null;
  identityKey: string;
  before: ImportRow | null;
  after: ImportRow | null;
};

export type DemandReconciliationPlan = {
  lines: ReconciliationLine[];
  headers: ReconciliationHeader[];
  /** Only active lines omitted from the replacement; unmatched history is retained. */
  removed: ReconciliationStoredLine[];
  /** Entire dispatched picklists omitted by the next open-demand snapshot. */
  archived: ReconciliationStoredLine[];
  /** Caller must recheck these snapshots under its transaction lock. */
  guards: ReconciliationStoredLine[];
  audits: ReconciliationAudit[];
};

const headerFields = new Set([
  "option", "plant", "zone", "areaType", "shipCategory", "loadNumber", "trainNumber",
  "picklistNumber", "cartNumber", "cartId", "palletId", "programId", "totalCarts",
  "pymtc", "checksheetNumber", "masterBarcode", "movementBarcode", "caseCode",
  "outgoingSerial", "cartSequenceNumber", "fromLot", "toLot", "model", "cartType",
  "scheduledDispatchDate", "scheduledDispatchTime", "deliveryLocation", "chassisNumber",
  "orderNumber", "batchNumber", "loadingSequence", "productionQuantity", "cartMaxQuantity",
  "interiorColor", "exteriorColor", "vehicleColor",
]);
const outputFields = new Set([
  "allocations", "remainingQuantity", "fulfilledAt", "fulfilledBy", "shortClosedAt", "id", "batchId", "headerId", "cartBarcode", "loadedAt", "loadedBy", "status",
  "verifiedAt", "aiagSerial", "legacyExpectedSerial", "fulfilledQuantity", "inventoryItemId",
  "sourceLineId", "sourceScope", "headerRevision", "detailRevision", "dispatchedAt", "dispatchedBy",
]);
const zeroDefaultFields = new Set(["totalCarts", "containerTotal"]);
const numericFields = new Set(["quantity", "totalCarts", "containerTotal", "productionQuantity", "cartMaxQuantity"]);

function text(value: unknown) {
  return String(value ?? "").trim();
}

function fieldValue(row: ImportRow, field: string): string | number {
  const value = (row as unknown as Record<string, unknown>)[field];
  if (field === "programId") return text(value) || "ODG303R";
  if (field === "unitOfMeasure") return text(value) || "EA";
  if (zeroDefaultFields.has(field) && text(value) === "") return 0;
  if (numericFields.has(field) && text(value) !== "") return Number(value);
  return text(value);
}

function differentFields(before: ImportRow, after: ImportRow, headerOnly = false) {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...fields].filter((field) => !outputFields.has(field)
    && (!headerOnly || headerFields.has(field))
    && fieldValue(before, field) !== fieldValue(after, field)).sort();
}

export function reconciliationCartKey(row: ImportRow): string {
  const movement = row.areaType === "offsite" ? row.loadNumber : row.trainNumber;
  return [row.plant, row.areaType, movement, row.picklistNumber, row.cartNumber, row.cartId].join("::");
}

/** Scope never depends on filename, receipt ID, import time, or array position. */
export function demandSourceIdentity(row: ImportRow, defaultScope = "") {
  const sourceScope = text(row.sourceScope) || text(defaultScope);
  const sourceLineId = text(row.sourceLineId);
  const identityKey = sourceLineId
    ? JSON.stringify(["source", sourceScope, sourceLineId])
    : JSON.stringify(["legacy", sourceScope, row.plant, row.areaType,
      row.areaType === "offsite" ? row.loadNumber : row.trainNumber,
      row.picklistNumber, row.cartNumber, row.cartId, row.sequence]);
  return { sourceScope, sourceLineId, identityKey };
}

export function demandHasWork(line: ReconciliationStoredLine) {
  return line.status !== "pending" || Boolean(line.verifiedAt || line.loadedAt || line.dispatchedAt || line.inventoryItemId)
    || line.fulfilledQuantity !== 0 || line.hasScanEvidence || line.hasLoadConfirmation;
}

/**
 * Pure reconciliation planner for a complete incoming snapshot.
 *
 * Supply every active line, plus historical identity matches and all their header
 * siblings. No business fields are inferred from serials. Explicit IDs are exact,
 * case-sensitive source identifiers; legacy rows use cart identity + sequence.
 * Adding explicit source IDs to worked legacy rows requires an explicit mapping.
 *
 * Apply the plan in ONE guarded transaction: verify the original active batch,
 * receipt/expiry, absence of leases on changed picklists, row/header revisions and work evidence;
 * save import-row snapshots; reuse IDs and move retained headers/details; write
 * audits; activate the new batch and finish its receipt. Never reset fulfillment,
 * delete stock, remove evidence, or copy worked details into new IDs. Recheck scan
 * and load evidence explicitly because recording a scan need not bump revisions.
 *
 * `removed` means retire from the active snapshot. Keep historical rows whenever
 * audit/projection references need them; this planner does not authorize evidence
 * deletion. Callers allocate IDs for inserts and resolve null audit line IDs.
 */
export function planDemandReconciliation(input: {
  incoming: ImportRow[];
  existing: ReconciliationStoredLine[];
  sourceScope?: string;
}): DemandReconciliationPlan {
  const scope = input.sourceScope || "";
  const issues: ReconciliationIssue[] = [];
  const byIdentity = new Map<string, ReconciliationStoredLine[]>();
  const byHeader = new Map<string, ReconciliationStoredLine[]>();
  const activeHeadersByCart = new Map<string, Set<string>>();
  const issue = (reason: ReconciliationIssue["reason"], row: ImportRow, message: string,
    stored?: ReconciliationStoredLine, fields?: string[]) => {
    const identity = demandSourceIdentity(row, scope);
    issues.push({ reason, sourceLineId: identity.sourceLineId, sourceScope: identity.sourceScope,
      ...(stored ? { lineId: stored.id, headerId: stored.headerId } : {}),
      ...(fields ? { fields } : {}), message });
  };
  for (const stored of input.existing) {
    const key = demandSourceIdentity(stored.row, scope).identityKey;
    const matches = byIdentity.get(key) || [];
    matches.push(stored);
    byIdentity.set(key, matches);
    const siblings = byHeader.get(stored.headerId) || [];
    siblings.push(stored);
    byHeader.set(stored.headerId, siblings);
    if (stored.active) {
      const cartKey = picklistIdentityKey(stored.row);
      const ids = activeHeadersByCart.get(cartKey) || new Set<string>();
      ids.add(stored.headerId);
      activeHeadersByCart.set(cartKey, ids);
    }
  }
  const seenIncoming = new Set<string>();
  const retainedIds = new Set<string>();
  const lines: ReconciliationLine[] = [];
  for (const row of input.incoming) {
    const identity = demandSourceIdentity(row, scope);
    if (seenIncoming.has(identity.identityKey)) {
      issue("duplicate_source_identity", row, `Source demand ${identity.sourceLineId || row.sequence} appears more than once. Supply a unique Source Line ID for each demand.`);
      continue;
    }
    seenIncoming.add(identity.identityKey);
    const candidates = byIdentity.get(identity.identityKey) || [];
    const active = candidates.filter((candidate) => candidate.active);
    // An active match cannot hide older consumed/loaded instances of that same ID.
    const historicalWork = candidates.filter((candidate) => !candidate.active && demandHasWork(candidate));
    if (active.length > 1 || historicalWork.length > 1 || (active.length && historicalWork.length)
      || (!active.length && candidates.length > 1)) {
      issue("ambiguous_history", row, `Source demand ${identity.sourceLineId || row.sequence} has multiple stored identities. Reconcile its history before retrying.`, active[0] || candidates[0]);
      continue;
    }
    const existing = active[0] || candidates[0] || null;
    if (existing && !existing.active && existing.dispatchedAt) {
      issue("terminal_demand_reintroduced", row,
        `Demand ${identity.sourceLineId || existing.id} was dispatched and archived. Use a new source identity for new demand; departed work cannot be reopened.`, existing);
    }
    const changedFields = existing ? differentFields(existing.row, row) : [];
    if (existing && changedFields.length && demandHasWork(existing)) {
      issue("worked_line_changed", row,
        `Demand ${identity.sourceLineId || existing.id} already has scan, packing, or loading history; changes to ${changedFields.join(", ")} require supervisor reconciliation.`,
        existing, changedFields);
    }
    if (existing) retainedIds.add(existing.id);
    lines.push({ row, identityKey: identity.identityKey, cartKey: reconciliationCartKey(row),
      existing, changedFields, kind: !existing ? "insert" : changedFields.length ? "update" : "preserve" });
  }
  const removed = input.existing.filter((stored) => stored.active && !retainedIds.has(stored.id));
  const incomingPicklists = new Set(input.incoming.map(picklistIdentityKey));
  const archivedHeaders = new Set([...byHeader].filter(([, siblings]) =>
    !incomingPicklists.has(picklistIdentityKey(siblings[0].row))
      && siblings.every((sibling) => sibling.active && Boolean(sibling.dispatchedAt) && !retainedIds.has(sibling.id)))
    .map(([headerId]) => headerId));
  const archived = removed.filter((stored) => archivedHeaders.has(stored.headerId));
  for (const stored of removed) {
    if (demandHasWork(stored) && !archivedHeaders.has(stored.headerId)) {
      issue("worked_line_removed", stored.row,
        `Demand ${text(stored.row.sourceLineId) || stored.id} is missing from the new snapshot but has scan, packing, or loading history. Restore it or reconcile the cancellation before retrying.`, stored);
    }
  }

  const grouped = new Map<string, ReconciliationLine[]>();
  for (const line of lines) {
    const key = picklistIdentityKey(line.row);
    const members = grouped.get(key) || [];
    members.push(line);
    grouped.set(key, members);
  }
  const headers: ReconciliationHeader[] = [];
  for (const [picklistKey, members] of grouped) {
    const row = members[0].row;
    const cartKey = reconciliationCartKey(row);
    for (const member of members) member.cartKey = cartKey;
    for (const member of members.slice(1)) {
      const fields = differentFields(row, member.row, true);
      if (fields.length) issue("inconsistent_header", member.row, `Picklist ${row.picklistNumber} must have exactly one outbound card/pallet/order; conflicting header fields: ${fields.join(", ")}.`, undefined, fields);
    }
    const matchedHeaders = new Set(members.filter((member) => member.existing
      && picklistIdentityKey(member.existing.row) === picklistKey).map((member) => member.existing!.headerId));
    const activeHeaderIds = activeHeadersByCart.get(picklistKey) || new Set<string>();
    const sourceHeaderIds = new Set([...matchedHeaders, ...activeHeaderIds]);
    // An omitted, untouched sibling receives an archival header. Its return is
    // not a second operational card: prefer the active header, or create one
    // when several compatible, untouched historical headers are being restored.
    // Check all siblings, including omitted history, before consolidating cards.
    const incompatibleHistory = sourceHeaderIds.size > 1 && [...sourceHeaderIds].some((headerId) =>
      (byHeader.get(headerId) || []).some((sibling) => demandHasWork(sibling)
        || differentFields(sibling.row, row, true).length > 0));
    if (activeHeaderIds.size > 1 || incompatibleHistory) {
      issue("ambiguous_header", row, `Picklist ${row.picklistNumber} has multiple stored outbound cards. Reconcile them to one outbound card/pallet/order before retrying; existing evidence cannot be merged automatically.`);
    }
    const existingHeaderId = activeHeaderIds.size === 1 ? [...activeHeaderIds][0]
      : matchedHeaders.size === 1 ? [...matchedHeaders][0] : null;
    headers.push({ cartKey, row, existingHeaderId, lines: members });
  }

  // Printed/scanned carts are a unit: adding or moving a sibling can change what
  // earlier cart evidence means, even when a fulfilled line's own fields agree.
  const guards = new Map<string, ReconciliationStoredLine>();
  const targetByHeader = new Map(headers.filter((header) => header.existingHeaderId).map((header) => [header.existingHeaderId!, header]));
  for (const stored of input.existing) if (stored.active || retainedIds.has(stored.id)) guards.set(stored.id, stored);
  for (const [headerId, siblings] of byHeader) {
    const selected = siblings.some((sibling) => sibling.active || retainedIds.has(sibling.id));
    if (!selected) continue;
    for (const sibling of siblings) guards.set(sibling.id, sibling);
    // A whole departed card remains immutable in history. Partial omissions still
    // fail below, as do membership changes to any retained worked card.
    if (archivedHeaders.has(headerId)) continue;
    const worked = siblings.find(demandHasWork);
    if (!worked) continue;
    const target = targetByHeader.get(headerId);
    const previousIds = new Set(siblings.map((sibling) => sibling.id));
    if (!target || target.lines.length !== previousIds.size
      || target.lines.some((line) => !line.existing || !previousIds.has(line.existing.id))) {
      issue("worked_cart_changed", worked.row,
        `Cart ${worked.row.cartNumber} already has scan, packing, or loading history. Its line membership cannot change until a supervisor reconciles the cart.`, worked);
    }
  }
  if (issues.length) throw new DemandReconciliationError(issues);

  const audits: ReconciliationAudit[] = lines.filter((line) => line.kind !== "preserve").map((line) => ({
    action: line.kind === "insert" ? "reconcile_add" : "reconcile_update",
    lineId: line.existing?.id || null, identityKey: line.identityKey,
    before: line.existing?.row || null, after: line.row,
  }));
  for (const stored of removed) audits.push({ action: archivedHeaders.has(stored.headerId) ? "reconcile_archive" : "reconcile_remove", lineId: stored.id,
    identityKey: demandSourceIdentity(stored.row, scope).identityKey, before: stored.row, after: null });
  return { lines, headers, removed, archived, guards: [...guards.values()], audits };
}
