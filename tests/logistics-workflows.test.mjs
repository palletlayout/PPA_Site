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

const baseRow = {
  plant: "01", zone: "A", areaType: "offsite", shipCategory: "AA", loadNumber: "LOG-LOAD", trainNumber: "",
  picklistNumber: "LOG-PICK", cartNumber: "1", cartId: "LOG-CART", palletId: "LOG-PALLET", sequence: "010",
  partNumber: "LOG-PART", description: "Disposable logistics fixture", color: "BLUE", quantity: 2, unitOfMeasure: "EA",
  aiagSerial: "", masterBarcode: "LOG-MASTER", checksheetNumber: "LOG-CHECK", movementBarcode: "LOG-DEST", loadingSequence: "1",
};
const keyFor = (line) => [line.plant, line.areaType, line.areaType === "onsite" ? line.trainNumber : line.loadNumber, line.picklistNumber, line.cartNumber, line.cartId].join("::");
const physicalReceipt = (serial, row = baseRow, metadata = {}) => ({
  captureId: randomUUID(), receiptSessionId: randomUUID(), operatorName: "Logistics receiver", operatorId: "log-receiver",
  rawValues: [`1S${serial}`, `P${row.partNumber}`, `2P${row.color}`, `Q${row.quantity}`], unitOfMeasure: row.unitOfMeasure || "EA", ...metadata,
});

test("logistics persistence preserves supplier identity, measured quantities and physical milestones", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-logistics-store-"));
  const envKeys = ["CARTFLOW_DATABASE_PATH", "DATABASE_URL", "POSTGRES_URL", "VERCEL"];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "logistics.sqlite");
  for (const key of envKeys.slice(1)) delete process.env[key];
  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => {
    db.close();
    for (const key of envKeys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    await rm(directory, { recursive: true, force: true });
  });
  const setup = async (rows = [baseRow]) => {
    await store.clearAllData();
    await store.replaceImport("logistics.csv", rows);
    const lines = (await store.getAppState()).lines;
    const context = { lineId: lines[0].id, cartKey: keyFor(lines[0]), sessionId: "logistics-tab", operatorName: "Logistics packer", operatorId: "log-packer" };
    assert.equal((await store.manageLock({ ...context, action: "acquire" })).locked, true);
    return { lines, context };
  };
  const scan = (context, value) => store.recordScan({ ...context, field: "cartBarcode", value });
  const stock = async (id) => (await store.listInventory()).items.find((item) => item.id === id);

  await t.test("the same serial from different suppliers is never selected silently", async () => {
    const { lines, context } = await setup([baseRow, { ...baseRow, sequence: "020" }, { ...baseRow, sequence: "030" }]);
    assert.equal((await scan(context, baseRow.masterBarcode)).matched, true);
    const receipts = await Promise.all(["SUP-A", "SUP-B", ""].map((supplierId) => store.receiveInventoryFromPhysicalLabel(physicalReceipt("SHARED", baseRow, { supplierId }))));
    assert.equal(new Set(receipts.map((receipt) => receipt.inventory.id)).size, 3);
    const ambiguous = await store.fulfillDemand({ ...context, serial: "1SSHARED", serialFormat: "barcode" });
    assert.equal(ambiguous.reason, "ambiguous_serial");
    assert.deepEqual([...ambiguous.suppliers].sort(), ["", "SUP-A", "SUP-B"]);
    assert.ok((await store.listInventory()).items.every((item) => item.fulfillmentStage === "available"));
    for (const [index, supplierId] of ["SUP-A", "SUP-B", ""].entries()) {
      const result = await store.fulfillDemand({ ...context, lineId: lines[index].id, serial: "1SSHARED", serialFormat: "barcode", supplierId });
      assert.equal(result.verified, true, JSON.stringify(result));
      assert.equal(result.inventoryItemId, receipts[index].inventory.id);
    }
    assert.ok((await store.listInventory()).items.every((item) => item.fulfillmentStage === "packed"));
    assert.equal((await store.listInventory()).summary.containers, 0);
  });

  await t.test("EA remains whole while measured quantities and units must match exactly", async () => {
    const measured = { ...baseRow, quantity: 2.500001, unitOfMeasure: "KG" };
    const { context } = await setup([measured]);
    assert.equal((await scan(context, baseRow.checksheetNumber)).matched, true);
    await assert.rejects(store.receiveInventoryFromPhysicalLabel(physicalReceipt("FRACTIONAL-EA", { ...baseRow, quantity: 2.5 })), /whole|quantity|digits only/i);
    await store.receiveInventoryFromPhysicalLabel(physicalReceipt("WRONG-UNIT", { ...measured, unitOfMeasure: "G" }));
    await store.receiveInventoryFromPhysicalLabel(physicalReceipt("WRONG-AMOUNT", { ...measured, quantity: 2.5 }));
    for (const serial of ["WRONG-UNIT", "WRONG-AMOUNT"]) {
      assert.equal((await store.fulfillDemand({ ...context, serial, serialFormat: "canonical" })).reason, "inventory_mismatch");
    }
    const correct = await store.receiveInventoryFromPhysicalLabel(physicalReceipt("MEASURED", measured));
    assert.equal(correct.inventory.quantity, 2.500001);
    assert.equal(correct.inventory.unitOfMeasure, "KG");
    const result = await store.fulfillDemand({ ...context, serial: "MEASURED", serialFormat: "canonical" });
    assert.equal(result.verified, true, JSON.stringify(result));
    assert.equal((await store.getAppState()).lines[0].fulfilledQuantity, 2.500001);
    assert.equal((await stock(correct.inventory.id)).consumedQuantity, 2.500001);
    const totals = (await store.listInventory()).summary;
    assert.equal(totals.units, 0, "measured stock must not be summed as eaches");
    assert.equal(totals.quantitiesByUnit.KG, 2.5);
    assert.equal(totals.quantitiesByUnit.G, 2.500001);
  });

  await t.test("expected inventory needs physical receipt before packing, loading and dispatch", async () => {
    const { lines, context } = await setup();
    const line = lines[0];
    assert.equal((await scan(context, line.picklistNumber)).matched, true);
    const expected = await store.receiveInventoryFromPhysicalLabel(physicalReceipt("EXPECTED", baseRow, { supplierId: "SUP-A", receiptKind: "expected" }));
    assert.equal(expected.inventory.fulfillmentStage, "expected");
    assert.equal(expected.inventory.receivedAt, "");
    assert.equal((await store.listInventory()).summary.containers, 0);
    const attempt = await store.fulfillDemand({ ...context, serial: "EXPECTED", serialFormat: "canonical", supplierId: "SUP-A" });
    assert.equal(attempt.reason, "inventory_expected");
    assert.equal(attempt.inventory.id, expected.inventory.id);
    assert.equal((await store.getAppState()).lines[0].fulfilledQuantity, 0);
    const destination = { movementValue: baseRow.movementBarcode, cartBarcode: baseRow.masterBarcode, operatorName: "Logistics loader", operatorId: "log-loader" };
    assert.equal((await store.confirmCartLoading(destination)).reason, "not_packed");
    assert.equal((await store.confirmPicklistDispatch(destination)).reason, "not_loaded");
    const receiptRequest = { inventoryId: expected.inventory.id, captureId: randomUUID(), receiptSessionId: randomUUID(), operatorName: "Dock receiver", operatorId: "dock-receiver" };
    const received = await store.receiveExpectedInventory(receiptRequest);
    assert.equal(received.inventory.id, expected.inventory.id);
    assert.equal(received.inventory.fulfillmentStage, "available");
    assert.equal(received.created, true);
    assert.ok(Date.parse(received.inventory.receivedAt));
    const replay = await store.receiveExpectedInventory(receiptRequest);
    assert.equal(replay.duplicate, true);
    assert.equal((await store.listInventory()).total, 1);
    assert.equal((await store.listInventory()).summary.containers, 1);
    assert.equal((await store.getAppState()).lines[0].status, "pending", "receiving alone never fulfils demand");
    assert.equal((await store.fulfillDemand({ ...context, serial: "EXPECTED", serialFormat: "canonical", supplierId: "SUP-A" })).verified, true);
    assert.equal((await stock(expected.inventory.id)).fulfillmentStage, "packed");
    assert.equal((await store.confirmPicklistDispatch(destination)).reason, "not_loaded");
    assert.equal((await store.confirmCartLoading({ ...destination, movementValue: "WRONG" })).reason, "wrong_movement");
    const loaded = await store.confirmCartLoading(destination);
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    assert.equal((await stock(expected.inventory.id)).fulfillmentStage, "loaded");
    assert.equal((await store.confirmCartLoading({ ...destination, cartBarcode: line.cartBarcode })).alreadyLoaded, true);
    assert.equal((await store.confirmPicklistDispatch({ ...destination, movementValue: "WRONG" })).reason, "wrong_movement");
    const dispatched = await store.confirmPicklistDispatch({ ...destination, cartBarcode: line.checksheetNumber });
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
    assert.ok(Date.parse(dispatched.cart.dispatchedAt));
    const repeated = await store.confirmPicklistDispatch(destination);
    assert.equal(repeated.alreadyDispatched, true);
    assert.equal(repeated.cart.dispatchedAt, dispatched.cart.dispatchedAt);
    assert.equal((await stock(expected.inventory.id)).fulfillmentStage, "dispatched");
    assert.equal((await store.listInventory()).summary.containers, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM load_confirmations").first()).n, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events WHERE action='dispatch' AND header_id=(SELECT header_id FROM demand_details WHERE id=?)").bind(line.id).first()).n, 1);
  });

  await t.test("new snapshots reject a second outbound card under the same picklist", async () => {
    await assert.rejects(setup([baseRow, { ...baseRow, cartNumber: "2", cartId: "OTHER-CART", palletId: "OTHER-PALLET", masterBarcode: "OTHER-MASTER", checksheetNumber: "OTHER-CHECK" }]), /exactly one outbound card/);
  });
});

async function startLogisticsServer(t) {
  const directory = await mkdtemp(join(tmpdir(), "ppa-logistics-http-"));
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const password = "Logistics-disposable-password-2026";
  const passwordHash = await hashPassword(password);
  const users = ["viewer", "operator", "supervisor"].map((role) => ({ id: `log-${role}`, username: role, name: `Logistics ${role}`, role, passwordHash }));
  let logs = "";
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, NODE_ENV: "production", DATABASE_URL: "", POSTGRES_URL: "", VERCEL: "", CARTFLOW_DATABASE_PATH: join(directory, "logistics.sqlite"),
      CARTFLOW_AUTH_MODE: "credentials", CARTFLOW_APP_ORIGIN: origin, CARTFLOW_AUTH_SECRET: "logistics-disposable-auth-secret-2026", CARTFLOW_AUTH_USERS: JSON.stringify(users), CARTFLOW_ENABLE_TEST_TOOLS: "false" },
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
    if (child.exitCode !== null) throw new Error(`Logistics server stopped: ${logs}`);
    try { await fetch(`${origin}/api/auth/session`, { signal: AbortSignal.timeout(500) }); break; }
    catch { if (attempt === 199) throw new Error(`Logistics server failed to start: ${logs}`); await delay(100); }
  }
  const request = (path, { method = "GET", body, cookie = "", headers = {} } = {}) => fetch(`${origin}${path}`, {
    method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), Origin: origin, Cookie: cookie, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  const login = async (role) => {
    const response = await request("/api/auth/login", { method: "POST", body: { username: role, password } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.headers.get("set-cookie").split(";")[0];
  };
  return { request, login };
}

test("logistics HTTP routes enforce expected receipts, supplier selection and dispatch authorization", { timeout: 90000 }, async (t) => {
  const { request, login } = await startLogisticsServer(t);
  const cookies = {};
  for (const role of ["viewer", "operator", "supervisor"]) cookies[role] = await login(role);
  const post = (path, body, role = "operator") => request(path, { method: "POST", body, cookie: cookies[role] });
  const okJson = async (response) => {
    const payload = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  };
  const measured = { ...baseRow, quantity: 1.250001, unitOfMeasure: "KG", sourceLineId: "HTTP-LINE-1", sourceScope: "http-erp" };
  await okJson(await post("/api/import", { fileName: "logistics-http.csv", rows: [measured] }, "supervisor"));
  const state = await okJson(await request("/api/state", { cookie: cookies.viewer }));
  const line = state.lines[0];
  const context = { lineId: line.id, cartKey: keyFor(line), sessionId: "log-http-tab", operatorName: "FORGED" };
  await okJson(await post("/api/locks", { ...context, picklistKey: keyFor(line).split("::").slice(0, 4).join("::"), action: "acquire" }));
  const scan = await okJson(await post("/api/scan", { ...context, field: "cartBarcode", value: measured.masterBarcode, rawValue: measured.masterBarcode }));
  assert.equal(scan.matched, true);
  const importBody = { importId: randomUUID(), startRow: 0, receiptKind: "expected", rows: ["SUP-A", "SUP-B"].map((supplierId) => ({ aiagSerial: "HTTP-SHARED", partNumber: measured.partNumber, color: measured.color, quantity: measured.quantity, unitOfMeasure: "KG", supplierId })) };
  assert.equal((await post("/api/inventory/import", importBody, "operator")).status, 403);
  await okJson(await post("/api/inventory/import", importBody, "supervisor"));
  const inventory = async () => okJson(await request("/api/inventory", { cookie: cookies.viewer }));
  const expected = await inventory();
  assert.equal(expected.total, 2);
  assert.equal(expected.summary.containers, 0);
  assert.ok(expected.items.every((item) => item.fulfillmentStage === "expected" && item.unitOfMeasure === "KG"));
  const ambiguousResponse = await post("/api/fulfill", { ...context, serial: "1SHTTP-SHARED", serialFormat: "barcode" });
  assert.equal(ambiguousResponse.status, 409);
  const ambiguous = await ambiguousResponse.json();
  assert.equal(ambiguous.reason, "ambiguous_serial");
  assert.deepEqual([...ambiguous.suppliers].sort(), ["SUP-A", "SUP-B"]);
  const selectedResponse = await post("/api/fulfill", { ...context, serial: "HTTP-SHARED", serialFormat: "canonical", supplierId: "SUP-A" });
  assert.equal(selectedResponse.status, 200);
  const selected = await selectedResponse.json();
  assert.equal(selected.reason, "inventory_expected");
  assert.equal(selected.nextAction, "receive_inventory");
  assert.equal(selected.ok, false, "expected inventory still requires physical receipt before packing");
  assert.equal(selected.inventory.supplierId, "SUP-A");
  const receipt = { inventoryId: selected.inventory.id, captureId: randomUUID(), receiptSessionId: randomUUID(), operatorName: "FORGED" };
  assert.equal((await post("/api/inventory/receive", receipt, "viewer")).status, 403);
  const received = await okJson(await post("/api/inventory/receive", receipt));
  assert.equal(received.inventory.fulfillmentStage, "available");
  assert.equal(received.inventory.receivedBy, "Logistics operator");
  const receivedReplay = await okJson(await post("/api/inventory/receive", receipt));
  assert.equal(receivedReplay.duplicate, true);
  assert.equal((await inventory()).summary.quantitiesByUnit.KG, 1.250001);
  assert.equal((await okJson(await request("/api/state", { cookie: cookies.viewer }))).lines[0].status, "pending");
  const placement = { movementValue: measured.movementBarcode, cartBarcode: measured.checksheetNumber, operatorName: "FORGED" };
  for (const path of ["/api/loading/confirm", "/api/loading/dispatch"]) {
    const early = await post(path, placement);
    assert.equal(early.status, 409);
    assert.equal((await early.json()).reason, path.endsWith("dispatch") ? "not_loaded" : "not_packed");
  }
  const fulfilled = await okJson(await post("/api/fulfill", { ...context, serial: "HTTP-SHARED", serialFormat: "canonical", supplierId: "SUP-A" }));
  assert.equal(fulfilled.verified, true);
  assert.equal((await inventory()).items.find((item) => item.id === selected.inventory.id).fulfillmentStage, "packed");
  const loaded = await okJson(await post("/api/loading/confirm", placement));
  assert.equal(loaded.cart.loadedBy, "Logistics operator");
  assert.equal((await inventory()).items.find((item) => item.id === selected.inventory.id).fulfillmentStage, "loaded");
  assert.equal((await post("/api/loading/dispatch", placement, "viewer")).status, 403);
  assert.equal((await request("/api/loading/dispatch", { method: "POST", body: placement })).status, 401);
  assert.equal((await request("/api/loading/dispatch", { method: "POST", body: placement, cookie: cookies.operator, headers: { Origin: "https://untrusted.invalid" } })).status, 403);
  const dispatched = await okJson(await post("/api/loading/dispatch", { ...placement, cartBarcode: measured.masterBarcode }));
  assert.equal(dispatched.cart.dispatchedBy, "Logistics operator");
  const replay = await okJson(await post("/api/loading/dispatch", { ...placement, cartBarcode: line.cartBarcode }));
  assert.equal(replay.alreadyDispatched, true);
  assert.equal(replay.cart.dispatchedAt, dispatched.cart.dispatchedAt);
  const final = await inventory();
  const finalItem = final.items.find((item) => item.id === selected.inventory.id);
  assert.equal(finalItem.fulfillmentStage, "dispatched");
  assert.equal(finalItem.loadedQuantity, measured.quantity);
  assert.equal(finalItem.dispatchedQuantity, measured.quantity);
  assert.equal(final.items.find((item) => item.supplierId === "SUP-B").fulfillmentStage, "expected");
  assert.equal(final.summary.containers, 0);
  const exported = await request("/api/inventory/export", { cookie: cookies.viewer });
  assert.equal(exported.status, 200);
  const workbook = XLSX.read(await exported.text(), { type: "string", raw: true });
  const records = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { raw: true });
  const csvItem = records.find((item) => item["Inventory ID"] === selected.inventory.id);
  assert.equal(Number(csvItem["Loaded Quantity"]), finalItem.loadedQuantity);
  assert.equal(Number(csvItem["Dispatched Quantity"]), finalItem.dispatchedQuantity);
  assert.equal(csvItem["Loaded At"], finalItem.loadedAt);
  assert.equal(csvItem["Dispatched At"], finalItem.dispatchedAt);
  await okJson(await post("/api/locks", { ...context, action: "release" }));
  const refresh = await okJson(await post("/api/import", { fileName: "logistics-http-refresh.csv", rows: [measured] }, "supervisor"));
  assert.equal(refresh.reconciliation.preserved, 1);
  const refreshed = (await okJson(await request("/api/state", { cookie: cookies.viewer }))).lines[0];
  assert.equal(refreshed.id, line.id);
  assert.equal(refreshed.inventoryItemId, selected.inventory.id);
  assert.equal(refreshed.dispatchedAt, dispatched.cart.dispatchedAt);
  const conflict = await post("/api/import", { fileName: "changed.csv", rows: [{ ...measured, quantity: 2 }] }, "supervisor");
  assert.equal(conflict.status, 409);
  const issue = await conflict.json();
  assert.equal(issue.code, "reconciliation_required");
  assert.ok(issue.issues.some((item) => item.reason === "worked_line_changed" && item.fields.includes("quantity")));
  assert.equal((await okJson(await request("/api/state", { cookie: cookies.viewer }))).lines[0].quantity, measured.quantity);
});
