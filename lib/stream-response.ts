import { createHash } from "node:crypto";

/** Keep large queue/export responses on the hosting platform's streaming path. */
export function streamResponse(body: string | Uint8Array, init: ResponseInit = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) { controller.close(); return; }
      const end = Math.min(offset + 64 * 1024, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
  const headers = new Headers(init.headers);
  headers.delete("Content-Length");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(stream, { ...init, headers });
}

/** The validator covers the complete authorized snapshot, including lock ownership. */
export function snapshotJsonResponse(value: unknown, request?: Request) {
  const json = JSON.stringify(value);
  const etag = `"${createHash("sha256").update(json).digest("hex")}"`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "ETag": etag,
    "Vary": "Cookie, X-Cartflow-Session",
  };
  if (request?.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return streamResponse(json, { headers });
}
