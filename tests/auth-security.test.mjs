import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  applyPrincipal, checkRequestOrigin, createSession, getAuthConfig, hashPassword,
  operatorSession, authorizeRequest, sessionCookie, testToolsEnabled, verifyPassword, verifySession,
} from "../lib/auth.ts";
import { readJsonBody, requestErrorResponse } from "../lib/request-security.ts";

const password = "a-long-random-test-password";
const passwordHash = await hashPassword(password);
const user = { id: "op-1", username: "operator", name: "Operator One", role: "operator", passwordHash };
const env = {
  CARTFLOW_AUTH_MODE: "credentials",
  CARTFLOW_AUTH_SECRET: "a-long-random-256-bit-test-secret-value",
  CARTFLOW_APP_ORIGIN: "https://cartflow.example",
  CARTFLOW_AUTH_USERS: JSON.stringify([user]),
};
const config = getAuthConfig(env);

function withEnv(values, callback) {
  const keys = ["CARTFLOW_AUTH_MODE", "CARTFLOW_AUTH_SECRET", "CARTFLOW_APP_ORIGIN", "CARTFLOW_AUTH_USERS", "CARTFLOW_ENABLE_TEST_TOOLS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key];
  }
  try { return callback(); } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}
const request = (method = "GET", cookie = "", origin = undefined, url = "https://cartflow.example/api/state") => new Request(url, {
  method, headers: { ...(cookie ? { Cookie: `cartflow_session=${cookie}` } : {}), ...(origin ? { Origin: origin } : {}) },
});

test("credential configuration fails closed for missing, malformed and unsafe settings", () => {
  assert.throws(() => getAuthConfig({}));
  for (const settings of [
    { ...env, CARTFLOW_AUTH_SECRET: "short" },
    { ...env, CARTFLOW_AUTH_MODE: "disabled" },
    { ...env, CARTFLOW_AUTH_USERS: "[]" },
    { ...env, CARTFLOW_AUTH_USERS: JSON.stringify([{ ...user, passwordHash: "plaintext" }]) },
    { ...env, CARTFLOW_AUTH_USERS: JSON.stringify([user, user]) },
    { ...env, CARTFLOW_APP_ORIGIN: "http://public.example" },
    { ...env, CARTFLOW_APP_ORIGIN: "https://public.example/path" },
    { ...env, CARTFLOW_APP_ORIGIN: "https://admin:secret@public.example" },
  ]) assert.throws(() => getAuthConfig(settings));
  assert.equal(getAuthConfig({ CARTFLOW_AUTH_MODE: "local" }).mode, "local");
  withEnv({}, () => assert.equal(authorizeRequest(request()).status, 503));
});

test("scrypt password hashes use random salts and reject incorrect passwords", async () => {
  assert.notEqual(await hashPassword(password), passwordHash);
  assert.equal(await verifyPassword(password, passwordHash), true);
  assert.equal(await verifyPassword(`${password}!`, passwordHash), false);
  assert.equal(await verifyPassword(password, "scrypt$invalid"), false);
  await assert.rejects(() => hashPassword("short"));
});

test("signed sessions reject tampering, expiry, removed users and credential rotation", () => {
  const now = 1700000000000;
  const { token, principal } = createSession(user, config, now);
  assert.deepEqual(verifySession(token, config, now), principal);
  assert.equal(verifySession(`${token}x`, config, now), null);
  assert.equal(verifySession(token, config, now + 8 * 60 * 60 * 1000), null);
  assert.equal(verifySession(token, { ...config, users: [] }, now), null);
  assert.equal(verifySession(token, { ...config, users: [{ ...user, role: "admin" }] }, now), null);
  const [scheme, salt, encodedHash] = passwordHash.split("$");
  const rotatedBytes = Buffer.from(encodedHash, "base64url");
  rotatedBytes[0] ^= 1;
  const rotatedHash = `${scheme}$${salt}$${rotatedBytes.toString("base64url")}`;
  assert.notEqual(rotatedHash, passwordHash);
  assert.equal(verifySession(token, { ...config, users: [{ ...user, passwordHash: rotatedHash }] }, now), null);
  assert.equal(verifySession(token, { ...config, secret: "replacement-secret" }, now), null);
  assert.equal(verifySession("x".repeat(2049), config, now), null);
});

test("credentials and signed tokens reject noncanonical base64url aliases", async () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alias = (encoded) => {
    // Salt/hash encodings have unused trailing bits: set one without changing decoded bytes.
    const last = alphabet.indexOf(encoded.at(-1));
    const result = `${encoded.slice(0, -1)}${alphabet[last + 1]}`;
    assert.notEqual(result, encoded);
    assert.deepEqual(Buffer.from(result, "base64url"), Buffer.from(encoded, "base64url"));
    return result;
  };
  const [scheme, salt, hash] = passwordHash.split("$");
  for (const malformed of [`${scheme}$${alias(salt)}$${hash}`, `${scheme}$${salt}$${alias(hash)}`]) {
    assert.equal(await verifyPassword(password, malformed), false);
    assert.throws(() => getAuthConfig({ ...env, CARTFLOW_AUTH_USERS: JSON.stringify([{ ...user, passwordHash: malformed }]) }));
  }
  const now = 1700000000000;
  const { token } = createSession(user, config, now);
  const [payload, signature] = token.split(".");
  assert.equal(verifySession(`${payload}.${alias(signature)}`, config, now), null);
  assert.equal(verifySession(`${payload}.${signature}=`, config, now), null);
  // Even correctly signed malformed payload encodings are rejected before JSON parsing.
  const paddedPayload = `${payload}=`;
  const paddedSignature = createHmac("sha256", config.secret).update(paddedPayload).digest("base64url");
  assert.equal(verifySession(`${paddedPayload}.${paddedSignature}`, config, now), null);
});

test("every role is enforced on the server and writes require the exact configured Origin", () => withEnv(env, () => {
  for (const role of ["viewer", "operator", "supervisor", "admin"]) {
    const thisUser = { ...user, role };
    withEnv({ ...env, CARTFLOW_AUTH_USERS: JSON.stringify([thisUser]) }, () => {
      const thisConfig = getAuthConfig();
      const { token } = createSession(thisUser, thisConfig);
      for (const minimum of ["viewer", "operator", "supervisor", "admin"]) {
        const result = authorizeRequest(request("POST", token, env.CARTFLOW_APP_ORIGIN), minimum);
        const allowed = ["viewer", "operator", "supervisor", "admin"].indexOf(role) >= ["viewer", "operator", "supervisor", "admin"].indexOf(minimum);
        assert.equal(!(result instanceof Response), allowed, `${role} requiring ${minimum}`);
        if (!allowed) assert.equal(result.status, 403);
      }
      assert.equal(authorizeRequest(request("POST", token), "viewer").status, 403);
      assert.equal(authorizeRequest(request("POST", token, "https://evil.example"), "viewer").status, 403);
      assert.equal(authorizeRequest(request("GET", token), "viewer").principal.id, user.id);
    });
  }
  assert.equal(authorizeRequest(request()).status, 401);
}));

test("local bypass is explicit, loopback-only, and rejects cross-site writes", () => withEnv({ CARTFLOW_AUTH_MODE: "local" }, () => {
  assert.equal(authorizeRequest(request()).status, 403);
  assert.equal(authorizeRequest(request("GET", "", undefined, "http://localhost:3000/api/state")).localMode, true);
  assert.equal(authorizeRequest(request("POST", "", "https://evil.example", "http://localhost:3000/api/scan")).status, 403);
  const crossSite = new Request("http://localhost:3000/api/scan", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(authorizeRequest(crossSite).status, 403);
  assert.equal(checkRequestOrigin(request("POST", "", "null"), config), false);
}));

test("server principal overwrites claimed names and isolates lease ownership by user, login and browser tab", () => withEnv(env, () => {
  const access = { principal: createSession(user, config).principal, localMode: false };
  const supplied = { operatorName: "Impersonated Administrator", sessionId: "tab-one", cartKey: "cart" };
  const actual = applyPrincipal(supplied, access);
  assert.equal(actual.operatorName, user.name);
  assert.match(actual.sessionId, /^[a-f0-9]{64}$/);
  assert.equal(actual.sessionId, operatorSession(access, "tab-one"));
  assert.notEqual(actual.sessionId, operatorSession(access, "tab-two"));
  assert.notEqual(actual.sessionId, operatorSession({ ...access, principal: { ...access.principal, id: "another-user" } }, "tab-one"));
  assert.notEqual(actual.sessionId, operatorSession({ ...access, principal: createSession(user, config).principal }, "tab-one"));
  assert.equal(operatorSession(access, null), "");
  assert.equal(operatorSession(access, "x".repeat(181)), "");
  assert.equal(applyPrincipal(supplied, { ...access, localMode: true }), supplied);
}));

test("test tools require an explicit server flag and admin role outside local development", () => {
  const access = { principal: createSession(user, config).principal, localMode: false };
  withEnv(env, () => assert.equal(testToolsEnabled(access), false));
  withEnv({ ...env, CARTFLOW_ENABLE_TEST_TOOLS: "true" }, () => {
    assert.equal(testToolsEnabled(access), false);
    assert.equal(testToolsEnabled({ ...access, principal: { ...access.principal, role: "admin" } }), true);
  });
  assert.equal(testToolsEnabled({ ...access, localMode: true }), true);
});

test("session cookies are HttpOnly, same-site, expiring, and secure for TLS deployments", () => {
  assert.match(sessionCookie("signed-token", true), /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  assert.match(sessionCookie("", true, 0), /Max-Age=0; Secure/);
});

test("bounded JSON parser rejects oversized, malformed, scalar and wrong-content-type requests", async () => {
  const make = (body, headers = { "Content-Type": "application/json" }) => new Request("http://localhost/", { method: "POST", body, headers });
  assert.deepEqual(await readJsonBody(make('{"value":1}')), { value: 1 });
  await assert.rejects(() => readJsonBody(make('{"value":"oversized"}'), 8), (error) => error.status === 413);
  await assert.rejects(() => readJsonBody(make("{}", { "Content-Type": "application/json", "Content-Length": "1000000" }), 8), (error) => error.status === 413);
  for (const invalid of ["null", "[]", "1", "{} trailing", ""]) await assert.rejects(() => readJsonBody(make(invalid)), (error) => error.status === 400);
  await assert.rejects(() => readJsonBody(make("{}", { "Content-Type": "text/plain" })), (error) => error.status === 415);
});

test("stream limits apply even when Content-Length is absent", async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"part":')); controller.enqueue(new Uint8Array(512)); controller.close(); } });
  const req = new Request("http://localhost/", { method: "POST", body: stream, duplex: "half", headers: { "Content-Type": "application/json" } });
  await assert.rejects(() => readJsonBody(req, 32), (error) => error.status === 413);
});

test("unexpected API errors do not disclose private backend details", async () => {
  const original = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values.join(" "));
  try {
    const response = requestErrorResponse(new Error("postgres://secret:password@private-host/database SELECT *"), "Unable to read data.");
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, "Unable to read data.");
    assert.match(body.requestId, /^[a-f0-9-]{36}$/);
    assert.equal(response.headers.get("X-Request-ID"), body.requestId);
    assert.equal(JSON.parse(logs[0]).requestId, body.requestId);
    assert.doesNotMatch(JSON.stringify(body) + logs.join("\n"), /secret:password|private-host|SELECT \*/);
  } finally { console.error = original; }
});
