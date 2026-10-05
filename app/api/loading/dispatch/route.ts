import { requireAccess } from "@/lib/auth-access";
import { type Access, applyPrincipal } from "@/lib/auth";
import { readJsonBody, requestErrorResponse } from "@/lib/request-security";
import { NextRequest, NextResponse } from "next/server";
import { confirmPicklistDispatch } from "@/db/cart-store";

async function handlePOST(request: NextRequest, access: Access) {
  let body: { movementValue?: unknown; cartBarcode?: unknown; operatorName?: unknown };
  try {
    body = applyPrincipal(await readJsonBody(request), access);
  } catch (error) {
    return requestErrorResponse(error, "Unable to read the request.");
  }
  if (typeof body.movementValue !== "string" || typeof body.cartBarcode !== "string" ||
      typeof body.operatorName !== "string") {
    return NextResponse.json({ ok: false, reason: "invalid", error: "Dispatch request is incomplete." }, { status: 400 });
  }

  const result = await confirmPicklistDispatch({
    operatorId: access.principal.id,
    movementValue: body.movementValue,
    cartBarcode: body.cartBarcode,
    operatorName: body.operatorName,
  });
  if (result.ok) return NextResponse.json(result);
  return NextResponse.json(result, { status: result.reason === "invalid" ? 400 : result.reason === "cart_missing" ? 404 : 409 });
}

export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "operator");
  if (access instanceof Response) return access;
  try { return await handlePOST(request, access); }
  catch (error) { return requestErrorResponse(error, "Unable to complete this request."); }
}
