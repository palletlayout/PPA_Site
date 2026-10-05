import type { ImportRow } from "./types.ts";

const lotMetadataFields = new Set([
  "containerSequence", "fromModel", "fromType", "fromOption", "fromColor", "fromInteriorColor", "fromUnits",
  "toModel", "toType", "toOption", "toColor", "toInteriorColor", "toUnits",
]);

export async function demandContentHash(rows: readonly ImportRow[]) {
  // The additive schema gives old rows empty metadata. Omit those new empty
  // defaults so retries still match receipts hashed before this schema existed.
  const payload = new TextEncoder().encode(JSON.stringify(rows.map((row) => Object.fromEntries(
    Object.entries(row).filter(([field, value]) => !lotMetadataFields.has(field) || (value !== "" && value != null)),
  ))));
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function cleanIdempotencyKey(value: string | null) {
  const key = String(value || "").trim();
  if (key.length > 180 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error("Idempotency-Key must be 180 printable characters or fewer.");
  }
  return key;
}
