import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { hashPassword } from "../lib/auth.ts";

async function startLabelsServer(t) {
  const directory = await mkdtemp(join(tmpdir(), "cartflow-labels-http-"));
  const databasePath = join(directory, "labels.sqlite");
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const password = "Disposable-labels-QA-password-2026";
  const passwordHash = await hashPassword(password);
  const users = ["viewer", "supervisor"].map((role) => ({
    id: `labels-${role}`, username: role, name: `Labels ${role}`, role, passwordHash,
  }));
  let logs = "";
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env, NODE_ENV: "production", DATABASE_URL: "", POSTGRES_URL: "", VERCEL: "",
      CARTFLOW_DATABASE_PATH: databasePath, CARTFLOW_AUTH_MODE: "credentials", CARTFLOW_APP_ORIGIN: origin,
      CARTFLOW_AUTH_SECRET: "labels-disposable-test-secret-2026", CARTFLOW_AUTH_USERS: JSON.stringify(users),
      CARTFLOW_ENABLE_TEST_TOOLS: "false", CARTFLOW_FORMAT_ONLY_TEST_MODE: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => { logs = (logs + data).slice(-8000); });
  child.stderr.on("data", (data) => { logs = (logs + data).slice(-8000); });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(4000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`Label QA server stopped: ${logs}`);
    try {
      await fetch(`${origin}/api/auth/session`, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      if (attempt === 199) throw new Error(`Label QA server failed to start: ${logs}`);
      await delay(100);
    }
  }
  async function request(path, { method = "GET", body, cookie = "" } = {}) {
    return fetch(`${origin}${path}`, {
      method, headers: { Origin: origin, Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
    });
  }
  async function login(role) {
    const response = await request("/api/auth/login", { method: "POST", body: { username: role, password } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.headers.get("set-cookie").split(";")[0];
  }
  return { databasePath, request, login };
}

function snapshotDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return Object.fromEntries(tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .map((row) => JSON.stringify(row)).sort()]));
  } finally { database.close(); }
}

function extractDrawnText(bytes) {
  const buffer = Buffer.from(bytes);
  const source = buffer.toString("latin1");
  const text = [];
  let cursor = 0;
  while ((cursor = source.indexOf("stream\n", cursor)) !== -1) {
    const start = cursor + "stream\n".length;
    const end = source.indexOf("\nendstream", start);
    if (end === -1) break;
    const dictionary = source.slice(Math.max(0, source.lastIndexOf("<<", cursor)), cursor);
    const raw = buffer.subarray(start, end);
    try {
      const operators = (dictionary.includes("/FlateDecode") ? inflateSync(raw) : raw).toString("latin1");
      for (const match of operators.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) text.push(Buffer.from(match[1], "hex").toString("latin1"));
    } catch { /* Binary font streams do not contain label text. */ }
    cursor = end + "\nendstream".length;
  }
  return text;
}

test("inventory label HTTP export prints every active production container without changing inventory", { timeout: 90000 }, async (t) => {
  const { databasePath, request, login } = await startLabelsServer(t);
  const viewer = await login("viewer");
  const supervisor = await login("supervisor");
  const labels = (query = "", cookie = viewer) => request(`/api/inventory/labels${query}`, { cookie });

  await t.test("authentication is required and an empty inventory returns an actionable error", async () => {
    assert.equal((await labels("", "")).status, 401);
    const response = await labels();
    assert.equal(response.status, 404, await response.clone().text());
    assert.match(response.headers.get("content-type") || "", /application\/json/);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    assert.match((await response.json()).error, /no inventory containers.*receive or import/i);
  });

  const ordinaryRows = Array.from({ length: 50 }, (_, index) => ({
    aiagSerial: `LABEL-${String(index + 1).padStart(3, "0")}`, partNumber: "7972A-THR-A000", color: "BLUE", quantity: 20,
  }));
  ordinaryRows[49] = { aiagSerial: "mixedCase-label", partNumber: "part-mixedCase", color: "blue", quantity: 20 };
  const rows = [
    ...ordinaryRows,
    { aiagSerial: "SHARED-SERIAL", supplierId: "SUPPLIER-A", partNumber: "SUPPLIER-A-PART", color: "", quantity: 7 },
    { aiagSerial: "SHARED-SERIAL", supplierId: "SUPPLIER-B", partNumber: "SUPPLIER-B-PART", color: "", quantity: 8 },
    { aiagSerial: "EXPECTED-LABEL", partNumber: "EXPECTED-PART", color: "", quantity: 12, receiptKind: "expected" },
    { aiagSerial: "CONSUMED-LABEL", partNumber: "CONSUMED-PART", color: "RED", quantity: 30 },
    { aiagSerial: "1SPREFIX-LABEL", partNumber: "PREFIX-PART", color: "", quantity: 6 },
    { aiagSerial: "DELETED-LABEL", partNumber: "DELETED-PART", color: "", quantity: 3 },
    { aiagSerial: "TEST-LABEL", partNumber: "TEST-PART", color: "", quantity: 4 },
  ];
  const importId = randomUUID();
  for (let startRow = 0; startRow < rows.length; startRow += 10) {
    const batch = rows.slice(startRow, startRow + 10);
    const response = await request("/api/inventory/import", {
      method: "POST", cookie: supervisor, body: { importId, startRow, rows: batch },
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { ok: true, created: batch.length, duplicate: 0 });
  }
  const fixture = new DatabaseSync(databasePath);
  try {
    fixture.prepare("UPDATE inventory_items SET status = 'deleted' WHERE aiag_serial = ?").run("DELETED-LABEL");
    fixture.prepare("UPDATE inventory_items SET is_test = 1 WHERE aiag_serial = ?").run("TEST-LABEL");
    fixture.prepare("UPDATE inventory_items SET status = 'consumed', consumed_quantity = quantity, consumed_at = ? WHERE aiag_serial = ?")
      .run("2026-09-26T12:00:00.000Z", "CONSUMED-LABEL");
  } finally { fixture.close(); }

  await t.test("viewer exports all 55 containers across pages and searches, including expected and consumed stock", async () => {
    const inventory = await request("/api/inventory", { cookie: viewer });
    const listed = await inventory.json();
    assert.equal(listed.total, 55);
    assert.equal(listed.items.length, 50, "the normal inventory page does not contain every container");
    const before = snapshotDatabase(databasePath);
    const response = await labels("?q=no-such-container&page=2&pageSize=1");
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get("content-type") || "", /^application\/pdf/);
    assert.match(response.headers.get("content-disposition") || "", /attachment.*\.pdf/);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-inventory-label-count"), "55");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 55);
    const drawn = extractDrawnText(bytes);
    for (const row of ordinaryRows) assert.equal(drawn.filter((value) => value === row.aiagSerial).length, 1, row.aiagSerial);
    assert.ok(drawn.includes("part-mixedCase") && drawn.includes("blue"), "valid mixed-case inventory keeps its recorded display values");
    assert.equal(drawn.filter((value) => value === "SHARED-SERIAL").length, 2, "same serial under two suppliers must remain two labels");
    for (const value of ["SUPPLIER-A-PART", "SUPPLIER-B-PART", "EXPECTED-LABEL", "CONSUMED-LABEL", "1SPREFIX-LABEL"]) {
      assert.ok(drawn.includes(value), `PDF is missing ${value}`);
    }
    assert.ok(drawn.includes("30"), "a consumed container retains its original quantity on the label");
    assert.ok(!drawn.includes("DELETED-LABEL"));
    assert.ok(!drawn.includes("TEST-LABEL"));
    assert.deepEqual(snapshotDatabase(databasePath), before, "printing must not receive, allocate, update, or audit containers");
  });

  await t.test("an unprintable serial returns a friendly error for the complete export", async () => {
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare("UPDATE inventory_items SET aiag_serial = ?, normalized_serial = ? WHERE aiag_serial = ?")
        .run("UNPRINTABLE-雪", "UNPRINTABLE-雪", "LABEL-001");
    } finally { database.close(); }
    const before = snapshotDatabase(databasePath);
    const response = await labels();
    assert.equal(response.status, 400, await response.clone().text());
    assert.match(response.headers.get("content-type") || "", /application\/json/);
    assert.equal(response.headers.get("content-disposition"), null, "an invalid container must never produce a partial PDF download");
    assert.equal(response.headers.get("x-inventory-label-count"), null);
    const result = await response.json();
    assert.equal(typeof result.error, "string");
    assert.match(result.error, /serial|container|label/i);
    assert.match(result.error, /unsupported|print|barcode|character|ASCII/i);
    assert.deepEqual(snapshotDatabase(databasePath), before, "invalid label data must remain unchanged for correction");
  });
});
