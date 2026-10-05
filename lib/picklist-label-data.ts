import type { CartLine } from "./types.ts";

// Courier 7 pt gives each character 4.2 points in the 548-point label body.
export const LABEL_NOTE_WIDTH = 128;
export const LABEL_NOTE_LINE_HEIGHT = 8.5;
export const LABEL_BASE_ROW_HEIGHT = 32;
export const VEHICLE_HEADER_LINE_HEIGHT = 10;
export const VEHICLE_HEADER_TITLE_HEIGHT = 14;
export const VEHICLE_HEADER_MIN_HEIGHT = 72;
const VEHICLE_HEADER_MAX_HEIGHT = 200;
// Courier 8 pt: 114 characters occupy 547.2 points.
const VEHICLE_HEADER_WIDTH = 114;

export type VehicleHeaderBlock = Readonly<{ title: string; lines: readonly string[] }>;
export type VehicleHeader = Readonly<{ blocks: readonly VehicleHeaderBlock[]; height: number }>;

type Field = readonly [keyof CartLine, string];
const otherFields: readonly Field[] = [
  ["description", "Description"], ["chassisNumber", "Chassis"],
  ["orderNumber", "Order"], ["batchNumber", "Batch"],
  ["loadingSequence", "Loading sequence"], ["pymtc", "P/Y/M/T/C"],
];

function text(input: unknown): string {
  return String(input ?? "").trim();
}

function fieldText(line: CartLine, field: keyof CartLine): string {
  const supplied = text(line[field]);
  if (/[^\x20-\x7e]/.test(supplied)) {
    throw new Error(`Picklist row ${line.sequence} ${field} cannot be printed losslessly. Use printable ASCII characters.`);
  }
  return supplied;
}

/** Keep complete, distinct source vehicle combinations in the master header.
 * Units are source values, not a total of repeated demand-line quantities. */
export function vehicleHeaders(lines: readonly CartLine[]): VehicleHeader[] {
  const blocks: VehicleHeaderBlock[] = [];
  for (const side of ["from", "to"] as const) {
    const seen = new Set<string>();
    const entries: string[] = [];
    for (const line of lines) {
      const fields = [
        fieldText(line, `${side}Lot`),
        fieldText(line, `${side}Model`) || fieldText(line, "model"),
        fieldText(line, `${side}Type`),
        fieldText(line, `${side}Option`) || fieldText(line, "option"),
        fieldText(line, `${side}Color`) || fieldText(line, "vehicleColor") || fieldText(line, "exteriorColor"),
        fieldText(line, `${side}InteriorColor`) || fieldText(line, "interiorColor"),
        fieldText(line, `${side}Units`),
      ];
      const key = JSON.stringify(fields);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = fields.map((field) => field || "-").join(" / ");
      entries.push(...(entry.match(new RegExp(`.{1,${VEHICLE_HEADER_WIDTH}}`, "g")) || [entry]));
    }
    blocks.push({ title: `${side.toUpperCase()} Lot# / Model / Type / Ops / Color / Interior color / Units`, lines: entries });
  }

  // Older imports can carry additional vehicle values alongside FROM/TO.
  // Preserve any value that the two source summaries did not already print.
  const extras = new Set<string>();
  for (const line of lines) {
    const fromColor = fieldText(line, "fromColor") || fieldText(line, "vehicleColor") || fieldText(line, "exteriorColor");
    const toColor = fieldText(line, "toColor") || fieldText(line, "vehicleColor") || fieldText(line, "exteriorColor");
    const legacy: readonly [keyof CartLine, string, readonly string[]][] = [
      ["model", "Model", [fieldText(line, "fromModel") || fieldText(line, "model"), fieldText(line, "toModel") || fieldText(line, "model")]],
      ["option", "Ops", [fieldText(line, "fromOption") || fieldText(line, "option"), fieldText(line, "toOption") || fieldText(line, "option")]],
      ["vehicleColor", "Vehicle color", [fromColor, toColor]],
      ["interiorColor", "Interior color", [fieldText(line, "fromInteriorColor") || fieldText(line, "interiorColor"), fieldText(line, "toInteriorColor") || fieldText(line, "interiorColor")]],
      ["exteriorColor", "Exterior color", [fromColor, toColor]],
    ];
    const extra = legacy.flatMap(([field, label, printed]) => {
      const entry = fieldText(line, field);
      return entry && !printed.includes(entry) ? [`${label}: ${entry}`] : [];
    }).join(" | ");
    if (extra) extras.add(extra);
  }
  if (extras.size) blocks.push({ title: "Other vehicle data", lines: [...extras].flatMap((entry) => entry.match(new RegExp(`.{1,${VEHICLE_HEADER_WIDTH}}`, "g")) || [entry]) });

  // Long values continue in the header of another master-label page, never
  // under a part row. Every continuation retains both business barcodes.
  const headers: VehicleHeader[] = [];
  let pending: VehicleHeaderBlock[] = [];
  let height = 0;
  const flush = () => {
    if (pending.length) headers.push({ blocks: pending, height: Math.max(VEHICLE_HEADER_MIN_HEIGHT, height) });
    pending = [];
    height = 0;
  };
  for (const block of blocks) {
    let offset = 0;
    while (offset < block.lines.length) {
      const available = Math.floor((VEHICLE_HEADER_MAX_HEIGHT - height - VEHICLE_HEADER_TITLE_HEIGHT) / VEHICLE_HEADER_LINE_HEIGHT);
      if (available < 1) { flush(); continue; }
      const selected = block.lines.slice(offset, offset + available);
      pending.push({ title: block.title, lines: selected });
      height += VEHICLE_HEADER_TITLE_HEIGHT + selected.length * VEHICLE_HEADER_LINE_HEIGHT;
      offset += selected.length;
      if (offset < block.lines.length) flush();
    }
  }
  flush();
  return headers;
}

/** Part-specific notes remain beside their part; vehicle data is header-only. */
export function labelNoteBlocks(line: CartLine): string[][] {
  const blocks: string[][] = [];
  function addFields(fields: readonly Field[]) {
    let entry = "";
    const flush = () => {
      if (entry) blocks.push(entry.match(/.{1,128}/g) || [entry]);
      entry = "";
    };
    for (const [field, label] of fields) {
      const supplied = fieldText(line, field);
      if (!supplied) continue;
      const next = `${label}: ${supplied}`;
      if (entry && entry.length + 3 + next.length > LABEL_NOTE_WIDTH) flush();
      entry = entry ? `${entry} | ${next}` : next;
    }
    flush();
  }
  if (fieldText(line, "containerSequence").length > 17) addFields([["containerSequence", "Container sequence"]]);
  if (text(line.shipCategory).length > 21) addFields([["shipCategory", "Ship category"]]);
  if (line.containerTotal) addFields([["containerTotal", "Container total"]]);
  if (text(line.checksheetNumber) && line.checksheetNumber !== (line.masterBarcode || line.picklistNumber)) {
    addFields([["checksheetNumber", "Checksheet"]]);
  }
  addFields(otherFields);
  return blocks;
}

export function labelRowHeight(notes: readonly string[]): number {
  return LABEL_BASE_ROW_HEIGHT + (notes.length ? notes.length * LABEL_NOTE_LINE_HEIGHT + 4 : 0);
}
