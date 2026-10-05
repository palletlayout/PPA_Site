import { createHash } from "node:crypto";
import { getDatabase, type Database } from "../db/index.ts";
import { SESSION_SECONDS, type Principal } from "./auth.ts";

const initialized = new WeakMap<Database, Promise<void>>();

async function sessionDatabase() {
  const db = getDatabase();
  let initialization = initialized.get(db);
  if (!initialization) {
    initialization = (async () => {
      await db.prepare(`CREATE TABLE IF NOT EXISTS auth_sessions (
        session_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      )`).run();
      await db.prepare("CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at)").run();
    })();
    initialized.set(db, initialization);
    initialization.catch(() => initialized.delete(db));
  }
  await initialization;
  return db;
}

function sessionHash(sessionId: string) {
  return createHash("sha256").update(sessionId).digest("hex");
}

export async function registerSession(principal: Principal, now = Date.now()) {
  const db = await sessionDatabase();
  await db.batch([
    db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(new Date(now).toISOString()),
    db.prepare("INSERT INTO auth_sessions (session_hash, user_id, expires_at, revoked_at) VALUES (?, ?, ?, NULL)")
      .bind(sessionHash(principal.sessionId), principal.id, new Date(now + SESSION_SECONDS * 1000).toISOString()),
  ]);
}

export async function isSessionActive(principal: Principal, now = Date.now()) {
  const db = await sessionDatabase();
  return Boolean(await db.prepare(`SELECT session_hash FROM auth_sessions
    WHERE session_hash = ? AND user_id = ? AND expires_at > ? AND revoked_at IS NULL`)
    .bind(sessionHash(principal.sessionId), principal.id, new Date(now).toISOString()).first());
}

export async function revokeSession(principal: Principal, now = Date.now()) {
  const db = await sessionDatabase();
  await db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE session_hash = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(new Date(now).toISOString(), sessionHash(principal.sessionId), principal.id).run();
}
