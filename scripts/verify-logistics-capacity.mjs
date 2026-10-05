#!/usr/bin/env node
/** Disposable local acceptance workload. Never connects to a configured database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log("Usage: node --experimental-strip-types scripts/verify-logistics-capacity.mjs --local-sqlite [--lines 5000] [--picklists 1000] [--containers 5000] [--concurrency 4] [--max-seconds 900]\nCreates and deletes a fresh temporary SQLite database. Prints a JSON result. This is not a remote Postgres, HTTP, scanner-device, or live production benchmark.");
  process.exit(0);
}
if (!argv.includes("--local-sqlite")) throw new Error("Pass --local-sqlite to run the disposable local workload. Existing databases are never used.");
const options = new Map();
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === "--local-sqlite") continue;
  if (!["--lines", "--picklists", "--containers", "--concurrency", "--max-seconds"].includes(argv[index])) throw new Error(`Unknown option ${argv[index]}`);
  const value = Number(argv[++index]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Provide a positive whole number after ${argv[index - 1]}.`);
  options.set(argv[index - 1], value);
}
const lineCount = options.get("--lines") || 5000;
const picklistCount = options.get("--picklists") || Math.ceil(lineCount / 5);
const containerCount = options.get("--containers") || lineCount;
const concurrency = options.get("--concurrency") || 4;
const maxSeconds = options.get("--max-seconds") || 900;
assert.ok(lineCount >= 2 && lineCount <= 10_000, "Use 2–10,000 demand lines.");
assert.ok(picklistCount >= 2 && picklistCount <= lineCount, "Use 2–lineCount picklists.");
assert.ok(containerCount >= lineCount && containerCount <= 20_000, "Use lineCount–20,000 containers.");
assert.ok(concurrency <= 8, "Concurrency is capped at eight local stations.");
assert.ok(maxSeconds <= 3600, "Workload duration is capped at one hour.");

const directory = await mkdtemp(join(tmpdir(), "ppa-capacity-acceptance-"));
// Set isolation before importing any application module with a database singleton.
for (const key of ["DATABASE_URL", "POSTGRES_URL", "VERCEL"]) delete process.env[key];
process.env.CARTFLOW_DATABASE_PATH = join(directory, "disposable.sqlite");
const started = performance.now();
const timings = new Map();
const report = {
  ok: false, database: "disposable_local_sqlite", concurrency,
  requested: { demandLines: lineCount, picklists: picklistCount, containers: containerCount },
  limitations: ["Single local process with bounded concurrent API calls", "No HTTP/network, Neon Postgres, or physical scanner timing", "Fresh synthetic data; no claim of production throughput"],
};
let db;
const deadline = () => {
  if (performance.now() - started > maxSeconds * 1000) throw new Error(`Disposable workload exceeded ${maxSeconds} seconds.`);
};
async function measure(name, operation) {
  deadline();
  const before = performance.now();
  try { return await operation(); }
  finally {
    const values = timings.get(name) || [];
    values.push(performance.now() - before);
    timings.set(name, values);
  }
}
async function bounded(items, work) {
  let cursor = 0;
  let failure;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async (_, station) => {
    for (;;) {
      if (failure) return;
      const index = cursor++;
      if (index >= items.length) return;
      try { deadline(); await work(items[index], index, station); }
      catch (error) { failure = error; throw error; }
    }
  }));
  const rejected = workers.find((worker) => worker.status === "rejected");
  if (rejected) throw rejected.reason;
}
function checkState(state) {
  assert.equal(state.lines.length, lineCount);
  for (const line of state.lines) {
    const allocated = line.allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
    assert.equal(allocated, line.fulfilledQuantity, `Snapshot ledger disagrees for ${line.id}`);
    assert.equal(line.remainingQuantity, line.quantity - allocated);
    if (line.status === "verified") assert.equal(allocated, line.quantity);
    if (line.status === "pending") assert.equal(allocated, 0);
  }
}
const phase = (name, counts = {}) => process.stderr.write(`${JSON.stringify({ phase: name, ...counts })}\n`);
try {
  const store = await import("../db/cart-store.ts");
  db = await measure("initialize", () => store.ensureDatabase());
  assert.equal(db.dialect, "sqlite");
  await store.updateFulfillmentSettings({ packingMode: "multiple", inventoryMode: "scan" }, { id: "capacity-admin", name: "Capacity test" });
  const groups = Array.from({ length: picklistCount }, () => []);
  const rows = Array.from({ length: lineCount }, (_, index) => {
    const group = index % picklistCount;
    const sequence = Math.floor(index / picklistCount);
    groups[group].push(index);
    return {
      plant: "CAPACITY", areaType: "onsite", trainNumber: `TRAIN-${group % 10}`, loadNumber: "", zone: "QA", shipCategory: "Production",
      picklistNumber: `PICK-${group}`, cartNumber: String(group), cartId: `CART-${group}`, palletId: `PALLET-${group}`,
      masterBarcode: `CAP-MASTER-${group}`, movementBarcode: `CAP-MOVE-${group % 10}`, sequence: String(sequence).padStart(5, "0"),
      sourceLineId: `CAP-LINE-${index}`, sourceScope: "disposable-capacity-test", partNumber: `PART-${sequence}`, description: "Disposable capacity verification",
      color: "", quantity: 1, aiagSerial: "",
    };
  });
  phase("import", { lines: lineCount, picklists: picklistCount });
  await measure("demand_import", () => store.replaceImport("disposable-capacity.csv", rows));
  phase("receive", { containers: containerCount });
  await bounded(Array.from({ length: containerCount }, (_, index) => index), async (index) => {
    const row = rows[index % rows.length];
    const received = await measure("receive_container", () => store.receiveInventoryFromPhysicalLabel({
      captureId: randomUUID(), receiptSessionId: randomUUID(),
      rawValues: [`1SCAP-STOCK-${index}`, `P${row.partNumber}`, `Q${index === 0 ? 2 : 1}`],
      operatorName: "Capacity receiver", operatorId: "capacity-receiver",
    }));
    assert.equal(received.ok, true);
  });
  const initial = await measure("state_snapshot", () => store.getAppState());
  checkState(initial);
  const bySource = new Map(initial.lines.map((line) => [line.sourceLineId, line]));
  let completedPicklists = 0;
  let replayCount = 0;
  let snapshotChecks = 1;
  let loadedPicklists = 0;
  let dispatchedPicklists = 0;
  const sampleEvery = Math.max(1, Math.floor(picklistCount / 20));
  phase("pack", { stations: concurrency, sharedContainer: "CAP-STOCK-0", sharedDemandLines: [0, 1] });
  await bounded(groups, async (indices, group, station) => {
    const first = bySource.get(`CAP-LINE-${indices[0]}`);
    const context = {
      cartKey: [first.plant, first.areaType, first.trainNumber, first.picklistNumber, first.cartNumber, first.cartId].join("::"),
      sessionId: `capacity-station-${station}`, operatorName: `Capacity station ${station}`, operatorId: `capacity-operator-${station}`,
    };
    const lock = await measure("acquire_picklist", () => store.manageLock({ ...context, action: "acquire" }));
    assert.equal(lock.locked, true);
    const scan = await measure("scan_card", () => store.recordScan({ ...context, lineId: first.id, field: "cartBarcode", value: first.cartBarcode }));
    assert.equal(scan.matched, true);
    for (const index of indices) {
      const line = bySource.get(`CAP-LINE-${index}`);
      // Two independent stations intentionally share one two-unit container.
      const serialIndex = index === 1 ? 0 : index;
      const request = { ...context, serial: `1SCAP-STOCK-${serialIndex}`, serialFormat: "barcode", requestId: randomUUID() };
      const shouldReplay = index === indices[0] && group % sampleEvery === 0;
      const attempts = await Promise.allSettled([
        measure("fulfill_line", () => store.fulfillDemand(request)),
        ...(shouldReplay ? [measure("replay_fulfillment", () => store.fulfillDemand(request))] : []),
      ]);
      const failed = attempts.find((attempt) => attempt.status === "rejected");
      if (failed) throw failed.reason;
      const [result, replay] = attempts.map((attempt) => attempt.value);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.verified, true);
      assert.equal(result.lineId, line.id);
      if (replay) {
        assert.equal(replay.ok, true, JSON.stringify(replay));
        assert.equal(replay.lineId, line.id);
        assert.equal(Number(Boolean(result.alreadyFulfilled)) + Number(Boolean(replay.alreadyFulfilled)), 1);
        replayCount++;
      }
    }
    assert.equal((await measure("release_picklist", () => store.manageLock({ ...context, action: "release" }))).released, true);
    if (group % sampleEvery === 0) {
      const movement = { cartBarcode: first.cartBarcode, movementValue: first.trainNumber, operatorName: "Capacity loader", operatorId: "capacity-loader" };
      assert.equal((await measure("confirm_loading", () => store.confirmCartLoading(movement))).ok, true);
      loadedPicklists++;
      assert.equal((await measure("confirm_dispatch", () => store.confirmPicklistDispatch(movement))).ok, true);
      dispatchedPicklists++;
      const snapshot = await measure("state_snapshot", () => store.getAppState());
      checkState(snapshot);
      snapshotChecks++;
    }
    completedPicklists++;
    if (completedPicklists % Math.max(1, Math.floor(picklistCount / 5)) === 0) phase("packing_progress", { completedPicklists, totalPicklists: picklistCount });
  });
  phase("reconcile_snapshots_and_exports");
  const state = await measure("state_snapshot", () => store.getAppState());
  checkState(state); snapshotChecks++;
  assert.ok(state.lines.every((line) => line.status === "verified" && line.fulfilledQuantity === 1));
  assert.equal(state.locks.length, 0);
  const audit = await measure("scanned_demand_export", () => store.getScannedDemandExport("active"));
  const inventory = await measure("inventory_export", () => store.getInventoryExport());
  assert.equal(inventory.length, containerCount);
  const lineById = new Map(state.lines.map((line) => [line.id, line]));
  assert.equal(new Set(audit.map((row) => row.line_id)).size, lineCount);
  for (const row of audit) {
    const line = lineById.get(row.line_id);
    assert.equal(row.status, line.status);
    assert.equal(Number(row.fulfilled_quantity), line.fulfilledQuantity);
    const allocations = JSON.parse(row.allocations_json);
    assert.deepEqual(allocations.map((allocation) => allocation.id), line.allocations.map((allocation) => allocation.id));
  }
  const allocatedByInventory = new Map();
  for (const line of state.lines) for (const allocation of line.allocations) allocatedByInventory.set(allocation.inventoryItemId, (allocatedByInventory.get(allocation.inventoryItemId) || 0) + allocation.quantity);
  for (const item of inventory) {
    assert.equal(item.consumedQuantity, allocatedByInventory.get(item.id) || 0);
    assert.equal(item.remainingQuantity, item.quantity - item.consumedQuantity);
  }
  const shared = inventory.find((item) => item.serial === "CAP-STOCK-0");
  assert.equal(shared.consumedQuantity, 2);
  assert.equal(shared.fulfilledDemandIds.length, 2);
  assert.equal(inventory.find((item) => item.serial === "CAP-STOCK-1").consumedQuantity, 0);
  report.ok = true;
  report.verified = {
    demandLines: state.lines.length, picklists: completedPicklists, containers: inventory.length,
    allocatedQuantity: [...allocatedByInventory.values()].reduce((sum, value) => sum + value, 0),
    remainingQuantity: inventory.reduce((sum, item) => sum + item.remainingQuantity, 0),
    sharedContainerDemandLines: shared.fulfilledDemandIds.length, replayChecks: replayCount, snapshotChecks,
    loadedPicklists, dispatchedPicklists, exportRows: audit.length,
  };
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  db?.close();
  await rm(directory, { recursive: true, force: true });
  report.cleanedUp = true;
  report.elapsedMs = Math.round(performance.now() - started);
  report.rssBytes = process.memoryUsage().rss;
  report.latencyMs = Object.fromEntries([...timings].map(([name, values]) => {
    const sorted = [...values].sort((left, right) => left - right);
    const percentile = (percent) => Number(sorted[Math.max(0, Math.ceil(sorted.length * percent / 100) - 1)].toFixed(3));
    return [name, { count: sorted.length, p50: percentile(50), p95: percentile(95), p99: percentile(99), max: Number(sorted.at(-1).toFixed(3)) }];
  }));
  console.log(JSON.stringify(report, null, 2));
}
