import type { CartLine } from "./types.ts";

export type SupervisorStatus = "ready" | "active" | "done" | "loaded" | "dispatched" | "attention" | "short";
export type SupervisorFilters = {
  query: string;
  status: "all" | SupervisorStatus;
  areaType: "all" | "onsite" | "offsite";
  plant: string;
  zone: string;
};

export const EMPTY_SUPERVISOR_FILTERS: SupervisorFilters = {
  query: "", status: "all", areaType: "all", plant: "", zone: "",
};

export function supervisorSearchMatches(line: CartLine, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const searchable = [
    line.plant, line.zone, line.loadNumber, line.trainNumber, line.movementBarcode,
    line.picklistNumber, line.masterBarcode, line.checksheetNumber, line.cartBarcode,
    line.cartNumber, line.cartId, line.palletId, line.orderNumber, line.outgoingSerial,
    line.partNumber, line.description, line.color, line.aiagSerial,
    line.sequence, line.packSequence, line.containerSequence, line.loadingSequence,
    line.fromLot, line.toLot, line.model, line.fromModel, line.toModel,
    line.fromType, line.toType, line.fromOption, line.toOption, line.option,
    line.fromColor, line.toColor, line.fromInteriorColor, line.toInteriorColor,
    line.vehicleColor, line.interiorColor, line.exteriorColor,
    line.deliveryLocation, line.detailDeliveryLocation, line.pickingLocation,
    line.containerPosition, line.containerType, line.mcid, line.chassisNumber,
    ...(line.allocations || []).flatMap((allocation) => [allocation.serial, allocation.packedBy]),
  ].filter(Boolean).join(" \n ").toLocaleLowerCase();
  return terms.every((term) => searchable.includes(term));
}

export function supervisorLineMatches(line: CartLine, filters: SupervisorFilters): boolean {
  return (filters.areaType === "all" || line.areaType === filters.areaType)
    && (!filters.plant || line.plant === filters.plant)
    && (!filters.zone || line.zone === filters.zone)
    && supervisorSearchMatches(line, filters.query);
}

export function filterSupervisorMovements<T extends { status: SupervisorStatus; lines: CartLine[] }>(movements: T[], filters: SupervisorFilters): T[] {
  return movements.filter((movement) => (filters.status === "all" || movement.status === filters.status)
    && movement.lines.some((line) => supervisorLineMatches(line, filters)));
}

export function filterSupervisorPicklists<T extends { lines: CartLine[] }>(picklists: T[], filters: SupervisorFilters, query: string): T[] {
  return picklists.filter((picklist) => picklist.lines.some((line) => supervisorLineMatches(line, filters) && supervisorSearchMatches(line, query)));
}

export function visibleSupervisorSelection<T extends { key: string }>(items: T[], selectedKey: string | null): T | null {
  return items.find((item) => item.key === selectedKey) || items[0] || null;
}
