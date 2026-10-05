import type { Database, DatabaseRow } from "./index.ts";
import type { FulfillmentSettings } from "../lib/fulfillment-settings.ts";
import { DEFAULT_FULFILLMENT_SETTINGS, validateFulfillmentSettings } from "../lib/fulfillment-settings.ts";
import type { CartLine, FulfillmentAllocation } from "../lib/types.ts";

export async function initializeFulfillmentLedger(db: Database) {
  const columns = db.dialect === "sqlite"
    ? async (table: string) => new Set((await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((row) => row.name))
    : async (table: string) => new Set((await db.prepare("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?").bind(table).all<{ name: string }>()).results.map((row) => row.name));
  const headers = await columns("demand_headers");
  const details = await columns("demand_details");
  for (const [table, existing, name, definition] of [
    ["demand_headers", headers, "option_text", "TEXT NOT NULL DEFAULT ''"],
    ["demand_headers", headers, "short_closed_at", "TEXT"],
    ["demand_details", details, "pack_sequence", "TEXT NOT NULL DEFAULT ''"],
    ["demand_details", details, "fulfilled_at", "TEXT"],
    ["demand_details", details, "fulfilled_by", "TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    if (!existing.has(name)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
  }
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS fulfillment_settings (
      id TEXT PRIMARY KEY, packing_mode TEXT NOT NULL, inventory_mode TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare(`INSERT INTO fulfillment_settings (id, packing_mode, inventory_mode) VALUES ('primary', 'exact', 'uploaded') ON CONFLICT DO NOTHING`),
    db.prepare(`CREATE TABLE IF NOT EXISTS fulfillment_allocations (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_fingerprint TEXT NOT NULL,
      demand_detail_id TEXT NOT NULL REFERENCES demand_details(id),
      inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id),
      quantity NUMERIC(20,6) NOT NULL CHECK(quantity > 0), serial TEXT NOT NULL,
      packed_at TEXT NOT NULL, packed_by TEXT NOT NULL, operator_id TEXT NOT NULL DEFAULT '',
      reversed_at TEXT, reversed_by TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS fulfillment_allocations_detail_idx ON fulfillment_allocations(demand_detail_id, reversed_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS fulfillment_allocations_inventory_idx ON fulfillment_allocations(inventory_item_id, reversed_at)"),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_allocations_active_pair_idx ON fulfillment_allocations(demand_detail_id, inventory_item_id) WHERE reversed_at IS NULL`),
    // Preserve every legacy stock binding, quantity and timestamp. No inventory
    // balances are changed by this migration; future reversals use this ledger.
    db.prepare(`INSERT INTO fulfillment_allocations (id, request_id, request_fingerprint,
      demand_detail_id, inventory_item_id, quantity, serial, packed_at, packed_by, operator_id)
      SELECT 'legacy:' || d.id, 'legacy:' || d.id, 'legacy', d.id, d.inventory_item_id,
        d.fulfilled_quantity, COALESCE(NULLIF(d.aiag_serial, ''), i.aiag_serial),
        COALESCE(d.verified_at, i.consumed_at, i.captured_at),
        COALESCE((SELECT e.operator_name FROM scan_events e WHERE e.line_id = d.id AND e.field = 'aiagSerial' AND e.matched = 1 ORDER BY e.created_at DESC LIMIT 1), ''),
        COALESCE((SELECT e.operator_id FROM scan_events e WHERE e.line_id = d.id AND e.field = 'aiagSerial' AND e.matched = 1 ORDER BY e.created_at DESC LIMIT 1), '')
      FROM demand_details d JOIN inventory_items i ON i.id = d.inventory_item_id
      WHERE d.fulfilled_quantity > 0 AND NOT EXISTS (SELECT 1 FROM fulfillment_allocations a WHERE a.demand_detail_id = d.id)
      ON CONFLICT DO NOTHING`),
    db.prepare("DROP INDEX IF EXISTS demand_details_inventory_item_idx"),
    db.prepare("CREATE INDEX IF NOT EXISTS demand_details_inventory_item_lookup_idx ON demand_details(inventory_item_id)"),
  ]);
  const settingsColumns = await columns("fulfillment_settings");
  if (!settingsColumns.has("part_attribute")) {
    await db.prepare("ALTER TABLE fulfillment_settings ADD COLUMN part_attribute TEXT NOT NULL DEFAULT 'color_or_part_level'").run();
  }
}

export async function readFulfillmentSettings(db: Database): Promise<FulfillmentSettings> {
  const row = await db.prepare("SELECT packing_mode, inventory_mode, part_attribute FROM fulfillment_settings WHERE id = 'primary'").first<{ packing_mode: string; inventory_mode: string; part_attribute: string }>();
  return fulfillmentSettingsFromRow(row);
}

export function fulfillmentSettingsFromRow(row: DatabaseRow | null | undefined): FulfillmentSettings {
  return row ? validateFulfillmentSettings({ packingMode: row.packing_mode, inventoryMode: row.inventory_mode, partAttribute: row.part_attribute }) : { ...DEFAULT_FULFILLMENT_SETTINGS };
}

export async function attachAllocations(db: Database, lines: CartLine[]): Promise<CartLine[]> {
  if (!lines.length) return lines;
  const records: DatabaseRow[] = [];
  for (let offset = 0; offset < lines.length; offset += 200) {
    const ids = lines.slice(offset, offset + 200).map((line) => line.id);
    const rows = await db.prepare(`SELECT * FROM fulfillment_allocations WHERE demand_detail_id IN (${ids.map(() => "?").join(",")}) AND reversed_at IS NULL ORDER BY packed_at, id`).bind(...ids).all();
    records.push(...rows.results);
  }
  return linesWithAllocations(lines, records);
}

export function linesWithAllocations(lines: CartLine[], records: DatabaseRow[]): CartLine[] {
  const grouped = new Map<string, FulfillmentAllocation[]>();
  for (const row of records) {
      const id = String(row.demand_detail_id);
      const allocations = grouped.get(id) || [];
      allocations.push({ id: String(row.id), inventoryItemId: String(row.inventory_item_id), serial: String(row.serial), quantity: Number(row.quantity), packedAt: String(row.packed_at), packedBy: String(row.packed_by) });
      grouped.set(id, allocations);
  }
  return lines.map((line) => {
    const allocations = grouped.get(line.id) || [];
    return { ...line, allocations, aiagSerial: allocations.length ? allocations.map((item) => item.serial).join(", ") : line.aiagSerial,
      fulfilledAt: line.fulfilledAt || allocations.at(-1)?.packedAt || null,
      fulfilledBy: line.fulfilledBy || allocations.at(-1)?.packedBy || "" };
  });
}

export function comparePackingLines(a: Pick<CartLine, "packSequence" | "sequence" | "id">, b: Pick<CartLine, "packSequence" | "sequence" | "id">) {
  return String(a.packSequence || a.sequence).localeCompare(String(b.packSequence || b.sequence), "en", { numeric: true })
    || a.sequence.localeCompare(b.sequence, "en", { numeric: true }) || a.id.localeCompare(b.id);
}
