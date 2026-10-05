import { picklistBarcodeMatches, normalizeIdentityBarcode } from "../lib/cart-identity.ts";

type PackingReference = {
  plant: string;
  areaType: "onsite" | "offsite";
  trainNumber: string;
  loadNumber: string;
  verified: number;
  total: number;
  lines: Array<{ cartBarcode: string; picklistNumber: string; checksheetNumber?: string; masterBarcode?: string; orderNumber?: string }>;
};

type PackingMovement = { plant: string; areaType: "onsite" | "offsite"; number: string };

function inMovement(reference: PackingReference, movement: PackingMovement) {
  return normalizeIdentityBarcode(reference.plant) === normalizeIdentityBarcode(movement.plant) && reference.areaType === movement.areaType
    && normalizeIdentityBarcode(reference.areaType === "onsite" ? reference.trainNumber : reference.loadNumber) === normalizeIdentityBarcode(movement.number);
}

/** A picklist owns exactly one outbound card. Include completed headers in this check. */
export function conflictingPackingPicklists(references: PackingReference[], movement: PackingMovement): string[] {
  const headers = new Map<string, Set<string>>();
  for (const reference of references.filter((candidate) => inMovement(candidate, movement))) {
    for (const line of reference.lines) {
      const identities = headers.get(normalizeIdentityBarcode(line.picklistNumber)) || new Set<string>();
      identities.add(line.cartBarcode);
      headers.set(normalizeIdentityBarcode(line.picklistNumber), identities);
    }
  }
  return [...headers].filter(([, identities]) => identities.size > 1).map(([picklist]) => picklist);
}

/** Legacy duplicate outbound cards require reconciliation, even for a specific barcode. */
export function matchingPackingReferences<T extends PackingReference>(references: T[], movement: PackingMovement, barcode: string): T[] {
  const conflicts = new Set(conflictingPackingPicklists(references, movement));
  const matches = references.filter((reference) => inMovement(reference, movement)
    && !reference.lines.some((line) => conflicts.has(normalizeIdentityBarcode(line.picklistNumber)))
    && reference.lines.some((line) => picklistBarcodeMatches(line, barcode)));
  // Finished physical labels still exist. They cannot identify another card
  // merely because their own work has disappeared from the unfinished queue.
  return matches.length > 1 ? matches : matches.filter((reference) => reference.verified < reference.total);
}
