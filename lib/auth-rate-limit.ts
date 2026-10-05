import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { getDatabase, type Database } from "../db/index.ts";
import { isLoopbackHost, type AuthConfig } from "./auth.ts";

const CLIENT_LIMIT = 300;
const ACCOUNT_CLIENT_LIMIT = 10;
const CLIENT_WINDOW_MS = 60_000;
const ACCOUNT_WINDOW_MS = 15 * 60_000;
const initialized = new WeakMap<Database, Promise<void>>();

export async function initializeAuthRateLimits(db: Database) {
  let pending = initialized.get(db);
  if (!pending) {
    pending = (async () => {
      await db.batch([db.prepare(`CREATE TABLE IF NOT EXISTS auth_rate_limits (
        key_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL,
        window_start TEXT NOT NULL, expires_at TEXT NOT NULL
      )`), db.prepare("CREATE INDEX IF NOT EXISTS auth_rate_limits_expiry_idx ON auth_rate_limits (expires_at)")]);
    })();
    initialized.set(db, pending);
    pending.catch(() => initialized.delete(db));
  }
  await pending;
}

/** Only a platform/administrator-selected, overwrite-only ingress header is trusted. */
export function loginClientIdentity(request: Request, origin: string, env = process.env) {
  const header = env.VERCEL ? "x-vercel-forwarded-for" : env.CARTFLOW_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (header) {
    if (!/^[a-z0-9-]{1,80}$/.test(header)) throw new Error("Invalid trusted client identity configuration.");
    const value = request.headers.get(header)?.trim() || "";
    // Reject lists: the configured ingress must replace client-supplied content.
    if (!isIP(value)) throw new Error("Trusted client identity is unavailable.");
    return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname : value;
  }
  if (isLoopbackHost(new URL(origin).host)) return "loopback";
  throw new Error("A trusted client identity header must be configured.");
}

function keyHash(secret: string, kind: string, client: string, username = "") {
  return createHmac("sha256", secret).update(JSON.stringify(["login-rate-limit-v1", kind, client, username])).digest("hex");
}

/** Shared transaction counters; one client's failures cannot lock out other clients. */
export async function consumeLoginAttempt(
  config: Extract<AuthConfig, { mode: "credentials" }>, client: string, username: string,
  now = Date.now(), db = getDatabase(),
) {
  await initializeAuthRateLimits(db);
  const nowIso = new Date(now).toISOString();
  const scopes = [
    { key: keyHash(config.secret, "client", client), maximum: CLIENT_LIMIT, duration: CLIENT_WINDOW_MS },
    { key: keyHash(config.secret, "account-client", client, username), maximum: ACCOUNT_CLIENT_LIMIT, duration: ACCOUNT_WINDOW_MS },
  ];
  const results = await db.batch([
    db.prepare("DELETE FROM auth_rate_limits WHERE expires_at <= ?").bind(nowIso),
    ...scopes.map((scope) => db.prepare(`INSERT INTO auth_rate_limits (key_hash, attempts, window_start, expires_at)
      VALUES (?, 1, ?, ?) ON CONFLICT(key_hash) DO UPDATE SET
      attempts = CASE WHEN auth_rate_limits.attempts < ? THEN auth_rate_limits.attempts + 1 ELSE auth_rate_limits.attempts END
      RETURNING attempts, expires_at`)
      .bind(scope.key, nowIso, new Date(now + scope.duration).toISOString(), scope.maximum + 1)),
  ]);
  let retryAfter = 0;
  for (let index = 0; index < scopes.length; index++) {
    const row = results[index + 1].results[0];
    if (!row) throw new Error("Login rate limit receipt is unavailable.");
    if (Number(row.attempts) > scopes[index].maximum) retryAfter = Math.max(retryAfter, Math.ceil((Date.parse(String(row.expires_at)) - now) / 1000));
  }
  return { allowed: retryAfter === 0, retryAfter };
}

export async function clearSuccessfulLoginLimit(config: Extract<AuthConfig, { mode: "credentials" }>, client: string, username: string) {
  await getDatabase().prepare("DELETE FROM auth_rate_limits WHERE key_hash = ?")
    .bind(keyHash(config.secret, "account-client", client, username)).run();
}
