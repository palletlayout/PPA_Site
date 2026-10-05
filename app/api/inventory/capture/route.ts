import { requireAccess } from "@/lib/auth-access";
import { type Access, applyPrincipal, testToolsEnabled } from "@/lib/auth";
import { readJsonBody, requestErrorResponse } from "@/lib/request-security";
import { NextRequest, NextResponse } from "next/server";
import {
  appendTestDemandFromPhysicalLabel,
  DemandAppendError,
  IntegrationImportError,
} from "@/db/cart-store";
import { DemandCaptureValidationError } from "@/lib/demand-capture";

async function handlePOST(request: NextRequest, access: Access) {
  try {
    const suppliedBody: unknown = await readJsonBody(request);
    if (!suppliedBody || typeof suppliedBody !== "object" || Array.isArray(suppliedBody)) {
      return NextResponse.json({ error: "Physical-label capture must be a JSON object." }, { status: 400 });
    }
    const body = applyPrincipal(suppliedBody as {
      captureId?: unknown;
      testSessionId?: unknown;
      rawValues?: unknown;
      operatorName?: unknown;
    }, access);
    const captureId = typeof body.captureId === "string" ? body.captureId.trim() : "";
    const testSessionId = typeof body.testSessionId === "string" ? body.testSessionId.trim() : "";
    const operatorName = typeof body.operatorName === "string" ? body.operatorName.trim() : "";
    if (!captureId || !testSessionId || !operatorName) {
      return NextResponse.json(
        { error: "Provide a capture identifier, test session, and operator name." },
        { status: 400 },
      );
    }
    if (captureId.length > 80 || testSessionId.length > 80 || operatorName.length > 120) {
      return NextResponse.json({ error: "The capture request contains an oversized identifier." }, { status: 400 });
    }

    const result = await appendTestDemandFromPhysicalLabel({
      captureId,
      testSessionId,
      rawValues: body.rawValues,
      operatorName,
    });
    const status = result.projectionStatus === "failed"
      ? 202
      : result.inventoryCreated ? 201 : 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Physical-label capture must be valid JSON." }, { status: 400 });
    }
    if (error instanceof DemandCaptureValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DemandAppendError || error instanceof IntegrationImportError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return requestErrorResponse(error, "Unable to capture the physical inventory label.");
  }
}

export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "admin");
  if (access instanceof Response) return access;
  if (!testToolsEnabled(access)) return NextResponse.json({ error: "Test inventory capture is disabled." }, { status: 403 });
  try { return await handlePOST(request, access); }
  catch (error) { return requestErrorResponse(error, "Unable to complete this request."); }
}
