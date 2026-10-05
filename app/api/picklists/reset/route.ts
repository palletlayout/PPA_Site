import { NextRequest, NextResponse } from "next/server";
import { resetPicklist, DemandMutationError } from "@/db/cart-store";
import { operatorSession } from "@/lib/auth";
import { requireAccess } from "@/lib/auth-access";
import { readJsonBody, RequestError, requestErrorResponse } from "@/lib/request-security";

export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "supervisor");
  if (access instanceof Response) return access;
  try {
    const body = await readJsonBody(request);
    if (typeof body.cartKey !== "string" || !body.cartKey.trim() || body.cartKey.length > 500
      || (body.sessionId !== undefined && (typeof body.sessionId !== "string" || body.sessionId.length > 180))) throw new RequestError("A valid picklist and scanner session are required.");
    return NextResponse.json(await resetPicklist({ cartKey: body.cartKey.trim(), sessionId: body.sessionId ? operatorSession(access, String(body.sessionId)) : undefined, operatorName: access.principal.name, operatorId: access.principal.id }));
  } catch (error) {
    if (error instanceof DemandMutationError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return requestErrorResponse(error, "Unable to reset the picklist.");
  }
}
