export const CAMERA_TARGET = {
  left: 0.12,
  top: 0.29,
  width: 0.76,
  height: 0.34,
  viewportAspect: 4 / 3,
} as const;

export function cleanScannerPayload(value: string | number) {
  const payload = String(value)
    .replace(/^[\s\u0000-\u001f\u007f]+|[\s\u0000-\u001f\u007f]+$/g, "")
    .replace(/^\][A-Za-z]\d/, "")
    .trim();
  // Framing belongs at the edges. Joining two barcodes across an embedded
  // newline or group separator can turn a malformed read into a false match.
  return /[\u0000-\u001f\u007f-\u009f]/.test(payload) ? "" : payload;
}

export function normalizeScanValue(value: string | number) {
  return cleanScannerPayload(value).toUpperCase().replace(/\s+/g, " ");
}

export const DEMAND_SCAN_ORDER = ["aiagSerial", "partNumber", "color", "quantity"] as const;
export type DemandScanField = (typeof DEMAND_SCAN_ORDER)[number];

export const DEMAND_SCAN_LABELS: Record<DemandScanField, string> = {
  aiagSerial: "Serial number",
  partNumber: "Part number",
  color: "Color",
  quantity: "Quantity",
};

export const DEMAND_SCAN_PREFIXES: Record<DemandScanField, string> = {
  aiagSerial: "1S",
  partNumber: "P",
  color: "2P",
  quantity: "Q",
};

export function buildDemandBarcodeSet(
  values: Record<DemandScanField, string | number>,
) {
  return DEMAND_SCAN_ORDER.map((field) =>
    `${DEMAND_SCAN_PREFIXES[field]}${String(values[field]).trim()}`,
  );
}

type DetectedDemandBarcode = {
  field: DemandScanField;
  prefix: string;
  value: string;
};

const demandIdentifiers: Array<{ field: DemandScanField; pattern: RegExp }> = [
  { field: "aiagSerial", pattern: /^(?:[1-9]S|S)/i },
  { field: "color", pattern: /^(?:2P|C)/i },
  { field: "partNumber", pattern: /^P/i },
  { field: "quantity", pattern: /^Q/i },
];

function cleanDetectedValue(field: DemandScanField, value: string) {
  const trimmed = value.trim();
  if (field === "quantity" && /^\d+$/.test(trimmed)) return trimmed.replace(/^0+(?=\d)/, "");
  return field === "partNumber" ? trimmed.replace(/\s*\.?\s*&\s*$/, "").trim() : trimmed;
}

export function detectDemandBarcode(rawValue: string): DetectedDemandBarcode | null {
  const value = cleanScannerPayload(rawValue);
  for (const identifier of demandIdentifiers) {
    const match = value.match(identifier.pattern);
    if (match) {
      return {
        field: identifier.field,
        prefix: match[0],
        value: cleanDetectedValue(identifier.field, value.slice(match[0].length)),
      };
    }
  }
  return null;
}

/** Scanner entry requires an actual container label. Canonical inventory
 * identifiers from trusted receipt responses must not pass through this path. */
export function scanSerialBarcode(suppliedValue: string):
  | { ok: true; serial: string; rawValue: string }
  | { ok: false; message: string } {
  const rawValue = cleanScannerPayload(suppliedValue);
  const detected = detectDemandBarcode(rawValue);
  if (!rawValue || rawValue.length > 512 || !detected || detected.field !== "aiagSerial"
    || detected.prefix.toUpperCase() !== "1S" || !detected.value) {
    return { ok: false, message: "Serial number not detected. Scan the container serial barcode beginning with 1S." };
  }
  return { ok: true, serial: detected.value, rawValue };
}

export function interpretDemandBarcode(rawValue: string, expectedField: DemandScanField, expectedValue: string | number) {
  const cleanedRawValue = cleanScannerPayload(rawValue);
  if (!cleanedRawValue) return { status: "unreadable" as const, detected: null };
  if (normalizeScanValue(cleanedRawValue) === normalizeScanValue(expectedValue)) {
    return { status: "ready" as const, detected: null, value: cleanedRawValue };
  }

  const detected = detectDemandBarcode(rawValue);
  if (detected) {
    if (!detected.value) {
      return { status: "unreadable" as const, detected };
    }
    if (detected.field !== expectedField) {
      return { status: "out_of_order" as const, detected };
    }
    return { status: "ready" as const, detected, value: detected.value };
  }

  return { status: "unrecognized" as const, detected: null };
}

export function cameraTargetRegion(sourceWidth: number, sourceHeight: number) {
  const safeWidth = Number.isFinite(sourceWidth) ? Math.max(1, sourceWidth) : 1;
  const safeHeight = Number.isFinite(sourceHeight) ? Math.max(1, sourceHeight) : 1;
  const sourceAspect = safeWidth / safeHeight;

  let visibleWidth = safeWidth;
  let visibleHeight = safeHeight;
  let visibleX = 0;
  let visibleY = 0;

  if (sourceAspect > CAMERA_TARGET.viewportAspect) {
    visibleWidth = safeHeight * CAMERA_TARGET.viewportAspect;
    visibleX = (safeWidth - visibleWidth) / 2;
  } else if (sourceAspect < CAMERA_TARGET.viewportAspect) {
    visibleHeight = safeWidth / CAMERA_TARGET.viewportAspect;
    visibleY = (safeHeight - visibleHeight) / 2;
  }

  return {
    x: Math.round(visibleX + visibleWidth * CAMERA_TARGET.left),
    y: Math.round(visibleY + visibleHeight * CAMERA_TARGET.top),
    width: Math.max(1, Math.round(visibleWidth * CAMERA_TARGET.width)),
    height: Math.max(1, Math.round(visibleHeight * CAMERA_TARGET.height)),
  };
}
