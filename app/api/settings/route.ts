import { NextRequest, NextResponse } from "next/server";
import { getFulfillmentSettings, updateFulfillmentSettings, DemandMutationError } from "@/db/cart-store";
import { requireAccess } from "@/lib/auth-access";
import { readJsonBody, requestErrorResponse } from "@/lib/request-security";

export async function GET(request: NextRequest) {
  const access = await requireAccess(request);
  if (access instanceof Response) return access;
  try {
    return NextResponse.json({ settings: await getFulfillmentSettings() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return requestErrorResponse(error, "Unable to read fulfillment settings."); }
}

export async function PATCH(request: NextRequest) {
  const access = await requireAccess(request, "supervisor");
  if (access instanceof Response) return access;
  try {
    return NextResponse.json({ settings: await updateFulfillmentSettings(await readJsonBody(request), access.principal) });
  } catch (error) {
    if (error instanceof DemandMutationError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return requestErrorResponse(error, "Unable to save fulfillment settings.");
  }
}
