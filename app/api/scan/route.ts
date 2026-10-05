import { requireAccess } from "@/lib/auth-access";
import { applyPrincipal } from "@/lib/auth";
import { readJsonBody, requestErrorResponse } from "@/lib/request-security";
import { NextRequest, NextResponse } from "next/server";
import { manageLock, recordScan } from "@/db/cart-store";
import { cleanScannerPayload } from "@/lib/scan-values";

export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "operator");
  if (access instanceof Response) return access;
  try {
    const body = applyPrincipal(await readJsonBody(request), access) as Record<string, unknown>;
    if (body.field !== "cartBarcode" || body.formatOnly || body.testMode) {
      return NextResponse.json({ ok: false, error: "Scan the PPA Cart ID here; use inventory serial fulfillment to pack a demand line." }, { status: 400 });
    }
    if (![body.lineId, body.cartKey, body.rawValue, body.sessionId, body.operatorName]
      .every((value) => typeof value === "string" && value.trim())
      || String(body.lineId).length > 180 || String(body.cartKey).length > 500
      || String(body.sessionId).length > 180 || String(body.operatorName).length > 120) {
      return NextResponse.json({ error: "Cart scan request is incomplete or contains an oversized identifier." }, { status: 400 });
    }
    const rawValue = cleanScannerPayload(String(body.rawValue));
    if (!rawValue || rawValue.length > 512) return NextResponse.json({ error: "Scanned value is empty or too long." }, { status: 400 });
    const context = { lineId: String(body.lineId).trim(), cartKey: String(body.cartKey).trim(),
      sessionId: String(body.sessionId).trim(), operatorName: String(body.operatorName).trim(), operatorId: access.principal.id };
    const lock = await manageLock({ ...context, action: "renew" });
    if (!lock.locked) return NextResponse.json({ ok: false, reason: "lock_lost", lock: lock.lock }, { status: 409 });
    const result = await recordScan({ ...context, field: "cartBarcode", value: rawValue, rawValue, operatorId: access.principal.id });
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) { return requestErrorResponse(error, "Unable to record the cart scan."); }
}
