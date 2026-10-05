import { MAX_IMPORT_CELL_CHARACTERS, MAX_IMPORT_ROWS } from "./import-validation.ts";
import { normalizeScanValue } from "./scan-values.ts";
import { parseSpreadsheetRecords } from "./spreadsheet-import.ts";
import { normalizeUnitOfMeasure, parseQuantity } from "./quantity.ts";

export type InventoryImportRow = {
  aiagSerial: string;
  partNumber: string;
  color: string;
  quantity: number;
  unitOfMeasure?: string;
  supplierId?: string;
  /** Pallet identifier supplied by the inventory file. */
  palletId?: string;
  receiptKind?: "received" | "expected";
  weight?: number;
  unitCost?: number;
  receiveDate?: string;
};

const normalizeHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function textCell(value: unknown, field: string, rowNumber: number) {
  if (value === undefined || value === null) return "";
  if ((typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))) {
    throw new Error(`Row ${rowNumber} ${field} must be text or a number with safe precision. Store long identifiers as text.`);
  }
  const text = String(value).trim();
  if (text.length > MAX_IMPORT_CELL_CHARACTERS) throw new Error(`Row ${rowNumber} ${field} exceeds the 512-character cell limit.`);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) throw new Error(`Row ${rowNumber} ${field} contains unsupported control characters.`);
  return text;
}

function optionalAmount(value: unknown, field: string, rowNumber: number) {
  const text = textCell(value, field, rowNumber);
  if (!text) return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text)) || Number(text) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Row ${rowNumber} ${field} must be a non-negative decimal number.`);
  }
  return Number(text);
}

function receiptKindForRow(row: Record<string, unknown>, rowNumber: number): "received" | "expected" {
  const explicit = textCell(row.receiptKind, "Receipt Kind", rowNumber).toLowerCase();
  if (explicit && explicit !== "received" && explicit !== "expected") {
    throw new Error(`Row ${rowNumber} Receipt Kind must be received or expected.`);
  }
  const flag = textCell(row.asnFlag, "ASN Flag", rowNumber).toUpperCase();
  if (flag && !["Y", "YES", "TRUE", "1", "N", "NO", "FALSE", "0"].includes(flag)) {
    throw new Error(`Row ${rowNumber} ASN Flag must be Y or N.`);
  }
  const flagged = flag ? (["Y", "YES", "TRUE", "1"].includes(flag) ? "expected" : "received") : "";
  if (explicit && flagged && explicit !== flagged) throw new Error(`Row ${rowNumber} Receipt Kind conflicts with ASN Flag.`);
  return (explicit || flagged || "received") as "received" | "expected";
}

/** Used again by the server so client-side file checks are never trusted. */
export function validateInventoryRows(input: unknown[]): InventoryImportRow[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_IMPORT_ROWS) {
    throw new Error(`PPA accepts between 1 and ${MAX_IMPORT_ROWS.toLocaleString("en-US")} inventory rows per import.`);
  }
  const serials = new Set<string>();
  return input.map((value, index) => {
    const rowNumber = index + 2;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Row ${rowNumber} must be an inventory record.`);
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length > 128) throw new Error("The inventory record exceeds the 128-column limit.");
    for (const [field, supplied] of Object.entries(row)) {
      const text = textCell(supplied, field, rowNumber);
      const key = normalizeHeader(field);
      if ((key === "consumedflag" && text && !["N", "0"].includes(text.toUpperCase())) ||
          (key === "consumedquantity" && text && text !== "0")) {
        throw new Error(`Row ${rowNumber} is marked consumed. Import only available inventory; PPA records consumption during packing.`);
      }
    }
    const aiagSerial = textCell(row.aiagSerial, "Serial Number", rowNumber);
    const partNumber = textCell(row.partNumber, "Part Number", rowNumber);
    const color = textCell(row.color, "Color", rowNumber);
    for (const [field, identifier, prefixLength] of [["Serial Number", aiagSerial, 2], ["Part Number", partNumber, 1], ["Color", color, 2]] as const) {
      if (identifier.length + prefixLength > MAX_IMPORT_CELL_CHARACTERS) {
        throw new Error(`Row ${rowNumber} ${field} exceeds the ${MAX_IMPORT_CELL_CHARACTERS - prefixLength}-character barcode value limit.`);
      }
    }
    const unitOfMeasure = normalizeUnitOfMeasure(row.unitOfMeasure);
    const supplierId = textCell(row.supplierId, "Supplier ID", rowNumber);
    if (supplierId.length > 180) throw new Error(`Row ${rowNumber} Supplier ID exceeds the 180-character identifier limit.`);
    const palletId = textCell(row.palletId, "Pallet ID", rowNumber);
    if (palletId.length > 180) throw new Error(`Row ${rowNumber} Pallet ID exceeds the 180-character identifier limit.`);
    const receiptKind = receiptKindForRow(row, rowNumber);
    const quantity = parseQuantity(row.quantity, unitOfMeasure);
    if (!aiagSerial || !partNumber || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Row ${rowNumber} requires Serial Number, Part Number, and a positive ${unitOfMeasure === "EA" ? "whole-number" : "decimal (at most six decimal places)"} Quantity no greater than 2,147,483,647.`);
    }
    const serialKey = JSON.stringify([normalizeScanValue(supplierId), normalizeScanValue(aiagSerial)]);
    if (serials.has(serialKey)) throw new Error(`Row ${rowNumber} repeats Serial Number ${aiagSerial} for the same supplier. Each inventory container needs a unique serial within its supplier.`);
    serials.add(serialKey);
    const receiveDate = textCell(row.receiveDate, "Receive Date", rowNumber);
    if (receiveDate && (!/^\d{4}-\d{2}-\d{2}$/.test(receiveDate) || !Number.isFinite(Date.parse(receiveDate)) ||
        new Date(receiveDate).toISOString().slice(0, 10) !== receiveDate)) {
      throw new Error(`Row ${rowNumber} Receive Date must be a valid YYYY-MM-DD date.`);
    }
    const weight = optionalAmount(row.weight, "Weight", rowNumber);
    const unitCost = optionalAmount(row.unitCost, "Unit Cost", rowNumber);
    return { aiagSerial, partNumber, color, quantity, unitOfMeasure, supplierId, receiptKind,
      ...(palletId ? { palletId } : {}),
      ...(weight !== undefined ? { weight } : {}), ...(unitCost !== undefined ? { unitCost } : {}),
      ...(receiveDate ? { receiveDate } : {}) };
  });
}

const columns: Record<"aiagSerial" | "partNumber" | "color" | "quantity" | "weight" | "unitCost" | "receiveDate" | "unitOfMeasure" | "supplierId" | "palletId" | "receiptKind" | "asnFlag", string[]> = {
  aiagSerial: ["containeruniqueserialnumber", "serialnumber", "inventoryserialnumber", "aiagserialnumber", "aiagserial", "serial", "serialbarcode"],
  partNumber: ["partnumber", "part", "partno", "partbarcode"],
  color: ["color", "colour", "partcolor", "partcolour", "partlevel", "partmark", "colorbarcode", "colourbarcode", "partlevelbarcode"],
  quantity: ["containerquantity", "quantity", "qty", "quantitybarcode"],
  unitOfMeasure: ["unitofmeasure", "uom", "quantityunit", "unit"],
  supplierId: ["supplierid", "suppliercode", "supplier", "vendorid", "vendorcode"],
  palletId: ["palletid", "palletnumber", "palletno", "palletidentifier", "pallet"],
  receiptKind: ["receiptkind", "receipttype", "inventorystage"],
  asnFlag: ["asnflag", "isasn", "expectedflag"],
  weight: ["weight", "unitweight"],
  unitCost: ["unitcost", "cost"],
  receiveDate: ["receivedate", "receiveddate", "datereceived"],
};

function columnValue(record: Record<string, unknown>, headers: Map<string, string>, field: keyof typeof columns, rowNumber: number) {
  const values = columns[field].flatMap((alias) => {
    const header = headers.get(alias);
    if (!header) return [];
    let value = textCell(record[header], header, rowNumber);
    if (alias.endsWith("barcode") && value) {
      const prefix = field === "aiagSerial" ? /^1S/i : field === "partNumber" ? /^P/i : field === "quantity" ? /^Q/i : /^(?:2P|C)/i;
      if (!prefix.test(value)) throw new Error(`Row ${rowNumber} ${header} does not have the expected barcode prefix.`);
      value = value.replace(prefix, "").trim();
    }
    return value ? [value] : [];
  });
  if (new Set(values).size > 1) throw new Error(`Row ${rowNumber} has conflicting columns for ${field}.`);
  return values[0] || "";
}

/** Plain value columns preserve identifiers; only explicitly named barcode columns strip prefixes. */
export async function parseInventorySpreadsheet(buffer: ArrayBuffer, fileName?: string): Promise<InventoryImportRow[]> {
  if (fileName && !/\.(?:csv|xlsx|xls)$/i.test(fileName)) throw new Error("Choose a CSV, XLSX, or XLS inventory file.");
  const records = await parseSpreadsheetRecords(buffer);
  if (!records.length) throw new Error("The first worksheet is empty.");
  const headers = new Map<string, string>();
  for (const header of Object.keys(records[0])) {
    const key = normalizeHeader(header);
    if (headers.has(key)) throw new Error(`Ambiguous duplicate column: ${header}.`);
    headers.set(key, header);
  }
  for (const field of ["aiagSerial", "partNumber", "quantity"] as const) {
    if (!columns[field].some((alias) => headers.has(alias))) throw new Error(`Missing required inventory column: ${field === "aiagSerial" ? "Serial Number" : field === "partNumber" ? "Part Number" : "Quantity"}.`);
  }
  return validateInventoryRows(records.map((record, index) => {
    for (const [header, supplied] of Object.entries(record)) {
      const key = normalizeHeader(header);
      const value = textCell(supplied, header, index + 2);
      if ((key === "consumedflag" && value && !["N", "0"].includes(value.toUpperCase())) ||
          (key === "consumedquantity" && value && value !== "0") ||
          (key === "containerconsumedstatus" && value && !["notconsumed", "unconsumed"].includes(normalizeHeader(value)))) {
        throw new Error(`Row ${index + 2} is marked consumed. Import only available inventory; PPA records consumption during packing.`);
      }
    }
    // The source inventory contract names Weight as unused. Keep the optional
    // numeric Weight extension for existing PPA templates, while ignoring it in
    // the Container Unique Serial Number source format.
    return Object.fromEntries(Object.keys(columns).map((field) => [field,
      field === "weight" && headers.has("containeruniqueserialnumber") ? "" : columnValue(record, headers, field as keyof typeof columns, index + 2)]));
  }));
}
