import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { DemandAppendError, receiveInventoryFromPhysicalLabel } from "@/db/cart-store";
import { requireAccess } from "@/lib/auth-access";
import { DemandCaptureValidationError, parseCaptureId } from "@/lib/demand-capture";
import { validateInventoryRows } from "@/lib/inventory-import";
import { MAX_IMPORT_ROWS } from "@/lib/import-validation";
import { readJsonBody, RequestError, requestErrorResponse, validateInput } from "@/lib/request-security";

// One import/row keeps the same receiving receipt across browser retries.
function rowReceiptId(importId: string, row: number) {
  const bytes = createHash("sha256").update(`ppa-inventory:${importId}:${row}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "supervisor");
  if (access instanceof Response) return access;
  let created = 0;
  let duplicate = 0;
  let rowNumber = 0;
  try {
    const body = await readJsonBody(request);
    const importId = parseCaptureId(body.importId);
    if (body.receiptKind !== undefined && body.receiptKind !== "received" && body.receiptKind !== "expected") {
      throw new RequestError("Inventory must be received stock or an expected shipment.");
    }
    if (!Number.isSafeInteger(body.startRow) || Number(body.startRow) < 0 || Number(body.startRow) >= MAX_IMPORT_ROWS) {
      throw new RequestError("A valid inventory import row offset is required.");
    }
    if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 10
      || Number(body.startRow) + body.rows.length > MAX_IMPORT_ROWS) {
      throw new RequestError(`Import inventory in batches of 1 to 10 rows, up to ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows per file.`);
    }
    if (body.fileName !== undefined && (typeof body.fileName !== "string" || body.fileName.length > 180 || /[\u0000-\u001f\u007f]/.test(body.fileName))) throw new RequestError("The inventory source filename is invalid.");
    const rows = validateInput(() => validateInventoryRows(body.rows as unknown[]));
    const operatorName = access.localMode && typeof body.operatorName === "string"
      ? body.operatorName.trim() : access.principal.name;
    for (const [index, row] of rows.entries()) {
      rowNumber = Number(body.startRow) + index + 2;
      const result = await receiveInventoryFromPhysicalLabel({
        captureId: rowReceiptId(importId, Number(body.startRow) + index), receiptSessionId: importId,
        rawValues: [`1S${row.aiagSerial}`, `P${row.partNumber}`, `C${row.color}`, `Q${row.quantity}`],
        operatorName, operatorId: access.principal.id,
        unitOfMeasure: row.unitOfMeasure, supplierId: row.supplierId, receiptKind: body.receiptKind === "expected" ? "expected" : row.receiptKind,
        palletId: row.palletId,
        weight: row.weight, unitCost: row.unitCost, receiveDate: row.receiveDate,
        provenance: { method: "spreadsheet_import", sourceFile: typeof body.fileName === "string" ? body.fileName : "", importId, rowNumber },
      });
      if (result.created) created++;
      else duplicate++;
    }
    return NextResponse.json({ ok: true, created, duplicate }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RequestError || error instanceof DemandCaptureValidationError || error instanceof DemandAppendError) {
      return NextResponse.json({ ok: false, error: error.message, created, duplicate, rowNumber }, {
        status: error instanceof DemandCaptureValidationError ? 400 : error.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return requestErrorResponse(error, "Inventory import stopped. Retry this file to confirm the saved rows.");
  }
}
