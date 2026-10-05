import { picklistIdentityKey } from "./cart-identity.ts";
import { encodeCode39 } from "./code39.ts";
import { resolveOnsiteMasterBarcode, resolveOnsiteMovementBarcode } from "./onsite-barcodes.ts";
import type { ImportRow } from "./types.ts";
import { normalizeScanValue } from "./scan-values.ts";
import { normalizeUnitOfMeasure, parseDecimalQuantity, parseQuantity } from "./quantity.ts";

export const MAX_IMPORT_ROWS = 10_000;
export const MAX_IMPORT_CELL_CHARACTERS = 512;
export const MAX_IMPORT_QUANTITY = 2_147_483_647;

// Fixed Letter layouts use Courier at no less than 6 pt. Table identifiers can
// span two lines; header identifiers have one line. Never abbreviate identity.
export const PRINTABLE_FIELD_LIMITS: Partial<Record<keyof ImportRow, number>> = {
  plant: 20, zone: 31, trainNumber: 32, cartNumber: 20, cartId: 40, palletId: 40,
  programId: 24, pymtc: 100, sequence: 18, packSequence: 18, partNumber: 66, color: 34,
  caseCode: 58, outgoingSerial: 77, cartSequenceNumber: 20, fromLot: 52, toLot: 45,
  model: 40, cartType: 16, option: 40, scheduledDispatchDate: 31, scheduledDispatchTime: 25,
  deliveryLocation: 36, detailDeliveryLocation: 40, containerPosition: 20,
  containerType: 16, pickingLocation: 28, mcid: 34, orderNumber: 51,
  batchNumber: 52, loadingSequence: 29,
};

export function printableProductCode(row: Partial<ImportRow>, colors = [String(row.color || "")]) {
  const cleanCode = (input: unknown) => String(input ?? "").trim().toUpperCase();
  const explicit = cleanCode(row.pymtc);
  if (explicit) return explicit;
  const model = cleanCode(row.model);
  if (model.split("/").filter(Boolean).length >= 5) return model;
  const segments = model.split("-").filter(Boolean);
  const year = segments.length >= 3 ? segments[0] : "-";
  const modelName = segments.length >= 3 ? segments[1] : model || "-";
  const type = segments.length >= 3 ? segments.slice(2).join("-") : cleanCode(row.cartType) || "-";
  const uniqueColors = [...new Set(colors.map(cleanCode).filter(Boolean))];
  return [cleanCode(row.plant) || "-", year, modelName, type, uniqueColors.length === 1 ? uniqueColors[0] : "-"].join("/");
}

export function validatePrintableFields(row: Partial<ImportRow>, context = "Picklist") {
  for (const [field, maximum] of Object.entries(PRINTABLE_FIELD_LIMITS)) {
    // A stable Demand ID can exceed the display width; Pack Sequence is the
    // printable ordering field for those records.
    if (field === "sequence" && row.packSequence) continue;
    const text = String(row[field as keyof ImportRow] ?? "").trim();
    if (text.length > maximum) {
      throw new Error(`${context} ${field} exceeds the ${maximum}-character printable limit. Shorten the source identifier or use a larger document layout; identifiers cannot be abbreviated.`);
    }
    if (/[^\x20-\x7e]/.test(text)) {
      throw new Error(`${context} ${field} cannot be printed losslessly. Operational identifiers must use printable ASCII characters.`);
    }
  }
  if (row.areaType === "onsite") {
    const sequence = String(row.cartSequenceNumber || "").trim() || String(row.cartNumber || "").trim();
    const display = sequence.includes("/") || !row.totalCarts ? sequence : `${sequence} / ${row.totalCarts}`;
    if (display.length > 20) throw new Error(`${context} cart sequence and total exceed the 20-character printable limit.`);
  }
  if (row.areaType === "offsite" && printableProductCode(row).length > 100) {
    throw new Error(`${context} derived P/Y/M/T/C exceeds the 100-character printable limit. Supply an explicit printable P/Y/M/T/C value.`);
  }
}

/** PostgreSQL integer columns and physical-label quantities share this bound. */
export function parseImportWholeNumber(value: unknown, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return 0;
  if (typeof value !== "number" && typeof value !== "string") return Number.NaN;
  const text = String(value).trim();
  if (optional && !text) return 0;
  // A comma is a thousands separator only when every group is well-formed.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) return Number.NaN;
  const parsed = Number(text.replaceAll(",", ""));
  return Number.isSafeInteger(parsed) && parsed <= MAX_IMPORT_QUANTITY ? parsed : Number.NaN;
}

const barcodeFields: Array<[keyof ImportRow, string]> = [
  ["loadNumber", "Load #"],
  ["trainNumber", "Train #"],
  ["picklistNumber", "Picklist #"],
  ["cartNumber", "Cart #"],
  ["cartId", "Cart ID"],
  ["palletId", "Pallet ID"],
  ["partNumber", "Part #"],
  ["color", "Part Mark"],
  ["masterBarcode", "Master Barcode"],
  ["movementBarcode", "Movement Barcode"],
  ["checksheetNumber", "Checksheet Number"],
  ["chassisNumber", "Chassis Number"],
];

const maximumBarcodeCharacters: Partial<Record<keyof ImportRow, number>> = {
  loadNumber: 10,
  picklistNumber: 28,
  masterBarcode: 28,
  movementBarcode: 32,
  chassisNumber: 32,
  checksheetNumber: 28,
};

const cartLevelFields: (keyof ImportRow)[] = [
  "cartNumber", "cartId",
  "palletId", "zone", "shipCategory", "programId", "totalCarts", "pymtc", "checksheetNumber",
  "masterBarcode", "movementBarcode", "caseCode", "outgoingSerial",
  "cartSequenceNumber", "fromLot", "toLot", "model", "cartType", "option", "scheduledDispatchDate",
  "scheduledDispatchTime", "deliveryLocation", "chassisNumber", "orderNumber", "batchNumber",
  "loadingSequence",
  "productionQuantity", "cartMaxQuantity", "interiorColor", "exteriorColor", "vehicleColor",
];

const loadLevelFields: (keyof ImportRow)[] = [
  "chassisNumber", "orderNumber", "batchNumber", "loadingSequence", "movementBarcode",
];

type HeaderValues = Partial<Record<keyof ImportRow, string | number>>;
type HeaderRecord = { rowNumber: number; values: HeaderValues };
const conflictFieldLabels: Partial<Record<keyof ImportRow, string>> = {
  cartId: "Cart ID", palletId: "Pallet ID", programId: "Program ID", pymtc: "P/Y/M/T/C",
  movementBarcode: "Movement Barcode", masterBarcode: "Master Barcode",
  scheduledDispatchDate: "Delivery / Dispatch Date", scheduledDispatchTime: "Delivery / Dispatch Time",
  fromLot: "From Lot number", toLot: "To Lot number",
};

function headerConflictDetails(fields: readonly (keyof ImportRow)[], current: ImportRow, rowNumber: number, previous: HeaderRecord) {
  return fields.filter((field) => previous.values[field] !== current[field]).map((field) => {
    const label = conflictFieldLabels[field] || field.replace(/([A-Z])/g, " $1").replace(/^./, (first) => first.toUpperCase());
    return `${label}: row ${rowNumber} has ${JSON.stringify(current[field] ?? "")}; row ${previous.rowNumber} has ${JSON.stringify(previous.values[field] ?? "")}.`;
  }).join(" ");
}

function loadKey(row: ImportRow) {
  return [row.plant, row.areaType, row.loadNumber, row.picklistNumber].join("::");
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function optionalWholeNumber(value: unknown, label: string, rowNumber: number) {
  const parsed = parseImportWholeNumber(value, true);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Row ${rowNumber} ${label} must be a non-negative whole number no greater than 2,147,483,647.`);
  }
  return parsed;
}

function cartKey(row: ImportRow) {
  return picklistIdentityKey(row);
}

function optionalCartMaximum(value: unknown, rowNumber: number) {
  const quantity = parseDecimalQuantity(value, true);
  if (!Number.isFinite(quantity) || !/^(?:\d+(?:\.\d{1,2})?)?$/.test(String(quantity))) {
    throw new Error(`Row ${rowNumber} Cart Maximum Quantity must be a non-negative quantity with at most two decimal places.`);
  }
  return quantity;
}

export function validateImportRows(input: unknown[]): ImportRow[] {
  if (!Array.isArray(input) || input.length > MAX_IMPORT_ROWS) {
    throw new Error(`PPA accepts between 0 and ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows per snapshot.`);
  }
  const cartMetadata = new Map<string, HeaderRecord>();
  const loadMetadata = new Map<string, HeaderRecord>();
  const cartSequences = new Set<string>();
  const sourceIdentities = new Set<string>();

  return input.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Row ${index + 2} must be a demand record.`);
    }
    const row = value as Partial<ImportRow>;
    for (const [field, supplied] of Object.entries(row)) {
      if (supplied === undefined || supplied === null) continue;
      const initialStatus = field === "status" && ["pending", "unpacked"].includes(String(supplied).trim().toLowerCase());
      if (["fulfilledQuantity", "inventoryItemId", "inventorySerialNumber", "containerUniqueSerialNumber", "allocations", "remainingQuantity", "status", "fulfilledAt", "fulfilledBy", "verifiedAt", "shortClosedAt"].includes(field) && String(supplied).trim() && supplied !== 0 && !initialStatus) {
        throw new Error(`Row ${index + 2} ${field} must be blank. PPA fills fulfillment fields during packing.`);
      }
      const numericField = ["quantity", "totalCarts", "containerTotal", "productionQuantity", "cartMaxQuantity"].includes(field);
      if ((typeof supplied !== "string" && typeof supplied !== "number") ||
          (typeof supplied === "number" && !Number.isFinite(supplied) && !numericField)) {
        throw new Error(`Row ${index + 2} ${field} must be text or a finite number.`);
      }
      if (!numericField && typeof supplied === "number" && Number.isInteger(supplied) && !Number.isSafeInteger(supplied)) {
        throw new Error(`Row ${index + 2} ${field} exceeds safe numeric precision. Store identifiers as text.`);
      }
      const text = String(supplied);
      if (text.length > MAX_IMPORT_CELL_CHARACTERS) {
        throw new Error(`Row ${index + 2} ${field} exceeds the 512-character cell limit.`);
      }
      if (/[\u0000-\u001f\u007f-\u009f]/.test(text.trim())) {
        throw new Error(`Row ${index + 2} ${field} contains unsupported control characters.`);
      }
    }
    const rawArea = clean(row.areaType).toLowerCase();
    if (rawArea !== "onsite" && rawArea !== "offsite") {
      throw new Error(`Row ${index + 2} must use Onsite or Offsite in the Area column.`);
    }
    const unitOfMeasure = normalizeUnitOfMeasure(row.unitOfMeasure);
    const sourceLineId = clean(row.sourceLineId);
    const sourceScope = clean(row.sourceScope);
    for (const [field, identifier] of [["sourceLineId", sourceLineId], ["sourceScope", sourceScope], ["preferredSupplierId", clean(row.preferredSupplierId)]]) {
      if (identifier.length > 180) throw new Error(`Row ${index + 2} ${field} exceeds the 180-character identifier limit.`);
    }
    if (sourceLineId) {
      const identity = JSON.stringify([sourceScope, sourceLineId]);
      if (sourceIdentities.has(identity)) throw new Error(`Row ${index + 2} repeats Source Line ID within the same source scope.`);
      sourceIdentities.add(identity);
    }

    const cleaned: ImportRow = {
      plant: clean(row.plant),
      zone: clean(row.zone),
      areaType: rawArea,
      shipCategory: clean(row.shipCategory),
      loadNumber: clean(row.loadNumber),
      trainNumber: clean(row.trainNumber),
      picklistNumber: clean(row.picklistNumber),
      cartNumber: clean(row.cartNumber) || "1",
      cartId: clean(row.cartId) || clean(row.picklistNumber),
      palletId: clean(row.palletId),
      programId: clean(row.programId) || "ODG303R",
      totalCarts: optionalWholeNumber(row.totalCarts, "Total Carts", index + 2),
      pymtc: clean(row.pymtc),
      checksheetNumber: clean(row.checksheetNumber),
      sequence: clean(row.sequence),
      packSequence: clean(row.packSequence),
      partNumber: clean(row.partNumber),
      description: clean(row.description),
      color: clean(row.color),
      quantity: parseQuantity(row.quantity, unitOfMeasure),
      unitOfMeasure,
      sourceLineId,
      sourceScope,
      preferredSupplierId: clean(row.preferredSupplierId),
      productionQuantity: clean(row.productionQuantity) === "" ? undefined : optionalWholeNumber(row.productionQuantity, "Production Quantity", index + 2),
      cartMaxQuantity: clean(row.cartMaxQuantity) === "" ? undefined : optionalCartMaximum(row.cartMaxQuantity, index + 2),
      interiorColor: clean(row.interiorColor),
      exteriorColor: clean(row.exteriorColor),
      vehicleColor: clean(row.vehicleColor),
      aiagSerial: "",
      masterBarcode: clean(row.masterBarcode),
      movementBarcode: clean(row.movementBarcode),
      caseCode: clean(row.caseCode),
      outgoingSerial: clean(row.outgoingSerial),
      cartSequenceNumber: clean(row.cartSequenceNumber),
      fromLot: clean(row.fromLot),
      toLot: clean(row.toLot),
      model: clean(row.model),
      cartType: clean(row.cartType),
      option: clean(row.option),
      scheduledDispatchDate: clean(row.scheduledDispatchDate),
      scheduledDispatchTime: clean(row.scheduledDispatchTime),
      deliveryLocation: clean(row.deliveryLocation),
      detailDeliveryLocation: clean(row.detailDeliveryLocation),
      containerPosition: clean(row.containerPosition),
      containerType: clean(row.containerType),
      containerSequence: clean(row.containerSequence),
      fromModel: clean(row.fromModel),
      fromType: clean(row.fromType),
      fromOption: clean(row.fromOption),
      fromColor: clean(row.fromColor),
      fromInteriorColor: clean(row.fromInteriorColor),
      fromUnits: clean(row.fromUnits),
      toModel: clean(row.toModel),
      toType: clean(row.toType),
      toOption: clean(row.toOption),
      toColor: clean(row.toColor),
      toInteriorColor: clean(row.toInteriorColor),
      toUnits: clean(row.toUnits),
      pickingLocation: clean(row.pickingLocation),
      mcid: clean(row.mcid),
      containerTotal: optionalWholeNumber(row.containerTotal, "Container Total", index + 2),
      chassisNumber: clean(row.chassisNumber),
      orderNumber: clean(row.orderNumber),
      batchNumber: clean(row.batchNumber),
      loadingSequence: clean(row.loadingSequence),
    };

    const requiredValues = [
      cleaned.plant, cleaned.zone, cleaned.shipCategory, cleaned.picklistNumber,
      cleaned.sequence,
      cleaned.partNumber,
    ];
    const movementMissing = cleaned.areaType === "onsite" ? !cleaned.trainNumber : !cleaned.loadNumber;
    if (requiredValues.some((item) => !item) || movementMissing ||
        !Number.isFinite(cleaned.quantity) || cleaned.quantity <= 0) {
      throw new Error(`Row ${index + 2} has missing or invalid data. Quantity must be ${unitOfMeasure === "EA" ? "a positive whole number" : "a positive decimal with at most six decimal places"} no greater than 2,147,483,647.`);
    }
    const keyComponents = [
      cleaned.plant,
      cleaned.areaType === "onsite" ? cleaned.trainNumber : cleaned.loadNumber,
      cleaned.picklistNumber,
      cleaned.cartNumber,
      cleaned.cartId,
    ];
    if (keyComponents.some((component) => component.includes("::"))) {
      throw new Error(`Row ${index + 2} key fields cannot contain the reserved :: delimiter.`);
    }

    for (const [field, label] of barcodeFields) {
      const barcodeValue = String(cleaned[field] ?? "");
      if (barcodeValue) {
        try {
          encodeCode39(barcodeValue);
        } catch {
          throw new Error(`Row ${index + 2} ${label} contains characters that cannot be printed as a Code 39 barcode.`);
        }
        const maximum = maximumBarcodeCharacters[field];
        if (maximum && barcodeValue.length > maximum) {
          throw new Error(`Row ${index + 2} ${label} is too long for the generated picklist barcode.`);
        }
      }
    }

    validatePrintableFields(cleaned, `Row ${index + 2}`);

    if (cleaned.areaType === "onsite" && !resolveOnsiteMasterBarcode(cleaned)) {
      throw new Error(`Row ${index + 2} requires a Master Barcode or Checksheet Number because a cart master barcode cannot be derived safely.`);
    }
    if (cleaned.areaType === "onsite" && !resolveOnsiteMovementBarcode(cleaned)) {
      throw new Error(`Row ${index + 2} requires a Movement Barcode because one cannot be derived safely.`);
    }

    const key = cartKey(cleaned);
    const existing = cartMetadata.get(key);
    const cartConflicts = existing && headerConflictDetails(cartLevelFields, cleaned, index + 2, existing);
    if (cartConflicts) {
      throw new Error(`Row ${index + 2} conflicts with another row for picklist ${cleaned.picklistNumber}. ${cartConflicts} Each picklist has exactly one outbound card/pallet/order. Correct the conflicting values or the Picklist Number.`);
    }
    if (!existing) cartMetadata.set(key, { rowNumber: index + 2, values: Object.fromEntries(cartLevelFields.map((field) => [field, cleaned[field]])) });
    const sequenceKey = JSON.stringify([key, normalizeScanValue(cleaned.sequence)]);
    if (cartSequences.has(sequenceKey)) {
      throw new Error(`Row ${index + 2} repeats a Sequence within picklist ${cleaned.picklistNumber}. Each demand line must have a unique sequence.`);
    }
    cartSequences.add(sequenceKey);


    if (cleaned.areaType === "offsite") {
      const documentKey = loadKey(cleaned);
      const existingLoad = loadMetadata.get(documentKey);
      const loadConflicts = existingLoad && headerConflictDetails(loadLevelFields, cleaned, index + 2, existingLoad);
      if (loadConflicts) {
        throw new Error(`Row ${index + 2} conflicts with another row for load ${cleaned.loadNumber}. ${loadConflicts} Trailer-load print fields must match across the document.`);
      }
      if (!existingLoad) loadMetadata.set(documentKey, { rowNumber: index + 2, values: Object.fromEntries(loadLevelFields.map((field) => [field, cleaned[field]])) });
    }

    return cleaned;
  });
}
