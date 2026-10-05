import { registerSession } from "@/lib/session-store";
import { authError, checkRequestOrigin, createSession, getAuthConfig, sessionCookie, testToolsEnabled, verifyPassword } from "@/lib/auth";
import { readJsonBody, requestErrorResponse } from "@/lib/request-security";
import { clearSuccessfulLoginLimit, consumeLoginAttempt, loginClientIdentity } from "@/lib/auth-rate-limit";

export const dynamic = "force-dynamic";
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;

export async function POST(request: Request) {
  try {
    let config;
    try { config = getAuthConfig(); } catch { return authError("Authentication is not configured. Contact the system administrator.", 503, "auth_not_configured"); }
    if (!checkRequestOrigin(request, config)) return authError("This request did not originate from this application.", 403, "invalid_origin");
    if (config.mode === "local") return authError("Local development does not use credential sign-in.", 409, "local_mode");
    const body = await readJsonBody(request, 4096);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || username.length > 120 || !password || password.length > 256) return authError("Enter a valid username and password.", 400, "invalid_credentials");
    let client: string;
    try {
      client = loginClientIdentity(request, config.origin);
      const limit = await consumeLoginAttempt(config, client, username);
      if (!limit.allowed) return Response.json({ error: "Too many sign-in attempts from this client. Try again later." }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
    } catch { return authError("Authentication is temporarily unavailable. Contact the system administrator.", 503, "auth_unavailable"); }
    const user = config.users.find((candidate) => candidate.username === username);
    const valid = await verifyPassword(password, user?.passwordHash || DUMMY_HASH);
    if (!valid || !user) return authError("The username or password is incorrect.", 401, "invalid_credentials");
    const { token, principal } = createSession(user, config);
    try { await registerSession(principal); await clearSuccessfulLoginLimit(config, client, username); }
    catch { return authError("Authentication is temporarily unavailable. Try again shortly.", 503, "auth_unavailable"); }
    const access = { principal, localMode: false };
    return Response.json({ authenticated: true, ...access, testToolsEnabled: testToolsEnabled(access) }, { headers: { "Set-Cookie": sessionCookie(token, config.origin.startsWith("https://")), "Cache-Control": "private, no-store" } });
  } catch (error) { return requestErrorResponse(error, "Unable to sign in. Try again."); }
}
