import { NextRequest, NextResponse } from "next/server";
import { closePicklist, DemandMutationError } from "@/db/cart-store";
import { requireAccess } from "@/lib/auth-access";
import { applyPrincipal } from "@/lib/auth";
import { readJsonBody, RequestError, requestErrorResponse } from "@/lib/request-security";

export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "operator");
  if (access instanceof Response) return access;
  try {
    const body = applyPrincipal(await readJsonBody(request), access);
    if (typeof body.cartKey !== "string" || !body.cartKey.trim() || body.cartKey.length > 500
      || typeof body.sessionId !== "string" || !body.sessionId.trim() || body.sessionId.length > 180) throw new RequestError("A picklist and scanner session are required.");
    if (typeof body.operatorName !== "string" || !body.operatorName.trim() || body.operatorName.length > 120) throw new RequestError("A valid operator name is required.");
    return NextResponse.json(await closePicklist({ cartKey: body.cartKey.trim(), sessionId: body.sessionId.trim(), operatorName: body.operatorName.trim(), operatorId: access.principal.id }));
  } catch (error) {
    if (error instanceof DemandMutationError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return requestErrorResponse(error, "Unable to close the picklist.");
  }
}
