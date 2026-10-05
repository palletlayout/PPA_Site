import type { InventoryItem } from "./inventory-types.ts";

/** Missing stock is the next capture step, before generic fulfillment failures. */
export function packingReceiptForResult(result: { reason?: string; serial?: string; inventory?: InventoryItem }, serialBarcode: string) {
  if (result.reason === "inventory_not_found") return { serial: result.serial ? `1S${result.serial}` : serialBarcode, capturing: true as const };
  if (result.reason === "inventory_expected" && result.inventory) {
    return { serial: `1S${result.inventory.serial}`, capturing: true as const, inventory: result.inventory };
  }
  return null;
}
