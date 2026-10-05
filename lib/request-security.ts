import { reportFailure } from "./observability.ts";

export class RequestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

export async function readLimitedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maximumBytes) {
    throw new RequestError("Request body is too large.", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RequestError("Request body is too large.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function readJsonBody(request: Request, maximumBytes = 64 * 1024): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json")) {
    throw new RequestError("Content-Type must be application/json.", 415);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readLimitedBody(request, maximumBytes))); }
  catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError("Request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError("Request body must be a JSON object.");
  return value as Record<string, unknown>;
}

export function requestErrorResponse(error: unknown, fallback: string) {
  if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  // Never return database connection strings, SQL, filesystem paths or stack traces.
  const requestId=reportFailure(fallback,error);
  return Response.json({ error: fallback, requestId }, { status: 500, headers:{"X-Request-ID":requestId} });
}

export function validateInput<T>(validation: () => T): T {
  try { return validation(); }
  catch (error) { throw new RequestError(error instanceof Error ? error.message : "Invalid request data."); }
}
