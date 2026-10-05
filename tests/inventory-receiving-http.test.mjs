import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as XLSX from "xlsx";
import { hashPassword } from "../lib/auth.ts";

async function startReceivingServer(t) {
  const directory = await mkdtemp(join(tmpdir(), "cartflow-receiving-http-"));
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const password = "Disposable-receiving-QA-password-2026";
  const passwordHash = await hashPassword(password);
  const users = ["viewer", "operator", "supervisor"].map((role) => ({
    id: `receiving-${role}`, username: role, name: `Receiving ${role}`, role, passwordHash,
  }));
  let logs = "";
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env, NODE_ENV: "production", DATABASE_URL: "", POSTGRES_URL: "", VERCEL: "",
      CARTFLOW_DATABASE_PATH: join(directory, "receiving.sqlite"), CARTFLOW_AUTH_MODE: "credentials",
      CARTFLOW_APP_ORIGIN: origin, CARTFLOW_AUTH_SECRET: "receiving-disposable-test-secret-2026",
      CARTFLOW_AUTH_USERS: JSON.stringify(users), CARTFLOW_ENABLE_TEST_TOOLS: "false",
      CARTFLOW_FORMAT_ONLY_TEST_MODE: "false",
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Receiving QA server stopped: ${logs}`);
    try {
      await fetch(`${origin}/api/auth/session`, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      if (attempt === 199) throw new Error(`Receiving QA server failed to start: ${logs}`);
      await delay(100);
    }
  }
  async function request(path, { method = "GET", body, rawBody, cookie = "", headers = {} } = {}) {
    return fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(body !== undefined || rawBody !== undefined ? { "Content-Type": "application/json" } : {}),
        Origin: origin, Cookie: cookie, ...headers,
      },
      ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  }
  async function login(role) {
    const response = await request("/api/auth/login", { method: "POST", body: { username: role, password } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.headers.get("set-cookie").split(";")[0];
  }
  return { request, login };
}

test("production receiving HTTP routes enforce receipt integrity and expose supervisor inventory", { timeout: 90000 }, async (t) => {
  const { request, login } = await startReceivingServer(t);
  const cookies = {};
  for (const role of ["viewer", "operator", "supervisor"]) cookies[role] = await login(role);
  const valid = () => ({
    captureId: randomUUID(), receiptSessionId: randomUUID(),
    rawValues: ["1SHTTP-CONTAINER-1", "PHTTP-PART", "2PBLACK", "Q24"], operatorName: "FORGED OPERATOR",
  });
  const receive = (body, options = {}) => request("/api/inventory/receive", {
    method: "POST", cookie: cookies.operator, body, ...options,
  });
  const inventory = async (query = "") => {
    const response = await request(`/api/inventory${query}`, { cookie: cookies.viewer });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    return response.json();
  };
  let originalBody;
  let originalInventory;

  await t.test("anonymous and viewer mutations are denied; receiving does not require test tools", async () => {
    for (const path of ["/api/inventory", "/api/inventory/export"]) {
      assert.equal((await request(path)).status, 401, path);
    }
    assert.equal((await receive(valid(), { cookie: "" })).status, 401);
    assert.equal((await receive(valid(), { cookie: cookies.viewer })).status, 403);
    assert.equal((await receive(valid(), { headers: { Origin: "https://untrusted.invalid" } })).status, 403);
    assert.equal((await request("/api/inventory/capture", { method: "POST", cookie: cookies.operator, body: valid() })).status, 403);
    assert.deepEqual((await inventory()).summary, { containers: 0, units: 0, quantitiesByUnit: {} });
  });

  await t.test("malformed and noncanonical label requests never create stock", async () => {
    const validBody = valid();
    const invalidBodies = [
      null, [], {}, { ...validBody, captureId: "not-a-uuid" }, { ...validBody, receiptSessionId: "not-a-uuid" },
      { ...validBody, rawValues: ["1SSERIAL", "PPART", "2PBLACK"] },
      { ...validBody, rawValues: ["1SSERIAL", "PPART", "PPART-2", "Q1"] },
      { ...validBody, rawValues: ["1SSERIAL", "PPART", "2PBLACK", 1] },
      { ...validBody, rawValues: ["1SSERIAL", "PPART", "2PBLACK", "Q1", "Q2"] },
      { ...validBody, rawValues: ["1SSERIAL", "PPART\nPOTHER", "2PBLACK", "Q1"] },
      { ...validBody, rawValues: ["1SSERIAL", `P${"A".repeat(513)}`, "2PBLACK", "Q1"] },
      { ...validBody, rawValues: ["1S", "PPART", "2PBLACK", "Q1"] },
      { ...validBody, rawValues: ["SSERIAL", "PPART", "2PBLACK", "Q1"] },
      { ...validBody, rawValues: ["9SSERIAL", "PPART", "2PBLACK", "Q1"] },
      ...["Q0", "Q-1", "Q1.5", "Q1e2", "Q2147483648", "Q99999999999999999999"].map((quantity) => ({
        ...validBody, rawValues: ["1SSERIAL", "PPART", "2PBLACK", quantity],
      })),
    ];
    for (const body of invalidBodies) {
      const response = await receive(body);
      assert.equal(response.status, 400, `${JSON.stringify(body)}: ${await response.text()}`);
    }
    const malformed = await request("/api/inventory/receive", {
      method: "POST", cookie: cookies.operator, rawBody: '{"captureId":',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await inventory()).total, 0);
  });

  await t.test("an operator receives without demand and server identity overrides supplied provenance", async () => {
    originalBody = { ...valid(), isTest: true, receivedBy: "FORGED RECEIVER" };
    const response = await receive(originalBody);
    assert.equal(response.status, 201, await response.clone().text());
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.duplicate, false);
    originalInventory = result.inventory;
    assert.equal(originalInventory.isTest, false);
    assert.equal(originalInventory.receivedBy, "Receiving operator");
    assert.equal(originalInventory.quantity, 24);
    assert.equal(originalInventory.serial, "HTTP-CONTAINER-1");
    assert.equal(originalInventory.partNumber, "HTTP-PART");
    assert.equal(originalInventory.partMark, "BLACK");
    assert.equal(originalInventory.status, "available");
    assert.equal(originalInventory.unitOfMeasure, "EA");
    assert.equal(originalInventory.supplierId, "");
    assert.equal(originalInventory.receiptKind, "received");
    assert.equal(originalInventory.fulfillmentStage, "available");
    assert.equal(originalInventory.loadedAt, null);
    assert.equal(originalInventory.dispatchedAt, null);
    assert.ok(Number.isFinite(Date.parse(originalInventory.receivedAt)));
    assert.deepEqual((await inventory()).summary, { containers: 1, units: 24, quantitiesByUnit: { EA: 24 } });
    const state = await (await request("/api/state", { cookie: cookies.viewer })).json();
    assert.equal(state.lines.length, 0, "receiving must not invent picklists or demand");
    const audit = await request("/api/audit/export", { cookie: cookies.supervisor });
    const auditCsv = await audit.text();
    assert.match(auditCsv, /inventory_received/);
    assert.match(auditCsv, /Receiving operator/);
    assert.doesNotMatch(auditCsv, /FORGED/);
  });

  await t.test("retries return the original container and conflicts preserve its balance", async () => {
    for (const body of [originalBody, { ...originalBody, captureId: randomUUID(), receiptSessionId: randomUUID() }]) {
      const response = await receive(body, { cookie: cookies.supervisor });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.equal(result.created, false);
      assert.equal(result.duplicate, true);
      assert.deepEqual(result.inventory, originalInventory);
    }
    for (const body of [
      { ...originalBody, captureId: randomUUID(), rawValues: ["1SHTTP-CONTAINER-1", "PHTTP-PART", "2PBLACK", "Q25"] },
      { ...originalBody, rawValues: ["1SHTTP-OTHER-CONTAINER", "PHTTP-PART", "2PBLACK", "Q24"] },
    ]) assert.equal((await receive(body)).status, 409);
    assert.deepEqual((await inventory()).summary, { containers: 1, units: 24, quantitiesByUnit: { EA: 24 } });
  });

  await t.test("concurrent operators receiving one container produce one new receipt", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => receive({
      ...valid(), rawValues: ["1SHTTP-CONCURRENT", "PHTTP-PART", "2PBLACK", "Q6"],
    })));
    assert.equal(results.filter((response) => response.status === 201).length, 1);
    assert.equal(results.filter((response) => response.status === 200).length, 19);
    const bodies = await Promise.all(results.map((response) => response.json()));
    assert.equal(new Set(bodies.map((body) => body.inventory.id)).size, 1);
    assert.deepEqual((await inventory()).summary, { containers: 2, units: 30, quantitiesByUnit: { EA: 30 } });
  });

  await t.test("inventory search treats wildcards literally and pagination remains stable", async () => {
    for (const [serial, part, mark, quantity] of [
      ["LITERAL%CONTAINER", "PART%VALUE", "BLACK", 3],
      ["LITERAL_CONTAINER", "PART_VALUE", "GRAY", 5],
      ["LITERAL\\CONTAINER", "PART\\VALUE", "GRAY", 7],
    ]) {
      const response = await receive({ ...valid(), rawValues: [`1S${serial}`, `P${part}`, `2P${mark}`, `Q${quantity}`] });
      assert.equal(response.status, 201, await response.clone().text());
    }
    const first = await inventory("?page=1&pageSize=2");
    const second = await inventory("?page=2&pageSize=2");
    assert.equal(first.page, 1);
    assert.equal(first.pageSize, 2);
    assert.equal(first.total, 5);
    assert.equal(first.items.length, 2);
    assert.equal(second.page, 2);
    assert.equal(second.items.length, 2);
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 4);
    assert.deepEqual((await inventory("?page=1&pageSize=2")).items, first.items);
    assert.equal((await inventory("?page=99&pageSize=2")).items.length, 0);
    assert.equal((await inventory("?pageSize=101")).pageSize, 100);
    for (const [query, expected] of [["%", "LITERAL%CONTAINER"], ["_", "LITERAL_CONTAINER"], ["\\", "LITERAL\\CONTAINER"]]) {
      const filtered = await inventory(`?q=${encodeURIComponent(query)}`);
      assert.equal(filtered.total, 1);
      assert.equal(filtered.items[0].serial, expected);
    }
    assert.equal((await inventory("?q=http-part")).total, 2, "part-number search is case insensitive");
    assert.equal((await inventory("?q=GRAY")).total, 2, "part marks are searchable");
    assert.equal((await inventory("?q=no-such-container")).total, 0);
    for (const query of ["page=0", "page=-1", "page=1.5", "page=1000001", "pageSize=0", "pageSize=invalid", `q=${"a".repeat(257)}`]) {
      assert.equal((await request(`/api/inventory?${query}`, { cookie: cookies.viewer })).status, 400, query);
    }
  });

  await t.test("only supervisors can delete and restore inventory, with confirmed actions and live totals", async () => {
    const body = { id: originalInventory.id, confirmation: "DELETE_INVENTORY", operatorName: "FORGED NAME" };
    const before = (await inventory()).summary;
    for (const role of ["viewer", "operator"]) {
      assert.equal((await request("/api/inventory", { method: "DELETE", cookie: cookies[role], body })).status, 403);
      assert.equal((await request("/api/inventory", { method: "PATCH", cookie: cookies[role], body: { ...body, confirmation: "RESTORE_INVENTORY" } })).status, 403);
      assert.equal((await request("/api/inventory?status=deleted", { cookie: cookies[role] })).status, 403);
    }
    assert.equal((await request("/api/inventory", { method: "DELETE", body })).status, 401);
    assert.equal((await request("/api/inventory", { method: "DELETE", cookie: cookies.supervisor, body, headers: { Origin: "https://untrusted.invalid" } })).status, 403);
    assert.equal((await request("/api/inventory", { method: "DELETE", cookie: cookies.supervisor, body: { ...body, confirmation: "" } })).status, 400);
    const remove = () => request("/api/inventory", { method: "DELETE", cookie: cookies.supervisor, body });
    assert.equal((await remove()).status, 200);
    assert.equal((await (await remove()).json()).changed, false);
    assert.deepEqual((await inventory()).summary, { containers: before.containers - 1, units: before.units - originalInventory.quantity,
      quantitiesByUnit: { ...before.quantitiesByUnit, EA: before.quantitiesByUnit.EA - originalInventory.quantity } });
    const deleted = await (await request("/api/inventory?status=deleted", { cookie: cookies.supervisor })).json();
    assert.equal(deleted.items[0].id, originalInventory.id);
    assert.equal((await receive(originalBody)).status, 409, "an old receipt cannot resurrect deleted stock");
    const restore = await request("/api/inventory", { method: "PATCH", cookie: cookies.supervisor, body: { ...body, confirmation: "RESTORE_INVENTORY" } });
    assert.equal(restore.status, 200);
    assert.deepEqual((await inventory()).summary, before);
    const audit = await request("/api/audit/export", { cookie: cookies.supervisor });
    const csv = await audit.text();
    assert.match(csv, /inventory_deleted/); assert.match(csv, /inventory_restored/);
    assert.match(csv, /Receiving supervisor/); assert.doesNotMatch(csv, /FORGED NAME/);
  });

  await t.test("filtered CSV exports preserve values and neutralize spreadsheet formulas", async () => {
    const response = await receive({
      ...valid(), rawValues: ['1S=SUM(1,2)', 'PQuoted,"Part"', '2P@FORMULA', 'Q9'],
    });
    assert.equal(response.status, 201, await response.clone().text());
    const exported = await request(`/api/inventory/export?q=${encodeURIComponent('Quoted,"Part"')}`, { cookie: cookies.viewer });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type") || "", /text\/csv/);
    assert.match(exported.headers.get("cache-control") || "", /no-store/);
    assert.match(exported.headers.get("content-disposition") || "", /attachment.*\.csv/);
    const csv = await exported.text();
    const workbook = XLSX.read(csv, { type: "string", raw: true });
    const records = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
    assert.equal(records.length, 2, "the CSV respects the selected search filter");
    assert.ok(records[1].includes("'=SUM(1,2)"));
    assert.ok(records[1].includes('Quoted,"Part"'));
    assert.ok(records[1].includes("'@FORMULA"));
    assert.ok(records[1].includes("Receiving operator"));
    assert.doesNotMatch(csv, /FORGED/);
    const wildcardCsv = await request("/api/inventory/export?q=%25", { cookie: cookies.viewer });
    assert.match(await wildcardCsv.text(), /LITERAL%CONTAINER/);
    assert.equal((await request(`/api/inventory/export?q=${"x".repeat(257)}`, { cookie: cookies.viewer })).status, 400);
    assert.equal((await (await request("/api/state", { cookie: cookies.viewer })).json()).lines.length, 0);
  });
  await t.test("inventory and exports use one color field", async () => {
    const response = await receive({ ...valid(), rawValues: ["PHTTP-PART", "Q24", "CBLUE", "1SHTTP-COLOR"] });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.inventory.color, "BLUE");
    assert.equal(result.inventory.partLevel, "");
    const csv = await (await request("/api/inventory/export", { cookie: cookies.supervisor })).text();
    assert.match(csv, /Color/);
    assert.doesNotMatch(csv, /Part level|Card color/);
    assert.match(csv, /BLUE/);
  });

  await t.test("labels without color can be received and retried with either empty color marker", async () => {
    const body = { ...valid(), rawValues: ["1SHTTP-NO-COLOR", "PHTTP-PART", "Q24"] };
    const response = await receive(body);
    assert.equal(response.status, 201, await response.clone().text());
    const original = await response.json();
    assert.equal(original.inventory.color, "");
    for (const marker of ["C", "2P"]) {
      const retry = await receive({ ...body, rawValues: [...body.rawValues, marker] });
      assert.equal(retry.status, 200, await retry.clone().text());
      const result = await retry.json();
      assert.equal(result.duplicate, true);
      assert.equal(result.inventory.id, original.inventory.id);
    }
    const conflict = await receive({ ...body, rawValues: [...body.rawValues, "CBLUE"] });
    assert.equal(conflict.status, 409);
    assert.equal((await inventory("?q=HTTP-NO-COLOR")).total, 1);
  });

  await t.test("inventory file batches enforce roles, preserve blank colors and metadata, and retry safely", async () => {
    const body = { importId: randomUUID(), fileName: "receiving-supplier.csv", startRow: 0, rows: [
      { aiagSerial: "UPLOAD-BLANK", partNumber: "UPLOAD-PART", color: "", quantity: 20,
        weight: 12.5, unitCost: 3.25, receiveDate: "2026-09-15", palletId: "000Mixed-Pallet" },
      { aiagSerial: "UPLOAD-BLUE", partNumber: "UPLOAD-PART", color: "BLUE", quantity: 10 },
    ] };
    const upload = (payload = body, cookie = cookies.supervisor) => request("/api/inventory/import", { method: "POST", cookie, body: payload });
    for (const role of ["viewer", "operator"]) assert.equal((await upload(body, cookies[role])).status, 403);
    assert.equal((await upload(body, "")).status, 401);
    assert.equal((await upload({ ...body, rows: [...body.rows, { ...body.rows[0], quantity: -1 }] })).status, 400);
    assert.equal((await inventory("?q=UPLOAD-")).total, 0, "validation runs before writes");
    const first = await upload();
    assert.equal(first.status, 200, await first.clone().text());
    assert.deepEqual(await first.json(), { ok: true, created: 2, duplicate: 0 });
    const second = await upload();
    assert.deepEqual(await second.json(), { ok: true, created: 0, duplicate: 2 });
    const items = (await inventory("?q=UPLOAD-")).items;
    assert.equal(items.length, 2);
    const blank = items.find((item) => item.serial === "UPLOAD-BLANK");
    assert.equal(blank.partMark, "");
    assert.equal(blank.consumedFlag, "N");
    assert.equal(blank.weight, 12.5);
    assert.equal(blank.unitCost, 3.25);
    assert.equal(blank.receiveDate, "2026-09-15");
    assert.equal(blank.palletId, "000Mixed-Pallet");
    assert.equal(blank.acquisitionMethod, "spreadsheet_import");
    assert.equal(blank.sourceFile, body.fileName);
    assert.equal(blank.sourceImportId, body.importId);
    assert.equal(blank.sourceRow, 2);
    assert.equal(blank.scannedValuesJson, "{}");
    assert.ok(Number.isFinite(Date.parse(blank.recordedAt)));
    assert.equal(blank.palletBarcode, undefined, "a source pallet ID remains metadata rather than a scanner barcode");
    assert.equal((await inventory("?q=000mixed-pallet")).items[0].id, blank.id);
    const csv = await (await request("/api/inventory/export?q=000mixed-pallet", { cookie: cookies.supervisor })).text();
    const exported = XLSX.utils.sheet_to_json(XLSX.read(csv, { type: "string", raw: true }).Sheets.Sheet1);
    assert.equal(exported[0]["Pallet ID"], "000Mixed-Pallet");
    assert.equal(exported[0]["Acquisition Method"], "spreadsheet_import");
    assert.equal(exported[0]["Source File"], body.fileName);
    assert.equal(exported[0]["Source Import ID"], body.importId);
    assert.equal(exported[0]["Source Row"], "2");
    assert.equal(exported[0]["Captured Label Input JSON"], "{}");
    const conflict = await upload({ ...body, rows: [{ ...body.rows[0], quantity: 21 }] });
    assert.equal(conflict.status, 409);
    assert.equal((await inventory("?q=UPLOAD-BLANK")).items[0].quantity, 20);
    const changedMetadata = await upload({ ...body, importId: randomUUID(), rows: [{ ...body.rows[0], weight: 99 }] });
    assert.equal(changedMetadata.status, 409);
    for (const importId of [body.importId, randomUUID()]) {
      const changedPallet = await upload({ ...body, importId, rows: [{ ...body.rows[0], palletId: "DIFFERENT-PALLET" }] });
      assert.equal(changedPallet.status, 409);
      assert.equal((await inventory("?q=UPLOAD-BLANK")).items[0].palletId, "000Mixed-Pallet");
    }
    assert.equal((await upload({ ...body, importId: randomUUID(), rows: [{ ...body.rows[0], aiagSerial: "INVALID-PALLET", palletId: "P".repeat(181) }] })).status, 400);
    const partialId = randomUUID();
    const partialBody = { importId: partialId, startRow: 0, rows: [
      { aiagSerial: "UPLOAD-PARTIAL", partNumber: "UPLOAD-PART", color: "", quantity: 1 },
      { ...body.rows[0], quantity: 999 },
    ] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const partial = await upload(partialBody);
      assert.equal(partial.status, 409);
      assert.equal((await partial.json()).rowNumber, 3);
    }
    assert.equal((await inventory("?q=UPLOAD-PARTIAL")).total, 1);
  });

});
