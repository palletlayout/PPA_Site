import { MAX_IMPORT_ROWS, validateImportRows } from "./import-validation.ts";
import { MAX_IMPORT_FILE_BYTES, MAX_IMPORT_REQUEST_BYTES } from "./import-transport.ts";
import { readJsonBody, readLimitedBody, RequestError, validateInput } from "./request-security.ts";
import { parseDemandSpreadsheet } from "./spreadsheet-import.ts";

/** allowShrink is an explicit confirmation, so only a real boolean (or "true"/"false" in a form) counts. */
function readAllowShrink(value: unknown) {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "true") return true;
  if (text === "false") return false;
  throw new RequestError("allowShrink must be true or false.");
}

/** Optional control total: the sender's own count of the rows in this delivery. */
function readExpectedRows(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_IMPORT_ROWS) {
    throw new RequestError(`expectedRows must be a whole number from 0 to ${MAX_IMPORT_ROWS.toLocaleString("en-US")}.`);
  }
  return number;
}

function checkControlTotal(expectedRows: number | undefined, rowCount: number) {
  if (expectedRows !== undefined && expectedRows !== rowCount) {
    throw new RequestError(`expectedRows is ${expectedRows} but this delivery contains ${rowCount} demand rows. Nothing was imported; resend the complete file.`, 422);
  }
}

/** Both ingestion boundaries use the original workbook and the same bounded parser. */
export async function readDemandImportRequest(request: Request) {
  const multipart = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data";
  try {
    if (!multipart) {
      const body = await readJsonBody(request, MAX_IMPORT_REQUEST_BYTES);
      if (!Array.isArray(body.rows)) throw new RequestError("No normalized demand rows were supplied.");
      const allowShrink = readAllowShrink(body.allowShrink);
      const expectedRows = readExpectedRows(body.expectedRows);
      const rows = validateInput(() => validateImportRows(body.rows as unknown[]));
      checkControlTotal(expectedRows, rows.length);
      return {
        action: String(body.action ?? "").trim().toLowerCase(),
        source: String(body.source ?? "").trim().slice(0, 80),
        fileName: String(body.fileName ?? "").trim().slice(0, 180),
        rows,
        allowShrink,
      };
    }

    const bytes = await readLimitedBody(request, MAX_IMPORT_REQUEST_BYTES);
    let form: FormData;
    try {
      form = await new Response(bytes as BodyInit, { headers: { "Content-Type": request.headers.get("content-type")! } }).formData();
    } catch { throw new RequestError("Request body must contain valid multipart form data."); }
    for (const field of ["file", "action", "source", "allowShrink", "expectedRows"]) {
      if (form.getAll(field).length > 1) throw new RequestError(`Supply the multipart ${field} field only once.`);
    }
    const file = form.get("file");
    if (!(file instanceof File) || !file.name) throw new RequestError("A spreadsheet file is required in the multipart file field.");
    if (file.size > MAX_IMPORT_FILE_BYTES) throw new RequestError("Spreadsheet upload is too large.", 413);
    for (const field of ["action", "source", "allowShrink", "expectedRows"]) {
      if (form.get(field) instanceof File) throw new RequestError(`The multipart ${field} field must be text.`);
    }
    const allowShrink = readAllowShrink(form.get("allowShrink"));
    const expectedRows = readExpectedRows(form.get("expectedRows"));
    let rows;
    try { rows = await parseDemandSpreadsheet(await file.arrayBuffer()); }
    catch (error) { throw new RequestError(error instanceof Error ? error.message : "Unable to parse the spreadsheet."); }
    checkControlTotal(expectedRows, rows.length);
    return {
      action: String(form.get("action") ?? "").trim().toLowerCase(),
      source: String(form.get("source") ?? "").trim().slice(0, 80),
      fileName: file.name.trim().slice(0, 180),
      rows,
      allowShrink,
    };
  } catch (error) {
    if (error instanceof RequestError && error.status === 413) {
      throw new RequestError(multipart
        ? "Upload is too large. Save a smaller compressed .xlsx workbook; the complete upload must stay below 4 MiB including form metadata."
        : "Demand JSON is too large. Send the original compressed .xlsx workbook as multipart/form-data in the file field; the complete upload must stay below 4 MiB.", 413);
    }
    throw error;
  }
}
