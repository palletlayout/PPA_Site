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
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

const fixture = {
  plant: 'QA', zone: 'A', areaType: 'offsite', shipCategory: 'AA',
  loadNumber: 'QA-LOAD', trainNumber: '', picklistNumber: 'QA-PICK',
  cartNumber: 'QA-CART', cartId: 'QA-CART-ID', palletId: 'QA-PALLET',
  sequence: '001', partNumber: 'QA-PART', description: 'Disposable HTTP regression fixture',
  color: 'M4', quantity: 2, aiagSerial: 'QA-SERIAL',
};
const keyFor = (line) => [line.plant, line.areaType, line.loadNumber, line.picklistNumber, line.cartNumber, line.cartId].join('::');
async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
async function startServer(t, authMode = 'credentials') {
  const directory = await mkdtemp(join(tmpdir(), 'cartflow-http-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const password = 'Disposable-QA-password-2026';
  const passwordHash = await hashPassword(password);
  const users = ['viewer', 'operator', 'supervisor', 'admin'].map((role) => ({
    id: `qa-${role}`, username: role, name: `QA ${role}`, role, passwordHash,
  }));
  let logs = '';
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: '', POSTGRES_URL: '', VERCEL: '',
      CARTFLOW_DATABASE_PATH: join(directory, 'qa.sqlite'), CARTFLOW_AUTH_MODE: authMode,
      CARTFLOW_APP_ORIGIN: origin, CARTFLOW_AUTH_SECRET: authMode === 'unconfigured' ? '' : 'qa-secret-that-is-only-for-disposable-tests-2026',
      CARTFLOW_AUTH_USERS: JSON.stringify(users), CARTFLOW_ENABLE_TEST_TOOLS: 'false',
      CARTFLOW_FORMAT_ONLY_TEST_MODE: 'false', CARTFLOW_INGEST_TOKEN: 'qa-ingestion-disposable-token-2026',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { logs = (logs + data).slice(-8000); });
  child.stderr.on('data', (data) => { logs = (logs + data).slice(-8000); });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(4000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`QA server stopped: ${logs}`);
    try { await fetch(`${origin}/api/auth/session`, { signal: AbortSignal.timeout(500) }); break; }
    catch { if (attempt === 199) throw new Error(`QA server failed to start: ${logs}`); await delay(100); }
  }
  async function request(path, { method = 'GET', body, cookie = '', headers = {} } = {}) {
    return await fetch(`${origin}${path}`, { method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Origin: origin, Cookie: cookie, ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
  }
  async function login(role) {
    const response = await request('/api/auth/login', { method: 'POST', body: { username: role, password } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    return response.headers.get('set-cookie').split(';')[0];
  }
  return { request, login, origin };
}

// Executes real HTTP routes from the production build against a disposable database.
test('section checksheet HTTP export includes both movements and keeps areas and work environments separate', { timeout: 30000 }, async (t) => {
  const { request, login } = await startServer(t);
  const supervisor = await login('supervisor');
  const viewer = await login('viewer');
  const rows = ['L000001', 'L000002', 'TP00001', 'TP00002', 'TEST-LOAD', 'TEST-TRAIN'].map((movement) => {
    const onsite = movement.startsWith('TP') || movement === 'TEST-TRAIN';
    const isTest = movement.startsWith('TEST');
    return { ...fixture, areaType: onsite ? 'onsite' : 'offsite', loadNumber: onsite ? '' : movement,
      trainNumber: onsite ? movement : '', picklistNumber: `PICK-${movement}`, cartId: `CART-${movement}`,
      masterBarcode: `MASTER-${movement}`, movementBarcode: movement,
      ...(isTest ? { plant: 'TEST', programId: 'TESTSCAN', pymtc: `TEST:${movement}` } : {}),
    };
  });
  const imported = await request('/api/import', { method: 'POST', cookie: supervisor, body: { rows } });
  assert.equal(imported.status, 200, await imported.clone().text());
  const download = (body, cookie = viewer) => request('/api/picklists/pdf', { method: 'POST', cookie, body });
  const selection = { scope: 'section', areaType: 'offsite', workScope: 'production' };
  assert.equal((await download(selection, '')).status, 401);
  for (const body of [
    { ...selection, areaType: 'unknown' }, { ...selection, areaType: undefined },
    { ...selection, workScope: 'all' }, { ...selection, workScope: undefined },
    { ...selection, scope: 'all' },
  ]) assert.equal((await download(body)).status, 400, JSON.stringify(body));
  const before = await (await request('/api/state', { cookie: viewer })).json();
  for (const [areaType, workScope, expected] of [
    ['offsite', 'production', ['L000001', 'L000002']],
    ['onsite', 'production', ['TP00001', 'TP00002']],
    ['offsite', 'test', ['TEST-LOAD']],
    ['onsite', 'test', ['TEST-TRAIN']],
  ]) {
    const response = await download({ scope: 'section', areaType, workScope });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get('cache-control'), /private, no-store/);
    assert.match(response.headers.get('content-disposition'), new RegExp(`${areaType === 'offsite' ? 'loads' : 'trains'}-all-checksheets\\.pdf`));
    const document = await PDFDocument.load(await response.arrayBuffer());
    assert.equal(document.getPageCount(), expected.length);
    const pages = document.getPages().map((page) => {
      const contents = page.node.Contents();
      const streams = contents instanceof PDFRawStream ? [contents] : contents.asArray().map((ref) => document.context.lookup(ref, PDFRawStream));
      const operators = streams.map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')).join('\n');
      return [...operators.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((match) => Buffer.from(match[1], 'hex').toString('latin1')).join('\n');
    });
    for (let index = 0; index < expected.length; index += 1) {
      assert.match(pages[index], new RegExp(`MASTER-${expected[index]}`));
      assert.match(pages[index], new RegExp(expected[index]));
    }
  }
  assert.deepEqual((await (await request('/api/state', { cookie: viewer })).json()).lines, before.lines);
});

test('authenticated HTTP lifecycle preserves permissions, leases, verification, exports and loading', { timeout: 90000 }, async (t) => {
  const { request, login } = await startServer(t);
  const cookies = {};
  for (const role of ['viewer', 'operator', 'supervisor', 'admin']) cookies[role] = await login(role);
  const op = { sessionId: 'qa-browser-tab-one', operatorName: 'FORGED NAME' };
  let line;
  let cartKey;
  await t.test('anonymous access, viewer writes and cross-origin mutations are denied', async () => {
    for (const path of ['/api/state', '/api/scans/export', '/api/health', '/api/audit/export']) assert.equal((await request(path)).status, 401, path);
    assert.equal((await request('/api/import', { method: 'POST', cookie: cookies.viewer, body: { rows: [fixture] } })).status, 403);
    assert.equal((await request('/api/import', { method: 'POST', cookie: cookies.supervisor, body: { rows: [fixture] }, headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await request('/api/data', { method: 'DELETE', cookie: cookies.supervisor, body: { confirmation: 'DELETE_ALL_CARTFLOW_DATA' } })).status, 403);
    assert.equal((await request('/api/inventory/capture', { method: 'POST', cookie: cookies.operator, body: {} })).status, 403);
    assert.equal((await request('/api/state', { cookie: cookies.viewer })).status, 200);
    for (const role of ['viewer', 'operator']) assert.equal((await request('/api/audit/export', { cookie: cookies[role] })).status, 403);
    const audit = await request('/api/audit/export', { cookie: cookies.supervisor });
    assert.equal(audit.status, 200); assert.match(audit.headers.get('content-type'), /text\/csv/); assert.match(audit.headers.get('cache-control'), /no-store/);
  });
  await t.test('malformed requests and invalid quantities cannot change the queue', async () => {
    assert.equal((await request('/api/import', { method: 'POST', cookie: cookies.supervisor, body: { rows: [{ ...fixture, quantity: 0 }] } })).status, 400);
    assert.equal((await request('/api/import', { method: 'POST', cookie: cookies.supervisor, body: { rows: [{ ...fixture, quantity: 2147483648 }] } })).status, 400);
    assert.equal((await request('/api/locks', { method: 'POST', cookie: cookies.operator, body: { action: 123 } })).status, 400);
    const response = await request('/api/import', { method: 'POST', cookie: cookies.supervisor, body: { fileName: 'qa-http.csv', rows: [fixture] } });
    assert.equal(response.status, 200, await response.clone().text());
    const state = await (await request('/api/state', { cookie: cookies.viewer })).json();
    assert.equal(state.lines.length, 1);
    line = state.lines[0]; cartKey = keyFor(line);
  });
  await t.test('one reservation wins, owners cannot be forged, active work blocks replacement', async () => {
    const contenders = await Promise.all(Array.from({ length: 100 }, (_, i) => `qa-browser-tab-${i}`).map((sessionId) => request('/api/locks', {
      method: 'POST', cookie: cookies.operator, body: { ...op, sessionId, action: 'acquire', cartKey, picklistKey: cartKey.split('::').slice(0, 4).join('::') },
    })));
    assert.equal(contenders.filter((response) => response.status === 200).length, 1);
    assert.equal(contenders.filter((response) => response.status === 409).length, 99);
    op.sessionId = `qa-browser-tab-${contenders.findIndex((response) => response.status === 200)}`;
    const state = await (await request('/api/state', { cookie: cookies.operator, headers: { 'x-cartflow-session': op.sessionId } })).json();
    assert.equal(state.locks[0].operatorName, 'QA operator');
    assert.equal(state.locks[0].isOwned, true);
    const stranger = await (await request('/api/state', { cookie: cookies.supervisor, headers: { 'x-cartflow-session': op.sessionId } })).json();
    assert.equal(stranger.locks[0].isOwned, false);
    assert.equal((await request('/api/import', { method: 'POST', cookie: cookies.supervisor, body: { rows: [{ ...fixture, quantity: 3 }] } })).status, 409);
  });
  await t.test('serial lookup requires cart verification, inventory and an exact match', async () => {
    const base = { ...op, lineId: line.id, cartKey };
    const fulfill = (serial, extra = {}) => request('/api/fulfill', { method: 'POST', cookie: cookies.operator, body: { ...base, serial, serialFormat: 'barcode', ...extra } });
    assert.equal((await request('/api/fulfill', { method: 'POST', cookie: cookies.viewer, body: { ...base, serial: 'QA-SERIAL' } })).status, 403);
    const guardStock = await request('/api/inventory/receive', { method: 'POST', cookie: cookies.operator, body: {
      captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ['1SQA-CART-GUARD', 'PQA-PART', '2PM4', 'Q2'],
    } });
    assert.equal(guardStock.status, 201, await guardStock.clone().text());
    const beforeCartScan = await fulfill('1SQA-CART-GUARD');
    assert.equal(beforeCartScan.status, 409, 'scanning the cart is required');
    assert.equal((await beforeCartScan.json()).reason, 'cart_not_scanned');
    const cart = await request('/api/scan', { method: 'POST', cookie: cookies.operator, body: { ...base, field: 'cartBarcode', rawValue: line.cartBarcode } });
    assert.equal(cart.status, 200, await cart.clone().text());
    const missing = await fulfill('1SQA-SERIAL');
    assert.equal(missing.status, 200);
    const missingResult = await missing.json();
    assert.equal(missingResult.reason, 'inventory_not_found');
    assert.equal(missingResult.nextAction, 'receive_inventory');
    assert.equal(missingResult.ok, false, 'lookup alone must not record fulfillment');
    for (const rawValues of [
      ['1SQA-WRONG-PART', 'POTHER', '2PM4', 'Q2'],
      ['1SQA-WRONG-COLOR', 'PQA-PART', '2PRED', 'Q2'],
      ['1SQA-WRONG-QTY', 'PQA-PART', '2PM4', 'Q1'],
    ]) {
      const received = await request('/api/inventory/receive', { method: 'POST', cookie: cookies.operator, body: {
        captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues,
      } });
      assert.equal(received.status, 201, await received.clone().text());
      const mismatch = await fulfill(rawValues[0]);
      assert.equal(mismatch.status, 409);
      assert.equal((await mismatch.json()).reason, 'inventory_mismatch');
    }
    const state = await (await request('/api/state', { cookie: cookies.viewer })).json();
    assert.equal(state.lines[0].status, 'pending');
    assert.equal(state.lines[0].aiagSerial, '');
    assert.equal(state.lines[0].fulfilledQuantity, 0);
    assert.equal((await request('/api/loading/confirm', { method: 'POST', cookie: cookies.operator, body: { cartBarcode: line.cartBarcode, movementValue: fixture.loadNumber } })).status, 409);
    // The old four-field route must never provide a second way to pack demand.
    const old = await request('/api/scan/batch', { method: 'POST', cookie: cookies.operator, body: { ...base, values: ['Q2', '2PM4', 'PQA-PART', '1SQA-SERIAL'] } });
    assert.ok(old.status >= 400);
  });
  await t.test('receiving during packing followed by a serial consumes once and exports the link', async () => {
    const received = await request('/api/inventory/receive', { method: 'POST', cookie: cookies.operator, body: {
      captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ['1SQA-SERIAL', 'PQA-PART', '2PM4', 'Q2'],
    } });
    assert.equal(received.status, 201, await received.clone().text());
    const stock = (await received.json()).inventory;
    assert.equal((await (await request('/api/state', { cookie: cookies.viewer })).json()).lines[0].status, 'pending');
    const payload = { ...op, lineId: line.id, cartKey, serial: '1SQA-SERIAL', serialFormat: 'barcode' };
    for (let retry = 0; retry < 2; retry++) {
      const response = await request('/api/fulfill', { method: 'POST', cookie: cookies.operator, body: payload });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).verified, true);
    }
    const state = await (await request('/api/state', { cookie: cookies.viewer })).json();
    assert.equal(state.lines[0].inventoryItemId, stock.id);
    assert.equal(state.lines[0].aiagSerial, 'QA-SERIAL');
    assert.equal(state.lines[0].fulfilledQuantity, 2);
    const items = (await (await request('/api/inventory', { cookie: cookies.viewer })).json()).items;
    const consumed = items.find((item) => item.id === stock.id);
    assert.equal(consumed.consumedFlag, 'Y');
    assert.equal(consumed.consumedQuantity, 2);
    assert.equal(consumed.status, 'consumed');
    const csv = await request('/api/scans/export', { cookie: cookies.viewer });
    assert.equal(csv.status, 200); assert.match(await csv.text(), /QA operator/);
    const pdf = await request('/api/picklists/pdf', { method: 'POST', cookie: cookies.viewer, body: { lineId: line.id, scope: 'movement' } });
    assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.equal((await request('/api/demand', { method: 'PATCH', cookie: cookies.supervisor, body: { lineId: line.id, changes: { quantity: 3 } } })).status, 409);
  });
  await t.test('destination mismatch is blocked; repeated correct confirmation is idempotent', async () => {
    const body = { cartBarcode: line.cartBarcode, operatorName: 'FORGED NAME', movementValue: 'WRONG-LOAD' };
    assert.equal((await request('/api/loading/confirm', { method: 'POST', cookie: cookies.operator, body })).status, 409);
    body.movementValue = fixture.loadNumber;
    const confirmed = await request('/api/loading/confirm', { method: 'POST', cookie: cookies.operator, body });
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    const repeated = await request('/api/loading/confirm', { method: 'POST', cookie: cookies.operator, body });
    assert.equal(repeated.status, 200); assert.equal((await repeated.json()).alreadyLoaded, true);
    const state = await (await request('/api/state', { cookie: cookies.viewer })).json();
    assert.ok(state.lines[0].loadedAt); assert.equal(state.lines[0].loadedBy, 'QA operator');
  });
  await t.test('a conflicting reimport returns its explanation and preserves loaded inventory', async () => {
    const release = await request('/api/locks', { method: 'POST', cookie: cookies.operator,
      body: { ...op, action: 'release', cartKey, picklistKey: cartKey.split('::').slice(0, 4).join('::') } });
    assert.equal(release.status, 200, await release.clone().text());
    const before = await (await request('/api/state', { cookie: cookies.viewer })).json();
    const stockBefore = await (await request('/api/inventory', { cookie: cookies.viewer })).json();
    const conflict = await request('/api/import', { method: 'POST', cookie: cookies.supervisor,
      body: { fileName: 'changed-demand.csv', rows: [{ ...fixture, quantity: 3 }] } });
    assert.equal(conflict.status, 409, await conflict.clone().text());
    const detail = await conflict.json();
    assert.equal(detail.code, 'reconciliation_required');
    assert.match(detail.error, /Demand reconciliation required:/);
    assert.match(detail.error, /No demand or inventory was changed/);
    assert.ok(detail.issues.some((issue) => issue.reason === 'worked_line_changed' && issue.fields.includes('quantity')));
    assert.deepEqual((await (await request('/api/state', { cookie: cookies.viewer })).json()).lines, before.lines);
    assert.deepEqual((await (await request('/api/inventory', { cookie: cookies.viewer })).json()).items, stockBefore.items);

    const unchanged = await request('/api/import', { method: 'POST', cookie: cookies.supervisor,
      body: { fileName: 'unchanged-demand.csv', rows: [fixture] } });
    assert.equal(unchanged.status, 200, await unchanged.clone().text());
    const retained = (await (await request('/api/state', { cookie: cookies.viewer })).json()).lines[0];
    for (const field of ['id', 'inventoryItemId', 'aiagSerial', 'fulfilledQuantity', 'loadedAt', 'loadedBy']) {
      assert.equal(retained[field], before.lines[0][field], field);
    }
  });
  await t.test('scanner voice recordings are served by the production build', async () => {
    for (const name of ['serial', 'part-number', 'quantity', 'color', 'duplicate']) {
      const response = await request(`/audio/scans/${name}.wav`);
      assert.equal(response.status, 200, name);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', name);
      assert.equal(bytes.toString('ascii', 8, 12), 'WAVE', name);
    }
  });
  await t.test('credential admins cannot erase production history and logout revokes copied cookies', async () => {
    const inventoryBefore = await (await request('/api/inventory', { cookie: cookies.admin })).json();
    const stateBefore = await (await request('/api/state', { cookie: cookies.admin })).json();
    const auditBefore = await (await request('/api/audit/export', { cookie: cookies.admin })).text();
    assert.ok(inventoryBefore.total > 0);
    assert.ok(stateBefore.lines.length > 0);
    for (const confirmation of ['wrong', 'DELETE_ALL_CARTFLOW_DATA']) {
      const response = await request('/api/data', { method: 'DELETE', cookie: cookies.admin, body: { confirmation } });
      assert.equal(response.status, 403, await response.clone().text());
    }
    assert.deepEqual(await (await request('/api/state', { cookie: cookies.viewer })).json(), stateBefore);
    assert.deepEqual(await (await request('/api/inventory', { cookie: cookies.admin })).json(), inventoryBefore);
    assert.equal(await (await request('/api/audit/export', { cookie: cookies.admin })).text(), auditBefore);
    const logout = await request('/api/auth/logout', { method: 'POST', cookie: cookies.admin });
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request('/api/state', { cookie: cookies.admin })).status, 401, 'copied cookies cannot replay a revoked session');
  });
});

test('fulfillment HTTP resolves barcode and canonical serials without prefix collisions', { timeout: 30000 }, async (t) => {
  const { request, login } = await startServer(t);
  const supervisor = await login('supervisor');
  const operator = await login('operator');
  const post = (path, body, cookie = operator) => request(path, { method: 'POST', body, cookie });
  const json = async (response) => {
    const payload = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  };
  await json(await post('/api/import', { fileName: 'identity.csv', rows: [fixture, { ...fixture, sequence: '002' }] }, supervisor));
  const line = (await json(await request('/api/state', { cookie: operator }))).lines[0];
  const context = { cartKey: keyFor(line), picklistKey: keyFor(line).split('::').slice(0, 4).join('::'), sessionId: 'identity-scanner' };
  await json(await post('/api/locks', { ...context, action: 'acquire' }));
  await json(await post('/api/scan', { ...context, lineId: line.id, field: 'cartBarcode', rawValue: line.cartBarcode }));
  const receive = async (serial) => (await json(await post('/api/inventory/receive', {
    captureId: randomUUID(), receiptSessionId: randomUUID(),
    rawValues: [`1S${serial}`, `P${fixture.partNumber}`, `C${fixture.color}`, `Q${fixture.quantity}`], supplierId: 'SUP-A',
  }))).inventory;
  const storedWithPrefix = await receive('1SABC');
  const untyped = await post('/api/fulfill', { ...context, serial: '1SABC', supplierId: 'SUP-A', requestId: randomUUID() });
  assert.equal(untyped.status, 409);
  assert.equal((await untyped.json()).reason, 'client_update_required');
  const missing = await json(await post('/api/fulfill', { ...context, serial: '1SABC', serialFormat: 'barcode', supplierId: 'SUP-A', requestId: randomUUID() }));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'inventory_not_found');
  assert.equal(missing.serial, 'ABC');
  assert.equal(missing.nextAction, 'receive_inventory');
  assert.ok((await json(await request('/api/state', { cookie: operator }))).lines.every((row) => row.fulfilledQuantity === 0));
  const storedPlain = await receive('ABC');
  const requestId = randomUUID();
  const packedPlain = await json(await post('/api/fulfill', { ...context, serial: '1SABC', serialFormat: 'barcode', supplierId: 'SUP-A', requestId }));
  assert.equal(packedPlain.inventoryItemId, storedPlain.id);
  const packedWithPrefix = await json(await post('/api/fulfill', { ...context, serial: '1SABC', serialFormat: 'canonical', supplierId: 'SUP-A', requestId: randomUUID() }));
  assert.equal(packedWithPrefix.inventoryItemId, storedWithPrefix.id);
  const retry = await json(await post('/api/fulfill', { ...context, serial: 'ABC', serialFormat: 'canonical', supplierId: 'SUP-A', requestId }));
  assert.equal(retry.alreadyFulfilled, true);
  assert.equal(retry.inventoryItemId, storedPlain.id);
  await json(await post('/api/locks', { ...context, action: 'release' }));
  const receiptQuery = new URLSearchParams({ cartKey: context.cartKey, serial: 'ABC', serialFormat: 'canonical', supplierId: 'SUP-A', requestId });
  const receiptPath = `/api/fulfill?${receiptQuery}`;
  assert.equal((await request(receiptPath)).status, 401);
  assert.equal((await request(receiptPath, { cookie: await login('viewer') })).status, 403);
  const recovered = await json(await request(receiptPath, { cookie: operator }));
  assert.equal(recovered.inventoryItemId, storedPlain.id, 'lost responses remain checkable after a completed picklist releases its lease');
  receiptQuery.set('requestId', randomUUID());
  const unknown = await request(`/api/fulfill?${receiptQuery}`, { cookie: operator });
  assert.equal((await unknown.json()).reason, 'receipt_unconfirmed');
  const inventory = await json(await request('/api/inventory', { cookie: operator }));
  assert.deepEqual(inventory.items.map((item) => item.consumedQuantity), [2, 2]);
});

test('an unconfigured deployment fails closed', { timeout: 30000 }, async (t) => {
  const { request } = await startServer(t, 'unconfigured');
  for (const path of ['/api/state', '/api/scans/export', '/api/auth/session']) assert.equal((await request(path)).status, 503);
});
