import type { DemandScanField } from "./scan-values.ts";

/** Speech is deliberately separate from detailed messages and container values. */
export const SCAN_FEEDBACK = {
  alreadyScanned: "Already scanned",
  containerUsed: "Container already used",
  demandFulfilled: "Demand already fulfilled",
  notInPicklist: "Not in picklist",
  alreadyCaptured: "Already captured. Check screen",
  checkScreen: "Check screen",
  receiptNotConfirmed: "Receipt not confirmed. Check screen",
  scanSerial: "Scan serial",
  scanPartNumber: "Scan part number",
  scanColor: "Scan color",
  scanQuantity: "Scan quantity",
  wrongSerial: "Wrong serial",
  wrongPartNumber: "Wrong part number",
  wrongColor: "Wrong color",
  wrongQuantity: "Wrong quantity",
  scanNotProcessed: "Scan not processed. Check screen",
  doNotLoad: "Do not load",
  networkProblem: "Network problem. Check screen",
} as const;

export type ScanFeedback = keyof typeof SCAN_FEEDBACK;

const FIELD_PROMPTS: Record<DemandScanField, ScanFeedback> = {
  aiagSerial: "scanSerial", partNumber: "scanPartNumber", color: "scanColor", quantity: "scanQuantity",
};
const MISMATCH_PROMPTS: Record<DemandScanField, ScanFeedback> = {
  aiagSerial: "wrongSerial", partNumber: "wrongPartNumber", color: "wrongColor", quantity: "wrongQuantity",
};

export function packingScanFeedback(reason?: string): ScanFeedback {
  switch (reason) {
    case "inventory_consumed": return "containerUsed";
    case "demand_fulfilled": return "demandFulfilled";
    case "no_matching_demand":
    case "content_mismatch":
    case "inventory_mismatch": return "notInPicklist";
    default: return "checkScreen";
  }
}

export function receivingScanFeedback(result: { status: string; field?: DemandScanField }): ScanFeedback {
  if (result.status === "duplicate") return "alreadyScanned";
  if (result.status === "conflict") return "alreadyCaptured";
  if (!result.field) return "checkScreen";
  return result.status === "mismatch" ? MISMATCH_PROMPTS[result.field] : FIELD_PROMPTS[result.field];
}
