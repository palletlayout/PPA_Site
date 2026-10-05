import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE39_QUIET_ZONE_MODULES,
  code39Runs,
  code39TotalModules,
  encodeCode39,
} from "../lib/code39.ts";

test("canonicalizes lowercase while preserving leading zeroes", () => {
  const encoding = encodeCode39("007a");

  assert.equal(encoding.payload, "007A");
  assert.equal(encoding.framedValue, "*007A*");
  assert.equal(encoding.totalModules, 115);
});

test("rejects empty, reserved, and unsupported payloads", () => {
  assert.throws(() => encodeCode39(""), /non-empty string/);
  assert.throws(() => encodeCode39("A*B"), /unsupported character "\*"/);
  assert.throws(() => encodeCode39("A_B"), /unsupported character "_"/);
});

test("emits 1:3 elements, one-module gaps, and ten-module quiet zones", () => {
  const runs = code39Runs("A");

  assert.deepEqual(runs[0], { isBar: false, modules: CODE39_QUIET_ZONE_MODULES });
  assert.deepEqual(runs.at(-1), { isBar: false, modules: CODE39_QUIET_ZONE_MODULES });
  assert.equal(runs.length, 31);
  assert.equal(code39TotalModules("A"), 67);

  const symbolRuns = runs.slice(1, -1);
  assert.ok(symbolRuns.every((run) => run.modules === 1 || run.modules === 3));
  assert.equal(symbolRuns.filter((run) => !run.isBar && run.modules === 1).length, 11);
});

test("adds only start and stop symbols, without a checksum character", () => {
  const encoding = encodeCode39("CODE 39");

  assert.equal(encoding.framedValue, "*CODE 39*");
  assert.equal(encoding.totalModules, 163);
});

test("rejects Unicode case expansions that would print a different identifier", () => {
  for (const payload of ["STRAßE", "ıD", "ﬀ", "A\nB"]) {
    assert.throws(() => encodeCode39(payload), /unsupported character/);
  }
});
