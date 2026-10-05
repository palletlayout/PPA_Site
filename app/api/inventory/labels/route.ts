import { streamResponse } from "@/lib/stream-response";
import { NextRequest, NextResponse } from "next/server";
import { getInventoryExport } from "@/db/cart-store";
import { requireAccess } from "@/lib/auth-access";
import { generateInventoryLabelsPdf, InventoryLabelValidationError } from "@/lib/inventory-label-pdf";
import { requestErrorResponse } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/** One label for every active production container, independent of UI pagination. */
export async function GET(request: NextRequest) {
  const access = await requireAccess(request, "viewer");
  if (access instanceof Response) return access;
  try {
    const items = await getInventoryExport();
    if (!items.length) {
      return NextResponse.json({ error: "There are no inventory containers to print. Receive or import inventory first." }, {
        status: 404, headers: { "Cache-Control": "private, no-store" },
      });
    }
    const { bytes, filename } = await generateInventoryLabelsPdf(items);
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return streamResponse(body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Inventory-Label-Count": String(items.length),
      },
    });
  } catch (error) {
    if (error instanceof InventoryLabelValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
    }
    return requestErrorResponse(error, "Unable to generate inventory labels. Please try again.");
  }
}
