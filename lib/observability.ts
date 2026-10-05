import { randomUUID } from "node:crypto";

/** Operational diagnostics never contain query text, bound values or credentials. */
export function reportFailure(operation: string, error: unknown) {
  const requestId = randomUUID();
  const detail = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; constraint?: unknown } : {};
  const safe = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined;
  console.error(JSON.stringify({ event: "ppa.operation_failed", requestId, operation,
    errorType: safe(detail.name) || "UnknownError", code: safe(detail.code), constraint: safe(detail.constraint),
  }));
  return requestId;
}

/** A refused demand snapshot needs a person to check the source feed, so it is logged for alerting. */
export function reportDemandSnapshotRefused(source: string, shrink: { reason: string; unworkedLines: number; removedLines: number; incomingLines: number }) {
  console.warn(JSON.stringify({ event: "ppa.demand_snapshot_refused",
    source: /^[A-Za-z0-9_. -]{1,80}$/.test(source) ? source : "unrecognized",
    reason: shrink.reason, unworkedLines: shrink.unworkedLines, removedLines: shrink.removedLines, incomingLines: shrink.incomingLines }));
}

export function recordDatabaseBatch(kind: "read" | "write", dialect: string, started: number, statements: number, ok: boolean) {
  if (process.env.CARTFLOW_TELEMETRY !== "true") return;
  console.info(JSON.stringify({ event:"ppa.database_batch", kind, dialect, statements, ok, durationMs:Math.round((performance.now()-started)*100)/100 }));
}
