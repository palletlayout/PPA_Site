import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "cartflow_session";
export const SESSION_SECONDS = 8 * 60 * 60;
export const ROLES = ["viewer", "operator", "supervisor", "admin"] as const;
export type Role = typeof ROLES[number];
export type Principal = { id: string; name: string; role: Role; sessionId: string };
export type AuthUser = { id: string; username: string; name: string; role: Role; passwordHash: string };
type Env = Record<string, string | undefined>;
export type AuthConfig = { mode: "local" } | { mode: "credentials"; secret: string; origin: string; users: AuthUser[] };
export type Access = { principal: Principal; localMode: boolean };

export class AuthConfigurationError extends Error {}

let lastReportedConfigurationError = "";
/** Say why authentication is unavailable, once per distinct reason, without secrets or values. */
export function reportAuthConfigurationError(error: unknown) {
  const reason = error instanceof AuthConfigurationError && error.message ? error.message : "Invalid authentication configuration.";
  if (reason === lastReportedConfigurationError) return;
  lastReportedConfigurationError = reason;
  console.error(JSON.stringify({ event: "ppa.auth_configuration_error", reason }));
}

export function isLoopbackHost(host: string) {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host)) return false;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(`http://${host}`).hostname);
  } catch { return false; }
}

function isLoopbackAddress(value: string) {
  let address = value.trim().toLowerCase().replace(/^"(.*)"$/, "$1");
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1];
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(address);
  if (withPort) address = withPort[1];
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (address === "::1" || address === "localhost") return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  return Boolean(octets) && octets!.slice(1).every((octet) => Number(octet) <= 255);
}

const FORWARDED_CLIENT_HEADERS = ["x-forwarded-for", "x-real-ip", "x-client-ip", "cf-connecting-ip", "true-client-ip", "fastly-client-ip", "x-vercel-forwarded-for"];

/**
 * True unless the request carries forwarding headers naming a client that is not
 * loopback. Next.js fills x-forwarded-for from the connection's real peer address when
 * the sender did not supply one, so a direct remote connection, or one relayed by a
 * proxy that reports the client, is rejected. This is defence in depth only: Next.js
 * keeps a client-supplied x-forwarded-for, and a proxy that reports nothing looks local.
 * Local mode must never be enabled on a host that other machines can reach.
 */
export function forwardedClientIsLoopback(headers: Headers) {
  for (const name of FORWARDED_CLIENT_HEADERS) {
    const value = headers.get(name);
    if (value === null) continue;
    if (value.split(",").some((hop) => !isLoopbackAddress(hop))) return false;
  }
  const forwarded = headers.get("forwarded");
  if (forwarded !== null) {
    for (const match of forwarded.matchAll(/(?:^|[;,\s])for=("[^"]*"|[^;,\s]+)/gi)) {
      if (!isLoopbackAddress(match[1])) return false;
    }
  }
  return true;
}

/** Local mode serves only loopback clients: a loopback Host and no forwarded remote client. */
export function localModeRequestAllowed(request: Request) {
  const host = request.headers.get("host") || new URL(request.url).host;
  return isLoopbackHost(host) && forwardedClientIsLoopback(request.headers);
}

export function getAuthConfig(env: Env = process.env): AuthConfig {
  if (env.CARTFLOW_AUTH_MODE === "local") {
    if (env.VERCEL) throw new AuthConfigurationError();
    // Credentials mode requires an https origin for any served deployment, so a leftover
    // local mode next to one, in a production build, is a misconfiguration. Fail closed
    // instead of opening access. Development servers are exempt so that a copied
    // .env.example does not break pnpm dev.
    if (env.NODE_ENV === "production" && /^https:/i.test((env.CARTFLOW_APP_ORIGIN || "").trim())) {
      throw new AuthConfigurationError("CARTFLOW_AUTH_MODE=local cannot be combined with an https CARTFLOW_APP_ORIGIN in a production build. Remove one of them.");
    }
    return { mode: "local" };
  }
  if (env.CARTFLOW_AUTH_MODE && env.CARTFLOW_AUTH_MODE !== "credentials") throw new AuthConfigurationError();
  const secret = env.CARTFLOW_AUTH_SECRET || "";
  if (Buffer.byteLength(secret.trim()) < 32) throw new AuthConfigurationError();
  let origin: URL;
  try { origin = new URL(env.CARTFLOW_APP_ORIGIN || ""); } catch { throw new AuthConfigurationError(); }
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && isLoopbackHost(origin.host)))) {
    throw new AuthConfigurationError();
  }
  let users: AuthUser[];
  try { users = JSON.parse(env.CARTFLOW_AUTH_USERS || ""); } catch { throw new AuthConfigurationError(); }
  if (!Array.isArray(users) || !users.length || users.length > 1000) throw new AuthConfigurationError();
  const ids = new Set<string>();
  const usernames = new Set<string>();
  for (const user of users) {
    if (!user || typeof user !== "object" ||
        typeof user.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(user.id) || ids.has(user.id) ||
        typeof user.username !== "string" || !/^[a-z0-9_.@-]{1,120}$/.test(user.username) || usernames.has(user.username) ||
        typeof user.name !== "string" || !user.name.trim() || user.name !== user.name.trim() || user.name.length > 120 || /[\u0000-\u001f\u007f]/.test(user.name) ||
        !ROLES.includes(user.role) || !validPasswordHash(user.passwordHash)) throw new AuthConfigurationError();
    ids.add(user.id);
    usernames.add(user.username);
  }
  return { mode: "credentials", secret, origin: origin.origin, users };
}

function isCanonicalBase64Url(value: string) {
  return /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}

function validPasswordHash(value: unknown): value is string {
  if (typeof value !== "string" || !/^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/.test(value)) return false;
  const [, salt, hash] = value.split("$");
  return isCanonicalBase64Url(salt) && isCanonicalBase64Url(hash);
}

async function derivePassword(password: string, salt: Buffer) {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => {
      if (error) reject(error); else resolve(result);
    });
  });
}

export async function hashPassword(password: string) {
  if (password.length < 14 || password.length > 256) throw new Error("Use a password between 14 and 256 characters.");
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  if (!validPasswordHash(encoded) || password.length > 256) return false;
  const [, salt, expected] = encoded.split("$");
  const actual = await derivePassword(password, Buffer.from(salt, "base64url"));
  const expectedBytes = Buffer.from(expected, "base64url");
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}

export function constantTimeEqual(a: string, b: string) {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function userVersion(user: AuthUser, secret: string) {
  return createHmac("sha256", secret).update(JSON.stringify([user.id, user.name, user.role, user.passwordHash])).digest("base64url");
}

export function createSession(user: AuthUser, config: Extract<AuthConfig, { mode: "credentials" }>, now = Date.now()) {
  const principal: Principal = { id: user.id, name: user.name, role: user.role, sessionId: randomUUID() };
  const payload = Buffer.from(JSON.stringify({ sub: user.id, sid: principal.sessionId, ver: userVersion(user, config.secret), iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + SESSION_SECONDS })).toString("base64url");
  const signature = createHmac("sha256", config.secret).update(payload).digest("base64url");
  return { token: `${payload}.${signature}`, principal };
}

export function verifySession(token: string, config: Extract<AuthConfig, { mode: "credentials" }>, now = Date.now()): Principal | null {
  if (token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, supplied] = parts;
  if (!isCanonicalBase64Url(payload) || supplied.length !== 43 || !isCanonicalBase64Url(supplied)) return null;
  const expected = createHmac("sha256", config.secret).update(payload).digest("base64url");
  if (!constantTimeEqual(supplied, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const seconds = Math.floor(now / 1000);
    if (!session || typeof session !== "object" || typeof session.sub !== "string" ||
        typeof session.sid !== "string" || !/^[a-f0-9-]{36}$/.test(session.sid) ||
        !Number.isInteger(session.iat) || !Number.isInteger(session.exp) ||
        session.iat > seconds + 30 || session.exp <= seconds || session.exp - session.iat !== SESSION_SECONDS) return null;
    const user = config.users.find((candidate) => candidate.id === session.sub);
    if (!user || !constantTimeEqual(String(session.ver), userVersion(user, config.secret))) return null;
    return { id: user.id, name: user.name, role: user.role, sessionId: session.sid };
  } catch { return null; }
}

export function readSession(request: Request, config: Extract<AuthConfig, { mode: "credentials" }>) {
  const token = (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) || "";
  return verifySession(token, config);
}

export function authError(error: string, status: number, code: string) {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function checkRequestOrigin(request: Request, config: AuthConfig) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (config.mode === "local") {
    const host = request.headers.get("host") || new URL(request.url).host;
    if (!isLoopbackHost(host)) return false;
    return !origin || origin === new URL(request.url).origin || origin === `http://${host}`;
  }
  return origin === config.origin;
}

export function authorizeRequest(request: Request, minimumRole: Role = "viewer"): Access | Response {
  let config: AuthConfig;
  try { config = getAuthConfig(); } catch (error) {
    reportAuthConfigurationError(error);
    return authError("Authentication is not configured. Contact the system administrator.", 503, "auth_not_configured");
  }
  if (config.mode === "local") {
    if (!localModeRequestAllowed(request)) {
      return authError("Local mode is restricted to loopback access.", 403, "local_only");
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !checkRequestOrigin(request, config)) {
      return authError("This request did not originate from this application.", 403, "invalid_origin");
    }
    return { principal: { id: "local-developer", name: "Local developer", role: "admin", sessionId: "" }, localMode: true };
  }
  const principal = readSession(request, config);
  if (!principal) return authError("Sign in to continue.", 401, "unauthenticated");
  if (ROLES.indexOf(principal.role) < ROLES.indexOf(minimumRole)) return authError("Your role does not permit this action.", 403, "forbidden");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !checkRequestOrigin(request, config)) {
    return authError("This request did not originate from this application.", 403, "invalid_origin");
  }
  return { principal, localMode: false };
}

export function testToolsEnabled(access: Access) {
  return access.localMode || (access.principal.role === "admin" && process.env.CARTFLOW_ENABLE_TEST_TOOLS === "true");
}

export function operatorSession(access: Access, clientSession: unknown) {
  if (typeof clientSession !== "string" || !clientSession.trim() || clientSession.length > 180) return "";
  if (access.localMode) return clientSession.trim();
  const config = getAuthConfig();
  if (config.mode !== "credentials") return "";
  return createHmac("sha256", config.secret)
    .update(JSON.stringify([access.principal.id, access.principal.sessionId, clientSession.trim()]))
    .digest("hex");
}

export function applyPrincipal<T extends { operatorName?: unknown; sessionId?: unknown }>(body: T, access: Access): T {
  return access.localMode ? body : { ...body, operatorName: access.principal.name, sessionId: operatorSession(access, body.sessionId) };
}

export function sessionCookie(token: string, secure: boolean, maxAge = SESSION_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
