/** Quantities use six decimal places at most, without floating-point arithmetic. */
export const QUANTITY_DECIMAL_PLACES = 6;
export const QUANTITY_SCALE = 1_000_000n;
export const MAX_QUANTITY = 2_147_483_647;

const unitAliases: Record<string, string> = {
  EA: "EA", EACH: "EA", PC: "EA", PCS: "EA", PIECE: "EA", PIECES: "EA", UNIT: "EA", UNITS: "EA",
  KG: "KG", KGS: "KG", KILOGRAM: "KG", KILOGRAMS: "KG",
  G: "G", GRAM: "G", GRAMS: "G", MG: "MG",
  M: "M", METER: "M", METERS: "M", METRE: "M", METRES: "M", CM: "CM", MM: "MM",
  L: "L", LITER: "L", LITERS: "L", LITRE: "L", LITRES: "L", ML: "ML",
  LB: "LB", LBS: "LB", OZ: "OZ", FT: "FT", IN: "IN",
};

export function normalizeUnitOfMeasure(value: unknown = "EA") {
  if (value === undefined || value === null || value === "") return "EA";
  if (typeof value !== "string") throw new Error("Unit of measure must be a supported unit code.");
  const supplied = value.trim().toUpperCase();
  if (!supplied) return "EA";
  const unit = unitAliases[supplied];
  if (!unit) throw new Error(`Unsupported unit of measure: ${supplied}. Use EA or a supported measured unit such as KG, G, M, or L.`);
  return unit;
}

/** Non-negative quantity represented as an exact integer of millionths. No unit conversion. */
export function quantityToScaled(value: unknown, unitOfMeasure: unknown = "EA"): bigint {
  const unit = normalizeUnitOfMeasure(unitOfMeasure);
  return decimalToScaled(value, unit === "EA");
}

function decimalToScaled(value: unknown, wholeOnly: boolean): bigint {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("Quantity must be a decimal number.");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Quantity must be finite.");
  const text = String(value).trim();
  const pattern = wholeOnly
    ? /^(?:\d+|\d{1,3}(?:,\d{3})+)$/
    : /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,6})?$/;
  if (!pattern.test(text)) throw new Error(wholeOnly
    ? "EA quantity must be a non-negative whole number."
    : "Measured quantity must be a non-negative decimal with at most six decimal places.");
  const [whole, fraction = ""] = text.replaceAll(",", "").split(".");
  const scaled = BigInt(whole) * QUANTITY_SCALE + BigInt(fraction.padEnd(QUANTITY_DECIMAL_PLACES, "0"));
  if (scaled > BigInt(MAX_QUANTITY) * QUANTITY_SCALE || scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Quantity must be no greater than ${MAX_QUANTITY.toLocaleString("en-US")}.`);
  }
  return scaled;
}

/** Decimal metadata (for example source cart capacity), without assigning it a UOM. */
export function parseDecimalQuantity(value: unknown, optional = false): number {
  if (optional && (value === undefined || value === null || (typeof value === "string" && !value.trim()))) return 0;
  try {
    const scaled = decimalToScaled(value, false);
    const quantity = Number(scaled) / Number(QUANTITY_SCALE);
    return decimalToScaled(quantity, false) === scaled ? quantity : Number.NaN;
  } catch { return Number.NaN; }
}

/** Parser contract matches parseImportWholeNumber: invalid input returns NaN. */
export function parseQuantity(value: unknown, unitOfMeasure: unknown = "EA", optional = false): number {
  if (optional && (value === undefined || value === null || (typeof value === "string" && !value.trim()))) return 0;
  try {
    const scaled = quantityToScaled(value, unitOfMeasure);
    const quantity = Number(scaled) / Number(QUANTITY_SCALE);
    // A numeric API value must round-trip to the exact decimal originally supplied.
    if (quantityToScaled(quantity, unitOfMeasure) !== scaled) return Number.NaN;
    return quantity;
  } catch { return Number.NaN; }
}

export function quantitiesEqual(left: unknown, right: unknown, leftUnit: unknown = "EA", rightUnit: unknown = leftUnit) {
  try {
    return normalizeUnitOfMeasure(leftUnit) === normalizeUnitOfMeasure(rightUnit)
      && quantityToScaled(left, leftUnit) === quantityToScaled(right, rightUnit);
  } catch { return false; }
}
