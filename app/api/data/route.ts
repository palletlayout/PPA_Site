import { requireAccess } from "@/lib/auth-access";
import { readJsonBody, requestErrorResponse } from "@/lib/request-security";
import { NextRequest, NextResponse } from "next/server";
import { clearAllData } from "@/db/cart-store";
import type { Access } from "@/lib/auth";

const DELETE_CONFIRMATION = "DELETE_ALL_CARTFLOW_DATA";

async function handleDELETE(request: NextRequest, access: Access) {
  try {
    const body = await readJsonBody(request) as { confirmation?: string };
    if (body.confirmation !== DELETE_CONFIRMATION) {
      return NextResponse.json(
        { error: "Explicit confirmation is required to delete all PPA data." },
        { status: 400 },
      );
    }
    return NextResponse.json(await clearAllData(access.principal));
  } catch (error) {
    return requestErrorResponse(error, "Unable to delete PPA data.");
  }
}

export async function DELETE(request: NextRequest) {
  const access = await requireAccess(request, "admin");
  if (access instanceof Response) return access;
  if (!access.localMode) return NextResponse.json({error:"Full data deletion is only available in local development. Production history must be retained."},{status:403});
  try { return await handleDELETE(request, access); }
  catch (error) { return requestErrorResponse(error, "Unable to complete this request."); }
}
