import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import {
  AuthConfigurationError, authorizeRequest, forwardedClientIsLoopback, getAuthConfig,
  localModeRequestAllowed, reportAuthConfigurationError,
} from "../lib/auth.ts";

const headers = (init) => new Headers(init);

test("local mode is refused next to an https app origin in a production build, or on Vercel", () => {
  const production = { NODE_ENV: "production" };
  assert.deepEqual(getAuthConfig({ ...production, CARTFLOW_AUTH_MODE: "local" }), { mode: "local" });
  assert.deepEqual(getAuthConfig({ ...production, CARTFLOW_AUTH_MODE: "local", CARTFLOW_APP_ORIGIN: "" }), { mode: "local" });
  assert.deepEqual(getAuthConfig({ ...production, CARTFLOW_AUTH_MODE: "local", CARTFLOW_APP_ORIGIN: "http://127.0.0.1:3000" }), { mode: "local" },
    "local credential testing uses an http loopback origin");
  for (const origin of ["https://cartflow.example.com", " https://cartflow.example.com ", "HTTPS://CARTFLOW.EXAMPLE.COM"]) {
    assert.throws(() => getAuthConfig({ ...production, CARTFLOW_AUTH_MODE: "local", CARTFLOW_APP_ORIGIN: origin }), (error) =>
      error instanceof AuthConfigurationError && /cannot be combined with an https CARTFLOW_APP_ORIGIN/.test(error.message), origin);
  }
  assert.throws(() => getAuthConfig({ CARTFLOW_AUTH_MODE: "local", VERCEL: "1" }), AuthConfigurationError);
});

test("a copied .env.example does not break development servers", () => {
  // .env.example ships an https origin for credentials mode. pnpm dev runs in development
  // with local mode forced from the command line, and must keep working.
  for (const env of [{ NODE_ENV: "development" }, {}, { NODE_ENV: "test" }]) {
    assert.deepEqual(getAuthConfig({ ...env, CARTFLOW_AUTH_MODE: "local", CARTFLOW_APP_ORIGIN: "https://cartflow.example.com" }), { mode: "local" }, JSON.stringify(env));
  }
});

test("the reason authentication is unavailable is logged once, without values", (t) => {
  const lines = [];
  t.mock.method(console, "error", (line) => lines.push(String(line)));
  const failure = new AuthConfigurationError("CARTFLOW_AUTH_MODE=local cannot be combined with an https CARTFLOW_APP_ORIGIN in a production build. Remove one of them.");
  reportAuthConfigurationError(failure);
  reportAuthConfigurationError(failure);
  reportAuthConfigurationError(new AuthConfigurationError());
  reportAuthConfigurationError(new Error("postgres://user:secret@host/db"));
  assert.equal(lines.length, 2, "repeats of the same reason are not logged again");
  assert.deepEqual(JSON.parse(lines[0]), { event: "ppa.auth_configuration_error", reason: failure.message });
  assert.equal(JSON.parse(lines[1]).reason, "Invalid authentication configuration.", "unlabelled and foreign errors log a fixed reason, never their text");
  assert.doesNotMatch(lines.join("\n"), /secret/);
});

test("forwarding headers naming a non-loopback client are detected in every common form", () => {
  const loopback = [
    {}, { "x-forwarded-for": "127.0.0.1" }, { "x-forwarded-for": "::1" }, { "x-forwarded-for": "::ffff:127.0.0.1" },
    { "x-forwarded-for": "127.0.0.1, ::1" }, { "x-forwarded-for": "127.0.0.1:52341" }, { "x-forwarded-for": "[::1]:52341" },
    { "x-real-ip": "127.10.20.30" }, { forwarded: "for=127.0.0.1;proto=http" }, { forwarded: 'for="[::1]:4711"' },
    { forwarded: "for=127.0.0.1, for=::1" }, { "x-forwarded-for": "localhost" },
  ];
  for (const init of loopback) assert.equal(forwardedClientIsLoopback(headers(init)), true, JSON.stringify(init));
  const remote = [
    { "x-forwarded-for": "203.0.113.9" }, { "x-forwarded-for": "127.0.0.1, 203.0.113.9" }, { "x-forwarded-for": "203.0.113.9, 127.0.0.1" },
    { "x-forwarded-for": "::ffff:203.0.113.9" }, { "x-forwarded-for": "2001:db8::1" }, { "x-forwarded-for": "" },
    { "x-forwarded-for": "127.0.0.999" }, { "x-forwarded-for": "127.0.0.1.evil.example" }, { "x-forwarded-for": "unknown" },
    { "x-real-ip": "10.0.0.5" }, { "x-client-ip": "192.168.1.20" }, { "cf-connecting-ip": "198.51.100.7" },
    { "true-client-ip": "198.51.100.7" }, { "fastly-client-ip": "198.51.100.7" }, { "x-vercel-forwarded-for": "198.51.100.7" },
    { forwarded: "for=203.0.113.9" }, { forwarded: "for=127.0.0.1, for=203.0.113.9" }, { forwarded: "for=_hidden" },
    { forwarded: 'for="[2001:db8::1]:4711"' }, { forwarded: "by=127.0.0.1;for=203.0.113.9" },
  ];
  for (const init of remote) assert.equal(forwardedClientIsLoopback(headers(init)), false, JSON.stringify(init));
});

test("local-mode requests are refused when forwarding headers show a remote client", async (t) => {
  const saved = { mode: process.env.CARTFLOW_AUTH_MODE, origin: process.env.CARTFLOW_APP_ORIGIN, vercel: process.env.VERCEL };
  process.env.CARTFLOW_AUTH_MODE = "local";
  delete process.env.CARTFLOW_APP_ORIGIN;
  delete process.env.VERCEL;
  t.after(() => {
    for (const [name, value] of [["CARTFLOW_AUTH_MODE", saved.mode], ["CARTFLOW_APP_ORIGIN", saved.origin], ["VERCEL", saved.vercel]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const request = (init = {}, url = "http://127.0.0.1:3000/api/state", method = "GET") => authorizeRequest(new Request(url, { method, headers: init }), "admin");

  const direct = request();
  assert.equal(direct.principal.id, "local-developer", "a plain loopback request keeps working");
  assert.equal(direct.localMode, true);
  assert.equal(request({ "x-forwarded-for": "::1" }).localMode, true, "Next.js fills this from a loopback socket");
  assert.equal(request({ "x-forwarded-for": "::ffff:127.0.0.1", "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "http" }).localMode, true);

  for (const init of [{ "x-forwarded-for": "203.0.113.9" }, { "x-real-ip": "10.0.0.5" }, { forwarded: "for=203.0.113.9" }, { "x-forwarded-for": "127.0.0.1, 203.0.113.9" }]) {
    const refused = request(init);
    assert.equal(refused instanceof Response, true, JSON.stringify(init));
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, "local_only");
  }
  const wrongHost = request({}, "http://ppa.example.com/api/state");
  assert.equal(wrongHost.status, 403, "the existing Host check still applies");
  const post = request({ "x-forwarded-for": "203.0.113.9", origin: "http://127.0.0.1:3000" }, "http://127.0.0.1:3000/api/scan", "POST");
  assert.equal(post.status, 403, "writes are refused too");
});

test("localModeRequestAllowed combines the Host and forwarding checks", () => {
  const request = (url, init = {}) => new Request(url, { headers: init });
  assert.equal(localModeRequestAllowed(request("http://127.0.0.1:3000/")), true);
  assert.equal(localModeRequestAllowed(request("http://localhost:3000/", { "x-forwarded-for": "::1" })), true);
  assert.equal(localModeRequestAllowed(request("http://ppa.example.com/")), false);
  assert.equal(localModeRequestAllowed(request("http://127.0.0.1:3000/", { "x-forwarded-for": "203.0.113.9" })), false);
});

test("the integration endpoint applies the loopback rule in local mode, not only the token", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-integration-local-"));
  const saved = Object.fromEntries(["CARTFLOW_AUTH_MODE", "CARTFLOW_APP_ORIGIN", "CARTFLOW_INGEST_TOKEN", "CARTFLOW_DATABASE_PATH", "VERCEL"].map((name) => [name, process.env[name]]));
  Object.assign(process.env, { CARTFLOW_AUTH_MODE: "local", CARTFLOW_INGEST_TOKEN: "x", CARTFLOW_DATABASE_PATH: join(directory, "unused.sqlite") });
  delete process.env.CARTFLOW_APP_ORIGIN;
  delete process.env.VERCEL;
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  const source = (await readFile(new URL("../app/api/integrations/demand/route.ts", import.meta.url), "utf8"))
    .replace(/from "@\/([^"]+)"/g, (_, specifier) => `from "${new URL(`../${specifier}.ts`, import.meta.url).href}"`)
    .replace('from "next/server"', `from "${new URL("../node_modules/next/server.js", import.meta.url).href}"`);
  const target = join(directory, "integration-route.mjs");
  await writeFile(target, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  const route = await import(pathToFileURL(target).href);
  const post = (url, headers) => route.POST(new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ rows: [] }) }));

  const relayed = await post("http://127.0.0.1:3000/api/integrations/demand", { authorization: "Bearer x", "x-forwarded-for": "203.0.113.9" });
  assert.equal(relayed.status, 403);
  assert.equal((await relayed.json()).code, "local_only", "a correct token from a remote client is still refused");
  const wrongHost = await post("http://ppa.example.com/api/integrations/demand", { authorization: "Bearer x" });
  assert.equal(wrongHost.status, 403);
  const loopback = await post("http://127.0.0.1:3000/api/integrations/demand", { authorization: "Bearer wrong" });
  assert.equal(loopback.status, 401, "a loopback request passes the check and reaches the token comparison");
});

const dbProbe = resolve(import.meta.dirname, "../db/index.ts");
const probeSource = `import(${JSON.stringify(dbProbe)}).then((m) => { try { const db = m.getDatabase(); console.log("OK " + (db.dialect || "")); } catch (e) { console.log("ERR " + e.message); } });`;

function probe(cwd, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(NODE_ENV|DATABASE_URL|POSTGRES_URL|VERCEL|CARTFLOW_.*)$/.test(name)));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", probeSource], { cwd, env: { ...clean, ...env }, encoding: "utf8" });
  return result.stdout.trim().split("\n").pop() || result.stderr.trim();
}

test("a production host without DATABASE_URL never quietly falls back to a SQLite file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-db-guard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const created = () => existsSync(join(directory, ".cartflow-data"));

  const refused = probe(directory, { NODE_ENV: "production", CARTFLOW_AUTH_MODE: "credentials" });
  assert.match(refused, /^ERR PPA requires DATABASE_URL in production/);
  assert.equal(created(), false, "no database file or directory may be created in the working directory");

  const explicit = probe(directory, { NODE_ENV: "production", CARTFLOW_AUTH_MODE: "credentials", CARTFLOW_DATABASE_PATH: join(directory, "chosen", "ppa.sqlite") });
  assert.match(explicit, /^OK/, "an explicitly chosen SQLite path is an informed opt-in");
  assert.equal(created(), false);

  const blank = probe(directory, { NODE_ENV: "production", CARTFLOW_DATABASE_PATH: "   " });
  assert.match(blank, /^ERR PPA requires DATABASE_URL in production/, "a blank path is not a choice");
  assert.equal(created(), false);
});

test("SQLite defaults remain available for development, local mode and explicit Postgres", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-db-allowed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.match(probe(directory, { NODE_ENV: "development" }), /^OK/, "pnpm dev");
  assert.equal(existsSync(join(directory, ".cartflow-data")), true, "development keeps its default local file");
  const localDirectory = await mkdtemp(join(tmpdir(), "ppa-db-local-"));
  t.after(() => rm(localDirectory, { recursive: true, force: true }));
  assert.match(probe(localDirectory, { NODE_ENV: "production", CARTFLOW_AUTH_MODE: "local" }), /^OK/, "local preview on a production build");
  assert.match(probe(directory, { NODE_ENV: "production", DATABASE_URL: "postgresql://user:disposable@localhost/db" }), /^OK/, "an explicit Postgres URL");
});

test("Vercel still requires DATABASE_URL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-db-vercel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.match(probe(directory, { VERCEL: "1", NODE_ENV: "production", CARTFLOW_DATABASE_PATH: join(directory, "x.sqlite") }), /^ERR PPA requires DATABASE_URL when deployed to Vercel/);
  assert.equal(existsSync(join(directory, "x.sqlite")), false);
});
