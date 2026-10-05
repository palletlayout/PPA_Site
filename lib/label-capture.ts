import { cleanScannerPayload, DEMAND_SCAN_LABELS, DEMAND_SCAN_ORDER, detectDemandBarcode, normalizeScanValue, type DemandScanField } from "./scan-values.ts";
import { normalizeUnitOfMeasure, parseQuantity } from "./quantity.ts";

export type CapturedValue = { rawValue: string; value: string };
export type LabelCapture = Partial<Record<DemandScanField, CapturedValue>>;

export function sameLabelBarcode(left: string, right: string) {
  const a = detectDemandBarcode(left);
  const b = detectDemandBarcode(right);
  return Boolean(a && b && (a.value || a.field === "color") && (b.value || b.field === "color") && a.field === b.field
    && normalizeScanValue(a.value) === normalizeScanValue(b.value));
}

/** Repeated reads never replace a field or complete a label a second time. */
export function captureLabelBarcode(current: LabelCapture, suppliedValue: string, unitOfMeasure: string = "EA") {
  const rawValue = cleanScannerPayload(suppliedValue);
  const detected = detectDemandBarcode(rawValue);
  const count = DEMAND_SCAN_ORDER.filter((field) => current[field]).length;
  const unchanged = { captured: current, count, completed: false };
  if (!rawValue || rawValue.length > 512 || !detected || (!detected.value && detected.field !== "color")) {
    return { ...unchanged, status: "invalid" as const, message: "Barcode not recognized. Scan one 1S, P, 2P, or Q barcode." };
  }
  const field = detected.field;
  const quantity = field === "quantity" ? parseQuantity(detected.value, unitOfMeasure) : 0;
  if (field === "quantity" && (!Number.isFinite(quantity) || quantity <= 0)) {
    let unit = "EA";
    try { unit = normalizeUnitOfMeasure(unitOfMeasure); } catch { /* Report invalid quantity without throwing from scanner UI. */ }
    return { ...unchanged, field, status: "invalid" as const, message: `Quantity must be ${unit === "EA" ? "a whole number" : "a decimal with at most six decimal places"} greater than zero and no greater than 2,147,483,647. Scan Q again.` };
  }
  const existing = current[field];
  if (existing) {
    return sameLabelBarcode(existing.rawValue, rawValue)
      ? { ...unchanged, field, status: "duplicate" as const, message: `${DEMAND_SCAN_LABELS[field]} already scanned. Duplicate ignored. ${count} of 4 captured.` }
      : { ...unchanged, field, status: "conflict" as const, message: `${DEMAND_SCAN_LABELS[field]} is already captured with a different value. Clear it before scanning a replacement.` };
  }
  const nextCount = count + 1;
  return {
    captured: { ...current, [field]: { rawValue, value: detected.value } },
    field, count: nextCount, completed: nextCount === DEMAND_SCAN_ORDER.length, status: "accepted" as const,
    message: nextCount === DEMAND_SCAN_ORDER.length ? "Label captured. Review the label."
      : `${DEMAND_SCAN_LABELS[field]} captured. ${nextCount} of 4 ready.`,
  };
}
