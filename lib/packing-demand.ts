import { partAttributeLabels, type FulfillmentSettings } from "./fulfillment-settings.ts";
import { detectDemandBarcode, normalizeScanValue } from "./scan-values.ts";
import { normalizeUnitOfMeasure, quantitiesEqual, parseQuantity } from "./quantity.ts";

export type PackingContents = {
  partNumber: string;
  color: string;
  quantity: string | number;
  unitOfMeasure?: string;
  supplierId?: string;
};
type PackingDemand = Omit<PackingContents, "supplierId"> & {
  sequence?: string;
  preferredSupplierId?: string;
  status?: string;
  inventoryItemId?: string | null;
  fulfilledQuantity?: number;
  loadedAt?: string | null;
};

// These printed part numbers use separators that the P barcode omits.
// Keep punctuation significant for other part-number formats.
export function normalizePackingPart(value: string) {
  const part = normalizeScanValue(value);
  return /^\d{5}[- ]?[A-Z0-9]{3}[- ]?[A-Z0-9]{4}[- ]?[A-Z0-9]{2}$/.test(part)
    ? part.replace(/[- ]/g, "") : part;
}

export function packingDemandDifferences(actual: PackingContents, demand: PackingDemand, packingMode: "exact" | "multiple" = "exact", partAttribute?: FulfillmentSettings["partAttribute"]) {
  const attribute = partAttributeLabels(partAttribute);
  const differences: string[] = [];
  if (normalizePackingPart(actual.partNumber) !== normalizePackingPart(demand.partNumber)) {
    differences.push(`part number requires ${demand.partNumber}; scanned ${actual.partNumber}`);
  }
  if (normalizeScanValue(actual.color) !== normalizeScanValue(demand.color)) {
    differences.push(`${attribute.label.toLowerCase()} requires ${demand.color || attribute.empty}; scanned ${actual.color || attribute.empty}`);
  }
  const quantityMatches = packingMode === "multiple"
    ? normalizeUnitOfMeasure(actual.unitOfMeasure || "EA") === normalizeUnitOfMeasure(demand.unitOfMeasure || "EA") && parseQuantity(actual.quantity, actual.unitOfMeasure) > 0
    : quantitiesEqual(actual.quantity, demand.quantity, actual.unitOfMeasure || "EA", demand.unitOfMeasure || "EA");
  if (!quantityMatches) {
    differences.push(`quantity requires ${demand.quantity} ${demand.unitOfMeasure || "EA"}; scanned ${actual.quantity} ${actual.unitOfMeasure || "EA"}`);
  }
  if (demand.preferredSupplierId && normalizeScanValue(demand.preferredSupplierId) !== normalizeScanValue(actual.supplierId || "")) {
    differences.push(`supplier requires ${demand.preferredSupplierId}; scanned ${actual.supplierId || "Unspecified"}`);
  }
  return differences;
}

export function packingDemandIsFulfilled(line: PackingDemand) {
  return Boolean(line.status === "verified" || line.loadedAt || (line.inventoryItemId && line.fulfilledQuantity === undefined));
}

export function checkPackingDemand<T extends PackingDemand>(lines: T[], actual: PackingContents, packingMode: "exact" | "multiple" = "exact", partAttribute?: FulfillmentSettings["partAttribute"]) {
  const compared = lines.map((line) => ({ line, differences: packingDemandDifferences(actual, line, packingMode, partAttribute) }));
  const match = compared.find(({ line, differences }) => line.status !== "short" && !packingDemandIsFulfilled(line) && !differences.length);
  if (match) return { line: match.line, reason: null, message: "" };
  if (compared.some(({ differences }) => !differences.length)) {
    return { line: null, reason: "demand_fulfilled" as const,
      message: "Matching demand on this picklist has already been fulfilled." };
  }
  const closest = compared.filter(({ line }) => line.status !== "short" && !packingDemandIsFulfilled(line))
    .sort((a, b) => a.differences.length - b.differences.length)[0];
  const scanned = `Scanned ${actual.partNumber}, ${actual.color || partAttributeLabels(partAttribute).empty}, ${actual.quantity} ${actual.unitOfMeasure || "EA"}.`;
  return { line: null, reason: "no_matching_demand" as const,
    message: `${scanned} ${closest
      ? `Closest remaining line ${closest.line.sequence || ""}: ${closest.differences.join("; ")}.`
      : "There are no remaining demand lines on this picklist."}` };
}

export function capturedPackingContents(rawValues: string[], unitOfMeasure: string, supplierId: string): PackingContents {
  const values = Object.fromEntries(rawValues.map((raw) => {
    const value = detectDemandBarcode(raw);
    return value ? [value.field, value.value] : ["", ""];
  }));
  return { partNumber: values.partNumber || "", color: values.color || "", quantity: values.quantity || "", unitOfMeasure, supplierId };
}

export function packingReceiptDefaults(lines: PackingDemand[]) {
  const pending = lines.filter((line) => line.status !== "short" && !packingDemandIsFulfilled(line));
  const units = [...new Set(pending.map((line) => normalizeUnitOfMeasure(line.unitOfMeasure || "EA")))];
  const suppliers = [...new Set(pending.map((line) => line.preferredSupplierId || ""))];
  return { unitOfMeasure: units.length === 1 ? units[0] : "EA", supplierId: suppliers.length === 1 ? suppliers[0] : "" };
}
