import { authError, authorizeRequest, type Access, type Role } from "./auth.ts";
import { isSessionActive } from "./session-store.ts";

/** Application boundary: cryptographic, role, origin AND durable session authorization. */
export async function requireAccess(request: Request, minimumRole: Role = "viewer"): Promise<Access | Response> {
  const access = authorizeRequest(request, minimumRole);
  if (access instanceof Response || access.localMode) return access;
  try {
    if (!await isSessionActive(access.principal)) return authError("Your session has ended. Sign in again.", 401, "unauthenticated");
    return access;
  } catch {
    return authError("Authentication is temporarily unavailable. Try again shortly.", 503, "auth_unavailable");
  }
}
