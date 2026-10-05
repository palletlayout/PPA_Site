import { getDatabase } from "./index.ts";
import { createRetryableInitializer } from "../lib/retryable-initializer.ts";
import { validateRawScan, type RawCaptureSession, type SavedRawScan } from "../lib/raw-capture.ts";
import { RequestError } from "../lib/request-security.ts";

const captureDatabase = createRetryableInitializer(async () => {
  const db = getDatabase();
  await db.prepare(`CREATE TABLE IF NOT EXISTS raw_capture_scans (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL,
    raw_value TEXT NOT NULL, scanned_at TEXT NOT NULL, saved_at TEXT NOT NULL,
    operator_id TEXT NOT NULL, operator_name TEXT NOT NULL
  )`).run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS raw_capture_owner_session_idx ON raw_capture_scans (operator_id, session_id, position)").run();
  return db;
});

export async function saveRawScan(input: unknown, actor: { id: string; name: string }) {
  let scan;
  try { scan = validateRawScan(input); }
  catch (error) { throw new RequestError(error instanceof Error ? error.message : "Invalid scan."); }
  const db = await captureDatabase();
  await db.prepare(`INSERT INTO raw_capture_scans
    (id, session_id, position, raw_value, scanned_at, saved_at, operator_id, operator_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(scan.id, scan.sessionId, scan.position, scan.rawValue, scan.scannedAt, new Date().toISOString(), actor.id, actor.name).run();
  const stored = await db.prepare("SELECT * FROM raw_capture_scans WHERE id = ? AND operator_id = ?")
    .bind(scan.id, actor.id).first();
  if (!stored || stored.session_id !== scan.sessionId || stored.position !== scan.position
    || stored.raw_value !== scan.rawValue || stored.scanned_at !== scan.scannedAt) {
    throw new RequestError("This scan identifier or position was already used for another scan.", 409);
  }
  return { ...scan, savedAt: String(stored.saved_at), operatorName: String(stored.operator_name) };
}

export async function listRawCaptureSessions(ownerId?: string): Promise<RawCaptureSession[]> {
  const db = await captureDatabase();
  const result = await db.prepare(`SELECT session_id, MIN(saved_at) AS started_at, COUNT(*) AS count,
    MAX(operator_name) AS operator_name FROM raw_capture_scans ${ownerId ? "WHERE operator_id = ?" : ""}
    GROUP BY session_id ORDER BY MIN(saved_at) DESC LIMIT 200`).bind(...(ownerId ? [ownerId] : [])).all();
  return result.results.map((row) => ({ sessionId: String(row.session_id), startedAt: String(row.started_at), count: Number(row.count), operatorName: String(row.operator_name) }));
}

export async function listRawScans(sessionId: string, ownerId?: string): Promise<SavedRawScan[]> {
  const db = await captureDatabase();
  const result = await db.prepare(`SELECT * FROM raw_capture_scans WHERE session_id = ?
    ${ownerId ? "AND operator_id = ?" : ""} ORDER BY position, saved_at, id`)
    .bind(sessionId, ...(ownerId ? [ownerId] : [])).all();
  return result.results.map((row) => ({ id: String(row.id), sessionId: String(row.session_id), position: Number(row.position),
    rawValue: String(row.raw_value), scannedAt: String(row.scanned_at), savedAt: String(row.saved_at), operatorName: String(row.operator_name) }));
}
