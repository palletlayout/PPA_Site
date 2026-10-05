import {
  PDFDocument,
  StandardFonts,
  fill,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setCharacterSqueeze,
  setFillingRgbColor,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

import { encodeCode128, type Code128Encoding } from "./code128.ts";
import type { InventoryItem } from "./inventory-types.ts";
import { normalizeUnitOfMeasure, quantityToScaled } from "./quantity.ts";

const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;
const LEFT = 24;
const RIGHT = 768;
const DIVIDER = 424;
const INK = rgb(0, 0, 0);
const MIN_BAR_MODULE_POINTS = 0.7;
const MAX_BAR_MODULE_POINTS = 2.5;

export class InventoryLabelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryLabelValidationError";
  }
}

type LabelField = Readonly<{
  text: string;
  barcode?: Code128Encoding;
}>;

type Label = Readonly<{
  context: string;
  part: LabelField;
  color: LabelField;
  serial: LabelField;
  quantity: LabelField;
  unit: string;
  supplier: string;
}>;

function printableValue(value: string | undefined, field: string, context: string): string {
  const text = value ?? "";
  if (typeof text !== "string" || /[^\x20-\x7e]/.test(text)) {
    throw new InventoryLabelValidationError(`${context}: ${field} contains characters this label cannot print. Use printable ASCII characters.`);
  }
  // Stored identifiers are already canonical. Trimming here could produce a
  // label whose displayed identifier differs from the inventory record.
  if (text !== text.trim()) {
    throw new InventoryLabelValidationError(`${context}: ${field} has leading or trailing spaces. Correct the inventory value before printing.`);
  }
  return text;
}

function barcodeField(value: string, prefix: string, field: string, width: number, context: string): LabelField {
  if (!value) return { text: "" };
  const payload = `${prefix}${value}`;
  let barcode: Code128Encoding;
  try {
    barcode = encodeCode128(payload);
  } catch {
    throw new InventoryLabelValidationError(`${context}: ${field} cannot be printed as a Code 128 barcode. Use printable ASCII characters.`);
  }
  // Code 128 preserves the exact recorded case and punctuation in both the
  // human-readable value and barcode, including the scanner's data prefix.
  if (width / barcode.totalModules < MIN_BAR_MODULE_POINTS) {
    throw new InventoryLabelValidationError(`${context}: ${field} is too long for a reliably scannable barcode on this label. A larger label layout is required; the identifier has not been shortened.`);
  }
  return { text: value, barcode };
}

function planLabel(item: InventoryItem, index: number): Label {
  const context = `Container ${index + 1}${item.serial ? ` (${String(item.serial).slice(0, 80)})` : ""}`;
  const part = printableValue(item.partNumber, "part number", context);
  const color = printableValue(item.color, "part number extension / color", context);
  const serial = printableValue(item.serial, "serial", context);
  const supplier = printableValue(item.supplierId, "supplier ID", context);
  let unit: string;
  try {
    unit = normalizeUnitOfMeasure(item.unitOfMeasure);
    if (quantityToScaled(item.quantity, unit) <= 0n) throw new Error("Quantity must be greater than zero.");
  } catch (error) {
    throw new InventoryLabelValidationError(`${context}: invalid original container quantity. ${error instanceof Error ? error.message : "Check the quantity and unit of measure."}`);
  }
  return {
    context,
    part: barcodeField(part, "P", "part number", 728, context),
    color: barcodeField(color, "C", "part number extension / color", 380, context),
    // Prefix the stored canonical serial once. A serial that itself starts
    // with 1S intentionally yields a barcode beginning with 1S1S.
    serial: barcodeField(serial, "1S", "serial", 728, context),
    quantity: barcodeField(String(item.quantity), "Q", "quantity", 312, context),
    unit,
    supplier,
  };
}

function drawText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  x: number,
  y: number,
  width: number,
  preferredSize: number,
  minimumSize: number,
  context: string,
  field: string,
  squeeze = 72,
): void {
  if (!text) return;
  const widthAtOnePoint = font.widthOfTextAtSize(text, 1) * squeeze / 100;
  const size = Math.min(preferredSize, width / widthAtOnePoint);
  if (size < minimumSize) {
    throw new InventoryLabelValidationError(`${context}: ${field} is too long to print legibly on this label. The value has not been shortened.`);
  }
  page.pushOperators(pushGraphicsState(), setCharacterSqueeze(squeeze));
  page.drawText(text, { x, y, font, size, color: INK });
  page.pushOperators(popGraphicsState());
}

function drawBarcode(page: PDFPage, field: LabelField, x: number, y: number, width: number, height: number): void {
  if (!field.barcode) return;
  const moduleWidth = Math.min(MAX_BAR_MODULE_POINTS, width / field.barcode.totalModules);
  let cursor = x + (width - field.barcode.totalModules * moduleWidth) / 2;
  page.pushOperators(pushGraphicsState(), setFillingRgbColor(0, 0, 0));
  for (const run of field.barcode.runs) {
    const runWidth = run.modules * moduleWidth;
    if (run.isBar) page.pushOperators(rectangle(cursor, y, runWidth, height), fill());
    cursor += runWidth;
  }
  page.pushOperators(popGraphicsState());
}

function drawLabel(page: PDFPage, font: PDFFont, label: Label): void {
  const title = (text: string, x: number, y: number, width: number) =>
    drawText(page, font, text, x, y, width, 14, 14, label.context, "field heading", 82);
  const value = (field: string, text: string, x: number, y: number, width: number, size = 56, minimum = 20) =>
    drawText(page, font, text, x, y, width, size, minimum, label.context, field);

  // The photographed form has three full-width rules and a divider through
  // the middle two rows. There is no outer frame or extra report furniture.
  for (const y of [450, 300, 164]) {
    page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 3.2, color: INK });
  }
  page.drawLine({ start: { x: DIVIDER, y: 164 }, end: { x: DIVIDER, y: 450 }, thickness: 3.2, color: INK });

  title("PART NO.(P)", 32, 562, 98);
  // Value baselines reserve the font's full descender height plus at least
  // six points of clearance from the adjacent bars and divider rules.
  value("part number", label.part.text, 134, 546, 626);
  drawBarcode(page, label.part, 32, 462, 728, 66);

  title("PART NO. EXT (C)", 32, 430, 380);
  value("part number extension / color", label.color.text, 40, 378, 372, 50);
  drawBarcode(page, label.color, 32, 313, 380, 48);

  if (label.supplier) {
    title("SUPPLIER ID", 436, 430, 312);
    value("supplier ID", label.supplier, 440, 385, 312, 32, 12);
  }

  title("D/C PART LEVEL (2P)", 32, 280, 380);
  // InventoryItem.partLevel is a deprecated, empty compatibility field.
  // The app's C/2P input is color, already printed in the extension box.
  // No genuine engineering part level is available to populate this box.

  drawBarcode(page, label.quantity, 436, 223, 312, 66);
  title("QUANTITY (Q)", 436, 177, 108);
  value("quantity", `${label.quantity.text}${label.unit === "EA" ? "" : ` ${label.unit}`}`, 550, 182, 210, 48, 18);

  title("SERIAL (1S)", 32, 140, 102);
  value("serial", label.serial.text, 141, 116, 619);
  drawBarcode(page, label.serial, 32, 32, 728, 66);
}

/** One original container label per landscape Letter page, in input order. */
export async function generateInventoryLabelsPdf(items: readonly InventoryItem[]): Promise<{ bytes: Uint8Array; filename: string }> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new InventoryLabelValidationError("At least one inventory container is required to print labels.");
  }
  const labels = items.map(planLabel);
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.HelveticaBold);
  document.setTitle("Inventory container labels");
  document.setSubject("One original container label per page");
  document.setCreator("PPA");
  document.setProducer("PPA");
  for (const label of labels) {
    drawLabel(document.addPage([PAGE_WIDTH, PAGE_HEIGHT]), font, label);
  }
  return { bytes: await document.save(), filename: "inventory-labels.pdf" };
}
