import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import * as XLSX from "xlsx";
import { MAX_IMPORT_ROWS, validateImportRows } from "../lib/import-validation.ts";
import { MAX_IMPORT_FILE_BYTES, MAX_IMPORT_REQUEST_BYTES } from "../lib/import-transport.ts";
import { parseDemandSpreadsheet } from "../lib/spreadsheet-import.ts";

const record = (index = 1) => ({
  "Source Scope": "erp", "Source Line ID": `source-${index}`, Plant: "P1", Zone: "A", Area: "Onsite",
  "Ship Category": "Production", "Train #": "TRAIN-1", Picklist: "PICK-1", "Cart #": "CART-1",
  "Cart ID": "CART-1", "Pallet ID": "PALLET-1", Sequence: String(index), "Part Number": "PART-1",
  Description: "Bounded route fixture", "Part Color": "BLUE", Quantity: "5",
  "Master Barcode": "MASTER-1", "Movement Barcode": "TRAIN-1",
});
const workbookBytes = (records) => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(records), "Demand");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
};
const csvBytes = (records) => XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(records));

// Executes the real route functions, authentication, spreadsheet parser and persistence
// with only module specifiers adapted for Node; no server or live database is used.
test("demand HTTP routes enforce bounded original-file transport and accountable ingestion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-import-http-boundary-"));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "disposable.sqlite");
  for (const name of ["DATABASE_URL", "POSTGRES_URL", "VERCEL"]) delete process.env[name];
  const auth = await import("../lib/auth.ts");
  const store = await import("../db/cart-store.ts");
  const sessions = await import("../lib/session-store.ts");
  const passwordHash = await auth.hashPassword("Disposable-import-route-password");
  const users = ["viewer", "supervisor"].map(role => ({ id: `import-${role}`, username: role, name: `Import ${role}`, role, passwordHash }));
  const origin = "https://import-review.example";
  const token = "disposable-import-integration-token-32-characters";
  Object.assign(process.env, {
    CARTFLOW_AUTH_MODE: "credentials", CARTFLOW_AUTH_SECRET: "disposable-import-route-secret-32-characters",
    CARTFLOW_APP_ORIGIN: origin, CARTFLOW_AUTH_USERS: JSON.stringify(users), CARTFLOW_INGEST_TOKEN: token,
  });
  const db = await store.ensureDatabase();
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const cookies = {};
  for (const user of users) {
    const session = auth.createSession(user, auth.getAuthConfig());
    await sessions.registerSession(session.principal);
    cookies[user.role] = `${auth.SESSION_COOKIE}=${session.token}`;
  }
  const loadRoute = async (path, filename) => {
    const source = (await readFile(new URL(path, import.meta.url), "utf8"))
      .replace(/from "@\/([^\"]+)"/g, (_, specifier) => `from "${new URL(`../${specifier}.ts`, import.meta.url).href}"`)
      .replace('from "next/server"', `from "${new URL("../node_modules/next/server.js", import.meta.url).href}"`);
    const target = join(directory, filename);
    await writeFile(target, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    return import(pathToFileURL(target).href);
  };
  const manual = await loadRoute("../app/api/import/route.ts", "manual.mjs");
  const integration = await loadRoute("../app/api/integrations/demand/route.ts", "integration.mjs");
  const request = (body, { automated = false, cookie = cookies.supervisor, headers = {} } = {}) => new Request(`${origin}/api/${automated ? "integrations/demand" : "import"}`, {
    method: "POST", headers: { Origin: origin, Cookie: cookie, ...(automated ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
  const json = (body, options = {}) => request(JSON.stringify(body), { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const form = (records = [record()], fields = {}) => {
    const value = new FormData();
    value.append("file", new File([csvBytes(records)], "original-demand.csv", { type: "text/csv" }));
    for (const [key, field] of Object.entries(fields)) value.append(key, field);
    return value;
  };
  const count = async () => (await db.prepare("SELECT COUNT(*) AS n FROM demand_import_rows").first()).n;
  const ok = async (response) => { assert.equal(response.status, 200, await response.clone().text()); return response.json(); };

  await t.test("manual multipart preserves role, origin and actor authorization", async () => {
    for (const [options, status] of [[{ cookie: "" }, 401], [{ cookie: cookies.viewer }, 403], [{ headers: { Origin: "https://attacker.invalid" } }, 403]]) {
      assert.equal((await manual.POST(request(form(), options))).status, status);
    }
    assert.equal(await count(), 0);
    const result = await ok(await manual.POST(request(form())));
    assert.equal(result.rowCount, 1);
    const batch = await db.prepare("SELECT file_name FROM import_batches WHERE id=?").bind(result.batchId).first();
    assert.equal(batch.file_name, "original-demand.csv");
    assert.equal((await db.prepare("SELECT actor_id FROM demand_audit_events ORDER BY created_at DESC LIMIT 1").first()).actor_id, "import-supervisor");
    await ok(await manual.POST(request(form([record(2)], { action: "append" }))));
    assert.equal((await db.prepare("SELECT actor_id FROM demand_audit_events WHERE action='manual_append'").first()).actor_id, "import-supervisor");
    assert.equal((await manual.POST(request(form([record(3), record(4)], { action: "append" })))).status, 400);
    assert.equal((await manual.POST(request(form([record(3)], { action: "discard" })))).status, 400);
    assert.equal((await manual.POST(json({ action: "append", rows: [] }))).status, 400);
  });

  await t.test("integration multipart preserves credentials, source and idempotent receipts", async () => {
    const options = { automated: true, headers: { "Idempotency-Key": "multipart-receipt" } };
    assert.equal((await integration.POST(request(form(), { ...options, headers: { Authorization: "Bearer wrong" } }))).status, 401);
    const result = await ok(await integration.POST(request(form([record()], { source: "upstream" }), options)));
    assert.equal(result.source, "upstream");
    const replay = await ok(await integration.POST(request(form([record()], { source: "upstream" }), options)));
    assert.equal(replay.batchId, result.batchId);
    assert.equal(replay.idempotentReplay, true);
    assert.equal((await integration.POST(request(form([record()], { action: "append" }), options))).status, 400);
    const audit = (await db.prepare("SELECT actor_id FROM demand_audit_events WHERE actor_id='integration:upstream'").all()).results;
    assert.ok(audit.length > 0);
  });

  await t.test("bad multipart metadata and malformed bodies never change persisted demand", async () => {
    const before = await count();
    const duplicate = form(); duplicate.append("file", new File(["x"], "extra.csv"));
    const binaryAction = form(); binaryAction.append("action", new File(["replace"], "action.txt"));
    for (const input of [request(new FormData()), request(duplicate), request(binaryAction), request("malformed", { headers: { "Content-Type": "multipart/form-data; boundary=boundary" } }), request("x", { headers: { "Content-Type": "text/plain" } })]) {
      assert.ok([400, 415].includes((await manual.POST(input)).status));
    }
    assert.equal(await count(), before);
  });

  await t.test("declared and streamed over-limit bodies return actionable 413 errors atomically", async () => {
    const before = await count();
    for (const route of [manual, integration]) {
      const automated = route === integration;
      const declared = await route.POST(json({ rows: [] }, { automated, headers: { "Content-Length": String(MAX_IMPORT_REQUEST_BYTES + 1) } }));
      assert.equal(declared.status, 413);
      assert.match((await declared.json()).error, /original compressed \.xlsx.*multipart\/form-data/);
      for (const contentType of ["application/json", "multipart/form-data; boundary=test"]) {
        const stream = new ReadableStream({ start(controller) { for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array(512 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
        const response = await route.POST(request(stream, { automated, headers: { "Content-Type": contentType } }));
        assert.equal(response.status, 413);
        assert.match((await response.json()).error, /4 MiB/);
      }
      const tooLarge = new FormData(); tooLarge.append("file", new File([new Uint8Array(MAX_IMPORT_FILE_BYTES + 1)], "large.xlsx"));
      assert.equal((await route.POST(request(tooLarge, { automated }))).status, 413);
    }
    assert.equal(await count(), before);
  });

  await t.test("10,000-row original workbook succeeds where expanded JSON exceeds ingress capacity", async () => {
    const bytes = workbookBytes(Array.from({ length: MAX_IMPORT_ROWS }, (_, index) => record(index + 1)));
    assert.ok(bytes.length < MAX_IMPORT_FILE_BYTES);
    const rows = await parseDemandSpreadsheet(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.ok(Buffer.byteLength(JSON.stringify({ rows: validateImportRows(rows) })) > MAX_IMPORT_REQUEST_BYTES);
    for (const route of [manual, integration]) {
      const automated = route === integration;
      const large = new FormData(); large.append("file", new File([bytes], "ten-thousand.xlsx"));
      if (automated) large.append("source", "erp");
      const result = await ok(await route.POST(request(large, { automated })));
      assert.equal(result.rowCount, MAX_IMPORT_ROWS);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_import_rows WHERE batch_id=?").bind(result.batchId).first()).n, MAX_IMPORT_ROWS);
    }
    // An empty delivery while demand is open is far more likely a failed export than
    // "no open orders", so it is refused until the sender confirms it explicitly.
    const refused = await integration.POST(json({ source: "erp", rows: [] }, { automated: true }));
    assert.equal(refused.status, 409);
    const refusal = await refused.json();
    assert.equal(refusal.code, "shrink_confirmation_required");
    assert.deepEqual(refusal.shrink, { reason: "empty_snapshot", unworkedLines: MAX_IMPORT_ROWS, removedLines: MAX_IMPORT_ROWS, incomingLines: 0 });
    assert.equal((await store.getAppState()).lines.length, MAX_IMPORT_ROWS, "a refused empty snapshot changes nothing");
    const result = await ok(await integration.POST(json({ source: "erp", rows: [], allowShrink: true }, { automated: true })));
    assert.equal(result.rowCount, 0);
    assert.equal((await store.getAppState()).lines.length, 0);
  });
});
