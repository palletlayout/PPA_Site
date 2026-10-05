import { resolveOnsiteMovementBarcode } from "./onsite-barcodes.ts";
import { cleanScannerPayload } from "./scan-values.ts";

type MovementIdentity = {
  areaType: "onsite" | "offsite";
  loadNumber: string;
  trainNumber: string;
  movementBarcode?: string;
  plant: string;
  zone: string;
  shipCategory: string;
  cartSequenceNumber?: string;
  masterBarcode?: string;
  checksheetNumber?: string;
};

/** One outbound card/pallet/order belongs to each picklist within its movement. */
export function picklistIdentityKey(line: {
  plant: string; areaType: "onsite" | "offsite"; loadNumber: string; trainNumber: string; picklistNumber: string;
}) {
  return JSON.stringify([line.plant, line.areaType,
    line.areaType === "offsite" ? line.loadNumber : line.trainNumber, line.picklistNumber]
    .map(normalizeIdentityBarcode));
}

function hash32(value: string, seed: number) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, "0");
}

/** A stable, compact Code 39 identifier generated for each demand header. */
export function cartBarcodeForHeaderId(headerId: string) {
  const source = String(headerId || "").trim();
  if (!source) throw new Error("A demand header ID is required to create a cart barcode.");
  return `CF${hash32(source, 0x811c9dc5)}${hash32(source, 0x9e3779b9)}`;
}

export function normalizeIdentityBarcode(value: unknown) {
  return cleanScannerPayload(String(value ?? "")).toUpperCase();
}

type PicklistIdentity = {
  cartBarcode: string;
  picklistNumber: string;
  checksheetNumber?: string;
  masterBarcode?: string;
  orderNumber?: string;
};

/** Source labels and the PPA alias resolve to the same work record.
 * Callers must resolve all matches within their movement and reject ambiguity. */
export function picklistBarcodeCandidates(line: PicklistIdentity) {
  return [...new Set([line.cartBarcode, line.picklistNumber, line.checksheetNumber, line.masterBarcode, line.orderNumber]
    .map(normalizeIdentityBarcode).filter(Boolean))];
}

export function picklistBarcodeMatches(line: PicklistIdentity, scannedValue: unknown) {
  const scanned = normalizeIdentityBarcode(scannedValue);
  return Boolean(scanned) && picklistBarcodeCandidates(line).includes(scanned);
}

export function expectedMovementNumber(line: MovementIdentity) {
  return line.areaType === "onsite" ? line.trainNumber : line.loadNumber;
}

export function movementBarcodeCandidates(line: MovementIdentity) {
  const candidates = new Set<string>();
  const add = (candidate: unknown) => {
    const normalized = normalizeIdentityBarcode(candidate);
    if (normalized) candidates.add(normalized);
  };
  add(expectedMovementNumber(line));
  add(line.movementBarcode);
  if (line.areaType === "onsite") add(resolveOnsiteMovementBarcode(line));
  return [...candidates];
}

export function movementBarcodeMatches(line: MovementIdentity, scannedValue: unknown) {
  return movementBarcodeCandidates(line).includes(normalizeIdentityBarcode(scannedValue));
}
