import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('SQLite backup includes committed WAL data, verifies integrity, restores separately and never overwrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartflow-backup-'));
  const source = join(dir, 'live.sqlite'); const snapshot = join(dir, 'snapshot.sqlite');
  const live = new DatabaseSync(source);
  try {
    live.exec('PRAGMA journal_mode=WAL; CREATE TABLE evidence (id TEXT PRIMARY KEY, value TEXT NOT NULL);');
    live.prepare('INSERT INTO evidence VALUES (?, ?)').run('scan-1', 'verified');
    const args = ['scripts/backup-sqlite.mjs', source, snapshot];
    const options = { cwd: new URL('..', import.meta.url), env: { ...process.env, DATABASE_URL: '', POSTGRES_URL: '' } };
    const { stdout } = await exec(process.execPath, args, options); assert.match(stdout, /Verified SQLite snapshot/);
    live.prepare('INSERT INTO evidence VALUES (?, ?)').run('scan-2', 'later');
    await assert.rejects(exec(process.execPath, args, options), /already exists/);
    const restoredPath = join(dir, 'restored.sqlite'); await copyFile(snapshot, restoredPath);
    const restored = new DatabaseSync(restoredPath);
    try { assert.deepEqual(restored.prepare('SELECT * FROM evidence').all().map(row => ({ ...row })), [{ id: 'scan-1', value: 'verified' }]); }
    finally { restored.close(); }
    assert.equal(live.prepare('SELECT COUNT(*) AS count FROM evidence').get().count, 2);
  } finally { live.close(); await rm(dir, { recursive: true, force: true }); }
});
