import { NextRequest, NextResponse } from "next/server";
import { requireAccess } from "@/lib/auth-access";
import { applyPrincipal } from "@/lib/auth";
import { readJsonBody, requestErrorResponse } from "@/lib/request-security";
import { fulfillDemand, getFulfillmentReceipt } from "@/db/cart-store";
import { packingReceiptForResult } from "@/lib/packing-scan";

export async function GET(request: NextRequest) {
  const access = await requireAccess(request, "operator");
  if (access instanceof Response) return access;
  const query = request.nextUrl.searchParams;
  const cartKey = query.get("cartKey") || "";
  const serial = query.get("serial") || "";
  const requestId = query.get("requestId") || "";
  const serialFormat = query.get("serialFormat");
  const supplierId = query.has("supplierId") ? query.get("supplierId")! : undefined;
  if (!cartKey || cartKey.length > 500 || !serial || serial.length > 512 || !requestId.trim() || requestId.length > 180
    || (serialFormat !== "barcode" && serialFormat !== "canonical") || (supplierId !== undefined && supplierId.length > 180)) {
    return NextResponse.json({ ok: false, error: "Provide a valid saved packing request." }, { status: 400 });
  }
  try {
    const result = await getFulfillmentReceipt({ cartKey, serial, serialFormat, supplierId, requestId });
    return NextResponse.json(result, { status: result.ok ? 200 : 409, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return requestErrorResponse(error, "Unable to check the saved packing receipt."); }
}

export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "operator");
  if (access instanceof Response) return access;
  try {
    const body = applyPrincipal(await readJsonBody(request), access) as Record<string, unknown>;
    const requiredFields = ["cartKey", "serial", "sessionId", "operatorName"] as const;
    if (requiredFields.some((field) => typeof body[field] !== "string" || !String(body[field]).trim())
      || (body.lineId !== undefined && (typeof body.lineId !== "string" || !String(body.lineId).trim()))
      || (body.lineId !== undefined && String(body.lineId).length > 180)
      || (body.requestId !== undefined && (typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 180))
      || (body.serialFormat !== undefined && body.serialFormat !== "barcode" && body.serialFormat !== "canonical")
      || String(body.cartKey).length > 500
      || (body.supplierId !== undefined && (typeof body.supplierId !== "string" || body.supplierId.length > 180))
      || String(body.serial).length > 512 || String(body.sessionId).length > 180 || String(body.operatorName).length > 120) {
      return NextResponse.json({ ok: false, error: "Fulfillment requires a cart, inventory serial, session, and operator." }, { status: 400 });
    }
    const result = await fulfillDemand({
      ...(body.lineId ? { lineId: String(body.lineId).trim() } : {}),
      cartKey: String(body.cartKey).trim(),
      serial: String(body.serial), serialFormat: body.serialFormat as "barcode" | "canonical" | undefined, sessionId: String(body.sessionId).trim(),
      supplierId: body.supplierId as string | undefined, requestId: body.requestId as string | undefined, quantity: body.quantity,
      operatorName: String(body.operatorName).trim(), operatorId: access.principal.id,
    });
    const receipt = packingReceiptForResult(result, String(body.serial));
    // The scan succeeded but needs physical label capture before allocation.
    // Keep ok=false until stock is actually packed, including for older clients.
    return NextResponse.json({ ...result, ...(receipt ? { nextAction: "receive_inventory" } : {}) }, { status: result.ok || receipt ? 200 : 409 });
  } catch (error) { return requestErrorResponse(error, "Unable to fulfill demand."); }
}
