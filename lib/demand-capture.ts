import {
  cleanScannerPayload,
  DEMAND_SCAN_ORDER,
  detectDemandBarcode,
  normalizeScanValue,
  type DemandScanField,
} from "./scan-values.ts";
import { normalizeUnitOfMeasure, parseQuantity } from "./quantity.ts";

export type CapturedDemandLabel = {
  rawValues: Record<DemandScanField, string>;
  values: Record<DemandScanField, string> & { quantity: string };
};

export type TestDemandContext = {
  sessionId: string;
  token: string;
  loadNumber: string;
  picklistNumber: string;
  checksheetNumber: string;
  cartNumber: string;
  cartId: string;
  palletId: string;
  orderNumber: string;
  batchNumber: string;
};

export class DemandCaptureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemandCaptureValidationError";
  }
}

export function parseCaptureId(input: unknown) {
  if (typeof input !== "string") {
    throw new DemandCaptureValidationError("A physical-label capture identifier is required.");
  }
  const captureId = input.trim();
  if (!/^[A-F0-9]{8}-[A-F0-9]{4}-4[A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}$/i.test(captureId)) {
    throw new DemandCaptureValidationError("The physical-label capture identifier is invalid.");
  }
  return captureId.toLowerCase();
}

export function buildTestDemandContext(input: unknown): TestDemandContext {
  if (typeof input !== "string") {
    throw new DemandCaptureValidationError("A test-load session identifier is required.");
  }
  const sessionId = input.trim().toLowerCase();
  const normalized = sessionId.replaceAll("-", "").toUpperCase();
  if (!/^[A-F0-9]{8}-[A-F0-9]{4}-4[A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}$/i.test(sessionId)) {
    throw new DemandCaptureValidationError("The test-load session identifier is invalid.");
  }

  // Load barcodes are limited to ten Code 39 characters. Nine UUID-derived
  // characters plus the T prefix keep the generated test context compact and
  // stable for every label captured during the same modal session.
  let firstHash = 0x811c9dc5;
  let secondHash = 0x9e3779b9;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    firstHash = Math.imul(firstHash ^ code, 0x01000193);
    secondHash = Math.imul(secondHash ^ (code + index), 0x85ebca6b);
  }
  const firstToken = (firstHash >>> 0).toString(36).toUpperCase().padStart(7, "0");
  const secondToken = (secondHash >>> 0).toString(36).toUpperCase().padStart(7, "0");
  const token = `${firstToken.slice(0, 5)}${secondToken.slice(-4)}`;
  return {
    sessionId,
    token,
    loadNumber: `T${token}`,
    picklistNumber: `TPL-${token}`,
    checksheetNumber: `TCHK-${token}`,
    cartNumber: "001",
    cartId: `TCART-${token}`,
    palletId: `TPAL-${token}`,
    orderNumber: `TORD-${token}`,
    batchNumber: `TBAT-${token}`,
  };
}

export function parseDemandCaptureValues(input: unknown, unitOfMeasure: unknown = "EA"): CapturedDemandLabel {
  if (!Array.isArray(input) || (input.length !== 3 && input.length !== 4)) {
    throw new DemandCaptureValidationError("A physical label must provide one serial (1S), part (P), and quantity (Q), with an optional color (C or 2P).");
  }

  const rawValues = {} as Record<DemandScanField, string>;
  const values = {} as Record<DemandScanField, string> & { quantity: string };

  input.forEach((suppliedValue) => {
    if (typeof suppliedValue !== "string") {
      throw new DemandCaptureValidationError("Every physical-label value must be a barcode string.");
    }
    const rawValue = cleanScannerPayload(suppliedValue);
    if (!rawValue || rawValue.length > 512) {
      throw new DemandCaptureValidationError("A physical-label barcode is empty or too long.");
    }
    const detected = detectDemandBarcode(rawValue);
    // An explicit empty color marker represents the operator's “No color” choice.
    // Other fields must still contain a scanned value.
    if (!detected || (!detected.value && detected.field !== "color")) {
      throw new DemandCaptureValidationError("Barcode not recognized. Scan one 1S, P, 2P, or Q value at a time.");
    }
    if (rawValues[detected.field]) {
      throw new DemandCaptureValidationError(`The label contains more than one ${detected.prefix.toUpperCase()} value.`);
    }
    rawValues[detected.field] = rawValue;
    values[detected.field] = detected.value;
  });

  const missing = DEMAND_SCAN_ORDER.filter((field) => field !== "color" && !rawValues[field]);
  if (missing.length) {
    throw new DemandCaptureValidationError("The physical label is missing a required serial (1S), part (P), or quantity (Q) barcode.");
  }
  if (!rawValues.color) { rawValues.color = "C"; values.color = ""; }

  let unit: string;
  try { unit = normalizeUnitOfMeasure(unitOfMeasure); }
  catch (error) { throw new DemandCaptureValidationError(error instanceof Error ? error.message : "Invalid unit of measure."); }
  if (unit === "EA" && !/^\d+$/.test(values.quantity)) {
    throw new DemandCaptureValidationError("The Q barcode must contain digits only.");
  }
  const quantity = parseQuantity(values.quantity, unit);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new DemandCaptureValidationError(`The Q barcode must contain a positive ${unit === "EA" ? "whole-number quantity" : "quantity with at most six decimal places"} no greater than 2,147,483,647.`);
  }
  values.quantity = String(quantity);
  return { rawValues, values };
}

export function capturedLabelMatches(
  existing: { aiagSerial: string; partNumber: string; color: string; quantity: number },
  captured: CapturedDemandLabel["values"],
) {
  return normalizeScanValue(existing.aiagSerial) === normalizeScanValue(captured.aiagSerial)
    && normalizeScanValue(existing.partNumber) === normalizeScanValue(captured.partNumber)
    && normalizeScanValue(existing.color) === normalizeScanValue(captured.color)
    && existing.quantity === Number(captured.quantity);
}

export function nextCapturedSequence(existingSequences: readonly string[]) {
  const numeric = existingSequences
    .map((sequence) => String(sequence).trim())
    .filter((sequence) => /^\d+$/.test(sequence));
  const used = new Set(existingSequences.map((sequence) => String(sequence).trim()));
  const width = numeric.reduce((largest, sequence) => Math.max(largest, sequence.length), 3);
  let candidate = numeric.reduce((largest, sequence) => {
    const parsed = BigInt(sequence);
    return parsed > largest ? parsed : largest;
  }, 0n) + 1n;
  while (used.has(String(candidate).padStart(width, "0"))) candidate += 1n;
  return String(candidate).padStart(width, "0");
}
