import { partAttributeLabels, type FulfillmentSettings } from "./fulfillment-settings.ts";
import { captureLabelBarcode, type LabelCapture } from "./label-capture.ts";
import { DEMAND_SCAN_LABELS, DEMAND_SCAN_ORDER, DEMAND_SCAN_PREFIXES, detectDemandBarcode, normalizeScanValue, type DemandScanField } from "./scan-values.ts";
import { normalizeUnitOfMeasure, parseQuantity, quantitiesEqual } from "./quantity.ts";
import { normalizePackingPart } from "./packing-demand.ts";

export const RECEIVING_SCAN_ORDER = ["partNumber", "color", "quantity", "aiagSerial"] as const;
export const RECEIVING_SCAN_LABELS = DEMAND_SCAN_LABELS;

export type ReceivingDemand = {
  partNumber: string;
  color: string;
  quantity: number;
  unitOfMeasure?: string;
  packingMode?: "exact" | "multiple";
};

function demandMismatch(field: DemandScanField, value: string, demand: ReceivingDemand, unitOfMeasure: string, partAttribute?: FulfillmentSettings["partAttribute"]) {
  // Demand does not preselect a container serial. Only its contents must match.
  if (field === "aiagSerial") return null;
  const matches = field === "quantity"
    ? demand.packingMode === "multiple"
      ? normalizeUnitOfMeasure(unitOfMeasure) === normalizeUnitOfMeasure(demand.unitOfMeasure || "EA") && parseQuantity(value, unitOfMeasure) > 0
      : quantitiesEqual(value, demand.quantity, unitOfMeasure, demand.unitOfMeasure || "EA")
    : field === "partNumber" ? normalizePackingPart(value) === normalizePackingPart(demand.partNumber)
      : normalizeScanValue(value) === normalizeScanValue(demand[field]);
  if (matches) return null;
  const attribute = partAttributeLabels(partAttribute);
  const label = field === "color" ? attribute.label.toLowerCase() : RECEIVING_SCAN_LABELS[field].toLowerCase();
  const expected = field === "quantity" ? `${demand.quantity} ${demand.unitOfMeasure || "EA"}` : demand[field] || attribute.empty;
  const actual = field === "quantity" ? `${value} ${unitOfMeasure}` : value || attribute.empty;
  return { field, message: `Wrong ${label}. Demand requires ${expected}; scanned ${actual}. Scan ${label} again.` };
}

/** Recheck restored/edited drafts before saving. Standalone receiving has no demand constraint. */
export function receivingDemandMismatch(rawValues: string[], demand?: ReceivingDemand, unitOfMeasure = "EA", partAttribute?: FulfillmentSettings["partAttribute"]) {
  for (const field of RECEIVING_SCAN_ORDER) {
    const raw = rawValues[DEMAND_SCAN_ORDER.indexOf(field)];
    if (!raw) continue;
    const detected = detectDemandBarcode(raw);
    if (!detected || detected.field !== field ||
        (detected.prefix.toUpperCase() !== DEMAND_SCAN_PREFIXES[field] && !(field === "color" && detected.prefix.toUpperCase() === "C")) ||
        (!detected.value && field !== "color") || (field === "quantity" && !(parseQuantity(detected.value, unitOfMeasure) > 0))) {
      return { field, message: `Invalid ${(field === "color" ? partAttributeLabels(partAttribute).label : RECEIVING_SCAN_LABELS[field]).toLowerCase()}. Scan this value again.` };
    }
    const mismatch = demand && demandMismatch(field, detected.value, demand, unitOfMeasure, partAttribute);
    if (mismatch) return mismatch;
  }
  return null;
}

// Keep legacy storage positions so saved drafts and receipt retries remain valid.
export function nextReceivingField(rawValues: string[]) {
  return RECEIVING_SCAN_ORDER.find((field) => !rawValues[DEMAND_SCAN_ORDER.indexOf(field)]);
}

export function captureReceivingBarcode(rawValues: string[], rawValue: string, editingIndex: number | null = null, unitOfMeasure: string = "EA", demand?: ReceivingDemand, partAttribute?: FulfillmentSettings["partAttribute"]) {
  const count = rawValues.filter(Boolean).length;
  const unchanged = { rawValues, count, completed: false };
  let expected = editingIndex === null ? nextReceivingField(rawValues) : DEMAND_SCAN_ORDER[editingIndex];
  if (!expected) return { ...unchanged, status: "invalid" as const, message: "Label captured. Finish this receipt before scanning another container." };
  const expectedLabel = expected === "color" ? partAttributeLabels(partAttribute).label : RECEIVING_SCAN_LABELS[expected];
  const detected = detectDemandBarcode(rawValue);
  // In the sequential flow, scanning Q after P explicitly means no color.
  // Keep the saved four-slot draft format, and only commit the blank marker
  // after the quantity and any demand requirements have passed validation.
  const skipColor = editingIndex === null && expected === "color" && detected?.field === "quantity";
  if (skipColor) {
    const mismatch = demand && demandMismatch("color", "", demand, unitOfMeasure, partAttribute);
    if (mismatch) return { ...unchanged, status: "mismatch" as const, ...mismatch };
    expected = "quantity";
  }
  if (!detected || (detected.prefix.toUpperCase() !== DEMAND_SCAN_PREFIXES[detected.field]
    && !(detected.field === "color" && detected.prefix.toUpperCase() === "C"))) {
    return { ...unchanged, field: expected, status: "invalid" as const, message: `${expectedLabel} not detected. Scan ${expectedLabel.toLowerCase()}.` };
  }
  if (detected.field !== expected) {
    return { ...unchanged, field: expected, status: "invalid" as const, message: `${expectedLabel} not detected. Scan ${expectedLabel.toLowerCase()} next.` };
  }
  const captured: LabelCapture = {};
  DEMAND_SCAN_ORDER.forEach((field, index) => {
    if (rawValues[index] && index !== editingIndex) captured[field] = { rawValue: rawValues[index], value: detectDemandBarcode(rawValues[index])?.value || "" };
  });
  if (skipColor) captured.color = { rawValue: "C", value: "" };
  const result = captureLabelBarcode(captured, rawValue, unitOfMeasure);
  if (result.status !== "accepted") return { ...unchanged, field: detected.field, status: result.status, message: result.status === "conflict"
    ? `${DEMAND_SCAN_LABELS[detected.field]} is already captured with a different value. Use Edit to replace it.` : result.message };
  const mismatch = demand && demandMismatch(detected.field, detected.value, demand, unitOfMeasure, partAttribute);
  if (mismatch) return { ...unchanged, status: "mismatch" as const, ...mismatch };
  return { ...result, completed: count < 4 && result.count === 4,
    rawValues: DEMAND_SCAN_ORDER.map((field) => result.captured[field]?.rawValue || "") };
}
