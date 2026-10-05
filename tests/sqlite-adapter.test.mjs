import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "../db/index.ts";

test("local SQLite adapter persists bound values and rolls back failed batches", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cartflow-sqlite-test-"));
  const databasePath = join(temporaryRoot, "nested", "cartflow.sqlite");
  const db = new Database({ sqlitePath: databasePath });
  t.after(async () => {
    db.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await stat(databasePath);
  await db.prepare(`CREATE TABLE records (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    note TEXT
  )`).run();

  const inserted = await db.prepare("INSERT INTO records (id, enabled, note) VALUES (?, ?, ?)")
    .bind("a", true, undefined).run();
  assert.equal(inserted.meta.changes, 1);
  const row = await db.prepare("SELECT id, enabled, note FROM records WHERE id = ?").bind("a").first();
  assert.equal(row?.id, "a");
  assert.equal(row?.enabled, 1);
  assert.equal(row?.note, null);

  await assert.rejects(
    db.batch([
      db.prepare("INSERT INTO records (id, enabled, note) VALUES (?, ?, ?)").bind("b", false, "pending"),
      db.prepare("INSERT INTO records (id, enabled, note) VALUES (?, ?, ?)").bind("a", false, "duplicate"),
    ]),
    /UNIQUE constraint failed/,
  );
  const count = await db.prepare("SELECT COUNT(*) AS count FROM records").first();
  assert.equal(count?.count, 1);
});
