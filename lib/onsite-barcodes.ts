type OnsiteBarcodeFields = {
  plant: string;
  zone: string;
  shipCategory: string;
  trainNumber: string;
  cartSequenceNumber?: string;
  masterBarcode?: string;
  movementBarcode?: string;
  checksheetNumber?: string;
};

function value(input: unknown) {
  return String(input ?? "").trim();
}

export function deriveOnsiteMasterBarcode(line: OnsiteBarcodeFields): string | null {
  const plant = value(line.plant).toUpperCase();
  const shipCategory = value(line.shipCategory).toUpperCase();
  const train = value(line.trainNumber).toUpperCase();
  const sequenceMatch = value(line.cartSequenceNumber).match(/^0*(\d{1,2})(?:\D|$)/);
  if (!/^[0-9A-Z]{2}$/.test(plant) || !/^[0-9A-Z]{2}$/.test(shipCategory) ||
      !/^[0-9A-Z. $/+%\-]{8}$/.test(train) || !sequenceMatch) return null;
  return `Z1${plant}${shipCategory}${train}${sequenceMatch[1].padStart(2, "0")}`;
}

export function deriveOnsiteMovementBarcode(line: OnsiteBarcodeFields): string | null {
  const plant = value(line.plant).toUpperCase();
  const shipCategory = value(line.shipCategory).toUpperCase();
  const train = value(line.trainNumber).toUpperCase();
  const zone = value(line.zone).toUpperCase();
  if (!/^[0-9A-Z]{2}$/.test(plant) || !/^[0-9A-Z]{2}$/.test(shipCategory) ||
      !/^[0-9A-Z. $/+%\-]{8}$/.test(train) || !/^[0-9A-Z]$/.test(zone)) return null;
  return `AE${plant[1]}${train}X${zone}${shipCategory}`;
}

export function resolveOnsiteMasterBarcode(line: OnsiteBarcodeFields): string | null {
  return value(line.masterBarcode) || value(line.checksheetNumber) || deriveOnsiteMasterBarcode(line);
}

export function resolveOnsiteMovementBarcode(line: OnsiteBarcodeFields): string | null {
  return value(line.movementBarcode) || deriveOnsiteMovementBarcode(line);
}
