import {
  MAX_IMPORT_CELL_CHARACTERS,
  MAX_IMPORT_ROWS,
  parseImportWholeNumber,
  validateImportRows,
} from "./import-validation.ts";
import type { ImportRow } from "./types.ts";
import { normalizeUnitOfMeasure, parseDecimalQuantity, parseQuantity } from "./quantity.ts";

const MAX_SPREADSHEET_BYTES = 5 * 1024 * 1024;
const MAX_SPREADSHEET_COLUMNS = 128;
const MAX_EXPANDED_WORKBOOK_BYTES = 32 * 1024 * 1024;

async function validateWorkbookArchive(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint32(0, true) !== 0x04034b50) return;
  // XLSX is a ZIP archive. Reject oversized declared expansion before SheetJS
  // inflates worksheet XML or shared strings, even when the upload is tiny.
  let end = -1;
  for (let offset = view.byteLength - 22; offset >= Math.max(0, view.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === view.byteLength) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("The workbook ZIP archive is incomplete.");
  for (let offset = end + 4; offset <= view.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === 0x06054b50) throw new Error("The workbook ZIP directory is ambiguous.");
  }
  const entries = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let cursor = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 ||
      view.getUint16(end + 8, true) !== entries || entries > 256 || cursor + directorySize > end) {
    throw new Error("The workbook archive structure exceeds supported limits.");
  }
  const directoryEnd = cursor + directorySize;
  let expanded = 0;
  const members: Array<{ offset: number; compressed: number; expanded: number; method: number }> = [];
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("The workbook ZIP directory is invalid.");
    }
    const expandedSize = view.getUint32(cursor + 24, true);
    expanded += expandedSize;
    if (expanded > MAX_EXPANDED_WORKBOOK_BYTES) {
      throw new Error("The expanded workbook exceeds the 32 MB limit.");
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const local = view.getUint32(cursor + 42, true);
    if ((flags & 0x2041) || ![0, 8].includes(method) || local + 30 > view.byteLength || view.getUint32(local, true) !== 0x04034b50) {
      throw new Error("The workbook uses unsupported or invalid ZIP compression.");
    }
    const offset = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (offset + compressed > directoryEnd || view.getUint16(local + 8, true) !== method || view.getUint16(local + 6, true) !== flags) {
      throw new Error("The workbook compressed data is invalid.");
    }
    for (const [position, expected] of [[local + 18, compressed], [local + 22, expandedSize]]) {
      const actual = view.getUint32(position, true);
      if (actual !== expected && !((flags & 8) && actual === 0)) throw new Error("The workbook ZIP size is invalid.");
    }
    // SheetJS lets ZIP64 extra fields override both local and central sizes.
    // Such archives are unnecessary under our upload cap and must not bypass it.
    for (const [extraStart, extraLength] of [
      [cursor + 46 + view.getUint16(cursor + 28, true), view.getUint16(cursor + 30, true)],
      [local + 30 + view.getUint16(local + 26, true), view.getUint16(local + 28, true)],
    ]) {
      const extraEnd = extraStart + extraLength;
      if (extraEnd > view.byteLength) throw new Error("The workbook ZIP extra fields are invalid.");
      for (let extra = extraStart; extra < extraEnd;) {
        if (extra + 4 > extraEnd || view.getUint16(extra, true) === 1) throw new Error("ZIP64 workbooks are not supported.");
        extra += 4 + view.getUint16(extra + 2, true);
        if (extra > extraEnd) throw new Error("The workbook ZIP extra fields are invalid.");
      }
    }
    members.push({ offset, compressed, expanded: expandedSize, method });
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    if (cursor > directoryEnd) throw new Error("The workbook ZIP directory is invalid.");
  }
  if (cursor !== directoryEnd) throw new Error("The workbook ZIP directory is invalid.");
  // Also count actual streaming expansion: forged ZIP size metadata must not
  // bypass the limit. Discard chunks instead of retaining a second workbook.
  let actualExpanded = 0;
  for (const member of members) {
    if (member.method === 0) {
      if (member.compressed !== member.expanded) throw new Error("The workbook ZIP size is invalid.");
      actualExpanded += member.expanded;
      continue;
    }
    const reader = new Blob([buffer.slice(member.offset, member.offset + member.compressed)])
      .stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    let memberExpanded = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        memberExpanded += chunk.value.byteLength;
        actualExpanded += chunk.value.byteLength;
        if (actualExpanded > MAX_EXPANDED_WORKBOOK_BYTES) {
          throw new Error("The expanded workbook exceeds the 32 MB limit.");
        }
        if (memberExpanded > member.expanded) throw new Error("The workbook ZIP size is invalid.");
      }
      if (memberExpanded !== member.expanded) throw new Error("The workbook ZIP size is invalid.");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

const headerAliases: Record<keyof ImportRow, string[]> = {
  plant: ["plant", "plantid", "plantcode", "ogplcd", "progplcd", "pr_ogplcd"],
  zone: ["prdvzone", "zone", "trailertype", "deliveryzone", "dvzone", "rdvzone", "r_dvzone"],
  areaType: ["area", "areatype", "sitearea", "locationtype"],
  shipCategory: ["shipcategory", "areacode", "shippingcategory", "category"],
  loadNumber: ["load", "loadnumber", "loadno"],
  trainNumber: ["prtrain", "train", "trainnumber", "trainno"],
  picklistNumber: ["picklist", "picklistnumber", "picklistno", "picklistid", "orderpallet"],
  cartNumber: ["cart", "cartnumber", "cartno"],
  cartId: ["prcrtid", "cartid", "cartidentifier", "crtid"],
  palletId: ["palletid", "pallet", "palletidentifier"],
  programId: ["pgmid", "programid", "program", "reportid", "formid"],
  totalCarts: ["totalcarts", "carttotal", "numberofcarts"],
  pymtc: ["pymtc", "programyearmodeltypecode", "vehiclemodelcode"],
  checksheetNumber: ["checksheetnumber", "checksheetno", "checksheetid"],
  sequence: ["sequence", "seq", "partsequence", "containerpackingsequence", "cntpsq", "picntpsq", "pi_cntpsq"],
  packSequence: ["packsequence", "packingsequence"],
  partNumber: ["part", "partnumber", "partno", "mbpn", "pimbpn", "pi_mbpn"],
  description: ["description", "partdescription", "partdesc", "partname"],
  color: ["piptclr", "color", "colour", "partmark", "partcolor", "partcolour", "ptclr", "onepartlevel", "2p"],
  quantity: ["piqty", "quantity", "qty", "orderquantity", "orderqty", "finalrequiredquantity", "requiredquantity", "shpqty"],
  unitOfMeasure: ["unitofmeasure", "uom", "quantityunit", "unit"],
  sourceLineId: ["sourcelineid", "demandid", "demandlineid", "orderlineid", "externallineid"],
  sourceScope: ["sourcescope", "sourcesystem", "sourcesystemid"],
  preferredSupplierId: ["preferredsupplierid", "demandsupplierid", "supplierid", "suppliercode"],
  productionQuantity: ["productionquantity", "prprdqty", "prdqty", "pr_dqty"],
  cartMaxQuantity: ["cartmaxquantity", "cartmaximumquantity", "prcrttqy", "prcrtmax", "crtmax"],
  interiorColor: ["interiorcolor", "interiorcolour", "printclr", "intclr"],
  exteriorColor: ["exteriorcolor", "exteriorcolour", "prextclr", "extclr"],
  vehicleColor: ["vehiclecolor", "vehiclecolour", "prcolor"],
  aiagSerial: ["aiagserialnumber", "aiagserial", "serialnumber", "serial"],
  masterBarcode: ["masterbarcode", "cartmasterlabel", "cartmasterlabelbarcode", "prbrcode", "checksheet", "checksheetbarcode"],
  movementBarcode: ["prbrcode2", "movementbarcode", "trainbarcode", "loadbarcode", "barcode2"],
  caseCode: ["prcasecod", "casecode", "rcasecod"],
  outgoingSerial: ["progsr", "outgoingserial", "ogserial", "ogsr"],
  cartSequenceNumber: ["prcrtseq", "cartsequencenumber", "cartsequence", "cartseq", "crtseq", "rcrtseq"],
  fromLot: ["fromlot", "fromlotnumber", "kdlotfrom", "kdlotnumberfrom"],
  toLot: ["tolot", "tolotnumber", "kdlotto", "kdlotnumberto"],
  model: ["prmodel", "model", "modelymto", "ymto"],
  cartType: ["prcrttyp", "carttype", "crttyp"],
  option: ["option", "vehicleoption"],
  scheduledDispatchDate: ["scheduleddispatchdate", "shippingdate", "dispatchdate", "deliverydate", "sdspdt", "prsdspdt", "pr_sdspdt"],
  scheduledDispatchTime: ["scheduleddispatchtime", "shippingtime", "dispatchtime", "deliverytime", "sdsptm", "prsdsptm", "pr_sdsptm"],
  deliveryLocation: ["headerdeliverylocation", "prdeliverylocation", "prdvlctn", "shippinglocation", "deliverylocation", "delivery", "dvlctn", "vlctn"],
  detailDeliveryLocation: ["detaildeliverylocation", "partdeliverylocation", "pideliverylocation", "pidvlctn"],
  containerPosition: ["picntptn", "containerposition", "position", "cntptn", "lcntptn", "l_cntptn"],
  containerType: ["picnttyp", "containertype", "container", "cnttyp"],
  containerSequence: ["containersequence"],
  fromModel: ["frommodel"],
  fromType: ["fromtype"],
  fromOption: ["fromoption"],
  fromColor: ["fromcolor", "fromcolour"],
  fromInteriorColor: ["frominteriorcolor", "frominteriorcolour"],
  fromUnits: ["fromunits"],
  toModel: ["tomodel"],
  toType: ["totype"],
  toOption: ["tooption"],
  toColor: ["tocolor", "tocolour"],
  toInteriorColor: ["tointeriorcolor", "tointeriorcolour"],
  toUnits: ["tounits"],
  pickingLocation: ["pipclc", "pickinglocation", "pickinglocation1", "picklocation", "picl1"],
  mcid: ["pimcid", "mcid", "mcidnumber", "mcidcode"],
  containerTotal: ["containertotal", "containercount", "conttotal"],
  chassisNumber: ["chassisnumber", "chassis", "chs"],
  orderNumber: ["ordernumber", "orderno", "order"],
  batchNumber: ["batchnumber", "batchno", "batch", "prodbat", "productionbatch"],
  loadingSequence: ["loadingsequence", "loadsequence"],
};

const productionDemandAliases: Partial<Record<keyof ImportRow, string[]>> = {
  trainNumber: ["trainnum"],
  picklistNumber: ["checksheet"],
  cartNumber: ["case"],
  cartId: ["casecode"],
  checksheetNumber: ["checksheet"],
  sequence: ["partsequence"],
  partNumber: ["partnumb"],
  quantity: ["order", "orderqty", "orderquantity"],
  caseCode: ["casecode"],
  outgoingSerial: ["productionid"],
  cartSequenceNumber: ["case"],
  model: ["mtc", "mtcmodel"],
  detailDeliveryLocation: ["delivery", "deliverylocation"],
  containerPosition: ["case"],
  containerType: ["container"],
  batchNumber: ["prodbatch"],
  loadingSequence: ["deliverysequence"],
  interiorColor: ["int"],
  exteriorColor: ["exterior"],
};

const productionDemandMarkers = [
  "trainnum", "trainid", "checksheet", "prodbatch", "casecode",
  "partnumb", "optimum", "container", "partname",
];

const optionalImportFields = new Set<keyof ImportRow>([
  "loadNumber", "trainNumber", "color", "aiagSerial", "cartNumber", "cartId", "palletId",
  "description", "programId", "totalCarts", "pymtc", "checksheetNumber", "masterBarcode",
  "movementBarcode", "caseCode", "outgoingSerial", "cartSequenceNumber", "fromLot", "toLot",
  "model", "cartType", "scheduledDispatchDate", "scheduledDispatchTime", "deliveryLocation", "detailDeliveryLocation",
  "containerPosition", "containerType", "pickingLocation", "mcid", "containerTotal",
  "chassisNumber", "orderNumber", "batchNumber", "loadingSequence",
  "unitOfMeasure", "sourceLineId", "sourceScope", "preferredSupplierId",
  "productionQuantity", "cartMaxQuantity", "interiorColor", "exteriorColor", "vehicleColor",
  "packSequence", "option",
  "containerSequence", "fromModel", "fromType", "fromOption", "fromColor", "fromInteriorColor", "fromUnits",
  "toModel", "toType", "toOption", "toColor", "toInteriorColor", "toUnits",
]);

const importFieldLabels: Partial<Record<keyof ImportRow, string>> = {
  areaType: "Area",
  loadNumber: "Load #",
  trainNumber: "Train #",
  picklistNumber: "Picklist #",
  cartNumber: "Cart #",
  cartId: "Cart ID",
  palletId: "Pallet ID",
  partNumber: "Part #",
  color: "Color",
  quantity: "Quantity",
  aiagSerial: "AIAG Serial Number",
};

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isProductionDemandExtract(headers: Map<string, string>) {
  return productionDemandMarkers.every((marker) => headers.has(marker));
}

function aliasesFor(key: keyof ImportRow, productionDemand: boolean) {
  let aliases = headerAliases[key];
  // In the production extract, Order is the line demand quantity. It is not an
  // order-number identifier and must not become cart-level metadata.
  if (productionDemand && key === "orderNumber") {
    aliases = aliases.filter((alias) => normalizeHeader(alias) !== "order");
  }
  if (productionDemand && key === "deliveryLocation") {
    aliases = aliases.filter((alias) => normalizeHeader(alias) !== "delivery");
  }
  return productionDemand
    ? [...(productionDemandAliases[key] || []), ...aliases]
    : aliases;
}

function readCell(value: unknown, label: string, rowNumber: number) {
  if (value === undefined || value === null) return "";
  if ((typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "number" && (!Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))))) {
    throw new Error(`Row ${rowNumber} ${label} must be text or a number with safe precision. Store long identifiers as text.`);
  }
  const text = String(value);
  if (text.length > MAX_IMPORT_CELL_CHARACTERS) {
    throw new Error(`Row ${rowNumber} ${label} exceeds the 512-character cell limit.`);
  }
  return text.trim();
}

export function mapDemandRecords(records: Array<Record<string, unknown>>): ImportRow[] {
  if (!Array.isArray(records) || !records.length) throw new Error("The first worksheet is empty.");
  if (records.length > MAX_IMPORT_ROWS) throw new Error(`PPA accepts up to ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows per import.`);
  records.forEach((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Row ${index + 2} must be a demand record.`);
    }
    const entries = Object.entries(record);
    if (entries.length > MAX_SPREADSHEET_COLUMNS) throw new Error("The worksheet exceeds the 128-column limit.");
    for (const [header, cell] of entries) readCell(cell, header, index + 2);
  });

  const actualHeaders = Object.keys(records[0]);
  const mappedHeaders = new Map<string, string>();
  for (const header of actualHeaders) {
    const normalized = normalizeHeader(header);
    if (mappedHeaders.has(normalized)) throw new Error(`Ambiguous duplicate column: ${header}.`);
    mappedHeaders.set(normalized, header);
  }
  const productionDemand = isProductionDemandExtract(mappedHeaders);
  const orderFormat = mappedHeaders.has("demandid");
  const typeHeader = mappedHeaders.get("type");
  const movementTypeHeader = mappedHeaders.get("movementtype");
  const movementHeader = mappedHeaders.get("trainloadnumber");
  const masterOrderHeader = mappedHeaders.get("masterordernumber");
  const commonFormat = Boolean(movementHeader);
  const legacyMovementType = Boolean(typeHeader && records.every((record) => /^(TRAIN|LOAD)$/i.test(String(record[typeHeader]).trim())));
  if ((commonFormat && !movementTypeHeader && !typeHeader) || (!commonFormat && legacyMovementType && !orderFormat)) {
    throw new Error("The common demand format requires both Type and Train/Load Number columns.");
  }
  const separatePartColor = ["piptclr", "partcolor", "partcolour", "partmark", "ptclr", "onepartlevel", "2p"].some((header) => mappedHeaders.has(header));
  const resolved: Partial<Record<keyof ImportRow, string>> = {};
  const candidates: Partial<Record<keyof ImportRow, string[]>> = {};
  (Object.keys(headerAliases) as (keyof ImportRow)[]).forEach((key) => {
    const aliases = [...aliasesFor(key, productionDemand)];
    if (key === "color" && (separatePartColor || orderFormat)) {
      for (const alias of ["color", "colour"]) {
        const position = aliases.indexOf(alias);
        if (position >= 0) aliases.splice(position, 1);
      }
    }
    if (key === "vehicleColor" && (separatePartColor || orderFormat)) aliases.push("color", "colour");
    // Type is printable vehicle/cart metadata in the order contract. The older
    // Type + Train/Load Number layout reserves that column for TRAIN or LOAD.
    if (key === "cartType" && (!commonFormat || movementTypeHeader)) aliases.push("type");
    if (key === "picklistNumber" && !aliases.some((alias) => mappedHeaders.has(normalizeHeader(alias)))) {
      // A missing picklist ID may use the one outbound card/pallet or its checksheet reference.
      // Validation still enforces exactly one outbound record for that picklist.
      const fallback = ["checksheetnumber", "checksheet", "cartmasterlabel", "ordernumber", "orderno", "order", "cartid", "cartnumber", "palletid"].find((alias) => mappedHeaders.has(alias));
      if (fallback) aliases.push(fallback);
    }
    const matches = [...new Set(aliases
      .map((alias) => mappedHeaders.get(normalizeHeader(alias)))
      .filter((header): header is string => Boolean(header)))];
    const match = matches[0];
    const derivedField = (key === "areaType" && (commonFormat || orderFormat || masterOrderHeader)) ||
      (key === "sequence" && orderFormat);
    if (!match && !optionalImportFields.has(key) && !derivedField) {
      const prefix = productionDemand
        ? "Production-style demand is missing required PPA column"
        : "Missing required column";
      throw new Error(`${prefix}: ${importFieldLabels[key] || key}.`);
    }
    if (match) resolved[key] = match;
    if (!optionalImportFields.has(key) || ["color", "quantity", "totalCarts", "containerTotal", "loadNumber", "trainNumber", "unitOfMeasure", "sourceLineId", "sourceScope", "preferredSupplierId", "productionQuantity", "cartMaxQuantity", "interiorColor", "exteriorColor", "vehicleColor", "cartType", "packSequence", "option", "scheduledDispatchDate", "scheduledDispatchTime", "containerSequence", "fromModel", "fromType", "fromOption", "fromColor", "fromInteriorColor", "fromUnits", "toModel", "toType", "toOption", "toColor", "toInteriorColor", "toUnits"].includes(key)) {
      candidates[key] = matches;
    }
  });

  const rows = records.map((record, index): ImportRow => {
    for (const [header, supplied] of Object.entries(record)) {
      if (["fulfilledquantity", "inventoryserialnumber", "inventoryitemid", "containeruniqueserialnumber", "partfulfillstatus", "partfulfillmentstatus", "picklistfulfillstatus", "picklistfulfillmentstatus", "loadtrainfulfillmentstatus", "filleddatetimeuser", "filleddatatimeuser", "filleddate", "filledtime", "filleduser"].includes(normalizeHeader(header)) &&
          readCell(supplied, header, index + 2)) {
        throw new Error(`Row ${index + 2} ${header} must be blank. PPA fills fulfillment fields when inventory is scanned during packing.`);
      }
    }
    const value = (key: keyof ImportRow) => {
      const alternatives = candidates[key];
      if (alternatives) {
        const supplied = [...new Set(alternatives.map((header) => readCell(record[header], header, index + 2)).filter(Boolean))];
        if (supplied.length > 1) {
          throw new Error(`Row ${index + 2} has conflicting columns for ${importFieldLabels[key] || key}: ${alternatives.join(", ")}.`);
        }
        return supplied[0] || "";
      }
      const header = resolved[key];
      return readCell(header ? record[header] : "", header || key, index + 2);
    };
    const sourceValue = (...aliases: string[]) => {
      const header = aliases
        .map((alias) => mappedHeaders.get(normalizeHeader(alias)))
        .find(Boolean);
      return readCell(header ? record[header] : "", header || aliases[0], index + 2);
    };
    const movementTypeColumn = movementTypeHeader || (commonFormat ? typeHeader : undefined);
    const movementType = readCell(movementTypeColumn ? record[movementTypeColumn] : "", "Movement Type", index + 2).toUpperCase();
    const movementNumber = readCell(movementHeader ? record[movementHeader] : "", "Train/Load Number", index + 2);
    if ((commonFormat || movementTypeHeader) && !["TRAIN", "LOAD"].includes(movementType)) {
      throw new Error(`Row ${index + 2} Type must be TRAIN or LOAD.`);
    }
    if (commonFormat && !movementNumber) throw new Error(`Row ${index + 2} requires Train/Load Number.`);
    const masterOrderNumber = readCell(masterOrderHeader ? record[masterOrderHeader] : "", "Master Order Number", index + 2);
    const expectedArea = movementType === "TRAIN" ? "onsite" : "offsite";
    const inferredArea = value("trainNumber") ? "onsite" : (value("loadNumber") || masterOrderNumber) ? "offsite" : "";
    const areaValue = (value("areaType") || (commonFormat || movementType ? expectedArea : orderFormat || masterOrderHeader ? inferredArea : "")).toLowerCase().replace(/[\s-]+/g, "");
    const areaType = ["offsite", "warehouse", "external"].includes(areaValue)
      ? "offsite"
      : ["onsite", "inplant", "internal"].includes(areaValue)
        ? "onsite"
        : null;
    if (!areaType) throw new Error(`Row ${index + 2} must use Onsite or Offsite in the Area column.`);
    if (commonFormat && areaType !== expectedArea) throw new Error(`Row ${index + 2} Type conflicts with Area.`);
    let trainNumber = value("trainNumber");
    let loadNumber = value("loadNumber");
    if (orderFormat && !value("sourceLineId")) throw new Error(`Row ${index + 2} requires Demand ID.`);
    if (orderFormat && trainNumber && loadNumber) throw new Error(`Row ${index + 2} must identify one Train or Load, not both.`);
    if (masterOrderNumber) {
      const existing = areaType === "onsite" ? trainNumber : loadNumber;
      if (existing && existing !== masterOrderNumber) throw new Error(`Row ${index + 2} Master Order Number conflicts with Train or Load.`);
      if (areaType === "onsite") trainNumber = masterOrderNumber;
      else loadNumber = masterOrderNumber;
    }
    if (commonFormat) {
      const existing = movementType === "TRAIN" ? trainNumber : loadNumber;
      const other = movementType === "TRAIN" ? loadNumber : trainNumber;
      if ((existing && existing !== movementNumber) || other) {
        throw new Error(`Row ${index + 2} Train/Load Number conflicts with legacy Train or Load columns.`);
      }
      trainNumber = movementType === "TRAIN" ? movementNumber : "";
      loadNumber = movementType === "LOAD" ? movementNumber : "";
    }

    // The first Production value, second Delivery value, second Production
    // value, Train Id, and Optimum remain source-only until their business
    // meanings are confirmed. In particular, none may replace Order as Q.
    const productionModel = productionDemand
      ? [sourceValue("MTC"), sourceValue("MTC_1"), sourceValue("MTC_2"), sourceValue("Int"), sourceValue("Exterior")]
        .filter(Boolean)
        .join("/")
      : "";

    return {
      plant: value("plant"), zone: value("zone"), areaType, shipCategory: value("shipCategory"),
      loadNumber, trainNumber, picklistNumber: value("picklistNumber"),
      cartNumber: value("cartNumber"), cartId: value("cartId"), palletId: value("palletId"),
      programId: value("programId") || "ODG303R", totalCarts: parseImportWholeNumber(value("totalCarts"), true),
      pymtc: value("pymtc") || productionModel, checksheetNumber: value("checksheetNumber"),
      sequence: value("sequence") || (orderFormat ? value("sourceLineId") : ""),
      packSequence: value("packSequence") || (orderFormat ? String(index + 1) : ""),
      partNumber: value("partNumber"), description: value("description"), color: value("color"),
      // Legacy serial columns describe the previous verification workflow.
      // Imported demand never reserves or fulfils an inventory container.
      quantity: parseQuantity(value("quantity"), value("unitOfMeasure")), aiagSerial: "",
      unitOfMeasure: normalizeUnitOfMeasure(value("unitOfMeasure")),
      sourceLineId: value("sourceLineId"), sourceScope: value("sourceScope"),
      preferredSupplierId: value("preferredSupplierId"),
      productionQuantity: value("productionQuantity") === "" ? undefined : parseImportWholeNumber(value("productionQuantity"), true),
      cartMaxQuantity: value("cartMaxQuantity") === "" ? undefined : parseDecimalQuantity(value("cartMaxQuantity"), true),
      interiorColor: value("interiorColor"), exteriorColor: value("exteriorColor"), vehicleColor: value("vehicleColor"),
      masterBarcode: value("masterBarcode") || (orderFormat ? value("picklistNumber") : ""),
      movementBarcode: value("movementBarcode") || (orderFormat ? (trainNumber || loadNumber) : ""),
      caseCode: value("caseCode"), outgoingSerial: value("outgoingSerial"),
      cartSequenceNumber: value("cartSequenceNumber"), fromLot: value("fromLot"), toLot: value("toLot"),
      model: value("model") || (productionDemand ? sourceValue("MTC") : ""), cartType: value("cartType"), option: value("option"), scheduledDispatchDate: value("scheduledDispatchDate"),
      scheduledDispatchTime: value("scheduledDispatchTime"), deliveryLocation: value("deliveryLocation"),
      detailDeliveryLocation: value("detailDeliveryLocation"),
      containerPosition: value("containerPosition"), containerType: value("containerType"),
      containerSequence: value("containerSequence"),
      fromModel: value("fromModel"), fromType: value("fromType"), fromOption: value("fromOption"),
      fromColor: value("fromColor"), fromInteriorColor: value("fromInteriorColor"), fromUnits: value("fromUnits"),
      toModel: value("toModel"), toType: value("toType"), toOption: value("toOption"),
      toColor: value("toColor"), toInteriorColor: value("toInteriorColor"), toUnits: value("toUnits"),
      pickingLocation: value("pickingLocation"), mcid: value("mcid"),
      containerTotal: parseImportWholeNumber(value("containerTotal"), true), chassisNumber: value("chassisNumber"),
      orderNumber: value("orderNumber"), batchNumber: value("batchNumber"),
      loadingSequence: value("loadingSequence"),
    };
  });

  if (productionDemand) {
    const outboundByMovement = new Map<string, Set<string>>();
    rows.forEach((row) => {
      const key = [row.plant, row.areaType, row.areaType === "onsite" ? row.trainNumber : row.loadNumber].join("\u001f");
      const carts = outboundByMovement.get(key) || new Set<string>();
      carts.add(row.picklistNumber);
      outboundByMovement.set(key, carts);
    });
    rows.forEach((row) => {
      if (row.totalCarts !== 0) return;
      const key = [row.plant, row.areaType, row.areaType === "onsite" ? row.trainNumber : row.loadNumber].join("\u001f");
      row.totalCarts = outboundByMovement.get(key)?.size || 0;
    });
  }

  return validateImportRows(rows);
}

// Excel keeps 15 significant digits, so a numeric cell cannot hold a longer identifier exactly.
const EXCEL_SIGNIFICANT_DIGITS = 15;

/** Spell a finite number without exponent notation (String() switches to it below 1e-6). */
function plainDecimalText(value: number) {
  const text = String(value);
  const match = /^(-?)(\d)(?:\.(\d+))?e-(\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, lead, fraction = "", exponent] = match;
  return `${sign}0.${"0".repeat(Number(exponent) - 1)}${lead}${fraction}`;
}

/**
 * True only when Excel's displayed text is provably not the stored number: scientific
 * notation (General format shows 1234567890123 as "1.23457E+12"), or a single figure
 * that differs from the value (a whole-number format shows 2.5 as "3", General cuts
 * 1234567.123456 to "1234567.123"). Anything else is left exactly as displayed,
 * including padding and prefix formats such as 0000123 or "PL-"0000, thousands
 * separators, units, and multi-part displays.
 */
function displayLosesValue(displayed: string, value: number) {
  if (/^-?\d(?:\.\d+)?E[+-]\d+$/i.test(displayed.trim())) return true;
  const figures = displayed.match(/\d[\d,]*(?:\.\d+)?/g);
  if (!figures || figures.length !== 1) return false;
  return Number(figures[0].replace(/,/g, "")) !== Math.abs(value);
}

/**
 * Text for a numeric worksheet cell. SheetJS supplies the cell as Excel displays it. That
 * is kept unless it loses the stored value, in which case the stored value is used,
 * rounded to Excel's own 15 significant digits and written without exponent notation.
 */
function numericCellText(value: number, displayed: string | undefined, address: string) {
  // Excel cannot hold such a number exactly and may already have altered it, even when
  // the cell's format displays every digit.
  if (Math.abs(value) >= 10 ** EXCEL_SIGNIFICANT_DIGITS) {
    throw new Error(`Cell ${address} holds ${String(value)}, a number with more than ${EXCEL_SIGNIFICANT_DIGITS} digits. Excel cannot store that exactly, so it may already be altered. Store long identifiers as text.`);
  }
  if (displayed !== undefined && !displayLosesValue(displayed, value)) return displayed;
  return plainDecimalText(Number(value.toPrecision(EXCEL_SIGNIFICANT_DIGITS)));
}

/** Shared bounded reader for demand and inventory spreadsheets. */
export async function parseSpreadsheetRecords(buffer: ArrayBuffer, allowProductionDuplicates = false): Promise<Array<Record<string, unknown>>> {
  if (!buffer.byteLength) throw new Error("The spreadsheet file is empty.");
  if (buffer.byteLength > MAX_SPREADSHEET_BYTES) throw new Error("Spreadsheet files must be 5 MB or smaller.");
  await validateWorkbookArchive(buffer);
  const XLSX = await import("xlsx");
  // cellDates makes SheetJS classify date and time cells itself, which is more reliable than
  // inspecting format strings (regional date formats can arrive without one). Those cells
  // keep their displayed text; see numericCellText for the other numeric cells.
  const workbook = XLSX.read(buffer, { type: "array", raw: true, cellDates: true, sheets: 0, sheetRows: MAX_IMPORT_ROWS + 2 });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The workbook does not contain a readable sheet.");
  const fullRange = sheet["!fullref"] || sheet["!ref"];
  if (fullRange) {
    const range = XLSX.utils.decode_range(fullRange);
    if (range.e.r - range.s.r > MAX_IMPORT_ROWS) throw new Error(`PPA accepts up to ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows per import.`);
    if (range.e.c - range.s.c + 1 > MAX_SPREADSHEET_COLUMNS) throw new Error("The worksheet exceeds the 128-column limit.");
    const headers = new Set<string>();
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: column })];
      const header = normalizeHeader(String(cell?.v ?? ""));
      // The production extract deliberately repeats these source-only headings.
      if (header && headers.has(header) && !(allowProductionDuplicates && ["production", "delivery", "mtc"].includes(header))) {
        throw new Error(`Ambiguous duplicate column: ${String(cell.v)}.`);
      }
      if (header) headers.add(header);
    }
  }
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!")) continue;
    if (cell.f) throw new Error(`Cell ${address} contains a formula. Import fixed values to avoid stale calculated data.`);
    if (cell.t === "e") throw new Error(`Cell ${address} contains a spreadsheet error.`);
    // A date cell's value is a Date; its displayed text is what is imported.
    readCell(cell.t === "d" ? cell.w : cell.v, address, XLSX.utils.decode_cell(address).r + 1);
    // sheet_to_json reads the displayed text (cell.w), so correct it before conversion.
    if (cell.t === "n" && typeof cell.v === "number") {
      cell.w = numericCellText(cell.v, cell.w, address);
    }
  }
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
}

export async function parseDemandSpreadsheet(buffer: ArrayBuffer): Promise<ImportRow[]> {
  return mapDemandRecords(await parseSpreadsheetRecords(buffer, true));
}
