import { requireAccess } from "@/lib/auth-access";
import { operationalHealth } from "@/db/health";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await requireAccess(request, "supervisor");
  if (access instanceof Response) return access;
  const result=await operationalHealth();
  return Response.json(result,{ status:result.status==="ready" ? 200 : 503, headers:{"Cache-Control":"private, no-store"} });
}
