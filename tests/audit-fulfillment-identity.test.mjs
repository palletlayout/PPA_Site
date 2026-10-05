import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAuditReport, inspectAllocation, readAllocationPage } from "../scripts/audit-fulfillment-identity.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/audit-fulfillment-identity.mjs", import.meta.url));
const legacy = (serial, supplier = "", line = "") => JSON.stringify(["cart", line, serial, supplier, null]);
const v2 = (serial, supplier = null, line = "") => JSON.stringify([2, "cart", line, serial, supplier, null]);
const row = (id, fingerprint, serial = "ABC", patch = {}) => ({
  allocation_id: id, request_id: `request-${id}`, request_fingerprint: fingerprint,
  demand_detail_id: "demand-1", inventory_item_id: `inventory-${id}`,
  allocation_serial: serial, packed_at: "2026-09-26T12:00:00.000Z", reversed_at: null,
  stored_inventory_id: `inventory-${id}`, inventory_serial: serial, inventory_supplier_id: "SUP-A", is_test: 0,
  ...patch,
});
const fixtures = [
  row("01", legacy("ABC")),
  row("02", legacy("1SABC")),
  row("03", legacy("1SABC"), "1SABC"),
  row("04", legacy("1S1SABC"), "1SABC"),
  row("05", v2("1SABC"), "1SABC"),
  row("06", v2("ABC"), "1SABC"),
  row("07", v2("ABC", "SUP-B")),
  row("08", "legacy"),
  row("09", "invalid fingerprint"),
  row("10", v2("ABC", null, "another-line"), "ABC", { reversed_at: "2026-09-26T13:00:00.000Z", is_test: 1 }),
  row("11", v2("ABC"), "ABC", { stored_inventory_id: null, inventory_serial: null, inventory_supplier_id: null, is_test: null }),
  row("12", legacy("DIFFERENT")),
];
const cleanEnv = { ...process.env, DATABASE_URL: "", POSTGRES_URL: "", CARTFLOW_DATABASE_PATH: "" };
const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

function createFixture(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE inventory_items (id TEXT PRIMARY KEY, normalized_serial TEXT, supplier_id TEXT, is_test INTEGER);
      CREATE TABLE fulfillment_allocations (id TEXT PRIMARY KEY, request_id TEXT, request_fingerprint TEXT,
        demand_detail_id TEXT, inventory_item_id TEXT, serial TEXT, packed_at TEXT, reversed_at TEXT);`);
    for (const item of fixtures) {
      if (item.stored_inventory_id) db.prepare("INSERT INTO inventory_items VALUES (?, ?, ?, ?)")
        .run(item.stored_inventory_id, item.inventory_serial, item.inventory_supplier_id, item.is_test);
      db.prepare("INSERT INTO fulfillment_allocations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(item.allocation_id, item.request_id, item.request_fingerprint, item.demand_detail_id,
          item.inventory_item_id, item.allocation_serial, item.packed_at, item.reversed_at);
    }
  } finally { db.close(); }
}

test("legacy serial ambiguity is review evidence while typed identity differences are mismatches", () => {
  for (const index of [0, 1, 3, 4]) assert.equal(inspectAllocation(fixtures[index]), null);
  const uncertain = inspectAllocation(fixtures[2]);
  assert.equal(uncertain.classification, "REVIEW");
  assert.deepEqual(uncertain.reasons, ["legacy_serial_format_ambiguous"]);
  assert.equal(uncertain.requestedSerial, "1SABC");
  assert.equal(uncertain.barcodeInterpretation, "ABC");
  assert.equal(uncertain.inventorySerial, "1SABC");
  assert.equal(inspectAllocation(fixtures[5]).classification, "MISMATCH");
  assert.deepEqual(inspectAllocation(fixtures[5]).reasons, ["canonical_serial_mismatch"]);
  assert.deepEqual(inspectAllocation(fixtures[6]).reasons, ["specified_supplier_mismatch"]);
  assert.equal(inspectAllocation(fixtures[7]).classification, "REVIEW");
  assert.equal(inspectAllocation(fixtures[8]).classification, "REVIEW");
  const reversed = inspectAllocation(fixtures[9]);
  assert.equal(reversed.classification, "MISMATCH");
  assert.equal(reversed.isTest, true);
  assert.ok(reversed.reversedAt);
  assert.deepEqual(reversed.reasons, ["specified_demand_line_mismatch"]);
  assert.deepEqual(inspectAllocation(fixtures[10]).reasons, ["inventory_record_missing"]);
  assert.equal(inspectAllocation(fixtures[11]).classification, "REVIEW");
});

test("standalone SQLite audit is bounded, includes reversed history, and changes no database bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-identity-audit-"));
  const path = join(directory, "existing.sqlite");
  try {
    createFixture(path);
    const before = await digest(path);
    const options = { cwd: directory, env: { ...cleanEnv, DATABASE_URL: "postgresql://user:hidden-secret@invalid/database" } };
    const { stdout, stderr } = await exec(process.execPath, [script, path], options);
    const report = JSON.parse(stdout);
    assert.equal(report.readOnly, true);
    assert.equal(report.backend, "sqlite");
    assert.equal(report.checkedAllocations, 12);
    assert.equal(report.reviewCount, 4);
    assert.equal(report.mismatchCount, 4);
    assert.equal(report.noFindingCount, 4);
    assert.equal(report.truncated, false);
    assert.equal(report.nextAfter, null);
    assert.doesNotMatch(stdout + stderr, /hidden-secret|postgresql:\/\//);
    assert.equal(await digest(path), before);

    const first = JSON.parse((await exec(process.execPath, [script, path, "--limit", "5"], options)).stdout);
    assert.equal(first.checkedAllocations, 5);
    assert.equal(first.truncated, true);
    assert.equal(first.nextAfter, "05");
    const next = JSON.parse((await exec(process.execPath, [script, path, "--limit", "5", "--after", first.nextAfter], options)).stdout);
    assert.equal(next.checkedAllocations, 5);
    assert.equal(next.nextAfter, "10");
    assert.deepEqual(next.findings.map((item) => item.allocationId), ["06", "07", "08", "09", "10"]);
    const last = JSON.parse((await exec(process.execPath, [script, path, "--limit", "5", "--after", next.nextAfter], options)).stdout);
    assert.equal(last.checkedAllocations, 2);
    assert.equal(last.truncated, false);
    assert.equal(await digest(path), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing schema or database never triggers initialization and errors omit connection details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-identity-audit-missing-"));
  try {
    const path = join(directory, "old.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE untouched (value TEXT)"); db.close();
    const before = await digest(path);
    await assert.rejects(exec(process.execPath, [script, path], { cwd: directory, env: cleanEnv }), (error) => {
      const failure = JSON.parse(error.stderr.trim());
      assert.match(failure.error, /No initialization, migration, or repair was attempted/);
      return true;
    });
    assert.equal(await digest(path), before);
    const readonly = new DatabaseSync(path, { readOnly: true });
    try { assert.deepEqual(readonly.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((item) => item.name), ["untouched"]); }
    finally { readonly.close(); }
    const missing = join(directory, "not-created.sqlite");
    await assert.rejects(exec(process.execPath, [script, missing], { cwd: directory, env: cleanEnv }));
    await assert.rejects(access(missing));
    await assert.rejects(exec(process.execPath, [script], { cwd: directory, env: cleanEnv }), /Specify an existing SQLite path/);
    await assert.rejects(exec(process.execPath, [script, path, "--limit", "100001"], { cwd: directory, env: cleanEnv }), /Usage/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Postgres auditing sends one bounded direct SELECT without initialization or credentials in its report", async () => {
  const calls = [];
  const rows = await readAllocationPage({ postgresUrl: "postgresql://user:must-not-print@host/db", after: "05", limit: 2,
    neonFactory: (url) => {
      assert.equal(url, "postgresql://user:must-not-print@host/db");
      return { query: async (query, values) => { calls.push({ query, values }); return fixtures.slice(5, 8); } };
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /^SELECT\s/);
  assert.doesNotMatch(calls[0].query, /\b(?:UPDATE|INSERT|DELETE|CREATE|ALTER|DROP|PRAGMA|BEGIN|COMMIT)\b/i);
  assert.match(calls[0].query, /WHERE a\.id > \$1 ORDER BY a\.id LIMIT \$2$/);
  assert.deepEqual(calls[0].values, ["05", 3]);
  const report = buildAuditReport(rows, { backend: "postgres", limit: 2 });
  assert.equal(report.checkedAllocations, 2);
  assert.equal(report.truncated, true);
  assert.equal(report.nextAfter, "07");
  assert.doesNotMatch(JSON.stringify(report), /must-not-print|postgresql:\/\//);
});
