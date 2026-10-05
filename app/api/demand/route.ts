import { requireAccess } from "@/lib/auth-access";
import { DatabaseConflictError } from "@/db/index";
import { type Access } from "@/lib/auth";
import { readJsonBody, requestErrorResponse } from "@/lib/request-security";
import { NextRequest, NextResponse } from "next/server";
import {
  deleteDemandLine,
  DemandMutationError,
  updateDemandLine,
} from "@/db/cart-store";
import type { DemandLinePatch } from "@/lib/types";

function mutationError(error: unknown) {
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Demand request must be valid JSON." }, { status: 400 });
  }
  if (error instanceof DemandMutationError || error instanceof DatabaseConflictError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return requestErrorResponse(error, "Unable to maintain demand.");
}

async function handlePATCH(request: NextRequest, access: Access) {
  try {
    const body = await readJsonBody(request) as { lineId?: string; changes?: DemandLinePatch };
    const lineId = String(body.lineId || "").trim();
    if (!lineId || !body.changes || typeof body.changes !== "object" || Array.isArray(body.changes)) {
      return NextResponse.json({ error: "Line ID and demand changes are required." }, { status: 400 });
    }
    return NextResponse.json(await updateDemandLine(lineId, body.changes, access.principal));
  } catch (error) {
    return mutationError(error);
  }
}

async function handleDELETE(request: NextRequest, access: Access) {
  try {
    const body = await readJsonBody(request) as { lineId?: string };
    const lineId = String(body.lineId || request.nextUrl.searchParams.get("lineId") || "").trim();
    if (!lineId) return NextResponse.json({ error: "Line ID is required." }, { status: 400 });
    return NextResponse.json(await deleteDemandLine(lineId, access.principal));
  } catch (error) {
    return mutationError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const access = await requireAccess(request, "supervisor");
  if (access instanceof Response) return access;
  try { return await handlePATCH(request, access); }
  catch (error) { return requestErrorResponse(error, "Unable to complete this request."); }
}

export async function DELETE(request: NextRequest) {
  const access = await requireAccess(request, "supervisor");
  if (access instanceof Response) return access;
  try { return await handleDELETE(request, access); }
  catch (error) { return requestErrorResponse(error, "Unable to complete this request."); }
}
