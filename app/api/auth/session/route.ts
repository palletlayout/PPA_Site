import { requireAccess } from "@/lib/auth-access";
import { testToolsEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await requireAccess(request);
  if (access instanceof Response) {
    if (access.status === 401) return Response.json({ authenticated: false, principal: null, localMode: false, testToolsEnabled: false }, { headers: { "Cache-Control": "private, no-store" } });
    return access;
  }
  return Response.json({ authenticated: true, ...access, testToolsEnabled: testToolsEnabled(access) }, { headers: { "Cache-Control": "private, no-store" } });
}
