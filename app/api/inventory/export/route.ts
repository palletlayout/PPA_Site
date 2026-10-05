import { streamResponse } from "@/lib/stream-response";
import { NextRequest, NextResponse } from "next/server";
import { getInventoryExport } from "@/db/cart-store";
import { requireAccess } from "@/lib/auth-access";
import { serializeCsvCell } from "@/lib/csv";
import { DemandCaptureValidationError } from "@/lib/demand-capture";
import { requestErrorResponse } from "@/lib/request-security";
import type { InventoryItem } from "@/lib/inventory-types";

export const dynamic = "force-dynamic";

const COLUMNS: readonly [keyof InventoryItem, string][] = [
  ["id", "Inventory ID"], ["supplierId", "Supplier ID"], ["unitOfMeasure", "Unit of Measure"],
  ["palletId", "Pallet ID"],
  ["fulfillmentStage", "Fulfillment Stage"], ["loadedAt", "Loaded At"], ["dispatchedAt", "Dispatched At"], ["serial", "Container serial"], ["partNumber", "Part number"],
  ["color", "Color"], ["quantity", "Quantity"], ["status", "Status"],
  ["consumedFlag", "Consumed Flag"], ["consumedQuantity", "Consumed Quantity"], ["remainingQuantity", "Remaining Quantity"], ["consumedAt", "Consumed At"],
  ["fulfilledDemandId", "Fulfilled Demand ID"], ["fulfilledDemandIds", "Fulfilled Demand IDs"],
  ["weight", "Weight"], ["unitCost", "Unit Cost"], ["receiveDate", "Receive Date"],
  ["receivedAt", "Received at"], ["receivedBy", "Received by"],
  ["acquisitionMethod", "Acquisition Method"], ["sourceFile", "Source File"], ["sourceImportId", "Source Import ID"],
  ["sourceRow", "Source Row"], ["recordedAt", "Initially Recorded At"], ["scannedValuesJson", "Captured Label Input JSON"],
  ["loadedQuantity", "Loaded Quantity"], ["dispatchedQuantity", "Dispatched Quantity"],
];

export async function GET(request: NextRequest) {
  const access = await requireAccess(request, "viewer");
  if (access instanceof Response) return access;
  try {
    const items = await getInventoryExport(request.nextUrl.searchParams.get("q") ?? "");
    const csv = [
      COLUMNS.map(([, label]) => serializeCsvCell(label)).join(","),
      ...items.map((item) => COLUMNS.map(([key]) => serializeCsvCell(item[key])).join(",")),
    ].join("\r\n");
    return streamResponse(`\uFEFF${csv}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ppa-inventory-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof DemandCaptureValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return requestErrorResponse(error, "Unable to export received inventory.");
  }
}
