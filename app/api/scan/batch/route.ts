import { NextRequest, NextResponse } from "next/server";
import { requireAccess } from "@/lib/auth-access";
import { applyPrincipal } from "@/lib/auth";
import { readJsonBody, requestErrorResponse } from "@/lib/request-security";
import { fulfillDemand } from "@/db/cart-store";

/** Compatibility endpoint for cameras sending a single serial barcode. */
export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "operator");
  if (access instanceof Response) return access;
  try {
    const body = applyPrincipal(await readJsonBody(request), access) as Record<string, unknown>;
    if (body.formatOnly || body.testMode || !Array.isArray(body.values) || body.values.length !== 1
      || typeof body.values[0] !== "string" || !body.values[0].trim() || body.values[0].length > 512
      || ![body.lineId, body.cartKey, body.sessionId, body.operatorName].every((value) => typeof value === "string" && value.trim())
      || String(body.lineId).length > 180 || String(body.cartKey).length > 500
      || String(body.sessionId).length > 180 || String(body.operatorName).length > 120) {
      return NextResponse.json({ ok: false, error: "Scan one inventory serial to fulfill demand. Four-field verification has been retired." }, { status: 400 });
    }
    const serial = body.values[0];
    const result = await fulfillDemand({ lineId: String(body.lineId).trim(), cartKey: String(body.cartKey).trim(),
      serial, serialFormat: "barcode", sessionId: String(body.sessionId).trim(), operatorName: String(body.operatorName).trim(), operatorId: access.principal.id });
    return NextResponse.json({ ...result, scans: result.ok ? [{ field: "aiagSerial", rawValue: serial }] : [] }, { status: result.ok ? 200 : 409 });
  } catch (error) { return requestErrorResponse(error, "Unable to fulfill demand."); }
}
