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

test('raw capture HTTP permissions, exact export, retries and separation from demand', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ppa-capture-http-'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const password = 'Capture-test-only-password';
  const passwordHash = await hashPassword(password);
  let logs = '';
  const roles = { viewer: 'viewer', operator: 'operator', other: 'operator', supervisor: 'supervisor' };
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: '', POSTGRES_URL: '', VERCEL: '', CARTFLOW_DATABASE_PATH: join(directory, 'test.sqlite'),
      CARTFLOW_AUTH_MODE: 'credentials', CARTFLOW_APP_ORIGIN: origin, CARTFLOW_AUTH_SECRET: 'raw-capture-test-secret-just-for-this-test',
      CARTFLOW_AUTH_USERS: JSON.stringify(Object.entries(roles).map(([id,role]) => ({ id, username:id, name:id, role, passwordHash }))) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', v => { logs = (logs + v).slice(-4000); });
  t.after(async () => {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await Promise.race([exited,delay(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive:true, force:true });
  });
  for (let i=0;i<100;i++) {
    try { await fetch(`${origin}/api/auth/session`, { signal:AbortSignal.timeout(500) }); break; }
    catch { if (i===99) throw new Error(logs); await delay(100); }
  }
  const cookies={};
  const request=(path,method='GET',body,role='operator',requestOrigin=origin)=>fetch(`${origin}${path}`,{
    method,headers:{ Origin:requestOrigin,Cookie:cookies[role]||'',...(body?{'Content-Type':'application/json'}:{}) },
    ...(body?{body:JSON.stringify(body)}:{}),
  });
  assert.equal((await request('/api/raw-capture')).status,401);
  for (const role of Object.keys(roles)) {
    const response=await request('/api/auth/login','POST',{username:role,password});
    assert.equal(response.status,200);
    cookies[role]=response.headers.get('set-cookie').split(';')[0];
  }
  const sessionId=randomUUID();
  const scan={id:randomUUID(),sessionId,position:1,rawValue:' AE3TP327074XRGS ',scannedAt:new Date().toISOString(),operatorName:'forged'};
  assert.equal((await request('/api/raw-capture','POST',scan,'viewer')).status,403);
  assert.equal((await request('/api/raw-capture','POST',scan,'operator','https://untrusted.example')).status,403);
  assert.equal((await request('/api/raw-capture','POST',scan)).status,200);
  assert.equal((await request('/api/raw-capture','POST',scan)).status,200);
  assert.equal((await request('/api/raw-capture','POST',{...scan,id:randomUUID(),position:2})).status,200);
  assert.equal((await request('/api/raw-capture','POST',{...scan,rawValue:'different'})).status,409);
  assert.equal((await request('/api/raw-capture','POST',{...scan,rawValue:'\n'})).status,400);
  const own=await (await request(`/api/raw-capture?sessionId=${sessionId}`)).json();
  assert.equal(own.scans.length,2);
  assert.equal(own.scans[0].operatorName,'operator');
  const foreign=await (await request(`/api/raw-capture?sessionId=${sessionId}`,'GET',undefined,'other')).json();
  assert.deepEqual(foreign.scans,[]);
  const supervisor=await (await request('/api/raw-capture','GET',undefined,'supervisor')).json();
  assert.equal(supervisor.sessions[0].count,2);
  const exported=await request(`/api/raw-capture?sessionId=${sessionId}&format=txt`,'GET',undefined,'supervisor');
  assert.match(exported.headers.get('content-disposition'),/attachment/);
  assert.equal(await exported.text(),`${scan.rawValue}\n${scan.rawValue}\n`);
  assert.deepEqual((await (await request('/api/state')).json()).lines,[]);
});
