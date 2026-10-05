import type { Database } from "./index.ts";
import type { ImportRow } from "../lib/types.ts";
import { picklistIdentityKey } from "../lib/cart-identity.ts";

export const PICKLIST_CONFLICT_MESSAGE = "This picklist has conflicting outbound cards. A supervisor must reconcile it to one outbound card/pallet/order before packing, loading, or editing. Existing demand and scan history are preserved.";

/** Compare the business identity, including legacy headers whose marker is blank. */
export function samePicklistSql(left = "peer", right = "h") {
  return `${left}.batch_id = ${right}.batch_id
    AND UPPER(TRIM(${left}.plant)) = UPPER(TRIM(${right}.plant))
    AND ${left}.area_type = ${right}.area_type
    AND UPPER(TRIM(CASE WHEN ${left}.area_type = 'offsite' THEN ${left}.load_number ELSE ${left}.train_number END))
      = UPPER(TRIM(CASE WHEN ${right}.area_type = 'offsite' THEN ${right}.load_number ELSE ${right}.train_number END))
    AND UPPER(TRIM(${left}.picklist_number)) = UPPER(TRIM(${right}.picklist_number))`;
}

export function uniquePicklistSql(alias = "h") {
  return `NOT EXISTS (SELECT 1 FROM demand_headers peer WHERE peer.id <> ${alias}.id AND ${samePicklistSql("peer", alias)})`;
}

export async function hasPicklistConflict(db: Database, headerId: string) {
  return Boolean(await db.prepare(`SELECT 1 FROM demand_headers h WHERE h.id = ? AND NOT (${uniquePicklistSql()})`)
    .bind(headerId).first());
}

export function availablePicklistGuard(db: Database, batchId: string, row: ImportRow, allowedHeaderId = "") {
  const [plant, , movement, picklist] = JSON.parse(picklistIdentityKey(row)) as string[];
  return db.prepare(`NOT EXISTS (SELECT 1 FROM demand_headers WHERE batch_id = ? AND id <> ?
    AND UPPER(TRIM(plant)) = ? AND area_type = ?
    AND UPPER(TRIM(CASE WHEN area_type = 'offsite' THEN load_number ELSE train_number END)) = ?
    AND UPPER(TRIM(picklist_number)) = ?)`)
    .bind(batchId, allowedHeaderId, plant, row.areaType, movement, picklist);
}

/** Duplicate legacy groups remain intact and blocked; no header or evidence is merged. */
export async function backfillPicklistIdentity(db: Database) {
  const result = await db.prepare("SELECT id, batch_id, plant, area_type, load_number, train_number, picklist_number FROM demand_headers").all<Record<string, string>>();
  const groups = new Map<string, Array<{ id: string; identity: string }>>();
  for (const row of result.results) {
    const identity = picklistIdentityKey({ plant: row.plant, areaType: row.area_type === "offsite" ? "offsite" : "onsite",
      loadNumber: row.load_number, trainNumber: row.train_number, picklistNumber: row.picklist_number });
    const key = JSON.stringify([row.batch_id, identity]);
    groups.set(key, [...(groups.get(key) || []), { id: row.id, identity }]);
  }
  const statements = [...groups.values()].flatMap((members) => members.map(({ id, identity }) =>
    db.prepare("UPDATE demand_headers SET picklist_identity = ? WHERE id = ?").bind(members.length === 1 ? identity : "", id)));
  if (statements.length) await db.batch(statements);
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS demand_headers_batch_picklist_idx
    ON demand_headers (batch_id, picklist_identity) WHERE picklist_identity <> ''`).run();
}
