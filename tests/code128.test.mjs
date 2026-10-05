import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { CODE128_QUIET_ZONE_MODULES, encodeCode128 } from "../lib/code128.ts";

const require = createRequire(import.meta.url);
const zxingRequire = createRequire(require.resolve("@zxing/browser"));
const { BarcodeFormat, BitArray, ChecksumException, Code128Reader } = zxingRequire("@zxing/library");

function decodeRuns(runs) {
  const row = new BitArray();
  for (const run of runs) {
    for (let moduleIndex = 0; moduleIndex < run.modules; moduleIndex += 1) {
      row.appendBit(run.isBar);
    }
  }
  return new Code128Reader().decodeRow(0, row);
}

test("Code 128 barcode data decodes with the application's independent scanner", () => {
  for (const payload of [
    "P7972A-THR-A000", "Cblue", "Q20", "Q12.5", "1S51606101-04120568",
    "1S1SABC", "PPART_GYP", "mixedCase-a/b:[]*", "  spaces stay  ", " ",
  ]) {
    const encoding = encodeCode128(payload);
    const result = decodeRuns(encoding.runs);
    assert.equal(result.getBarcodeFormat(), BarcodeFormat.CODE_128);
    assert.equal(result.getText(), payload);
    assert.equal(encoding.payload, payload);
  }
});

test("Code 128 preserves every printable ASCII character including case and punctuation", () => {
  const printableAscii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)).join("");
  assert.equal(decodeRuns(encodeCode128(printableAscii).runs).getText(), printableAscii);
});

test("Code 128 uses start B, a weighted modulo-103 checksum, and the full stop symbol", () => {
  const encoding = encodeCode128("ABC123");
  assert.deepEqual(encoding.codewords, [104, 33, 34, 35, 17, 18, 19, 67, 106]);
  assert.deepEqual(encoding.runs.slice(-8, -1).map((run) => run.modules), [2, 3, 3, 1, 1, 1, 2]);
  assert.equal(decodeRuns(encoding.runs).getText(), "ABC123");
});

test("Code 128 supports every checksum symbol and longer weighted payloads", () => {
  const seenChecksums = new Set();
  for (let first = 32; first <= 126 && seenChecksums.size < 103; first += 1) {
    for (let second = 32; second <= 126; second += 1) {
      const payload = String.fromCharCode(first, second);
      const encoding = encodeCode128(payload);
      const checksum = encoding.codewords.at(-2);
      if (!seenChecksums.has(checksum)) {
        assert.equal(decodeRuns(encoding.runs).getText(), payload);
        seenChecksums.add(checksum);
      }
    }
  }
  assert.equal(seenChecksums.size, 103);
  const longPayload = "Mixed-0123456789".repeat(16);
  assert.equal(decodeRuns(encodeCode128(longPayload).runs).getText(), longPayload);
});

test("Code 128 emits integral widths, alternating bars, and ten-module quiet zones", () => {
  const encoding = encodeCode128("A");
  assert.deepEqual(encoding.runs[0], { isBar: false, modules: CODE128_QUIET_ZONE_MODULES });
  assert.deepEqual(encoding.runs.at(-1), { isBar: false, modules: CODE128_QUIET_ZONE_MODULES });
  assert.equal(encoding.totalModules, 66);
  assert.equal(encoding.totalModules, encoding.runs.reduce((sum, run) => sum + run.modules, 0));
  const symbolRuns = encoding.runs.slice(1, -1);
  assert.ok(symbolRuns.every((run, index) => run.isBar === (index % 2 === 0)));
  assert.ok(symbolRuns.every((run) => Number.isInteger(run.modules) && run.modules >= 1 && run.modules <= 4));
});

test("the independent Code 128 scanner rejects a valid symbol with a corrupted checksum", () => {
  const encoding = encodeCode128("1S51606101-04120568");
  const wrongChecksum = (encoding.codewords.at(-2) + 1) % 103;
  const wrongChecksumRuns = [...Code128Reader.CODE_PATTERNS[wrongChecksum]].map((modules, index) => ({
    isBar: index % 2 === 0,
    modules,
  }));
  const corrupted = [...encoding.runs];
  corrupted.splice(1 + (encoding.codewords.length - 2) * 6, 6, ...wrongChecksumRuns);
  assert.throws(() => decodeRuns(corrupted), ChecksumException);
});

test("Code 128 rejects empty, non-string, Unicode, and control-character payloads", () => {
  for (const payload of ["", null, undefined, 123]) {
    assert.throws(() => encodeCode128(payload), /non-empty string/);
  }
  for (const payload of ["STRAßE", "ıD", "ﬀ", "🙂", "A\nB", "\t", "\x00", "\x1f", "\x7f"]) {
    assert.throws(() => encodeCode128(payload), /unsupported character/);
  }
});
