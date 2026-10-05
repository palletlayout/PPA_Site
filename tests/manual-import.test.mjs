import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the import route keeps replacement as the default and accepts one-row append requests", async () => {
  const route = await source("../app/api/import/route.ts");

  assert.match(route, /appendImportRow/);
  assert.match(route, /action !== "replace" && action !== "append"/);
  assert.match(route, /action === "append" && body\.rows\.length !== 1/);
  assert.match(route, /manual append must contain exactly one demand row/i);
  assert.match(route, /action === "append"[\s\S]*appendImportRow\([\s\S]*rows\[0\]/);
  assert.match(route, /replaceImport\(clean\(body\.fileName\) \|\| "pick-list\.xlsx", rows, undefined, access\.principal, \{ allowShrink: body\.allowShrink \}\)/);
  assert.match(route, /error instanceof SnapshotShrinkError/);
  assert.match(route, /error instanceof IntegrationImportError \|\| error instanceof DemandAppendError/);
  assert.match(route, /error instanceof DemandReconciliationError/);
  assert.match(route, /issues: error\.issues/);
});

test("manual row append is scoped to the target picklist and preserves the active batch", async () => {
  const store = await source("../db/cart-store.ts");
  const start = store.indexOf("export async function appendImportRow");
  const end = store.indexOf("async function findIntegrationReceipt", start);
  assert.ok(start >= 0 && end > start);
  const append = store.slice(start, end);

  assert.match(append, /validatedImportRows\(\[inputRow\]\)/);
  assert.match(append, /if \(!initialBatch\)[\s\S]*replaceImport\(fileName, \[row\](?:,|\))/);
  assert.match(append, /acquireDemandAppendLock\(db, row\)/);
  assert.match(store, /SELECT 1 FROM cart_locks WHERE picklist_key = \? AND expires_at > \?/);
  assert.match(store, /DELETE FROM cart_locks WHERE cart_key = \? AND session_id = \?/);
  assert.doesNotMatch(append, /DELETE FROM cart_locks(?! WHERE cart_key)/);
  assert.doesNotMatch(append, /UPDATE import_batches SET is_active = 0/);
  assert.match(append, /Sequence \$\{row\.sequence\} already exists for cart/);
  assert.match(append, /already has verified demand and cannot accept another row/);
  assert.match(append, /APPEND_CART_LEVEL_FIELDS/);
  assert.match(append, /APPEND_LOAD_LEVEL_FIELDS/);
  assert.match(append, /UPDATE import_batches SET row_count = row_count \+ 1/);
  assert.match(append, /createdCart: !existingCart/);
  assert.match(append, /finally \{\s*await releaseDemandAppendLock\(db, appendLock\)/);
});
