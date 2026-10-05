import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitRawScans, validateRawScan } from '../lib/raw-capture.ts';

test('raw intake preserves barcode prefixes, duplicates, spaces, unknown formats and line order', () => {
  assert.deepEqual(splitRawScans('AE3TP327074XRGS\r\nQ15\nQ15\r arbitrary data \n'), ['AE3TP327074XRGS','Q15','Q15',' arbitrary data ']);
  const base = { id: randomUUID(), sessionId: randomUUID(), position: 1, rawValue: '  ]C1Ppart\u001dDATA  ', scannedAt: new Date().toISOString() };
  assert.deepEqual(validateRawScan(base), base);
  for (const changes of [{ rawValue: 'Q1\nQ2' }, { rawValue: '' }, { rawValue: 'x'.repeat(4097) }, { position: 0 }, { id: 'wrong' }, { scannedAt: 'wrong' }]) {
    assert.throws(() => validateRawScan({ ...base, ...changes }));
  }
});

test('capture storage persists ordered duplicates, safely retries, isolates operators and changes no operational tables', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ppa-raw-capture-'));
  process.env.DATABASE_URL = '';
  process.env.POSTGRES_URL = '';
  process.env.VERCEL = '';
  process.env.CARTFLOW_DATABASE_PATH = join(directory, 'capture.sqlite');
  const { getDatabase, Database } = await import('../db/index.ts');
  const { saveRawScan, listRawScans, listRawCaptureSessions } = await import('../db/raw-capture.ts');
  t.after(async () => { getDatabase().close(); await rm(directory, { recursive: true, force: true }); });
  const actor = { id: 'operator-a', name: 'Operator A' };
  const sessionId = randomUUID();
  const first = { id: randomUUID(), sessionId, position: 1, rawValue: 'Q15', scannedAt: new Date().toISOString() };
  const second = { ...first, id: randomUUID(), position: 2 };
  await Promise.all([saveRawScan(second, actor), saveRawScan(first, actor)]);
  await saveRawScan(first, actor);
  await assert.rejects(saveRawScan({ ...first, rawValue: 'Q99' }, actor), { status: 409 });
  await assert.rejects(saveRawScan({ ...first, id: randomUUID() }, actor), { status: 409 });
  await assert.rejects(saveRawScan(first, { id: 'operator-b', name: 'B' }), { status: 409 });
  const saved = await listRawScans(sessionId, actor.id);
  assert.deepEqual(saved.map(r => [r.position,r.rawValue]), [[1,'Q15'],[2,'Q15']]);
  assert.deepEqual(await listRawScans(sessionId, 'operator-b'), []);
  assert.deepEqual(await listRawCaptureSessions('operator-b'), []);
  assert.equal((await listRawCaptureSessions())[0].count, 2);
  const reopened = new Database({ sqlitePath: process.env.CARTFLOW_DATABASE_PATH });
  assert.equal((await reopened.prepare('SELECT COUNT(*) AS count FROM raw_capture_scans').first()).count, 2);
  const tables = await reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  assert.deepEqual(tables.results.map(r => r.name), ['raw_capture_scans']);
  reopened.close();
});
