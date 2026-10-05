import { NextRequest, NextResponse } from "next/server";
import { DemandAppendError, receiveInventoryFromPhysicalLabel, receiveExpectedInventory } from "@/db/cart-store";
import { requireAccess } from "@/lib/auth-access";
import { applyPrincipal } from "@/lib/auth";
import { DemandCaptureValidationError } from "@/lib/demand-capture";
import { readJsonBody, requestErrorResponse } from "@/lib/request-security";

export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "operator");
  if (access instanceof Response) return access;
  try {
    const supplied = await readJsonBody(request);
    const body = applyPrincipal(supplied as {
      captureId?: unknown;
      receiptSessionId?: unknown;
      rawValues?: unknown;
      inventoryId?: unknown;
      unitOfMeasure?: string;
      supplierId?: string;
      palletId?: string;
      operatorName?: unknown;
    }, access);
    const identity = {
      captureId: body.captureId,
      receiptSessionId: body.receiptSessionId,
      operatorName: typeof body.operatorName === "string" ? body.operatorName : "",
      operatorId: access.principal.id,
    };
    const result = body.inventoryId !== undefined
      ? await receiveExpectedInventory({ ...identity, inventoryId: body.inventoryId })
      : await receiveInventoryFromPhysicalLabel({ ...identity, rawValues: body.rawValues,
        unitOfMeasure: body.unitOfMeasure, supplierId: body.supplierId, palletId: body.palletId });
    return NextResponse.json(result, {
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DemandCaptureValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DemandAppendError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return requestErrorResponse(error, "Unable to receive inventory. Retry the same receipt to confirm its result.");
  }
}
