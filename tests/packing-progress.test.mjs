import assert from "node:assert/strict";
import test from "node:test";
import { comparePackingLines, packingLineLabel, packingMetrics, remainingDemand, shippingPriority } from "../lib/packing-progress.ts";

const row = (id, overrides = {}) => ({
  id, plant: "P1", areaType: "offsite", loadNumber: "LOAD-1", trainNumber: "", picklistNumber: "PL-1",
  sequence: "1", packSequence: "", partNumber: "SAME-PART", color: "BLUE", quantity: 15,
  fulfilledQuantity: 0, unitOfMeasure: "EA", status: "pending", allocations: [], ...overrides,
});

test("pack sequence sorts repeated demand lines numerically without merging their identities", () => {
  const lines = [row("third", { sequence: "3", packSequence: "10" }), row("second", { sequence: "2", packSequence: "2" }), row("first", { sequence: "9", packSequence: "1" })];
  const sorted = [...lines].sort(comparePackingLines);
  assert.deepEqual(sorted.map((line) => line.id), ["first", "second", "third"]);
  assert.equal(sorted.length, 3);
  assert.equal(new Set(sorted.map((line) => line.id)).size, 3);
  assert.ok(sorted.every((line) => line.partNumber === "SAME-PART" && line.color === "BLUE" && line.quantity === 15));
  assert.deepEqual(lines.map((line) => line.id), ["third", "second", "first"]);
});

test("packing order falls back to sequence and breaks equal positions deterministically", () => {
  const lines = [row("z", { sequence: "2" }), row("a", { sequence: "2" }), row("ten", { sequence: "10" }), row("one", { sequence: "1" })];
  assert.deepEqual(lines.sort(comparePackingLines).map((line) => line.id), ["one", "a", "z", "ten"]);
  assert.ok(comparePackingLines(row("before", { packSequence: "2", sequence: "2" }), row("after", { packSequence: "2", sequence: "10" })) < 0);
});

test("remaining demand uses exact decimal subtraction and never becomes negative", () => {
  for (const [quantity, fulfilledQuantity, remaining] of [[0.3, 0.2, 0.1], [1.000001, 1, 0.000001], [12.345678, 12.3, 0.045678], [0.2, 0.3, 0], [0.3, 0.3, 0]]) {
    assert.equal(remainingDemand({ quantity, fulfilledQuantity, unitOfMeasure: "KG" }), remaining);
  }
  assert.equal(remainingDemand({ quantity: 15, fulfilledQuantity: 6, unitOfMeasure: "EA" }), 9);
  assert.equal(remainingDemand({ quantity: 15, unitOfMeasure: "EA" }), 15);
});

test("partially allocated demand remains Active and short lines retain their shortage state", () => {
  assert.equal(packingLineLabel(row("untouched")), "Unpacked");
  assert.equal(packingLineLabel(row("partial", { fulfilledQuantity: 5, inventoryItemId: "CONTAINER-1" })), "Active");
  assert.equal(packingLineLabel(row("working", { status: "active" })), "Active");
  assert.equal(packingLineLabel(row("short", { status: "short", fulfilledQuantity: 5 })), "Short");
  assert.equal(packingLineLabel(row("done", { status: "verified", fulfilledQuantity: 15 })), "Packed");
});

test("shortage analytics count distinct scoped picklists rather than short rows", () => {
  const lines = [
    row("short-1", { status: "short" }), row("short-2", { status: "short", sequence: "2" }),
    row("packed-in-short-list", { status: "verified", fulfilledQuantity: 15, sequence: "3" }),
    row("another-load", { status: "short", loadNumber: "LOAD-2" }),
    row("another-plant", { status: "short", plant: "P2" }),
    row("train", { status: "short", areaType: "onsite", trainNumber: "LOAD-1", loadNumber: "" }),
    row("complete", { status: "verified", fulfilledQuantity: 15, picklistNumber: "PL-2" }),
    row("unpacked-1", { picklistNumber: "PL-3" }), row("unpacked-2", { picklistNumber: "PL-3", sequence: "2" }),
    row("partial", { status: "active", fulfilledQuantity: 5, picklistNumber: "PL-4" }),
  ];
  const metrics = packingMetrics(lines);
  assert.equal(metrics.short, 4);
  assert.equal(metrics.packed, 1);
  assert.equal(metrics.unpacked, 1);
  assert.equal(metrics.completion, 20);
  assert.equal(metrics.linesPerHour, null);
});

test("completion and observed throughput count completed lines without adding unlike units", () => {
  const lines = [
    row("pieces", { status: "verified", fulfilledQuantity: 15, allocations: [{ packedAt: "2026-09-23T08:00:00Z" }] }),
    row("weight", { status: "verified", quantity: 0.125, fulfilledQuantity: 0.125, unitOfMeasure: "KG", allocations: [{ packedAt: "2026-09-23T10:00:00Z" }] }),
    row("unfinished", { status: "active", fulfilledQuantity: 5, allocations: [{ packedAt: "not-a-date" }] }),
  ];
  assert.equal(packingMetrics(lines).linesPerHour, 1);
  assert.equal(packingMetrics(lines).completion, 67);
  assert.deepEqual(packingMetrics([]), { packed: 0, unpacked: 0, short: 0, linesPerHour: null, completion: 0 });
  assert.equal(packingMetrics([lines[0]]).linesPerHour, null);
});

test("shipping priority orders known dates and times before unscheduled work", () => {
  const lines = [row("none"), row("late", { scheduledDispatchDate: "2026-09-24", scheduledDispatchTime: "08:00:00" }), row("no-time", { scheduledDispatchDate: "2026-09-23" }), row("early", { scheduledDispatchDate: "2026-09-23", scheduledDispatchTime: "06:30:00" })];
  assert.deepEqual(lines.sort((a, b) => shippingPriority(a).localeCompare(shippingPriority(b))).map((line) => line.id), ["early", "no-time", "late", "none"]);
});
