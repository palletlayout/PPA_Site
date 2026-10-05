import { NextRequest, NextResponse } from "next/server";
import { requireAccess } from "@/lib/auth-access";
import { readJsonBody, requestErrorResponse, RequestError } from "@/lib/request-security";
import { listRawCaptureSessions, listRawScans, saveRawScan } from "@/db/raw-capture";
import { validCaptureSession } from "@/lib/raw-capture";

export async function GET(request: NextRequest) {
  const access = await requireAccess(request, "operator");
  if (access instanceof Response) return access;
  try {
    const ownerId = ["admin", "supervisor"].includes(access.principal.role) ? undefined : access.principal.id;
    const sessionId = request.nextUrl.searchParams.get("sessionId");
    if (!sessionId) return NextResponse.json({ sessions: await listRawCaptureSessions(ownerId) }, { headers: { "Cache-Control": "no-store" } });
    if (!validCaptureSession(sessionId)) throw new RequestError("Invalid capture session.");
    const scans = await listRawScans(sessionId, ownerId);
    if (request.nextUrl.searchParams.get("format") === "txt") {
      return new Response(scans.map((scan) => scan.rawValue).join("\n") + (scans.length ? "\n" : ""), {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="ppa-capture-${sessionId}.txt"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    return NextResponse.json({ scans }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return requestErrorResponse(error, "Unable to read captured scans."); }
}

export async function POST(request: NextRequest) {
  const access = await requireAccess(request, "operator");
  if (access instanceof Response) return access;
  try { return NextResponse.json({ scan: await saveRawScan(await readJsonBody(request), access.principal) }); }
  catch (error) { return requestErrorResponse(error, "Unable to save this scan. Retry when connected."); }
}
