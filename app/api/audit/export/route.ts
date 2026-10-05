import { streamResponse } from "@/lib/stream-response";
import { requireAccess } from "@/lib/auth-access";
import { requestErrorResponse } from "@/lib/request-security";
import { getDemandAuditExport, MAX_AUDIT_EXPORT_ROWS, serializeDemandAuditCsv } from "@/db/audit-export";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request, "supervisor");
    if (access instanceof Response) return access;
    const page = await getDemandAuditExport(new URL(request.url).searchParams.get("before") || "");
    const date = new Date().toISOString().slice(0, 10);
    const headers: Record<string, string> = {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ppa-demand-audit-${date}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-CartFlow-Export-Limit": String(MAX_AUDIT_EXPORT_ROWS),
      "X-CartFlow-Export-Has-Older-Records": String(page.hasOlderRecords),
    };
    if (page.nextBefore) headers.Link = `</api/audit/export?before=${page.nextBefore}>; rel="next"`;
    return streamResponse(`\uFEFF${serializeDemandAuditCsv(page, new URL(request.url).origin)}`, { headers });
  } catch (error) {
    return requestErrorResponse(error, "Unable to export demand audit history.");
  }
}
