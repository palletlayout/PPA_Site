import assert from "node:assert/strict";
import test from "node:test";
import { toPostgresQuery } from "../db/index.ts";

test("converts D1-style placeholders without changing quoted question marks", () => {
  assert.equal(
    toPostgresQuery("SELECT '?' AS literal, value FROM scans WHERE id = ? AND note = 'it''s ?'"),
    "SELECT '?' AS literal, value FROM scans WHERE id = $1 AND note = 'it''s ?'",
  );
});

test("makes legacy additive schema upgrades safe across serverless cold starts", () => {
  assert.equal(
    toPostgresQuery("ALTER TABLE scans ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0"),
    "ALTER TABLE scans ADD COLUMN IF NOT EXISTS is_test INTEGER NOT NULL DEFAULT 0",
  );
  assert.equal(
    toPostgresQuery("ALTER TABLE scans ADD COLUMN IF NOT EXISTS session_id TEXT"),
    "ALTER TABLE scans ADD COLUMN IF NOT EXISTS session_id TEXT",
  );
});
