import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_SUPERVISOR_FILTERS, filterSupervisorMovements, filterSupervisorPicklists, supervisorLineMatches, supervisorSearchMatches, visibleSupervisorSelection } from "../lib/supervisor-filters.ts";

const line = (id, overrides = {}) => ({
  id, areaType: "offsite", plant: "01", zone: "N", loadNumber: "L000001", trainNumber: "",
  picklistNumber: "MASTER-1", partNumber: "PANEL-123", color: "BLUE", ...overrides,
});
const movement = (key, lines, status = "ready") => ({ key, lines, status });
const filters = (overrides = {}) => ({ ...EMPTY_SUPERVISOR_FILTERS, ...overrides });

test("supervisor search finds source labels and allocated serials without requiring optional fields", () => {
  const fields = ["movementBarcode", "masterBarcode", "checksheetNumber", "cartBarcode", "cartId", "cartNumber", "palletId", "orderNumber", "outgoingSerial", "aiagSerial", "fromLot", "toLot", "model", "fromModel", "toModel", "fromType", "toType", "fromOption", "toOption", "fromColor", "toColor", "fromInteriorColor", "toInteriorColor", "pickingLocation", "deliveryLocation", "detailDeliveryLocation", "packSequence", "containerSequence", "containerPosition"];
  for (const field of fields) {
    assert.equal(supervisorSearchMatches(line("row", { [field]: "UNIQUE-REFERENCE" }), "  unique-reference  "), true, field);
  }
  assert.equal(supervisorSearchMatches(line("row", { allocations: [{ serial: "SERIAL-987", packedBy: "Alex" }] }), "serial-987 alex"), true);
  assert.equal(supervisorSearchMatches(line("row"), ""), true);
  assert.equal(supervisorSearchMatches(line("row"), "missing"), false);
  assert.equal(supervisorSearchMatches(line("row"), "panel blue"), true);
});

test("movement, plant, zone, status and search filters intersect on the same demand row", () => {
  const matching = movement("match", [line("match-row", { palletId: "PAL-7" })], "active");
  const groups = [
    matching,
    movement("wrong-type", [line("train", { areaType: "onsite", palletId: "PAL-7" })], "active"),
    movement("wrong-plant", [line("plant", { plant: "02", palletId: "PAL-7" })], "active"),
    movement("wrong-zone", [line("zone", { zone: "S", palletId: "PAL-7" })], "active"),
    movement("wrong-status", [line("status", { palletId: "PAL-7" })]),
    movement("split-match", [line("other-zone", { zone: "S", palletId: "PAL-7" }), line("no-pallet")], "active"),
  ];
  const selection = filters({ areaType: "offsite", plant: "01", zone: "N", status: "active", query: "pal-7" });
  assert.deepEqual(filterSupervisorMovements(groups, selection), [matching]);
  assert.deepEqual(filterSupervisorMovements(groups, filters()), groups, "clear filters restores every movement");
  assert.equal(groups.length, 6, "table filtering must not modify the section PDF source");
  assert.equal(groups[5].lines.length, 2);
});

test("search narrows picklists and demand rows to matching identifiers within the selected movement", () => {
  const blue = line("blue", { palletId: "PAL-7", allocations: [{ serial: "INBOUND-1" }] });
  const red = line("red", { color: "RED", picklistNumber: "MASTER-2", palletId: "PAL-8" });
  const lists = [{ key: "one", lines: [blue] }, { key: "two", lines: [red] }];
  assert.deepEqual(filterSupervisorPicklists(lists, filters({ query: "inbound-1" }), "pal-7"), [lists[0]]);
  assert.deepEqual(filterSupervisorPicklists(lists, filters({ query: "inbound-1" }), "pal-8"), []);
  assert.deepEqual(lists.flatMap((group) => group.lines).filter((row) => supervisorLineMatches(row, filters({ query: "blue" }))), [blue]);
  assert.deepEqual(filterSupervisorPicklists(lists, filters(), "master-2"), [lists[1]]);
});

test("hidden or stale selected movements and picklists cannot leak into the visible details", () => {
  const groups = [{ key: "one" }, { key: "two" }];
  assert.equal(visibleSupervisorSelection(groups, "two"), groups[1]);
  assert.equal(visibleSupervisorSelection(groups.slice(0, 1), "two"), groups[0]);
  assert.equal(visibleSupervisorSelection(groups, "old-import-id"), groups[0]);
  assert.equal(visibleSupervisorSelection([], "two"), null);
});
