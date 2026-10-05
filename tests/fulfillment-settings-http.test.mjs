import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from '../lib/auth.ts';

test('configured fulfillment HTTP lifecycle preserves quantities, permissions and reversals', { timeout: 90000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ppa-fulfillment-http-'));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const password = 'Disposable-fulfillment-test-password';
  const passwordHash = await hashPassword(password);
  let logs = '';
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: '', POSTGRES_URL: '', VERCEL: '', CARTFLOW_DATABASE_PATH: join(directory, 'test.sqlite'),
      CARTFLOW_AUTH_MODE: 'credentials', CARTFLOW_APP_ORIGIN: origin, CARTFLOW_AUTH_SECRET: 'only-for-disposable-fulfillment-http-test-2026',
      CARTFLOW_AUTH_USERS: JSON.stringify(['viewer', 'operator', 'supervisor'].map((role) => ({ id: role, username: role, name: role, role, passwordHash }))) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (value) => { logs = (logs + value).slice(-6000); });
  t.after(async () => {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(4000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Test server stopped: ${logs}`);
    try { await fetch(`${origin}/api/auth/session`, { signal: AbortSignal.timeout(500) }); break; }
    catch { if (attempt === 149) throw new Error(`Test server unavailable: ${logs}`); await delay(100); }
  }
  const cookies = {};
  const request = async (path, method = 'GET', body, role = 'supervisor') => fetch(`${origin}${path}`, {
    method, headers: { Origin: origin, Cookie: cookies[role] || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  const ok = async (path, method, body, role) => {
    const response = await request(path, method, body, role);
    assert.ok(response.ok, `${path} (${response.status}): ${await response.clone().text()}`);
    return response.json();
  };
  for (const role of ['viewer', 'operator', 'supervisor']) {
    const response = await request('/api/auth/login', 'POST', { username: role, password });
    assert.equal(response.status, 200);
    cookies[role] = response.headers.get('set-cookie').split(';')[0];
  }
  const settings = { packingMode: 'multiple', inventoryMode: 'scan', partAttribute: 'color' };
  assert.equal((await request('/api/settings', 'PATCH', settings, 'operator')).status, 403);
  assert.equal((await request('/api/settings', 'PATCH', { ...settings, packingMode: 'unknown' })).status, 400);
  assert.deepEqual((await ok('/api/settings', 'PATCH', { ...settings, partAttribute: 'part_level' })).settings, settings);
  assert.deepEqual((await ok('/api/state')).settings, settings);
  assert.equal((await request('/api/settings', 'PATCH', { ...settings, partAttribute: 'invalid' })).status, 400);
  assert.deepEqual((await ok('/api/settings', 'PATCH', { packingMode: 'multiple', inventoryMode: 'scan' })).settings, settings, 'older clients use optional color');

  const row = { plant: 'HTTP', areaType: 'offsite', shipCategory: 'A', zone: 'Z', loadNumber: 'LOAD-HTTP', trainNumber: '', picklistNumber: 'PICK-HTTP',
    cartNumber: 'CARD', cartId: 'CARD-ID', palletId: 'PALLET', orderNumber: 'ORDER-HTTP', partNumber: 'PART-A', color: 'BLUE', unitOfMeasure: 'EA', description: '' };
  await ok('/api/import', 'POST', { fileName: 'fulfillment-http.json', rows: [
    { ...row, sourceLineId: 'demand-later', sequence: '1', packSequence: '2', quantity: 4 },
    { ...row, sourceLineId: 'demand-first', sequence: '2', packSequence: '1', quantity: 5 },
    { ...row, sourceLineId: 'demand-independent', sequence: '3', packSequence: '3', partNumber: 'PART-B', quantity: 2 },
  ] });
  const initial = await ok('/api/state');
  const first = initial.lines.find((line) => line.sourceLineId === 'demand-first');
  const later = initial.lines.find((line) => line.sourceLineId === 'demand-later');
  const independent = initial.lines.find((line) => line.sourceLineId === 'demand-independent');
  const cartKey = [first.plant, first.areaType, first.loadNumber, first.picklistNumber, first.cartNumber, first.cartId].join('::');
  const op = { sessionId: 'packing-tab', operatorName: 'forged name', cartKey, picklistKey: [first.plant, first.areaType, first.loadNumber, first.picklistNumber].join('::') };
  await ok('/api/inventory/receive', 'POST', { captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ['1SSHARED-HTTP', 'PPART-A', 'CBLUE', 'Q7'], operatorName: 'ignored' }, 'operator');
  await ok('/api/inventory/receive', 'POST', { captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ['1SLATER-HTTP', 'PPART-B', 'CBLUE', 'Q2'], operatorName: 'ignored' }, 'operator');
  await ok('/api/locks', 'POST', { ...op, action: 'acquire' }, 'operator');
  assert.equal((await request('/api/settings', 'PATCH', { packingMode: 'exact', inventoryMode: 'uploaded' })).status, 409);
  await ok('/api/scan', 'POST', { ...op, lineId: first.id, field: 'cartBarcode', rawValue: first.orderNumber }, 'operator');
  for (const serial of ['PPART-B', 'CBLUE', '2PBLUE', 'Q2']) {
    const wrongField = await request('/api/fulfill', 'POST', { ...op, serial, serialFormat: 'barcode', requestId: randomUUID() }, 'operator');
    assert.equal(wrongField.status, 409);
    assert.equal((await wrongField.json()).reason, 'invalid_serial');
  }
  assert.ok((await ok('/api/state')).lines.every((line) => line.fulfilledQuantity === 0 && line.allocations.length === 0));
  const chosenBySerial = await ok('/api/fulfill', 'POST', { ...op, serial: '1SLATER-HTTP', serialFormat: 'barcode', requestId: randomUUID() }, 'operator');
  assert.equal(chosenBySerial.lineId, independent.id);
  assert.equal(chosenBySerial.verified, true);
  const afterIndependent = await ok('/api/state');
  assert.equal(afterIndependent.lines.find((line) => line.id === first.id).status, 'pending');
  assert.equal(afterIndependent.lines.find((line) => line.id === later.id).status, 'pending');

  const contribution = { ...op, lineId: first.id, serial: '1SSHARED-HTTP', serialFormat: 'barcode', requestId: randomUUID() };
  const packed = await ok('/api/fulfill', 'POST', contribution, 'operator');
  assert.equal(packed.verified, true);
  assert.equal(packed.fulfilledQuantity, 5);
  await ok('/api/fulfill', 'POST', contribution, 'operator');
  const partial = await ok('/api/fulfill', 'POST', { ...op, lineId: later.id, serial: '1SSHARED-HTTP', serialFormat: 'barcode', requestId: randomUUID() }, 'operator');
  assert.equal(partial.verified, false);
  assert.equal(partial.fulfilledQuantity, 2);
  assert.equal(partial.remainingQuantity, 2);
  const active = (await ok('/api/state')).lines.find((line) => line.id === later.id);
  assert.equal(active.status, 'active');
  assert.equal(active.allocations.length, 1);
  assert.equal(active.allocations[0].packedBy, 'operator');
  assert.equal((await request('/api/picklists/reset', 'POST', { cartKey }, 'viewer')).status, 403);
  assert.equal((await request('/api/picklists/reset', 'POST', { cartKey, sessionId: 'foreign-tab' })).status, 409);
  await ok('/api/picklists/close', 'POST', op, 'operator');
  const closed = await ok('/api/state');
  assert.equal(closed.lines.find((line) => line.id === later.id).status, 'short');
  assert.equal(closed.lines.find((line) => line.id === first.id).status, 'verified');
  await ok('/api/picklists/reset', 'POST', { cartKey });
  const reset = await ok('/api/state');
  assert.ok(reset.lines.every((line) => line.status === 'pending' && line.fulfilledQuantity === 0 && line.allocations.length === 0));
  const inventory = await ok('/api/inventory');
  const shared = inventory.items.find((item) => item.serial === 'SHARED-HTTP');
  assert.equal(shared.consumedQuantity, 0);
  assert.equal(shared.remainingQuantity, 7);
  assert.equal(inventory.summary.quantitiesByUnit.EA, 9);
  const audit = await request('/api/audit/export');
  assert.equal(audit.status, 200);
  assert.match(await audit.text(), /reset|unpack/i);
});
