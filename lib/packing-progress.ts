import type { CartLine } from "./types.ts";
import { quantityToScaled, QUANTITY_SCALE } from "./quantity.ts";

export function comparePackingLines(left: Pick<CartLine, "sequence" | "packSequence" | "id">, right: Pick<CartLine, "sequence" | "packSequence" | "id">) {
  return (left.packSequence || left.sequence).localeCompare(right.packSequence || right.sequence, undefined, { numeric: true })
    || left.sequence.localeCompare(right.sequence, undefined, { numeric: true }) || left.id.localeCompare(right.id);
}

export function remainingDemand(line: Pick<CartLine, "quantity" | "fulfilledQuantity" | "unitOfMeasure">) {
  const remaining = quantityToScaled(line.quantity, line.unitOfMeasure) - quantityToScaled(line.fulfilledQuantity || 0, line.unitOfMeasure);
  return Number(remaining > 0n ? remaining : 0n) / Number(QUANTITY_SCALE);
}

export function packingLineLabel(line: Pick<CartLine, "status" | "fulfilledQuantity">) {
  return line.status === "short" ? "Short" : line.status === "verified" ? "Packed"
    : line.status === "active" || line.fulfilledQuantity > 0 ? "Active" : "Unpacked";
}

export function shippingPriority(line: Pick<CartLine, "scheduledDispatchDate" | "scheduledDispatchTime">) {
  return `${line.scheduledDispatchDate || "9999-12-31"}T${line.scheduledDispatchTime || "23:59:59"}`;
}

/** A rate of completed demand lines; quantities with different units are never added. */
export function packingMetrics(lines: CartLine[]) {
  const groups = new Map<string, CartLine[]>();
  for (const line of lines) {
    const key = JSON.stringify([line.plant, line.areaType, line.areaType === "onsite" ? line.trainNumber : line.loadNumber, line.picklistNumber]);
    groups.set(key, [...(groups.get(key) || []), line]);
  }
  const picklists = [...groups.values()];
  const allocations = lines.flatMap((line) => line.allocations || []);
  const times = allocations.map((entry) => Date.parse(entry.packedAt)).filter(Number.isFinite);
  const packedLines = lines.filter((line) => line.status === "verified").length;
  const elapsedHours = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 3_600_000 : 0;
  return {
    packed: picklists.filter((group) => group.every((line) => line.status === "verified")).length,
    unpacked: picklists.filter((group) => group.every((line) => line.status === "pending" && !line.fulfilledQuantity)).length,
    short: picklists.filter((group) => group.some((line) => line.status === "short")).length,
    // Observed throughput, not paid-hours productivity. Show no rate for a single timestamp.
    linesPerHour: elapsedHours > 0 ? Math.round(packedLines / elapsedHours * 10) / 10 : null,
    completion: lines.length ? Math.round(packedLines / lines.length * 100) : 0,
  };
}
