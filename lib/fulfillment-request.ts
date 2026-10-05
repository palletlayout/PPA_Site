import { cleanScannerPayload, normalizeScanValue, scanSerialBarcode } from "./scan-values.ts";

export type SerialFormat = "barcode" | "canonical";
export type FulfillmentIdentity = { canonicalSerial: string; rawValue: string };
export type FulfillmentRequest = {
  cartKey: string;
  serial: string;
  serialFormat: SerialFormat;
  supplierId?: string;
};
export type FulfillmentAttempt = {
  version: 2;
  key: string;
  requestId: string;
  request: FulfillmentRequest;
  phase?: "unconfirmed" | "not_allocated";
};

/** Barcode identifiers are removed exactly once, and only on the barcode path. */
export function resolveFulfillmentSerial(value: string, format: SerialFormat): FulfillmentIdentity | null {
  if (format === "barcode") {
    const scanned = scanSerialBarcode(value);
    return scanned.ok ? { canonicalSerial: normalizeScanValue(scanned.serial), rawValue: scanned.rawValue } : null;
  }
  if (format !== "canonical") return null;
  const rawValue = cleanScannerPayload(value);
  return rawValue && rawValue.length <= 512 ? { canonicalSerial: normalizeScanValue(rawValue), rawValue } : null;
}

type FingerprintInput = { cartKey: string; lineId?: string; serial: string; supplierId?: string; quantity?: unknown };

export function legacyFulfillmentFingerprint(input: FingerprintInput) {
  return JSON.stringify([input.cartKey, input.lineId || "", normalizeScanValue(input.serial), normalizeScanValue(input.supplierId || ""), input.quantity ?? null]);
}

/** These alternatives only authorize replay after the stored inventory ID's
 * canonical serial has also been checked. They never select new inventory. */
export function legacyFulfillmentFingerprints(input: FingerprintInput, canonicalSerial?: string) {
  return [legacyFulfillmentFingerprint(input), ...(canonicalSerial
    ? [legacyFulfillmentFingerprint({ ...input, serial: canonicalSerial }), legacyFulfillmentFingerprint({ ...input, serial: `1S${canonicalSerial}` })] : [])];
}

export function fulfillmentFingerprint(input: FingerprintInput, canonicalSerial: string) {
  return JSON.stringify([2, input.cartKey, input.lineId || "", canonicalSerial,
    input.supplierId === undefined ? null : normalizeScanValue(input.supplierId), input.quantity ?? null]);
}

export function fulfillmentAttemptKey(request: FulfillmentRequest) {
  const identity = resolveFulfillmentSerial(request.serial, request.serialFormat);
  if (!identity) throw new Error("Scan a valid container serial barcode.");
  return JSON.stringify([request.cartKey, identity.canonicalSerial,
    request.supplierId === undefined ? null : normalizeScanValue(request.supplierId)]);
}

/** Recover the old browser's exact barcode envelope without changing its request ID. */
export function restoreFulfillmentAttempt(value: unknown): FulfillmentAttempt | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<FulfillmentAttempt>;
  if (typeof saved.key !== "string" || typeof saved.requestId !== "string" || !saved.requestId || saved.requestId.length > 180) return null;
  if (saved.version === 2) {
    const request = saved.request;
    if (!request || typeof request.cartKey !== "string" || typeof request.serial !== "string"
      || (request.serialFormat !== "barcode" && request.serialFormat !== "canonical")
      || (request.supplierId !== undefined && typeof request.supplierId !== "string")) return null;
    try { return fulfillmentAttemptKey(request) === saved.key ? saved as FulfillmentAttempt : null; } catch { return null; }
  }
  try {
    const oldKey: unknown = JSON.parse(saved.key);
    if (!Array.isArray(oldKey) || oldKey.length !== 3 || oldKey.some((part) => typeof part !== "string")) return null;
    const [cartKey, serial, supplier] = oldKey as string[];
    const request: FulfillmentRequest = { cartKey, serial: `1S${serial}`, serialFormat: "barcode", ...(supplier ? { supplierId: supplier } : {}) };
    return { version: 2, key: fulfillmentAttemptKey(request), requestId: saved.requestId, request };
  } catch { return null; }
}

export function createFulfillmentAttempt(request: FulfillmentRequest, requestId: string): FulfillmentAttempt {
  return { version: 2, key: fulfillmentAttemptKey(request), requestId, request, phase: "unconfirmed" };
}

export function recordFulfillmentResponse(attempt: FulfillmentAttempt, result: { ok?: boolean; retryDisposition?: string }) {
  return !result.ok && result.retryDisposition === "not_allocated"
    ? { ...attempt, phase: "not_allocated" as const } : attempt;
}

/** A picklist reset only invalidates that picklist's retries. A deliberate
 * all-data reset invalidates every saved receipt, including malformed drafts. */
export function fulfillmentAttemptAfterReset(current: FulfillmentAttempt | null, storedValue: unknown, cartKey: string | null) {
  if (cartKey === null) return { attempt: null, clearStored: true };
  const stored = restoreFulfillmentAttempt(storedValue);
  const retainedCurrent = current?.request.cartKey === cartKey ? null : current;
  const retainedStored = stored?.request.cartKey === cartKey ? null : stored;
  return { attempt: retainedCurrent || retainedStored, clearStored: stored?.request.cartKey === cartKey };
}

export function prepareFulfillmentAttempt(previous: FulfillmentAttempt | null, request: FulfillmentRequest, requestId: string, receiving = false) {
  const next = createFulfillmentAttempt(request, requestId);
  const sameContainer = previous && previous.request.cartKey === request.cartKey
    && resolveFulfillmentSerial(previous.request.serial, previous.request.serialFormat)?.canonicalSerial === resolveFulfillmentSerial(request.serial, request.serialFormat)?.canonicalSerial;
  // A receipt can name the supplier that was originally left unspecified. Keep
  // the existing request scope so a lost allocation response remains replayable.
  if (previous && (previous.key === next.key || (receiving && sameContainer && previous.request.supplierId === undefined))) return { ...previous, phase: "unconfirmed" as const };
  if (previous && previous.phase !== "not_allocated") {
    throw new Error(`The previous container scan (${previous.request.serial}) is not confirmed. Scan it again before starting another container.`);
  }
  return next;
}
