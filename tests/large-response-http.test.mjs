import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { hashPassword } from "../lib/auth.ts";

const lineCount = 4000;
const seedCode = `
  const store=await import('./db/cart-store.ts');
  const db=await store.ensureDatabase();
  try {
    const rows=Array.from({length:${lineCount}},(_,index)=>{
      const group=Math.floor(index/10);
      return {plant:'STREAM',areaType:'onsite',trainNumber:'TRAIN-1',loadNumber:'',zone:'QA',shipCategory:'Production',
        picklistNumber:'PICK-'+group,cartNumber:String(group),cartId:'CART-'+group,palletId:'PAL-'+group,
        masterBarcode:'MASTER-'+group,movementBarcode:'MOVE-1',sequence:String(index%10),partNumber:'PART-'+index,
        sourceLineId:'STREAM-LINE-'+index,sourceScope:'disposable-large-response-test',
        description:'Storage-zone description for streaming regression. '.repeat(8),color:'',quantity:1,aiagSerial:''};
    });
    await store.replaceImport('disposable-large-response.csv',rows);
    console.log(JSON.stringify({bytes:Buffer.byteLength(JSON.stringify(await store.getAppState()))}));
  } finally {db.close();}
`;

test("large authenticated snapshots stream completely and validate only after access checks", { timeout: 90000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-large-response-http-"));
  let server;
  let logs = "";
  t.after(async () => {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(4000)]);
      if (server.exitCode === null) {
        server.kill("SIGKILL");
        await new Promise((resolve) => server.once("exit", resolve));
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  // Seeding is a separate process; no parent singleton can select an existing DB.
  const isolatedEnv = { ...process.env, DATABASE_URL: "", POSTGRES_URL: "", VERCEL: "", CARTFLOW_DATABASE_PATH: join(directory, "isolated.sqlite") };
  const seeded = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", seedCode], {
    cwd: new URL("..", import.meta.url), env: isolatedEnv, encoding: "utf8", timeout: 30000,
  }));
  assert.ok(seeded.bytes > 4.5 * 1024 * 1024, "fixture must exceed the non-streamed hosting payload threshold");
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const password = "Disposable-large-stream-test-password";
  const passwordHash = await hashPassword(password);
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: new URL("..", import.meta.url),
    env: { ...isolatedEnv, NODE_ENV: "production", CARTFLOW_AUTH_MODE: "credentials", CARTFLOW_APP_ORIGIN: origin,
      CARTFLOW_AUTH_SECRET: "disposable-large-response-http-secret-2026-only",
      CARTFLOW_AUTH_USERS: JSON.stringify(["viewer", "supervisor"].map((role) => ({ id: `stream-${role}`, username: role, name: `Stream ${role}`, role, passwordHash }))),
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (data) => { logs = (logs + data).slice(-8000); });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.exitCode !== null) throw new Error(`Disposable server stopped: ${logs}`);
    try { await fetch(`${origin}/api/auth/session`, { signal: AbortSignal.timeout(500) }); break; }
    catch { if (attempt === 199) throw new Error(`Disposable server failed to start: ${logs}`); await delay(100); }
  }
  const request = (path, cookie = "", { method = "GET", body, headers = {} } = {}) => fetch(`${origin}${path}`, {
    method, headers: { Origin: origin, Cookie: cookie, "Accept-Encoding": "identity", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
  });
  async function login(role) {
    const response = await request("/api/auth/login", "", { method: "POST", body: { username: role, password } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.headers.get("set-cookie").split(";")[0];
  }
  const viewer = await login("viewer");
  const supervisor = await login("supervisor");
  const response = await request("/api/state", viewer);
  assert.equal(response.status, 200);
  assert.equal(response.headers.has("content-length"), false);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.byteLength > 4.5 * 1024 * 1024);
  const state = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(state.lines.length, lineCount);
  assert.equal(new Set(state.lines.map((line) => line.sourceLineId)).size, lineCount);
  assert.ok(state.lines.every((line) => line.status === "pending" && line.fulfilledQuantity === 0 && line.remainingQuantity === 1 && line.allocations.length === 0));
  const etag = response.headers.get("etag");
  assert.equal(etag, `"${createHash("sha256").update(bytes).digest("hex")}"`);
  const conditional = { headers: { "If-None-Match": etag } };
  const unchanged = await request("/api/state", viewer, conditional);
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  assert.equal(unchanged.headers.get("etag"), etag);
  assert.equal((await request("/api/state", "", conditional)).status, 401, "an anonymous validator is not an authorization credential");

  const changedDescription = "Updated through authenticated HTTP";
  const mutation = await request("/api/demand", supervisor, { method: "PATCH", body: { lineId: state.lines[0].id, changes: { description: changedDescription } } });
  assert.equal(mutation.status, 200, await mutation.clone().text());
  const changed = await request("/api/state", viewer, conditional);
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
  const changedTag = changed.headers.get("etag");
  const latest = await changed.json();
  assert.equal(latest.lines.find((line) => line.id === state.lines[0].id).description, changedDescription);
  assert.equal(latest.lines.length, lineCount);

  assert.equal((await request("/api/warehouse", supervisor)).status, 404, "the removed route is unavailable even to authenticated supervisors");

  const logout = await request("/api/auth/logout", viewer, { method: "POST" });
  assert.equal(logout.status, 200);
  for (const [path, validator] of [["/api/state", changedTag]]) {
    const revoked = await request(path, viewer, { headers: { "If-None-Match": validator } });
    assert.equal(revoked.status, 401, `${path} must check durable session revocation before returning 304`);
    assert.equal((await revoked.json()).code, "unauthenticated");
  }
});
