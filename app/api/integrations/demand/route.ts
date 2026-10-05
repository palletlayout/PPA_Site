import { requireAccess } from "@/lib/auth-access";
import { constantTimeEqual, getAuthConfig, localModeRequestAllowed, reportAuthConfigurationError } from "@/lib/auth";
import { RequestError, requestErrorResponse, validateInput } from "@/lib/request-security";
import { readDemandImportRequest } from "@/lib/demand-import-request";
import { NextRequest, NextResponse } from "next/server";
import { DemandReconciliationError, SHRINK_GUARD_FRACTION, SHRINK_GUARD_MIN_LINES, SnapshotShrinkError } from "@/db/demand-reconciliation";
import { IntegrationImportError, replaceIntegrationImport } from "@/db/cart-store";
import { cleanIdempotencyKey, demandContentHash } from "@/lib/integration-import";
import { MAX_IMPORT_ROWS } from "@/lib/import-validation";
import { MAX_IMPORT_REQUEST_BYTES, MAX_IMPORT_FILE_BYTES } from "@/lib/import-transport";
import type { ImportRow } from "@/lib/types";
import { reportDemandSnapshotRefused } from "@/lib/observability";

export const dynamic = "force-dynamic";

function configuredToken() {
  return String(process.env.CARTFLOW_INGEST_TOKEN || "").trim();
}

function bearerToken(request: NextRequest) {
  const authorization = request.headers.get("authorization") || "";
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
}

export async function GET(request: NextRequest) {
  const access = await requireAccess(request);
  if (access instanceof Response) return access;
  return NextResponse.json({
    configured: Boolean(configuredToken()),
    accepts: ["normalized PPA demand JSON", "multipart Excel or CSV file"],
    maximumRows: MAX_IMPORT_ROWS,
    maximumRequestBytes: MAX_IMPORT_REQUEST_BYTES,
    maximumFileBytes: MAX_IMPORT_FILE_BYTES,
    controlTotal: "optional expectedRows",
    shrinkGuard: {
      minimumRemovedLines: SHRINK_GUARD_MIN_LINES,
      removedFraction: SHRINK_GUARD_FRACTION,
      emptySnapshot: "refused while open demand exists",
      override: "allowShrink",
    },
    retention: "up to 37 batches or approximately 56 hours",
  });
}

async function readDemandRequest(request: NextRequest): Promise<{
  source: string;
  fileName: string;
  rows: ImportRow[];
  allowShrink: boolean;
}> {
  const body = await readDemandImportRequest(request);
  if (body.action && body.action !== "replace") throw new RequestError("Automated ingestion accepts full replacement snapshots only.");
  const source = body.source || "source-system";
  return {
    source,
    fileName: String(body.fileName || `${source}-${new Date().toISOString()}.json`).trim().slice(0, 180),
    rows: body.rows,
    allowShrink: body.allowShrink,
  };
}

export async function POST(request: NextRequest) {
  let sourceForLog = "";
  try {
    let localMode = false;
    try { localMode = getAuthConfig().mode === "local"; } catch (error) {
      reportAuthConfigurationError(error);
      return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
    }
    // Local mode also relaxes the token rules below, so it must serve loopback clients only.
    if (localMode && !localModeRequestAllowed(request)) {
      return NextResponse.json({ error: "Local mode is restricted to loopback access.", code: "local_only" }, { status: 403 });
    }
    const expectedToken = configuredToken();
    if (!expectedToken || (!localMode && expectedToken.length < 32)) {
      return NextResponse.json(
        { error: "Automated demand ingestion is not configured." },
        { status: 503 },
      );
    }
    if (!constantTimeEqual(bearerToken(request), expectedToken)) {
      return NextResponse.json({ error: "Invalid integration credential." }, { status: 401 });
    }

    const { source, fileName, rows, allowShrink } = await readDemandRequest(request);
    sourceForLog = source;
    if (rows.length > MAX_IMPORT_ROWS) throw new RequestError(`Demand imports cannot exceed ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows.`);
    const result = await replaceIntegrationImport({
      source,
      fileName,
      rows,
      idempotencyKey: validateInput(() => cleanIdempotencyKey(request.headers.get("idempotency-key"))),
      contentHash: await demandContentHash(rows),
      allowShrink,
    });
    return NextResponse.json({ ...result, source, automated: true });
  } catch (error) {
    if (error instanceof DemandReconciliationError) return NextResponse.json({ error: error.message, code: error.code, issues: error.issues }, { status: error.status });
    if (error instanceof SnapshotShrinkError) {
      reportDemandSnapshotRefused(sourceForLog, error.shrink);
      return NextResponse.json({ error: error.message, code: error.code, shrink: error.shrink }, { status: error.status });
    }
    if (error instanceof IntegrationImportError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return requestErrorResponse(error, "Automated demand ingestion failed.");
  }
}
