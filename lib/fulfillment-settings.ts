export type FulfillmentSettings = {
  packingMode: "exact" | "multiple";
  inventoryMode: "uploaded" | "scan";
  /** Retained for older clients; the only supported attribute is optional color. */
  partAttribute: "color";
};

export const DEFAULT_FULFILLMENT_SETTINGS: FulfillmentSettings = {
  packingMode: "exact",
  inventoryMode: "uploaded",
  partAttribute: "color",
};

export function partAttributeLabels(_attribute?: string) {
  void _attribute; // Older callers may still pass their saved setting.
  return { label: "Color", empty: "No color", prefix: "C" };
}

export function validateFulfillmentSettings(value: unknown): FulfillmentSettings {
  if (!value || typeof value !== "object") throw new Error("Provide fulfillment settings.");
  const input = value as Record<string, unknown>;
  if (input.packingMode !== "exact" && input.packingMode !== "multiple") throw new Error("Packing mode must be exact or multiple.");
  if (input.inventoryMode !== "uploaded" && input.inventoryMode !== "scan") throw new Error("Inventory mode must be uploaded or scan.");
  const partAttribute = input.partAttribute === undefined ? DEFAULT_FULFILLMENT_SETTINGS.partAttribute : input.partAttribute;
  if (partAttribute !== "color" && partAttribute !== "part_level" && partAttribute !== "color_or_part_level") {
    throw new Error("Part attribute must be color.");
  }
  // Normalize saved settings and requests from the short-lived configurable UI.
  return { packingMode: input.packingMode, inventoryMode: input.inventoryMode, partAttribute: "color" };
}
