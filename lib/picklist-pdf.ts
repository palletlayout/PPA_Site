import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

import { encodeCode128 } from "./code128.ts";
import { validatePrintableFields } from "./import-validation.ts";
import {
  LABEL_NOTE_LINE_HEIGHT, VEHICLE_HEADER_LINE_HEIGHT, VEHICLE_HEADER_TITLE_HEIGHT,
  labelNoteBlocks, labelRowHeight, vehicleHeaders, type VehicleHeader,
} from "./picklist-label-data.ts";
import { parseQuantity } from "./quantity.ts";
import {
  resolveOnsiteMasterBarcode,
  resolveOnsiteMovementBarcode,
} from "./onsite-barcodes.ts";
import type { CartLine } from "./types.ts";

const LETTER_WIDTH = 612;
const LETTER_HEIGHT = 792;
const CONTENT_LEFT = 32;
const CONTENT_WIDTH = 548;
const INK = rgb(0, 0, 0);
const RULE = rgb(0.34, 0.37, 0.4);
const MIN_BAR_MODULE_POINTS = 0.7;
const MIN_TEXT_POINTS = 6;

type Fonts = Readonly<{
  regular: PDFFont;
  bold: PDFFont;
}>;

type Column = Readonly<{
  label: string;
  width: number;
  align?: "left" | "right" | "center";
}>;

type TableCell =
  | string
  | number
  | Readonly<{
      primary: string | number;
      secondary?: string | number;
      abbreviateSecondary?: boolean;
    }>;

type LabelRow = Readonly<{ line: CartLine; notes: readonly string[] }>;
type PlannedPage = Readonly<{
  kind: "onsite" | "offsite";
  source: CartLine;
  header: VehicleHeader;
  lines: readonly CartLine[];
  rows: readonly LabelRow[];
  groupPage: number;
  groupPages: number;
}>;

type PdfScope = "picklist" | "movement" | "section";
type BundlePage = Readonly<{ page: number; pages: number }>;

function value(input: string | null | undefined): string {
  return String(input ?? "").trim();
}

function printable(input: string | number | null | undefined): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "-";
  return raw.replace(/[^\x20-\x7E]/g, "?");
}

function printableOrBlank(input: string | number | null | undefined): string {
  const raw = String(input ?? "").trim();
  return raw ? raw.replace(/[^\x20-\x7E]/g, "?") : "";
}

function compareText(a: string | null | undefined, b: string | null | undefined): number {
  return value(a).localeCompare(value(b), "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function compareLines(a: CartLine, b: CartLine): number {
  return (
    compareText(a.plant, b.plant) ||
    compareText(a.areaType, b.areaType) ||
    compareText(a.trainNumber || a.loadNumber, b.trainNumber || b.loadNumber) ||
    compareText(a.picklistNumber, b.picklistNumber) ||
    compareText(a.cartSequenceNumber, b.cartSequenceNumber) ||
    compareText(a.cartNumber, b.cartNumber) ||
    compareText(a.cartId, b.cartId) ||
    compareText(a.packSequence || a.sequence, b.packSequence || b.sequence) ||
    compareText(a.sequence, b.sequence) ||
    compareText(a.containerPosition, b.containerPosition) ||
    compareText(a.partNumber, b.partNumber) ||
    compareText(a.id, b.id)
  );
}

function groupBy<T>(items: readonly T[], keyFor: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()];
}

function planPages(lines: readonly CartLine[]): PlannedPage[] {
  const onsite = lines.filter((line) => line.areaType === "onsite");
  const offsite = lines.filter((line) => line.areaType === "offsite");
  const result: PlannedPage[] = [];
  const addGroup = (group: readonly CartLine[], kind: PlannedPage["kind"]) => {
    const headers = vehicleHeaders([...group].sort(compareLines));
    const bodyHeight = 338 - Math.max(...headers.map((header) => header.height));
    const pages: LabelRow[][] = [];
    let page: LabelRow[] = [];
    let used = 0;
    const flush = () => {
      if (page.length) pages.push(page);
      page = [];
      used = 0;
    };
    for (const line of [...group].sort(compareLines)) {
      const blocks = labelNoteBlocks(line);
      const notes = blocks.flat();
      if (labelRowHeight(notes) <= bodyHeight) {
        if (page.length === 7 || used + labelRowHeight(notes) > bodyHeight) flush();
        page.push({ line, notes });
        used += labelRowHeight(notes);
        continue;
      }
      // A very long source row continues on another master label with the
      // same two barcodes. No report pages or truncated source values.
      flush();
      let fragment: string[] = [];
      const flushFragment = () => {
        if (fragment.length) pages.push([{ line, notes: fragment }]);
        fragment = [];
      };
      for (const block of blocks) {
        if (labelRowHeight(block) <= bodyHeight) {
          if (labelRowHeight([...fragment, ...block]) > bodyHeight) flushFragment();
          fragment.push(...block);
        } else {
          for (const entry of block) {
            if (labelRowHeight([...fragment, entry]) > bodyHeight) flushFragment();
            fragment.push(entry);
          }
        }
      }
      flushFragment();
    }
    flush();
    while (pages.length < headers.length) pages.push([]);
    pages.forEach((rows, groupPage) => result.push({
      kind, source: group[0], header: headers[groupPage % headers.length],
      rows, lines: rows.map((row) => row.line), groupPage, groupPages: pages.length,
    }));
  };

  const onsiteGroups = groupBy(
    onsite,
    (line) =>
      [
        line.plant,
        line.trainNumber,
        line.picklistNumber,
        line.cartNumber,
        line.cartId,
        line.cartBarcode,
      ].join("\u001f"),
  ).sort((a, b) => compareLines(a[0], b[0]));

  onsiteGroups.forEach((group) => addGroup(group, "onsite"));

  const offsiteGroups = groupBy(
    offsite,
    (line) =>
      [
        line.plant,
        line.loadNumber,
        line.picklistNumber,
        line.chassisNumber,
        line.orderNumber,
        line.cartNumber,
        line.cartId,
        line.palletId,
        line.cartBarcode,
      ].join("\u001f"),
  ).sort((a, b) => compareLines(a[0], b[0]));

  offsiteGroups.forEach((group) => addGroup(group, "offsite"));

  return result;
}

function fitText(font: PDFFont, input: string, size: number, maxWidth: number, abbreviate = false): string {
  const text = printable(input);
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  if (!abbreviate) {
    throw new Error(`Picklist value "${text.slice(0, 80)}" cannot fit at a readable font size. Use a shorter source identifier or a larger document layout; identifiers cannot be abbreviated.`);
  }

  const suffix = "...";
  let end = text.length;
  while (end > 0 && font.widthOfTextAtSize(`${text.slice(0, end)}${suffix}`, size) > maxWidth) {
    end -= 1;
  }
  return end > 0 ? `${text.slice(0, end)}${suffix}` : suffix;
}

function centeredX(font: PDFFont, text: string, size: number, x: number, width: number): number {
  return x + Math.max(0, (width - font.widthOfTextAtSize(text, size)) / 2);
}

function drawCenteredText(
  page: PDFPage,
  font: PDFFont,
  input: string,
  size: number,
  x: number,
  y: number,
  width: number,
): void {
  const actualSize = fittedSize(font, input, size, MIN_TEXT_POINTS, width);
  const text = fitText(font, input, actualSize, width);
  page.drawText(text, {
    x: centeredX(font, text, actualSize, x, width),
    y,
    size: actualSize,
    font,
    color: INK,
  });
}

function fittedSize(
  font: PDFFont,
  input: string | number | null | undefined,
  preferredSize: number,
  minimumSize: number,
  maxWidth: number,
): number {
  const text = printable(input);
  let size = preferredSize;
  while (size > minimumSize && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 0.25;
  }
  return Math.max(size, minimumSize);
}

function drawFittedText(
  page: PDFPage,
  font: PDFFont,
  input: string | number | null | undefined,
  x: number,
  y: number,
  width: number,
  preferredSize: number,
  minimumSize = MIN_TEXT_POINTS,
): void {
  const text = printable(input);
  const size = fittedSize(font, text, preferredSize, minimumSize, width);
  page.drawText(fitText(font, text, size, width), {
    x,
    y,
    size,
    font,
    color: INK,
  });
}

function drawReportLabel(
  page: PDFPage,
  fonts: Fonts,
  label: string,
  x: number,
  y: number,
  size = 7.5,
): void {
  page.drawText(printable(label), {
    x,
    y,
    size,
    font: fonts.bold,
    color: INK,
  });
}

function drawReportField(
  page: PDFPage,
  fonts: Fonts,
  label: string,
  fieldValue: string | number | null | undefined,
  x: number,
  labelY: number,
  width: number,
  valueSize = 12,
  valueY = labelY - 17,
): void {
  drawReportLabel(page, fonts, label, x, labelY);
  drawFittedText(page, fonts.regular, fieldValue, x, valueY, width, valueSize);
}

function drawInlineReportField(
  page: PDFPage,
  fonts: Fonts,
  label: string,
  fieldValue: string | number | null | undefined,
  x: number,
  y: number,
  labelWidth: number,
  valueWidth: number,
  valueSize = 11,
): void {
  drawReportLabel(page, fonts, label, x, y, 7.5);
  drawFittedText(
    page,
    fonts.regular,
    fieldValue,
    x + labelWidth,
    y,
    valueWidth,
    valueSize,
  );
}

function drawBarcode(
  page: PDFPage,
  fonts: Fonts,
  rawValue: string,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  humanReadable = true,
): void {
  const encoded = encodeCode128(rawValue);
  const moduleWidth = width / encoded.totalModules;
  if (moduleWidth < MIN_BAR_MODULE_POINTS) {
    throw new Error(
      `${label} is too long to render as a reliably scannable Code 128 barcode on this layout.`,
    );
  }

  let cursor = x;
  for (const run of encoded.runs) {
    const runWidth = run.modules * moduleWidth;
    if (run.isBar) {
      page.drawRectangle({ x: cursor, y, width: runWidth, height, color: INK });
    }
    cursor += runWidth;
  }

  if (humanReadable) {
    drawCenteredText(page, fonts.regular, encoded.payload, 7.5, x, y - 10, width);
  }
}

function drawDashedRule(
  page: PDFPage,
  x: number,
  y: number,
  width: number,
): void {
  page.drawLine({
    start: { x, y },
    end: { x: x + width, y },
    thickness: 0.55,
    color: INK,
    dashArray: [2.2, 2.2],
  });
}

function drawReportRows(
  page: PDFPage,
  fonts: Fonts,
  columns: readonly Column[],
  rows: readonly (readonly TableCell[])[],
  x: number,
  headerY: number,
  ruleY: number,
  firstRowY: number,
  rowHeight: number,
  rowTextSize = 9.5,
  secondaryTextSize = 7.25,
  labelRows: readonly LabelRow[] = [],
): void {
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);

  let columnX = x;
  columns.forEach((column) => {
    const labels = column.label.split("\n").slice(0, 2);
    labels.forEach((rawLabel, labelIndex) => {
      const labelSize = 7.25;
      const label = fitText(fonts.bold, rawLabel, labelSize, column.width - 2);
      const labelX =
        column.align === "center"
          ? centeredX(fonts.bold, label, labelSize, columnX, column.width)
          : column.align === "right"
            ? columnX + column.width - 1 - fonts.bold.widthOfTextAtSize(label, labelSize)
            : columnX;
      page.drawText(label, {
        x: labelX,
        y: headerY - labelIndex * 8.5,
        size: labelSize,
        font: fonts.bold,
        color: INK,
      });
    });
    columnX += column.width;
  });
  drawDashedRule(page, x, ruleY, tableWidth);

  let rowY = firstRowY;
  rows.forEach((row, rowIndex) => {

    let cellX = x;
    columns.forEach((column, columnIndex) => {
      const rawCell = row[columnIndex];
      const primary =
        typeof rawCell === "object"
          ? printableOrBlank(rawCell.primary)
          : printableOrBlank(rawCell);
      const secondary =
        typeof rawCell === "object" && rawCell.secondary !== undefined
          ? value(String(rawCell.secondary))
          : "";
      const drawCellText = (input: string, preferredSize: number, y: number, maximumLines: number, abbreviate = false): number => {
        if (!input) return 0;
        const text = printable(input);
        const size = fittedSize(
          fonts.regular,
          text,
          preferredSize,
          MIN_TEXT_POINTS,
          column.width - 2,
        );
        const cells: string[] = [];
        if (abbreviate) cells.push(fitText(fonts.regular, text, size, column.width - 2, true));
        else {
          let remaining = text;
          while (remaining) {
            if (cells.length >= maximumLines) throw new Error(`Picklist ${column.label.replaceAll("\n", " ")} value "${text.slice(0, 80)}" exceeds its printable area. Identifiers cannot be abbreviated.`);
            let end = remaining.length;
            while (end > 0 && fonts.regular.widthOfTextAtSize(remaining.slice(0, end), size) > column.width - 2) end -= 1;
            if (!end) throw new Error("The picklist column is too narrow to print readable text.");
            cells.push(remaining.slice(0, end));
            remaining = remaining.slice(end);
          }
        }
        cells.forEach((cell, index) => {
          const textX =
            column.align === "center"
              ? centeredX(fonts.regular, cell, size, cellX, column.width)
              : column.align === "right"
                ? cellX + column.width - 1 - fonts.regular.widthOfTextAtSize(cell, size)
                : cellX;
          page.drawText(cell, { x: textX, y: y - index * 8, size, font: fonts.regular, color: INK });
        });
        return cells.length;
      };

      if (secondary) {
        const primaryLines = drawCellText(primary, rowTextSize, rowY, 2);
        drawCellText(secondary, secondaryTextSize, rowY - 10 - Math.max(0, primaryLines - 1) * 8, 3 - primaryLines, typeof rawCell === "object" && rawCell.abbreviateSecondary === true);
      } else {
        drawCellText(primary, rowTextSize, rowY, 2);
      }
      cellX += column.width;
    });
    const notes = labelRows[rowIndex]?.notes || [];
    notes.forEach((entry, index) => {
      drawFittedText(page, fonts.regular, entry, x, rowY - 27 - index * LABEL_NOTE_LINE_HEIGHT, tableWidth, 7, 7);
    });
    rowY -= labelRows[rowIndex] ? labelRowHeight(notes) : rowHeight;
  });
}

function drawTopPageNumber(page: PDFPage, fonts: Fonts, pageNumber: number): void {
  const label = `Page: ${pageNumber}`;
  page.drawText(label, {
    x: LETTER_WIDTH - 32 - fonts.regular.widthOfTextAtSize(label, 7),
    y: 750,
    size: 7,
    font: fonts.regular,
    color: RULE,
  });
}

function drawBottomPageNumber(
  page: PDFPage,
  fonts: Fonts,
  pageNumber: number,
  totalPages: number,
  bundlePage?: BundlePage,
  baseline = 22,
): void {
  const label = bundlePage
    ? `Sheet: ${pageNumber} Of ${totalPages} | File: ${bundlePage.page} Of ${bundlePage.pages}`
    : `Page: ${pageNumber} Of ${totalPages}`;
  page.drawText(label, {
    x: LETTER_WIDTH - 42 - fonts.regular.widthOfTextAtSize(label, 7),
    y: baseline,
    size: 7,
    font: fonts.regular,
    color: RULE,
  });
}

function localPrintDateTime(now = new Date()): Readonly<{ date: string; time: string }> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  return {
    date: `${parts.month}/${parts.day}/${parts.year}`,
    time: `${parts.hour}:${parts.minute}:${parts.second} CT`,
  };
}

function drawPrintDateTime(page: PDFPage, fonts: Fonts): void {
  const printed = localPrintDateTime();
  page.drawText(`Date: ${printed.date}`, {
    x: 476,
    y: 738,
    size: 6,
    font: fonts.regular,
    color: RULE,
  });
  page.drawText(`Time: ${printed.time}`, {
    x: 476,
    y: 729,
    size: 6,
    font: fonts.regular,
    color: RULE,
  });
}

function cartSequenceValue(line: CartLine): string {
  const explicit = value(line.cartSequenceNumber).split("/")[0]?.trim();
  return explicit || value(line.cartNumber);
}

function cartSequenceTotalValue(line: CartLine): string {
  const explicit = value(line.cartSequenceNumber);
  if (explicit.includes("/")) return explicit;
  const sequence = explicit || value(line.cartNumber);
  return line.totalCarts && sequence ? `${sequence} / ${line.totalCarts}` : sequence;
}

function requiredBarcodePayload(payload: string | null, label: string): string {
  if (!payload) {
    throw new Error(
      `${label} is required because no barcode with the same business meaning can be derived safely.`,
    );
  }
  return payload;
}

function drawVehicleHeader(page: PDFPage, fonts: Fonts, header: VehicleHeader): void {
  let y = 635;
  for (const block of header.blocks) {
    drawReportLabel(page, fonts, block.title, CONTENT_LEFT, y, 7.5);
    y -= VEHICLE_HEADER_TITLE_HEIGHT;
    for (const entry of block.lines) {
      page.drawText(entry, { x: CONTENT_LEFT, y, size: 8, font: fonts.regular, color: INK });
      y -= VEHICLE_HEADER_LINE_HEIGHT;
    }
  }
}

/** Both movement types use the photographed cart-master form. The movement
 * name changes to Load# for offsite work; its source values keep their meaning. */
function drawCartMasterPage(
  page: PDFPage,
  fonts: Fonts,
  plan: PlannedPage,
  bundlePage?: BundlePage,
): void {
  const line = plan.source;
  const onsite = plan.kind === "onsite";
  const checksheet = onsite ? value(line.checksheetNumber) : requiredBarcodePayload(
    value(line.checksheetNumber) || value(line.picklistNumber), "Picklist / checksheet barcode",
  );
  const masterPayload = requiredBarcodePayload(
    onsite ? resolveOnsiteMasterBarcode(line) : value(line.masterBarcode) || checksheet,
    "Cart master barcode",
  );
  const movementPayload = requiredBarcodePayload(
    onsite ? resolveOnsiteMovementBarcode(line) : value(line.movementBarcode) || value(line.loadNumber),
    "Movement barcode",
  );
  const movementNumber = onsite ? line.trainNumber : line.loadNumber;

  drawFittedText(page, fonts.regular, `<DMS> Plant ${printable(line.plant)}`, CONTENT_LEFT, 753, 130, 8);
  drawFittedText(page, fonts.regular, line.programId || "ODG315R", CONTENT_LEFT, 742, 130, 8);
  drawTopPageNumber(page, fonts, plan.groupPage + 1);
  drawPrintDateTime(page, fonts);
  drawCenteredText(page, fonts.regular, "CART MASTER LABEL", 24, 153, 739, 315);
  drawBarcode(page, fonts, masterPayload, "Cart master barcode", 155, 687, 310, 34);
  if (plan.groupPage) drawCenteredText(page, fonts.regular, "CONTINUED", 7, 155, 663, 240);
  if (value(line.caseCode)) drawInlineReportField(page, fonts, "Case Code:", line.caseCode, CONTENT_LEFT, 650, 67, 290, 9);
  drawInlineReportField(page, fonts, "Cart Seq. :", cartSequenceTotalValue(line), 418, 651, 70, 92, 17);

  drawVehicleHeader(page, fonts, plan.header);
  const headerOffset = plan.header.height - 72;
  drawInlineReportField(page, fonts, "O/G Serial# :", line.outgoingSerial, CONTENT_LEFT, 548 - headerOffset, 85, 463, 9);
  drawReportField(page, fonts, onsite ? "Train#" : "Load#", movementNumber, CONTENT_LEFT, 528 - headerOffset, 140, 18, 507 - headerOffset);
  drawReportField(page, fonts, "Cart Seq.", cartSequenceValue(line), 193, 528 - headerOffset, 100, 18, 507 - headerOffset);
  drawReportField(page, fonts, "Cart Type", line.cartType, 325, 528 - headerOffset, 90, 18, 507 - headerOffset);
  drawReportField(page, fonts, "Cart ID", line.cartId, 426, 528 - headerOffset, 154, 18, 507 - headerOffset);
  drawInlineReportField(page, fonts, "Del./Loc.", line.deliveryLocation, CONTENT_LEFT, 483 - headerOffset, 86, 276, 10);
  drawInlineReportField(page, fonts, "Del./Zone:", line.zone, 404, 483 - headerOffset, 64, 112, 10);
  drawInlineReportField(page, fonts, "Dispatch Date&Time", `${value(line.scheduledDispatchDate)} ${value(line.scheduledDispatchTime)}`.trim(), CONTENT_LEFT, 468 - headerOffset, 116, 286, 10);
  drawInlineReportField(page, fonts, "Ship Cat:", value(line.shipCategory).length > 21 ? "Per row" : line.shipCategory, 442, 468 - headerOffset, 60, 78, 9);

  const columns: readonly Column[] = [
    { label: "Position", width: 46 },
    { label: "Pack Seq.\nCont. Seq.", width: 64, align: "center" },
    { label: "C/T", width: 32, align: "center" },
    { label: "Part# (MBPN)\nPick/Loc.", width: 144 },
    { label: "Color", width: 70 },
    { label: "Del. Loc.", width: 74 },
    { label: "Qty. / UOM\nMCID#", width: 76, align: "right" },
    { label: "Check", width: 42, align: "center" },
  ];
  const rows = plan.lines.map((item) => [
    item.containerPosition || "",
    { primary: item.packSequence || item.sequence, secondary: value(item.containerSequence).length > 17 ? "Below" : item.containerSequence || undefined },
    item.containerType || "",
    { primary: item.partNumber, secondary: item.pickingLocation || undefined },
    item.color,
    item.detailDeliveryLocation || item.deliveryLocation || "",
    { primary: `${item.quantity} ${item.unitOfMeasure || "EA"}`, secondary: item.mcid || undefined },
    packingCheck(item),
  ]);
  drawReportRows(page, fonts, columns, rows, CONTENT_LEFT, 450 - headerOffset, 432 - headerOffset, 415 - headerOffset, 32, 11, 7.25, plan.rows);
  drawFittedText(page, fonts.regular, `Picklist: ${line.picklistNumber} | Cart: ${line.cartNumber} | Pallet: ${line.palletId || "-"}`, CONTENT_LEFT, 145, CONTENT_WIDTH, 7);

  // The physical form has exactly two barcodes: master above, movement below.
  drawBarcode(page, fonts, movementPayload, "Movement barcode", 124, 89, 364, 34);
  drawCenteredText(page, fonts.regular, movementNumber, 51, CONTENT_LEFT, 30, CONTENT_WIDTH);
  drawBottomPageNumber(page, fonts, plan.groupPage + 1, plan.groupPages, bundlePage);
}

function filenameFor(lines: readonly CartLine[], scope: PdfScope): string {
  const first = lines[0];
  const allOnsite = lines.every((line) => line.areaType === "onsite");
  const allOffsite = lines.every((line) => line.areaType === "offsite");
  let name: string;

  if (scope === "section") {
    name = allOnsite ? "trains-all-checksheets" : "loads-all-checksheets";
  } else if (scope === "movement" && allOnsite) {
    name = `train-${first.trainNumber}-all-checksheets`;
  } else if (scope === "movement" && allOffsite) {
    name = `load-${first.loadNumber}-all-checksheets`;
  } else if (allOnsite) {
    const cartCount = new Set(lines.map((line) => `${line.cartNumber}\u001f${line.cartId}`)).size;
    name =
      cartCount === 1
        ? `train-${first.trainNumber}-cart-${first.cartNumber || first.cartId}`
        : `train-${first.trainNumber}-picklist-${first.picklistNumber}`;
  } else if (allOffsite) {
    const cartCount = new Set(
      lines.map((line) => `${line.cartNumber}\u001f${line.cartId}\u001f${line.cartBarcode}`),
    ).size;
    name =
      cartCount === 1
        ? `load-${first.loadNumber}-cart-${first.cartNumber || first.cartId}`
        : `load-${first.loadNumber}-picklist-${first.picklistNumber}`;
  } else {
    name = `picklists-${first.picklistNumber}`;
  }

  const safeName = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return `${safeName || "picklist"}.pdf`;
}

function packingCheck(line: CartLine): string {
  if (line.status === "verified") return "OK";
  if (line.status === "short") return "SHORT";
  if (line.status === "active" || line.fulfilledQuantity > 0) return "PART";
  return "____";
}

export async function generatePicklistPdf(
  inputLines: CartLine[],
  options: Readonly<{ scope?: PdfScope }> = {},
): Promise<{ bytes: Uint8Array; filename: string }> {
  if (!Array.isArray(inputLines) || inputLines.length === 0) {
    throw new Error("At least one picklist line is required to generate a PDF.");
  }
  if (inputLines.some((line) => line.areaType !== "onsite" && line.areaType !== "offsite")) {
    throw new Error("Every PDF row must have a supported Onsite or Offsite area.");
  }
  if (inputLines.some((line) => !Number.isFinite(parseQuantity(line.quantity, line.unitOfMeasure)) || line.quantity <= 0)) {
    throw new Error("Every PDF row must have a valid positive quantity no greater than 2,147,483,647; EA requires a positive whole-number quantity.");
  }
  inputLines.forEach((line) => validatePrintableFields(line, `Picklist row ${line.sequence}`));

  const lines = [...inputLines].sort(compareLines);
  const scope = options.scope || "picklist";
  if (scope === "section" && new Set(lines.map((line) => line.areaType)).size !== 1) {
    throw new Error("A section checksheet PDF must contain only loads or only trains.");
  }
  if (scope === "movement") {
    const movements = new Set(lines.map((line) => [
      line.batchId,
      line.plant,
      line.areaType,
      line.areaType === "onsite" ? line.trainNumber : line.loadNumber,
    ].join("\u001f")));
    if (movements.size !== 1) {
      throw new Error("A combined checksheet PDF must contain exactly one load or train.");
    }
  }
  const pages = planPages(lines);
  if (pages.length === 0) {
    throw new Error("The requested rows do not contain a supported Onsite or Offsite picklist.");
  }

  const document = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await document.embedFont(StandardFonts.Courier),
    bold: await document.embedFont(StandardFonts.CourierBold),
  };
  const filename = filenameFor(lines, scope);
  document.setTitle(filename.replace(/\.pdf$/i, ""));
  document.setSubject("PPA generated warehouse picklist");
  document.setCreator("PPA");
  document.setProducer("PPA");

  pages.forEach((plan, pageIndex) => {
    const page = document.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
    const bundlePage = scope === "movement" || scope === "section"
      ? { page: pageIndex + 1, pages: pages.length }
      : undefined;
    drawCartMasterPage(page, fonts, plan, bundlePage);
  });

  return {
    bytes: await document.save(),
    filename,
  };
}
