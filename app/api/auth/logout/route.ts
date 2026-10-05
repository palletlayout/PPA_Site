import { revokeSession } from "@/lib/session-store";
import { authError, checkRequestOrigin, getAuthConfig, sessionCookie, readSession } from "@/lib/auth";

export async function POST(request: Request) {
  let config;
  try { config = getAuthConfig(); } catch { return authError("Authentication is not configured.", 503, "auth_not_configured"); }
  if (!checkRequestOrigin(request, config)) return authError("This request did not originate from this application.", 403, "invalid_origin");
  if (config.mode === "credentials") {
    const principal = readSession(request, config);
    if (principal) {
      try { await revokeSession(principal); }
      catch { return authError("Unable to end this session. Try again shortly.", 503, "auth_unavailable"); }
    }
  }
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", config.mode === "credentials" && config.origin.startsWith("https://"), 0), "Cache-Control": "private, no-store" } });
}
