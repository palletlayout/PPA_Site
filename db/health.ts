import { randomUUID } from "node:crypto";
import { ensureDatabase, DATABASE_SCHEMA_VERSION } from "./cart-store.ts";
import { reportFailure } from "../lib/observability.ts";

/** Supervisor readiness probes check usable schema, atomic writes and ledger totals. */
export async function operationalHealth() {
  const checkedAt = new Date().toISOString();
  try {
    const db = await ensureDatabase();
    const [schema, stock, demand, departures] = await db.readBatch([
      db.prepare("SELECT version FROM cartflow_schema WHERE name='primary'"),
      db.prepare(`SELECT COUNT(*) AS count FROM inventory_items i WHERE quantity<=0 OR consumed_quantity<0 OR consumed_quantity>quantity
        OR ROUND(consumed_quantity,6) <> (SELECT ROUND(COALESCE(SUM(quantity),0),6) FROM fulfillment_allocations a WHERE a.inventory_item_id=i.id AND a.reversed_at IS NULL)`),
      db.prepare(`SELECT COUNT(*) AS count FROM demand_details d WHERE quantity<=0 OR fulfilled_quantity<0 OR fulfilled_quantity>quantity
        OR ROUND(fulfilled_quantity,6) <> (SELECT ROUND(COALESCE(SUM(quantity),0),6) FROM fulfillment_allocations a WHERE a.demand_detail_id=d.id AND a.reversed_at IS NULL)
        OR (status='verified' AND fulfilled_quantity<>quantity)`),
      db.prepare(`SELECT COUNT(*) AS count FROM demand_headers h WHERE (dispatched_at IS NOT NULL AND loaded_at IS NULL)
        OR (loaded_at IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM load_confirmations lc WHERE lc.header_id=h.id)
          OR EXISTS(SELECT 1 FROM demand_details d WHERE d.header_id=h.id AND (d.status<>'verified' OR d.fulfilled_quantity<>d.quantity))))`),
    ]);
    const schemaReady = Number(schema.results[0]?.version) === DATABASE_SCHEMA_VERSION;
    const inconsistencies = { inventory:Number(stock.results[0].count), demand:Number(demand.results[0].count), loading:Number(departures.results[0].count) };
    const id = `health:${randomUUID()}`;
    await db.batch([
      db.prepare("INSERT INTO cartflow_write_guards(id,valid) VALUES(?,1)").bind(id),
      db.prepare("DELETE FROM cartflow_write_guards WHERE id=?").bind(id),
    ]);
    const ready = schemaReady && Object.values(inconsistencies).every((count) => count===0);
    return { status:ready ? "ready" : "degraded", database:"read_write", schemaReady, inconsistencies, checkedAt };
  } catch(error) {
    const requestId=reportFailure("operational_readiness",error);
    return { status:"unavailable",database:"unavailable",checkedAt,requestId };
  }
}
