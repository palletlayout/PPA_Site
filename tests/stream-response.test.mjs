import assert from "node:assert/strict";
import test from "node:test";
import { streamResponse, snapshotJsonResponse } from "../lib/stream-response.ts";

async function chunks(response) {
  const reader = response.body.getReader();
  const values = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    assert.ok(result.value instanceof Uint8Array);
    assert.ok(result.value.byteLength > 0 && result.value.byteLength <= 64 * 1024);
    values.push(result.value);
  }
  return values;
}

test("streamed binary and Unicode bodies preserve every byte in bounded chunks", async () => {
  const binary = Uint8Array.from({ length: 64 * 1024 * 3 + 17 }, (_, index) => index % 251);
  const response = streamResponse(binary, { headers: { "Content-Type": "application/octet-stream", "Content-Length": "1" } });
  assert.equal(response.headers.has("content-length"), false);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const binaryChunks = await chunks(response);
  assert.deepEqual(binaryChunks.map((value) => value.length), [65536, 65536, 65536, 17]);
  assert.deepEqual(Buffer.concat(binaryChunks), Buffer.from(binary));

  // The first emoji deliberately crosses the first chunk's byte boundary.
  const unicode = "a".repeat(65535) + "🚚漢字".repeat(30000);
  const textChunks = await chunks(streamResponse(unicode));
  assert.ok(textChunks.length > 1);
  assert.equal(Buffer.concat(textChunks).toString("utf8"), unicode);
  assert.equal(await streamResponse("").text(), "");
});

test("snapshot validators cover authorized ownership and every changed value", async () => {
  const value = { lines: [{ id: "one", status: "pending", description: "🚚" }], locks: [{ isOwned: true }] };
  const first = snapshotJsonResponse(value);
  const etag = first.headers.get("etag");
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  assert.equal(first.headers.has("content-length"), false);
  assert.equal(first.headers.get("vary"), "Cookie, X-Cartflow-Session");
  assert.deepEqual(await first.json(), value);
  const condition = new Request("https://example.test/api/state", { headers: { "If-None-Match": etag } });
  const unchanged = snapshotJsonResponse(value, condition);
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body, null);
  assert.equal(unchanged.headers.get("etag"), etag);
  const changed = snapshotJsonResponse({ ...value, lines: [{ ...value.lines[0], status: "verified" }] }, condition);
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
  const anotherOwner = snapshotJsonResponse({ ...value, locks: [{ isOwned: false }] }, condition);
  assert.equal(anotherOwner.status, 200);
  assert.notEqual(anotherOwner.headers.get("etag"), etag);
});
