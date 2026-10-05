import { requireAccess } from "@/lib/auth-access";
import { type Access, applyPrincipal } from "@/lib/auth";
import { readJsonBody, requestErrorResponse } from "@/lib/request-security";
import { NextRequest, NextResponse } from "next/server";
import { manageLock } from "@/db/cart-store";

async function handlePOST(request: NextRequest, access: Access) {
  try {
    let body: {
      action?: "acquire" | "renew" | "release" | "release_own";
      cartKey?: string;
      picklistKey?: string;
      sessionId?: string;
      operatorName?: string;
    };
    try {
      body = applyPrincipal(await readJsonBody(request), access);
    } catch (error) {
      return requestErrorResponse(error, "Unable to read the request.");
    }
    if (![body.cartKey, body.operatorName].every((value) => typeof value === "string" && value.trim()) ||
        (body.sessionId !== undefined && typeof body.sessionId !== "string") ||
        (body.picklistKey !== undefined && typeof body.picklistKey !== "string")) {
      return NextResponse.json({ error: "Lock identifiers must be nonempty strings." }, { status: 400 });
    }
    const picklistKey = body.picklistKey?.trim();
    const expectedPicklistKey = body.cartKey?.split("::").slice(0, 4).join("::");
    const actions = ["acquire", "renew", "release", "release_own"] as const;
    if (!body.action || !actions.includes(body.action) ||
        !body.cartKey || !body.operatorName ||
        (body.action !== "release_own" && !body.sessionId) ||
        (body.action === "acquire" && !picklistKey) ||
        (picklistKey && picklistKey !== expectedPicklistKey)) {
      return NextResponse.json({ error: "Lock request is incomplete." }, { status: 400 });
    }
    if (body.cartKey.length > 500 || (body.sessionId || "").length > 180 || body.operatorName.length > 120 ||
        (picklistKey && picklistKey.length > 400)) {
      return NextResponse.json({ error: "Lock request contains an oversized identifier." }, { status: 400 });
    }
    const result = await manageLock({
      action: body.action,
      cartKey: body.cartKey.trim(),
      picklistKey,
      sessionId: (body.sessionId || "").trim(),
      operatorName: body.operatorName.trim(),
      operatorId: access.principal.id,
    });
    return NextResponse.json(result, { status: "locked" in result && !result.locked ? 409 : 200 });
  } catch (error) {
    return requestErrorResponse(error, "Unable to update the cart lock.");
  }
}

export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "operator");
  if (access instanceof Response) return access;
  try { return await handlePOST(request, access); }
  catch (error) { return requestErrorResponse(error, "Unable to complete this request."); }
}
