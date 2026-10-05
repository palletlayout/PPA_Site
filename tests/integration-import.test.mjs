import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cleanIdempotencyKey, demandContentHash } from "../lib/integration-import.ts";
import { validateImportRows } from "../lib/import-validation.ts";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

const row = {
  plant: "01", zone: "R", areaType: "onsite", shipCategory: "AA", loadNumber: "",
  trainNumber: "TE309771", picklistNumber: "PL-1", cartNumber: "1", cartId: "CART-1",
  palletId: "PAL-1", sequence: "1", partNumber: "PART-1", description: "Part",
  color: "BLUE", quantity: 30, aiagSerial: "SERIAL-1",
};

test("builds a deterministic content identity from normalized demand", async () => {
  const first = await demandContentHash([row]);
  const replay = await demandContentHash([{ ...row }]);
  const changed = await demandContentHash([{ ...row, quantity: 31 }]);

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(replay, first);
  assert.notEqual(changed, first);
});

test("accepts bounded printable idempotency keys", () => {
  assert.equal(cleanIdempotencyKey("  feed-2026-08-15-am  "), "feed-2026-08-15-am");
  assert.throws(() => cleanIdempotencyKey("x".repeat(181)), /180 printable characters/);
  assert.throws(() => cleanIdempotencyKey("feed\nkey"), /180 printable characters/);
});

test("empty new lot metadata preserves integration receipt hashes created before the schema upgrade", async () => {
  const rows = validateImportRows([{ ...row, masterBarcode: "MASTER-1", movementBarcode: "MOVE-1" }]);
  const fields = ["containerSequence", "fromModel", "fromType", "fromOption", "fromColor", "fromInteriorColor", "fromUnits", "toModel", "toType", "toOption", "toColor", "toInteriorColor", "toUnits"];
  const legacyRows = rows.map((value) => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key))));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(legacyRows)));
  const legacyHash = Buffer.from(digest).toString("hex");
  assert.equal(await demandContentHash(rows), legacyHash);
  assert.equal(await demandContentHash(legacyRows), legacyHash);
  for (const field of fields) {
    assert.notEqual(await demandContentHash([{ ...rows[0], [field]: "001" }]), legacyHash, `${field} remains part of content identity when supplied`);
  }
});

test("persists integration claims and coordinates them with live picklist leases", async () => {
  const [schema, store, route, activation] = await Promise.all([
    source("../db/schema.ts"),
    source("../db/cart-store.ts"),
    source("../app/api/integrations/demand/route.ts"),
    source("../db/import-activation.ts"),
  ]);

  assert.match(schema, /pgTable\("integration_imports"/);
  assert.match(schema, /integration_imports_source_content_idx/);
  assert.match(schema, /integration_imports_source_key_idx/);
  assert.match(schema, /integration_imports_one_processing_idx/);
  assert.match(store, /INSERT INTO integration_imports[\s\S]*?WHERE NOT EXISTS \(\s*SELECT 1 FROM integration_imports WHERE status = 'processing' AND expires_at > \?\s*\)/);
  assert.match(store, /INSERT INTO integration_imports[\s\S]*?ON CONFLICT DO NOTHING/);
  assert.match(store, /Another automated demand activation is already in progress/);
  assert.match(store, /INSERT INTO cart_locks[\s\S]*?AND NOT EXISTS \(\s*SELECT 1 FROM integration_imports WHERE status = 'processing' AND expires_at > \?\s*\)/);
  assert.match(store, /idempotentReplay: true/);
  assert.match(store, /integrationReceiptBatchIsActive/);
  assert.match(store, /same content is a[\s\S]*legitimate new snapshot/);
  assert.match(store, /DELETE FROM integration_imports WHERE batch_id = \? AND idempotency_key = ''/);
  assert.match(store, /activateReconciledImport\(db/);
  assert.match(activation, /new Date\(Date\.parse\(now\) \+ 56 \* 60 \* 60_000\)/);
  assert.match(activation, /status = 'processing' AND expires_at > \$\{currentTime\}/);
  assert.match(activation, /affectedPicklists/);
  assert.match(activation, /picklist_key = \? OR cart_key = \?/);
  assert.match(store, /SELECT 1 FROM integration_imports WHERE status = 'processing' AND expires_at > \?/);
  assert.match(route, /request\.headers\.get\("idempotency-key"\)/);
  assert.match(route, /process\.env\.CARTFLOW_INGEST_TOKEN/);
  assert.match(route, /error instanceof IntegrationImportError/);
});
