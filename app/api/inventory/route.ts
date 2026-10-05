import { NextRequest, NextResponse } from "next/server";
import { DemandAppendError, listInventory, setInventoryDeleted } from "@/db/cart-store";
import { requireAccess } from "@/lib/auth-access";
import { DemandCaptureValidationError } from "@/lib/demand-capture";
import { readJsonBody, requestErrorResponse } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function positiveInteger(value: string | null, fallback: number) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new DemandCaptureValidationError("Inventory page and page size must be positive whole numbers.");
  }
  return Number(value);
}

export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status") || "active";
  const access = await requireAccess(request, status === "deleted" ? "supervisor" : "viewer");
  if (access instanceof Response) return access;
  try {
    if (!["active", "deleted"].includes(status)) throw new DemandCaptureValidationError("Inventory status must be active or deleted.");
    const params = request.nextUrl.searchParams;
    return NextResponse.json(await listInventory({
      q: params.get("q") ?? "",
      page: positiveInteger(params.get("page"), 1),
      pageSize: positiveInteger(params.get("pageSize"), 50),
      deleted: status === "deleted",
    }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DemandCaptureValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return requestErrorResponse(error, "Unable to load received inventory.");
  }
}

async function changeInventory(request: NextRequest, deleted: boolean) {
  const access = await requireAccess(request, "supervisor");
  if (access instanceof Response) return access;
  try {
    const body = await readJsonBody(request) as { id?: unknown; confirmation?: unknown; operatorName?: unknown };
    if (body.confirmation !== (deleted ? "DELETE_INVENTORY" : "RESTORE_INVENTORY")) {
      return NextResponse.json({ error: "Confirm the inventory action before submitting it." }, { status: 400 });
    }
    const result = await setInventoryDeleted({ id: body.id, deleted,
      operatorId: access.principal.id,
      operatorName: access.localMode && typeof body.operatorName === "string" ? body.operatorName : access.principal.name });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DemandCaptureValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof DemandAppendError) return NextResponse.json({ error: error.message }, { status: error.status });
    return requestErrorResponse(error, "Unable to change inventory. Check its current status before trying again.");
  }
}

export async function DELETE(request: NextRequest) { return changeInventory(request, true); }
export async function PATCH(request: NextRequest) { return changeInventory(request, false); }
