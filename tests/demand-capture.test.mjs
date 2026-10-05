import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTestDemandContext,
  capturedLabelMatches,
  nextCapturedSequence,
  parseCaptureId,
  parseDemandCaptureValues,
} from "../lib/demand-capture.ts";

test("physical labels require an explicit measured unit for decimal quantities", () => {
  const raw = ["1SDECIMAL", "PPART", "2P", "Q0.125000"];
  assert.equal(parseDemandCaptureValues(raw, "KG").values.quantity, "0.125");
  assert.throws(() => parseDemandCaptureValues(raw), /digits only/);
  assert.throws(() => parseDemandCaptureValues(raw, "INVALID"), (error) => error.name === "DemandCaptureValidationError" && /Unsupported unit/.test(error.message));
  assert.throws(() => parseDemandCaptureValues(["1SDECIMAL", "PPART", "2P", "Q0.0000001"], "L"), /at most six decimal places/);
});

test("accepts only UUIDv4 capture identifiers for idempotent inventory writes", () => {
  assert.equal(
    parseCaptureId("123E4567-E89B-42D3-A456-426614174000"),
    "123e4567-e89b-42d3-a456-426614174000",
  );
  assert.throws(() => parseCaptureId("capture-1"), /capture identifier is invalid/);
  assert.throws(() => parseCaptureId(null), /capture identifier is required/);
});

test("builds stable, printable identifiers for one generated test load session", () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const context = buildTestDemandContext(sessionId);

  assert.deepEqual(context, {
    sessionId,
    token: "1M7HXC8JC",
    loadNumber: "T1M7HXC8JC",
    picklistNumber: "TPL-1M7HXC8JC",
    checksheetNumber: "TCHK-1M7HXC8JC",
    cartNumber: "001",
    cartId: "TCART-1M7HXC8JC",
    palletId: "TPAL-1M7HXC8JC",
    orderNumber: "TORD-1M7HXC8JC",
    batchNumber: "TBAT-1M7HXC8JC",
  });
  assert.equal(context.loadNumber.length, 10);
  assert.throws(() => buildTestDemandContext("user-picked-load"), /session identifier is invalid/);
});

test("parses one unordered 1S, P, 2P, and Q set for inventory intake", () => {
  const parsed = parseDemandCaptureValues([
    "]C1Q00030\r",
    "2PNH900L",
    "PP1971064A",
    "1SSERIAL-1001",
  ]);

  assert.deepEqual(parsed.values, {
    quantity: "30",
    color: "NH900L",
    partNumber: "P1971064A",
    aiagSerial: "SERIAL-1001",
  });
  assert.equal(parsed.rawValues.quantity, "Q00030");
});

test("rejects incomplete, duplicate, unrecognized, and invalid-quantity labels", () => {
  assert.throws(
    () => parseDemandCaptureValues(["1SSERIAL-1", "PPART-1", "2PBLUE"]),
    /missing a required/,
  );
  assert.throws(
    () => parseDemandCaptureValues(["1SSERIAL-1", "PPART-1", "POTHER", "Q1"]),
    /more than one P value/,
  );
  assert.throws(
    () => parseDemandCaptureValues(["1SSERIAL-1", "PPART-1", "2PBLUE", "NOT-A-LABEL"]),
    /not recognized/,
  );
  assert.throws(
    () => parseDemandCaptureValues(["1SSERIAL-1", "PPART-1", "2PBLUE", "Q0"]),
    /positive whole-number quantity/,
  );
  assert.throws(
    () => parseDemandCaptureValues(["1SSERIAL-1", "PPART-1", "2PBLUE", "Q1e2"]),
    /digits only/,
  );
  assert.throws(
    () => parseDemandCaptureValues(["1SSERIAL-1", "PPART-1", "2PBLUE", "Q1.0"]),
    /digits only/,
  );
  assert.equal(
    parseDemandCaptureValues(["1SSERIAL-1", "PPART-1", "2PBLUE", "Q2147483647"]).values.quantity,
    "2147483647",
  );
  assert.throws(
    () => parseDemandCaptureValues(["1SSERIAL-1", "PPART-1", "2PBLUE", "Q2147483648"]),
    /no greater than 2,147,483,647/,
  );
});

test("matches idempotent label replays but rejects changed physical values", () => {
  const parsed = parseDemandCaptureValues(["1SSERIAL-1", "PPART-1", "2PBLUE", "Q12"]);
  const existing = { aiagSerial: " serial-1 ", partNumber: "part-1", color: "blue", quantity: 12 };

  assert.equal(capturedLabelMatches(existing, parsed.values), true);
  assert.equal(capturedLabelMatches({ ...existing, quantity: 13 }, parsed.values), false);
  assert.equal(capturedLabelMatches({ ...existing, color: "RED" }, parsed.values), false);
});

test("allocates the next zero-padded part sequence without reusing a value", () => {
  assert.equal(nextCapturedSequence(["010", "020", "NOTE"]), "021");
  assert.equal(nextCapturedSequence([]), "001");
  assert.equal(nextCapturedSequence(["1", "002", "003"]), "004");
});

test("allocates sequences beyond JavaScript numeric precision without rounding or hanging", () => {
  assert.equal(nextCapturedSequence(["9007199254740992", "9007199254740993"]), "9007199254740994");
  assert.equal(nextCapturedSequence(["0009999999999999999999999999999999"]), "0010000000000000000000000000000000");
});

test("canonicalizes UUID casing so a test-load session has one identity", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(buildTestDemandContext(id), buildTestDemandContext(id.toUpperCase()));
});

test("rejects quantities with precision loss and multiple concatenated barcode segments", () => {
  assert.throws(() => parseDemandCaptureValues(["1SSERIAL-1", "PPART-1", "2PBLUE", "Q9007199254740993"]), /no greater than/);
  assert.throws(() => parseDemandCaptureValues(["1SSERIAL\n-1", "PPART-1", "2PBLUE", "Q1"]), /empty or too long/);
});

test("an explicit empty color marker is valid but serial, part and quantity remain required", () => {
  for (const color of ["2P", "C"]) {
    const captured = parseDemandCaptureValues(["1SSERIAL-1", "PPART-1", color, "Q12"]);
    assert.equal(captured.values.color, "");
    assert.equal(captured.rawValues.color, color);
  }
  for (const values of [["1S", "PPART-1", "2P", "Q12"], ["1SS1", "P", "2P", "Q12"], ["1SS1", "PPART", "2P", "Q"]]) {
    assert.throws(() => parseDemandCaptureValues(values), /not recognized/);
  }
});

test("a three-barcode label means no color, with serial, part and quantity still required", () => {
  const captured = parseDemandCaptureValues(["Q12", "1SSERIAL-1", "PPART-1"]);
  assert.equal(captured.values.color, "");
  assert.equal(captured.rawValues.color, "C");
  assert.equal(captured.values.quantity, "12");
  for (const values of [["PPART-1", "CBLUE", "Q12"], ["1SSERIAL-1", "CBLUE", "Q12"], ["1SSERIAL-1", "PPART-1", "CBLUE"]]) {
    assert.throws(() => parseDemandCaptureValues(values), /missing a required/);
  }
});
