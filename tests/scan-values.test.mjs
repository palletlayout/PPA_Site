import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDemandBarcodeSet,
  cameraTargetRegion,
  cleanScannerPayload,
  detectDemandBarcode,
  interpretDemandBarcode,
  scanSerialBarcode,
  normalizeScanValue,
} from "../lib/scan-values.ts";

test("serial scan entry requires the serial barcode and never reinterprets another field", () => {
  for (const raw of ["PPART-1", "CBLUE", "2PBLUE", "Q15", "1S", "S123", "2S123", "SERIAL-1", "123", "", "1S" + "X".repeat(511), "1SABC\nPPART-1"]) {
    const result = scanSerialBarcode(raw);
    assert.equal(result.ok, false, raw);
    assert.match(result.message, /Serial number not detected.*1S/);
  }
});

test("serial scanner preserves identifiers, including values that begin with another barcode prefix", () => {
  for (const serial of ["0000123", "PART-123", "Q123", "CBLUE", "1SABC", "X".repeat(510)]) {
    const rawValue = `1S${serial}`;
    assert.deepEqual(scanSerialBarcode(rawValue), { ok: true, serial, rawValue });
  }
  assert.deepEqual(scanSerialBarcode("\r\n]C11s000AbC\r\n"), { ok: true, serial: "000AbC", rawValue: "1s000AbC" });
});

test("builds a complete expected label set for the random test shortcut", () => {
  const barcodes = buildDemandBarcodeSet({
    aiagSerial: "59524202-22694949",
    partNumber: "P1971064A",
    color: "12-M4",
    quantity: 30,
  });
  assert.deepEqual(barcodes, [
    "1S59524202-22694949",
    "PP1971064A",
    "2P12-M4",
    "Q30",
  ]);
  assert.deepEqual(barcodes.map((barcode) => detectDemandBarcode(barcode)?.field), [
    "aiagSerial",
    "partNumber",
    "color",
    "quantity",
  ]);
});

test("removes Zebra AIM identifiers and scanner control characters", () => {
  assert.equal(cleanScannerPayload("]C1P1971064A A010M4\r\n"), "P1971064A A010M4");
  assert.deepEqual(detectDemandBarcode("]C12P12-M4\u001d"), {
    field: "color",
    prefix: "2P",
    value: "12-M4",
  });
});

test("normalizes zero-padded quantity barcodes", () => {
  assert.deepEqual(interpretDemandBarcode("Q00030", "quantity", 30), {
    status: "ready",
    detected: { field: "quantity", prefix: "Q", value: "30" },
    value: "30",
  });
});

test("normalizes camera and server scan values consistently", () => {
  assert.equal(normalizeScanValue("  tr-301  "), "TR-301");
  assert.equal(normalizeScanValue("aiag-9001   a"), "AIAG-9001 A");
  assert.equal(normalizeScanValue(24), "24");
});

test("maps the visible target into a landscape camera frame", () => {
  assert.deepEqual(cameraTargetRegion(1920, 1080), {
    x: 413,
    y: 313,
    width: 1094,
    height: 367,
  });
});

test("maps the visible target into a portrait camera frame", () => {
  assert.deepEqual(cameraTargetRegion(1080, 1920), {
    x: 130,
    y: 790,
    width: 821,
    height: 275,
  });
});

test("identifies demand barcodes and removes their field identifiers", () => {
  assert.deepEqual(detectDemandBarcode("P1971064A A010M4"), {
    field: "partNumber",
    prefix: "P",
    value: "1971064A A010M4",
  });
  assert.deepEqual(detectDemandBarcode("Q30"), {
    field: "quantity",
    prefix: "Q",
    value: "30",
  });
  assert.deepEqual(detectDemandBarcode("2P12-m4"), {
    field: "color",
    prefix: "2P",
    value: "12-m4",
  });
  assert.deepEqual(detectDemandBarcode("1S59524202 - 22694949"), {
    field: "aiagSerial",
    prefix: "1S",
    value: "59524202 - 22694949",
  });
  assert.equal(detectDemandBarcode("P1971064A A010M4.  &")?.value, "1971064A A010M4");
  assert.equal(detectDemandBarcode("P7793030A B010M4 &")?.value, "7793030A B010M4");
  assert.equal(interpretDemandBarcode("P1971064A", "partNumber", "1971064A").status, "ready");
  assert.equal(interpretDemandBarcode("2P12-m4", "color", "12-M4").status, "ready");
});

test("detects missed and unrecognized demand scans", () => {
  const outOfOrder = interpretDemandBarcode("Q30", "aiagSerial", "SER-100");
  assert.equal(outOfOrder.status, "out_of_order");
  assert.equal(outOfOrder.detected?.field, "quantity");
  assert.equal(interpretDemandBarcode("not-a-label-code", "color", "Blue").status, "unrecognized");
  assert.equal(interpretDemandBarcode("Blue", "color", "Blue").status, "ready");
  assert.equal(interpretDemandBarcode("Crimson", "color", "Crimson").value, "Crimson");
  assert.equal(interpretDemandBarcode("P1971064A", "partNumber", "P1971064A").status, "ready");
  assert.equal(interpretDemandBarcode("PINK", "color", "PINK").status, "ready");
});

test("rejects embedded scanner controls without joining separate payloads", () => {
  assert.equal(cleanScannerPayload("\r\n]C1PPART-1\r\n"), "PPART-1");
  for (const control of ["\n", "\r", "\t", "\u0000", "\u001d", "\u0085"]) {
    const payload = `PPART${control}-1`;
    assert.equal(cleanScannerPayload(payload), "");
    assert.equal(detectDemandBarcode(payload), null);
    assert.equal(interpretDemandBarcode(payload, "partNumber", "PART-1").status, "unreadable");
  }
});

test("preserves large quantity digits instead of rounding them into a different scan", () => {
  assert.equal(detectDemandBarcode("Q009007199254740993")?.value, "9007199254740993");
  assert.equal(detectDemandBarcode("Q000")?.value, "0");
});

test("camera target dimensions remain finite before video metadata is ready", () => {
  for (const value of [NaN, Infinity, -Infinity, 0]) {
    const region = cameraTargetRegion(value, value);
    assert.ok(Object.values(region).every(Number.isFinite));
    assert.ok(region.width >= 1 && region.height >= 1);
  }
});
