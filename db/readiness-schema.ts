import type { Database } from "./index.ts";
import { initializeAuthRateLimits } from "../lib/auth-rate-limit.ts";

/** Additive upgrade: historical provenance and legacy lock owners stay unknown. */
export async function initializeReadinessSchema(db: Database) {
  for (const [table, definitions] of [
    ["cart_locks", [["operator_id", "TEXT NOT NULL DEFAULT ''"]]],
    ["inventory_items", [
      ["acquisition_method", "TEXT NOT NULL DEFAULT 'legacy_unknown'"],
      ["source_file", "TEXT NOT NULL DEFAULT ''"], ["source_import_id", "TEXT NOT NULL DEFAULT ''"],
      ["source_row", "INTEGER"], ["scanned_values_json", "TEXT NOT NULL DEFAULT '{}'"],
      ["recorded_at", "TEXT NOT NULL DEFAULT ''"],
    ]],
  ] as const) {
    const columns = db.dialect === "sqlite"
      ? await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
      : await db.prepare("SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name=?").bind(table).all<{ name: string }>();
    const names = new Set(columns.results.map((row) => row.name));
    for (const [name, definition] of definitions) if (!names.has(name)) {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${db.dialect === "postgres" ? "IF NOT EXISTS " : ""}${name} ${definition}`).run();
    }
  }
  await db.batch([db.prepare(`CREATE TABLE IF NOT EXISTS maintenance_audit_events (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
    created_at TEXT NOT NULL, detail TEXT NOT NULL
  )`)]);
  await initializeAuthRateLimits(db);
}
