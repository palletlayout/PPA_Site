import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

test("authenticated ownership, append history, provenance and shared login limits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-security-regression-"));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "disposable.sqlite");
  for (const key of ["DATABASE_URL", "POSTGRES_URL", "VERCEL"]) delete process.env[key];
  const auth = await import("../lib/auth.ts");
  const store = await import("../db/cart-store.ts");
  const { Database } = await import("../db/index.ts");
  const limits = await import("../lib/auth-rate-limit.ts");
  const db = await store.ensureDatabase();
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const passwordHash = await auth.hashPassword("review-only-regression-password");
  const users = ["first", "second"].map(id => ({ id, username: id, name: "Same Name", role: "operator", passwordHash }));
  Object.assign(process.env, { CARTFLOW_AUTH_MODE: "credentials", CARTFLOW_AUTH_SECRET: "test-only-rate-limit-secret-at-least-32-bytes", CARTFLOW_APP_ORIGIN: "https://review.example", CARTFLOW_AUTH_USERS: JSON.stringify(users), CARTFLOW_CLIENT_IP_HEADER: "x-review-client-ip" });
  const config = auth.getAuthConfig();
  const fixture = { plant: "SECURITY", zone: "A", areaType: "onsite", shipCategory: "Production", loadNumber: "", trainNumber: "TRAIN-1", picklistNumber: "PICK-1", cartNumber: "CART-1", cartId: "CART-1", palletId: "PALLET-1", sequence: "001", partNumber: "PART-1", description: "Security fixture", color: "BLUE", quantity: 5, aiagSerial: "", masterBarcode: "MASTER-1", movementBarcode: "MOVEMENT-1" };
  const actor = { id: "supervisor-1", name: "Accountable Supervisor" };

  await t.test("manual append stores source and actor atomically, including the first batch", async () => {
    const first = await store.appendImportRow("first.json", fixture, undefined, actor);
    let audit = await db.prepare("SELECT * FROM demand_audit_events").all();
    assert.equal(audit.results.length, 1);
    assert.equal(audit.results[0].actor_id, actor.id);
    const appended = await store.appendImportRow("second.json", { ...fixture, sequence: "002" }, undefined, actor);
    audit = await db.prepare("SELECT * FROM demand_audit_events WHERE action='manual_append'").all();
    assert.equal(audit.results.length, 1);
    assert.equal(audit.results[0].actor_id, actor.id);
    assert.equal(audit.results[0].line_id, appended.lineId);
    assert.equal(JSON.parse(audit.results[0].after_json).sourceFile, "second.json");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_import_rows WHERE batch_id=?").bind(first.batchId).first()).n, 2);
    const count = async table => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
    const before = await Promise.all(["demand_details", "demand_import_rows", "demand_audit_events"].map(count));
    await db.prepare("CREATE TRIGGER fail_append_audit BEFORE INSERT ON demand_audit_events WHEN NEW.action='manual_append' BEGIN SELECT RAISE(ABORT, 'audit write rejected'); END").run();
    await assert.rejects(store.appendImportRow("third.json", { ...fixture, sequence: "003" }, undefined, actor), /audit write rejected/);
    await db.prepare("DROP TRIGGER fail_append_audit").run();
    assert.deepEqual(await Promise.all(["demand_details", "demand_import_rows", "demand_audit_events"].map(count)), before);
    assert.equal((await store.getAppState()).lastImport.rowCount, 2);
  });

  await t.test("duplicate display names cannot release leases, including legacy leases", async () => {
    const line = (await store.getAppState()).lines[0];
    const cartKey = [line.plant, line.areaType, line.trainNumber, line.picklistNumber, line.cartNumber, line.cartId].join("::");
    const first = { cartKey, sessionId: "first-session", operatorName: users[0].name, operatorId: users[0].id };
    const second = { ...first, sessionId: "second-session", operatorId: users[1].id };
    assert.equal((await store.manageLock({ ...first, action: "acquire" })).lock.isOwnedByOperator, true);
    assert.equal((await store.manageLock({ ...second, action: "acquire" })).lock.isOwnedByOperator, false);
    assert.equal((await store.manageLock({ ...second, action: "release_own" })).released, false);
    assert.equal((await store.getAppState(second.sessionId, second.operatorId)).locks[0].isOwnedByOperator, false);
    assert.equal((await store.manageLock({ ...first, sessionId: "new-tab", action: "release_own" })).released, true);
    await store.manageLock({ ...first, operatorId: undefined, action: "acquire" });
    assert.equal((await store.manageLock({ ...first, action: "release_own" })).released, false, "legacy ownerless reservations never match a display name");
    assert.equal((await store.manageLock({ ...first, action: "release" })).released, true);
  });

  await t.test("imports and expected-stock confirmation never invent scanner input", async () => {
    const input = { captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ["1SIMPORTED-1", "PPART-1", "CBLUE", "Q5"], operatorName: actor.name, operatorId: actor.id, receiveDate: "2026-09-20", receiptKind: "expected", provenance: { method: "spreadsheet_import", sourceFile: "supplier.csv", importId: randomUUID(), rowNumber: 2 } };
    const imported = await store.receiveInventoryFromPhysicalLabel(input);
    assert.equal(imported.inventory.acquisitionMethod, "spreadsheet_import");
    assert.equal(imported.inventory.sourceFile, "supplier.csv");
    assert.equal(imported.inventory.sourceImportId, input.provenance.importId);
    assert.equal(imported.inventory.sourceRow, 2);
    assert.equal(imported.inventory.scannedValuesJson, "{}");
    const raw = await db.prepare("SELECT source,raw_aiag_serial,raw_part_number,raw_part_level,raw_quantity FROM inventory_items WHERE id=?").bind(imported.inventory.id).first();
    assert.deepEqual({ ...raw }, { source: "spreadsheet_import", raw_aiag_serial: "", raw_part_number: "", raw_part_level: "", raw_quantity: "" });
    const receipt = { inventoryId: imported.inventory.id, captureId: randomUUID(), receiptSessionId: randomUUID(), operatorName: "Receiver", operatorId: "receiver" };
    const received = await store.receiveExpectedInventory(receipt);
    assert.equal(received.inventory.status, "available");
    assert.equal(received.inventory.acquisitionMethod, "spreadsheet_import");
    assert.equal(received.inventory.recordedAt, imported.inventory.recordedAt);
    assert.equal(received.inventory.receiveDate, "2026-09-20");
    assert.equal(received.inventory.scannedValuesJson, "{}");
    assert.deepEqual((await store.receiveExpectedInventory(receipt)).inventory, received.inventory);
    const audit = (await db.prepare("SELECT after_json FROM demand_audit_events WHERE line_id=? AND action='inventory_received'").bind(imported.inventory.id).first());
    assert.deepEqual(JSON.parse(audit.after_json).rawValues, {});
    assert.equal(JSON.parse(audit.after_json).provenance.method, "explicit_confirmation");
    assert.equal((await store.getInventoryExport()).find(item => item.id === imported.inventory.id).sourceFile, "supplier.csv");
    await assert.rejects(store.receiveInventoryFromPhysicalLabel({ ...input, provenance: { ...input.provenance, sourceFile: "changed.csv" } }), /already used/);
  });

  await t.test("limits persist across adapters and isolate other clients and accounts", async () => {
    const secondAdapter = new Database({ sqlitePath: process.env.CARTFLOW_DATABASE_PATH });
    try {
      for (let index = 0; index < 10; index++) assert.equal((await limits.consumeLoginAttempt(config, "client-a", "first", 1700000000000, index % 2 ? secondAdapter : db)).allowed, true);
      assert.equal((await limits.consumeLoginAttempt(config, "client-a", "first", 1700000000000, secondAdapter)).allowed, false);
      assert.equal((await limits.consumeLoginAttempt(config, "client-b", "first", 1700000000000, secondAdapter)).allowed, true);
      assert.equal((await limits.consumeLoginAttempt(config, "client-a", "second", 1700000000000, secondAdapter)).allowed, true);
      assert.equal((await limits.consumeLoginAttempt(config, "client-a", "first", 1700000900001, secondAdapter)).allowed, true);
      const saved = await db.prepare("SELECT * FROM auth_rate_limits").all();
      assert.ok(saved.results.every(row => /^[a-f0-9]{64}$/.test(row.key_hash)));
      assert.doesNotMatch(JSON.stringify(saved.results), /client-a|client-b|first|second/);
    } finally { secondAdapter.close(); }
  });

  await t.test("only trusted client identity is accepted", () => {
    const req = new Request("https://review.example/", { headers: { "x-forwarded-for": "203.0.113.1" } });
    assert.throws(() => limits.loginClientIdentity(req, "https://review.example", {}), /must be configured/);
    assert.throws(() => limits.loginClientIdentity(req, "https://review.example", { VERCEL: "1" }), /unavailable/);
    assert.equal(limits.loginClientIdentity(new Request(req, { headers: { "x-vercel-forwarded-for": "203.0.113.1" } }), "https://review.example", { VERCEL: "1" }), "203.0.113.1");
    assert.throws(() => limits.loginClientIdentity(new Request(req, { headers: { "x-proxy-ip": "203.0.113.1,203.0.113.2" } }), "https://review.example", { CARTFLOW_CLIENT_IP_HEADER: "x-proxy-ip" }), /unavailable/);
  });

  await t.test("malformed login flood cannot block a valid sign-in; failures fail closed", async () => {
    const source = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
    const resolved = source.replace(/from "@\/lib\/([^\"]+)"/g, (_, path) => `from "${new URL(`../lib/${path}.ts`, import.meta.url).href}"`);
    const target = join(directory, "login-route.mjs");
    await writeFile(target, ts.transpileModule(resolved, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    const { POST } = await import(pathToFileURL(target).href);
    const req = body => new Request(`${config.origin}/api/auth/login`, { method: "POST", headers: { Origin: config.origin, "Content-Type": "application/json", "x-review-client-ip": "203.0.113.70" }, body: JSON.stringify(body) });
    for (let index = 0; index < 100; index++) assert.equal((await POST(req({}))).status, 400);
    const login = await POST(req({ username: "first", password: "review-only-regression-password" }));
    assert.equal(login.status, 200);
    assert.match(login.headers.get("set-cookie"), /HttpOnly/);
    await db.prepare("DROP TABLE auth_rate_limits").run();
    assert.equal((await POST(req({ username: "first", password: "review-only-regression-password" }))).status, 503);
  });
});
