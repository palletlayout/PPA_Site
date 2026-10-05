import { streamResponse } from "@/lib/stream-response";
import { requireAccess } from "@/lib/auth-access";
import { readJsonBody, requestErrorResponse, validateInput } from "@/lib/request-security";
import { NextRequest, NextResponse } from "next/server";
import { getMovementPdfLines, getPicklistPdfLines, getSectionPdfLines, DemandMutationError } from "@/db/cart-store";
import { validatePrintableFields } from "@/lib/import-validation";
import { generatePicklistPdf } from "@/lib/picklist-pdf";

export const dynamic = "force-dynamic";

function cleanLineId(value: unknown) {
  return String(value ?? "").trim().slice(0, 180);
}

function cleanScope(value: unknown): "picklist" | "movement" | "section" | null {
  if (value === undefined || value === null || value === "") return "picklist";
  return value === "picklist" || value === "movement" || value === "section" ? value : null;
}

async function handlePOST(request: NextRequest) {
  try {
    const body = await readJsonBody(request);
    const lineId = cleanLineId(body.lineId);
    const scope = cleanScope(body.scope);
    if (!scope) {
      return NextResponse.json({ error: "PDF scope must be picklist, movement or section." }, { status: 400 });
    }
    if (scope === "section" && body.areaType !== "onsite" && body.areaType !== "offsite") {
      return NextResponse.json({ error: "PDF section must be onsite or offsite." }, { status: 400 });
    }
    if (scope === "section" && body.workScope !== "production" && body.workScope !== "test") {
      return NextResponse.json({ error: "PDF work scope must be production or test." }, { status: 400 });
    }
    if (scope !== "section" && !lineId) {
      return NextResponse.json({ error: `Choose a ${scope} before generating its PDF.` }, { status: 400 });
    }

    const lines = scope === "section"
      ? await getSectionPdfLines(body.areaType as "onsite" | "offsite", body.workScope as "production" | "test")
      : scope === "movement" ? await getMovementPdfLines(lineId) : await getPicklistPdfLines(lineId);
    if (!lines.length) {
      return NextResponse.json({ error: `That ${scope} is no longer in the current work queue.` }, { status: 404 });
    }

    validateInput(() => lines.forEach((line) => validatePrintableFields(line)));
    const { bytes, filename } = await generatePicklistPdf(lines, { scope });
    const bodyBytes = new Uint8Array(bytes.byteLength);
    bodyBytes.set(bytes);
    return streamResponse(bodyBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof DemandMutationError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "PDF request must be valid JSON." }, { status: 400 });
    }
    return requestErrorResponse(error, "Unable to generate this checksheet PDF.");
  }
}

export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "viewer");
  if (access instanceof Response) return access;
  try { return await handlePOST(request); }
  catch (error) { return requestErrorResponse(error, "Unable to complete this request."); }
}
