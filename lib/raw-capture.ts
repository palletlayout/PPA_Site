export type RawScan = {
  id: string;
  sessionId: string;
  position: number;
  rawValue: string;
  scannedAt: string;
};

export type SavedRawScan = RawScan & { savedAt: string; operatorName: string };
export type RawCaptureSession = { sessionId: string; startedAt: string; count: number; operatorName: string };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function validCaptureSession(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Only line terminators separate scans. Keep prefixes, case, spacing and repeats. */
export function splitRawScans(value: string) {
  return value.split(/\r\n|\r|\n/).filter((line) => line.length > 0);
}

export function validateRawScan(value: unknown): RawScan {
  if (!value || typeof value !== "object") throw new Error("A scan is required.");
  const scan = value as RawScan;
  if (!validCaptureSession(scan.id) || !validCaptureSession(scan.sessionId)
    || !Number.isSafeInteger(scan.position) || scan.position < 1 || scan.position > 1_000_000
    || typeof scan.rawValue !== "string" || !scan.rawValue.length || scan.rawValue.length > 4096
    || /[\r\n\u0000]/.test(scan.rawValue)
    || typeof scan.scannedAt !== "string" || !Number.isFinite(Date.parse(scan.scannedAt))) {
    throw new Error("Each scan needs a valid session, position, timestamp and one line of up to 4,096 characters.");
  }
  return { id: scan.id, sessionId: scan.sessionId, position: scan.position, rawValue: scan.rawValue, scannedAt: scan.scannedAt };
}
