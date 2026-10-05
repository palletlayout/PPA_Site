import assert from "node:assert/strict";
import test from "node:test";
import {
  DemandReconciliationError,
  demandSourceIdentity,
  planDemandReconciliation,
} from "../db/demand-reconciliation.ts";

const row = (changes = {}) => ({
  sourceScope: "erp", sourceLineId: "ORDER-1/LINE-1", plant: "PLT-01", zone: "A",
  areaType: "onsite", shipCategory: "Production", loadNumber: "", trainNumber: "TRAIN-01",
  picklistNumber: "PL-1", cartNumber: "C-1", cartId: "CART-1", palletId: "PAL-1",
  sequence: "010", partNumber: "P-1", description: "Part", color: "BLUE", quantity: 12,
  aiagSerial: "", ...changes,
});
const stored = (changes = {}) => ({
  id: "demand-uuid", headerId: "header-uuid", batchId: "old-batch", active: true,
  row: row(), detailRevision: 3, headerRevision: 5, status: "pending", verifiedAt: null,
  loadedAt: null, inventoryItemId: null, fulfilledQuantity: 0,
  hasScanEvidence: false, hasLoadConfirmation: false, ...changes,
});
const worked = (changes = {}) => stored({
  row: row({ aiagSerial: "CONTAINER-9" }), status: "verified", verifiedAt: "2026-09-16T01:00:00Z",
  inventoryItemId: "inventory-uuid", fulfilledQuantity: 12, hasScanEvidence: true, ...changes,
});
const conflict = (callback, reason) => assert.throws(callback, (error) => {
  assert.ok(error instanceof DemandReconciliationError);
  assert.equal(error.status, 409);
  assert.equal(error.code, "reconciliation_required");
  assert.ok(error.issues.some((issue) => issue.reason === reason), JSON.stringify(error.issues));
  return true;
});

test("unchanged recurring demand preserves fulfilled IDs, allocation and loaded header", () => {
  const previous = worked({ loadedAt: "2026-09-16T02:00:00Z", hasLoadConfirmation: true });
  const before = structuredClone(previous);
  const incoming = row();
  const plan = planDemandReconciliation({ incoming: [incoming], existing: [previous] });
  assert.equal(plan.lines[0].kind, "preserve");
  assert.equal(plan.lines[0].existing.id, "demand-uuid");
  assert.equal(plan.lines[0].existing.inventoryItemId, "inventory-uuid");
  assert.equal(plan.headers[0].existingHeaderId, "header-uuid");
  assert.deepEqual(plan.removed, []);
  assert.deepEqual(plan.audits, []);
  assert.deepEqual(previous, before);
  assert.equal(incoming.aiagSerial, "");
});

test("source identity survives reordering and scopes identical upstream IDs independently", () => {
  const a = stored();
  const b = stored({ id: "other-line", headerId: "other-header", row: row({
    sourceScope: "other-erp", picklistNumber: "PL-2", cartId: "CART-2", cartNumber: "C-2",
  }) });
  const plan = planDemandReconciliation({ incoming: [b.row, a.row], existing: [a, b] });
  assert.deepEqual(plan.lines.map((line) => line.existing.id), ["other-line", "demand-uuid"]);
  assert.notEqual(demandSourceIdentity(a.row).identityKey, demandSourceIdentity(b.row).identityKey);
  assert.notEqual(demandSourceIdentity(row({ sourceLineId: "abc" })).identityKey,
    demandSourceIdentity(row({ sourceLineId: "ABC" })).identityKey);
});

test("legacy fallback matches cart and sequence without coupling identity to quantity or part", () => {
  const previous = stored({ row: row({ sourceScope: "", sourceLineId: "" }) });
  const plan = planDemandReconciliation({ sourceScope: "erp", incoming: [{ ...previous.row, quantity: 14 }], existing: [previous] });
  assert.equal(plan.lines[0].existing.id, previous.id);
  assert.equal(plan.lines[0].kind, "update");
  assert.deepEqual(plan.lines[0].changedFields, ["quantity"]);
  assert.equal(plan.audits[0].before.quantity, 12);
  assert.equal(plan.audits[0].after.quantity, 14);
});

test("unworked updates, additions and removals retain explicit audit intent", () => {
  const a = stored();
  const removed = stored({ id: "removed-line", row: row({ sourceLineId: "removed", sequence: "020" }) });
  const changed = row({ quantity: 10.25, unitOfMeasure: "KG" });
  const added = row({ sourceLineId: "new", sequence: "030" });
  const plan = planDemandReconciliation({ incoming: [changed, added], existing: [a, removed] });
  assert.deepEqual(plan.lines.map((line) => line.kind), ["update", "insert"]);
  assert.equal(plan.headers[0].existingHeaderId, a.headerId);
  assert.deepEqual(plan.removed.map((line) => line.id), [removed.id]);
  assert.deepEqual(plan.audits.map((audit) => audit.action), ["reconcile_update", "reconcile_add", "reconcile_remove"]);
  assert.equal(plan.audits[0].after.quantity, 10.25);
  assert.equal(plan.audits[1].lineId, null);
  assert.equal(plan.guards.length, 2);
});

test("changed or removed worked demand is rejected with line and field context", () => {
  for (const previous of [worked(), stored({ hasScanEvidence: true }), stored({ hasLoadConfirmation: true }),
    stored({ inventoryItemId: "allocated" }), stored({ fulfilledQuantity: 1 }), stored({ verifiedAt: "old" })]) {
    conflict(() => planDemandReconciliation({ incoming: [row({ quantity: 20 })], existing: [previous] }), "worked_line_changed");
    conflict(() => planDemandReconciliation({ incoming: [], existing: [previous] }), "worked_line_removed");
  }
  try {
    planDemandReconciliation({ incoming: [row({ preferredSupplierId: "supplier-b" })], existing: [worked()] });
    assert.fail("expected reconciliation error");
  } catch (error) {
    assert.equal(error.issues[0].lineId, "demand-uuid");
    assert.deepEqual(error.issues[0].fields, ["preferredSupplierId"]);
  }
});

test("cart header changes and new siblings cannot reinterpret worked cart evidence", () => {
  conflict(() => planDemandReconciliation({ incoming: [row({ zone: "B" })], existing: [worked()] }), "worked_line_changed");
  conflict(() => planDemandReconciliation({ incoming: [row(), row({ sourceLineId: "new", sequence: "020" })], existing: [worked()] }), "worked_cart_changed");
});

test("removing an unworked sibling from a worked cart still needs reconciliation", () => {
  const sibling = stored({ id: "unworked-sibling", row: row({ sourceLineId: "sibling", sequence: "020" }) });
  conflict(() => planDemandReconciliation({ incoming: [row()], existing: [worked(), sibling] }), "worked_cart_changed");
});

test("historical matches retain their original IDs while unmatched history is left alone", () => {
  const history = worked({ active: false });
  const unrelated = worked({ active: false, id: "unrelated", headerId: "other-header", row: row({ sourceLineId: "other", cartNumber: "C-2", cartId: "CART-2" }) });
  const plan = planDemandReconciliation({ incoming: [row()], existing: [history, unrelated] });
  assert.equal(plan.lines[0].kind, "preserve");
  assert.equal(plan.lines[0].existing.id, history.id);
  assert.equal(plan.headers[0].existingHeaderId, history.headerId);
  assert.deepEqual(plan.removed, []);
  assert.deepEqual(plan.guards.map((line) => line.id), [history.id]);
});

test("ambiguous historical identity cannot silently recreate already consumed demand", () => {
  const history = worked({ active: false, id: "previous-consumption", headerId: "previous-header" });
  conflict(() => planDemandReconciliation({ incoming: [row()], existing: [stored(), history] }), "ambiguous_history");
  conflict(() => planDemandReconciliation({ incoming: [row()], existing: [history, stored({ active: false })] }), "ambiguous_history");
});

test("duplicate upstream identities and conflicting cart metadata fail before planning writes", () => {
  conflict(() => planDemandReconciliation({ incoming: [row(), row({ sequence: "020" })], existing: [] }), "duplicate_source_identity");
  conflict(() => planDemandReconciliation({ incoming: [row(), row({ sourceLineId: "two", sequence: "020", exteriorColor: "RED" })], existing: [] }), "inconsistent_header");
});

test("moving untouched demand keeps line identity but uses the target cart's header", () => {
  const a = stored();
  const b = stored({ id: "target-line", headerId: "target-header", row: row({
    sourceLineId: "target", picklistNumber: "PL-2", cartNumber: "C-2", cartId: "CART-2", sequence: "020",
  }) });
  const moved = { ...a.row, picklistNumber: "PL-2", cartNumber: "C-2", cartId: "CART-2" };
  const plan = planDemandReconciliation({ incoming: [moved, b.row], existing: [a, b] });
  assert.equal(plan.lines[0].existing.id, a.id);
  assert.equal(plan.headers.length, 1);
  assert.equal(plan.headers[0].existingHeaderId, b.headerId);
  assert.deepEqual(plan.lines[0].changedFields, ["cartId", "cartNumber", "picklistNumber"]);
});

test("default metadata and fulfilled serial outputs do not fabricate source changes", () => {
  const previous = worked({ row: row({ programId: "ODG303R", totalCarts: 0, containerTotal: 0, unitOfMeasure: "EA", aiagSerial: "CONTAINER" }) });
  const plan = planDemandReconciliation({ incoming: [row()], existing: [previous] });
  assert.equal(plan.lines[0].kind, "preserve");
});

test("untouched historical siblings return to the active card with stable source and legacy IDs", () => {
  for (const sourceLineId of ["restored", ""]) {
    const active = stored({ row: row({ sourceLineId: sourceLineId ? "active" : "" }) });
    const historical = stored({ id: "returning-line", headerId: "archived-header", active: false,
      row: row({ sourceLineId, sequence: "020" }) });
    const omitted = stored({ id: "omitted-sibling", headerId: historical.headerId, active: false,
      row: row({ sourceLineId: sourceLineId ? "omitted" : "", sequence: "030" }) });
    const plan = planDemandReconciliation({ incoming: [historical.row, active.row], existing: [active, historical, omitted] });
    assert.equal(plan.headers[0].existingHeaderId, active.headerId);
    assert.deepEqual(plan.lines.map((line) => line.existing.id), [historical.id, active.id]);
    assert.ok(plan.lines.every((line) => line.kind === "preserve"));
    assert.deepEqual(new Set(plan.guards.map((line) => line.id)), new Set([active.id, historical.id, omitted.id]));
  }
});

test("compatible untouched historical cards consolidate under a new header when none is active", () => {
  const a = stored({ active: false });
  const b = stored({ id: "second-line", headerId: "second-header", active: false,
    row: row({ sourceLineId: "second", sequence: "020" }) });
  const plan = planDemandReconciliation({ incoming: [a.row, b.row], existing: [a, b] });
  assert.equal(plan.headers[0].existingHeaderId, null);
  assert.deepEqual(plan.lines.map((line) => line.existing.id), [a.id, b.id]);
});

test("restoration cannot merge worked source or target cards, including omitted historical siblings", () => {
  const active = stored();
  const historical = stored({ id: "restored", headerId: "archive", active: false,
    row: row({ sourceLineId: "restored", sequence: "020" }) });
  const omitted = stored({ id: "omitted", headerId: "archive", active: false,
    row: row({ sourceLineId: "omitted", sequence: "030" }) });
  for (const target of ["active", "historical", "omitted"]) {
    const existing = [active, historical, omitted].map((line, index) => ({ ...line,
      hasScanEvidence: index === ["active", "historical", "omitted"].indexOf(target) }));
    conflict(() => planDemandReconciliation({ incoming: [active.row, historical.row], existing }), "worked_cart_changed");
  }
});

test("restoration retains conflicts for separate active cards and incompatible historical card metadata", () => {
  const a = stored();
  const b = stored({ id: "second-line", headerId: "second-header",
    row: row({ sourceLineId: "second", sequence: "020" }) });
  conflict(() => planDemandReconciliation({ incoming: [a.row, b.row], existing: [a, b] }), "ambiguous_header");
  const historical = { ...b, active: false, row: { ...b.row, palletId: "OTHER-PALLET" } };
  // Even an incoming correction cannot silently merge distinct historical cards.
  conflict(() => planDemandReconciliation({ incoming: [a.row, b.row], existing: [{ ...a, active: false }, historical] }), "ambiguous_header");
});

test("only whole dispatched picklists can retire while preserving their historical identities", () => {
  const first = worked({ loadedAt: "loaded", dispatchedAt: "departed", hasLoadConfirmation: true });
  const second = worked({ id: "second-line", row: row({ sourceLineId: "second", sequence: "020" }),
    loadedAt: "loaded", dispatchedAt: "departed", hasLoadConfirmation: true });
  const plan = planDemandReconciliation({ incoming: [], existing: [first, second] });
  assert.deepEqual(plan.archived.map((line) => line.id), [first.id, second.id]);
  assert.deepEqual(plan.guards.map((line) => line.id), [first.id, second.id]);
  assert.ok(plan.audits.every((event) => event.action === "reconcile_archive"));
  conflict(() => planDemandReconciliation({ incoming: [first.row], existing: [first, second] }), "worked_line_removed");
  conflict(() => planDemandReconciliation({ incoming: [{ ...first.row, sourceLineId: "replacement-identity" }], existing: [first, second] }), "worked_cart_changed");
  conflict(() => planDemandReconciliation({ incoming: [{ ...first.row, quantity: 13 }, second.row], existing: [first, second] }), "worked_line_changed");
  conflict(() => planDemandReconciliation({ incoming: [first.row, second.row], existing: [
    { ...first, active: false }, { ...second, active: false },
  ] }), "terminal_demand_reintroduced");
  conflict(() => planDemandReconciliation({ incoming: [], existing: [
    { ...first, dispatchedAt: null }, { ...second, dispatchedAt: null },
  ] }), "worked_line_removed");
});
