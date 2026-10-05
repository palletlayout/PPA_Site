import type { Database, PreparedStatement } from "./index.ts";

// Stay below SQLite expression/parameter limits, including the guard ID.
const MAX_PREDICATES = 35;
const MAX_PARAMETERS = 900;

/** Build bounded checks for a single guardedBatch; never execute chunks separately. */
export function prepareWriteGuards(db: Database, conditions: PreparedStatement[]) {
  const statements: PreparedStatement[] = [];
  const cleanup: PreparedStatement[] = [];
  let group: PreparedStatement[] = [];
  let parameters = 1;
  const flush = () => {
    if (!group.length) return;
    const id = crypto.randomUUID();
    statements.push(db.prepare(`INSERT INTO cartflow_write_guards (id, valid)
      VALUES (?, CASE WHEN (${group.map((condition) => `(${condition.query})`).join(" AND ")}) THEN 1 ELSE 0 END)`)
      .bind(id, ...group.flatMap((condition) => condition.values)));
    cleanup.push(db.prepare("DELETE FROM cartflow_write_guards WHERE id = ?").bind(id));
    group = [];
    parameters = 1;
  };
  for (const condition of conditions) {
    if (condition.values.length + 1 > MAX_PARAMETERS) throw new Error("A write guard exceeds the supported parameter limit.");
    if (group.length >= MAX_PREDICATES || parameters + condition.values.length > MAX_PARAMETERS) flush();
    group.push(condition);
    parameters += condition.values.length;
  }
  flush();
  return { statements, cleanup };
}
