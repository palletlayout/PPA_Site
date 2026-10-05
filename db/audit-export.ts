import { ensureDatabase } from "./cart-store.ts";
import { serializeCsvCell } from "../lib/csv.ts";
import { RequestError } from "../lib/request-security.ts";

export const MAX_AUDIT_EXPORT_ROWS = 10_000;

export type DemandAuditRecord = {
  id: string;
  batch_id: string;
  header_id: string;
  line_id: string;
  action: string;
  before_json: string;
  after_json: string;
  actor_id: string;
  actor_name: string;
  created_at: string;
};

function parseBeforeCursor(value: string) {
  if (!value) return null;
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error();
    const cursor = JSON.parse(decoded.toString("utf8"));
    if (!Array.isArray(cursor) || cursor.length !== 2 ||
        typeof cursor[0] !== "string" || new Date(cursor[0]).toISOString() !== cursor[0] ||
        typeof cursor[1] !== "string" || !cursor[1] || cursor[1].length > 180 || /[\u0000-\u001f\u007f]/.test(cursor[1])) {
      throw new Error();
    }
    return { createdAt: cursor[0], id: cursor[1] };
  } catch {
    throw new RequestError("The audit export cursor is invalid. Use the Next Export URL from your previous audit CSV.");
  }
}

/** Read-only, stable pagination across immutable records, including timestamp ties. */
export async function getDemandAuditExport(before = "") {
  const cursor = parseBeforeCursor(before);
  const db = await ensureDatabase();
  const result = await db.prepare(`SELECT id, batch_id, header_id, line_id, action,
      before_json, after_json, actor_id, actor_name, created_at
    FROM demand_audit_events
    ${cursor ? "WHERE created_at < ? OR (created_at = ? AND id < ?)" : ""}
    ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []), MAX_AUDIT_EXPORT_ROWS + 1)
    .all<DemandAuditRecord>();
  const hasOlderRecords = result.results.length > MAX_AUDIT_EXPORT_ROWS;
  const rows = result.results.slice(0, MAX_AUDIT_EXPORT_ROWS);
  const oldest = rows.at(-1);
  const nextBefore = hasOlderRecords && oldest
    ? Buffer.from(JSON.stringify([oldest.created_at, oldest.id])).toString("base64url")
    : null;
  return { rows, hasOlderRecords, nextBefore };
}

const AUDIT_COLUMNS = [
  ["id", "Audit Event ID"], ["created_at", "Changed At (UTC)"],
  ["action", "Action"], ["actor_id", "Actor ID"], ["actor_name", "Actor Name"],
  ["batch_id", "Import Batch ID"], ["header_id", "Demand Header ID"], ["line_id", "Demand Line ID"],
  ["before_json", "Before (JSON)"], ["after_json", "After (JSON)"],
] as const;

export function serializeDemandAuditCsv(page: Awaited<ReturnType<typeof getDemandAuditExport>>, applicationOrigin?: string) {
  const nextPath = page.nextBefore ? `/api/audit/export?before=${page.nextBefore}` : "";
  const nextUrl = nextPath && applicationOrigin ? new URL(nextPath, applicationOrigin).href : nextPath;
  return [
    [...AUDIT_COLUMNS.map(([, label]) => label), "Export Has Older Records", "Next Export URL"]
      .map(serializeCsvCell).join(","),
    ...page.rows.map((row) => [
      ...AUDIT_COLUMNS.map(([key]) => row[key]),
      page.hasOlderRecords ? "Yes" : "No", nextUrl,
    ].map(serializeCsvCell).join(",")),
  ].join("\r\n");
}
