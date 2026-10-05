import { requireAccess } from "@/lib/auth-access";
import { requestErrorResponse, RequestError } from "@/lib/request-security";
import { readDemandImportRequest } from "@/lib/demand-import-request";
import { NextRequest, NextResponse } from "next/server";
import {
  appendImportRow,
  DemandAppendError,
  IntegrationImportError,
  replaceImport,
} from "@/db/cart-store";
import { DemandReconciliationError, SnapshotShrinkError } from "@/db/demand-reconciliation";
import type { Access } from "@/lib/auth";
import { reportDemandSnapshotRefused } from "@/lib/observability";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

async function handlePOST(request: NextRequest, access: Access) {
  try {
    const body = await readDemandImportRequest(request);
    const action = clean(body.action).toLowerCase();
    if (action && action !== "replace" && action !== "append") {
      throw new RequestError("Import action must be replace or append.");
    }
    if (action === "append" && body.rows.length !== 1) {
      throw new RequestError("A manual append must contain exactly one demand row.");
    }
    const rows = body.rows;
    if (action === "append") {
      return NextResponse.json(await appendImportRow(
        clean(body.fileName) || "manual-demand-row.json",
        rows[0],
        undefined,
        access.principal,
      ));
    }
    return NextResponse.json(await replaceImport(clean(body.fileName) || "pick-list.xlsx", rows, undefined, access.principal, { allowShrink: body.allowShrink }));
  } catch (error) {
    if (error instanceof DemandReconciliationError) return NextResponse.json({ error: error.message, code: error.code, issues: error.issues }, { status: error.status });
    if (error instanceof SnapshotShrinkError) {
      reportDemandSnapshotRefused("manual", error.shrink);
      return NextResponse.json({ error: error.message, code: error.code, shrink: error.shrink }, { status: error.status });
    }
    if (error instanceof IntegrationImportError || error instanceof DemandAppendError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return requestErrorResponse(error, "Import failed.");
  }
}

export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "supervisor");
  if (access instanceof Response) return access;
  try { return await handlePOST(request, access); }
  catch (error) { return requestErrorResponse(error, "Unable to complete this request."); }
}
