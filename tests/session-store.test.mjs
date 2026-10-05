import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSession, getAuthConfig, hashPassword, verifySession } from "../lib/auth.ts";

test("durable sessions reject unregistered cookies, revoke copied cookies, and fail closed when the store fails", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cartflow-session-test-"));
  const keys = ["CARTFLOW_AUTH_MODE", "CARTFLOW_AUTH_SECRET", "CARTFLOW_APP_ORIGIN", "CARTFLOW_AUTH_USERS", "CARTFLOW_DATABASE_PATH", "DATABASE_URL", "POSTGRES_URL", "VERCEL"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const user = { id: "operator-id", username: "operator", name: "Assigned Operator", role: "operator", passwordHash: await hashPassword("random-password-for-persistent-session-tests") };
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    CARTFLOW_AUTH_MODE: "credentials",
    CARTFLOW_AUTH_SECRET: "random-session-signing-secret-with-more-than-32-bytes",
    CARTFLOW_APP_ORIGIN: "https://cartflow.example",
    CARTFLOW_AUTH_USERS: JSON.stringify([user]),
    CARTFLOW_DATABASE_PATH: join(temporaryRoot, "session.sqlite"),
  });
  const [{ registerSession, isSessionActive, revokeSession }, { requireAccess }, { getDatabase }] = await Promise.all([
    import("../lib/session-store.ts"), import("../lib/auth-access.ts"), import("../db/index.ts"),
  ]);
  t.after(async () => {
    getDatabase().close();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const config = getAuthConfig();
  const { token, principal } = createSession(user, config);
  const req = new Request("https://cartflow.example/api/state", { headers: { Cookie: `cartflow_session=${token}` } });
  assert.equal((await requireAccess(req)).status, 401, "a signed but never persisted token is not an authenticated session");
  await registerSession(principal);
  assert.equal(await isSessionActive(principal), true);
  assert.equal((await requireAccess(req)).principal.id, user.id);
  assert.equal(await isSessionActive({ ...principal, id: "another-user" }), false);
  assert.equal(await isSessionActive(principal, Date.now() + 8 * 60 * 60 * 1000 + 1000), false);
  const stored = await getDatabase().prepare("SELECT session_hash FROM auth_sessions").first();
  assert.notEqual(stored.session_hash, principal.sessionId, "raw session identifiers are not stored");
  assert.match(stored.session_hash, /^[a-f0-9]{64}$/);

  const second = createSession(user, config);
  await registerSession(second.principal);
  await revokeSession(principal);
  assert.ok(verifySession(token, config), "copied cookie is still cryptographically valid");
  assert.equal((await requireAccess(req)).status, 401, "durable revocation rejects the copied cookie immediately");
  assert.equal(await isSessionActive(second.principal), true, "logout leaves other separately authenticated sessions active");
  await revokeSession(principal); // idempotent logout

  await getDatabase().prepare("DROP TABLE auth_sessions").run();
  const secondReq = new Request("https://cartflow.example/api/state", { headers: { Cookie: `cartflow_session=${second.token}` } });
  assert.equal((await requireAccess(secondReq)).status, 503, "missing/inaccessible session storage must not authorize access");
});
