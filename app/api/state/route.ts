import { snapshotJsonResponse } from "@/lib/stream-response";
import { requireAccess } from "@/lib/auth-access";
import { type Access, operatorSession } from "@/lib/auth";
import { requestErrorResponse } from "@/lib/request-security";
import { NextRequest } from "next/server";
import { getAppState } from "@/db/cart-store";

export const dynamic = "force-dynamic";

async function handleGET(request: NextRequest, access: Access) {
  try {
    const sessionId = operatorSession(access, request.headers.get("x-cartflow-session"));
    return snapshotJsonResponse(await getAppState(sessionId, access.principal?.id || ""), request);
  } catch (error) {
    return requestErrorResponse(error, "Unable to load PPA.");
  }
}

export async function GET(request: NextRequest) {
  const access = await requireAccess(request, "viewer");
  if (access instanceof Response) return access;
  try { return await handleGET(request, access); }
  catch (error) { return requestErrorResponse(error, "Unable to complete this request."); }
}
