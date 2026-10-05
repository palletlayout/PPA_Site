import assert from "node:assert/strict";
import test from "node:test";
import { MAX_IMPORT_ROWS, PRINTABLE_FIELD_LIMITS, validateImportRows } from "../lib/import-validation.ts";
import { planDemandReconciliation } from "../db/demand-reconciliation.ts";

const validRow = {
  plant: "PLT-01",
  zone: "A-12",
  areaType: "onsite",
  shipCategory: "Production",
  loadNumber: "",
  trainNumber: "TR-204",
  picklistNumber: "PL-21006789",
  cartNumber: "CT-0187",
  cartId: "CART-0187-A",
  palletId: "PAL-0187",
  sequence: "010",
  partNumber: "AP-44018",
  description: "Front fascia assembly",
  color: "Midnight Blue",
  quantity: 24,
  aiagSerial: "AIAG-78241001",
  masterBarcode: "DEMO-TR204-CT0187",
  movementBarcode: "DEMO-TR204-A12",
};

test("normalizes valid import rows", () => {
  const [row] = validateImportRows([{ ...validRow, areaType: " Onsite ", quantity: "24" }]);
  assert.equal(row.areaType, "onsite");
  assert.equal(row.quantity, 24);
});

test("pack sequence is independent of stable demand identity and option is retained", () => {
  const rows = validateImportRows([
    { ...validRow, sourceLineId: "D1", sequence: "D1", packSequence: "2", option: " SUNROOF " },
    { ...validRow, sourceLineId: "D2", sequence: "D2", packSequence: "2", option: " SUNROOF " },
  ]);
  assert.deepEqual(rows.map(row => row.packSequence), ["2", "2"]);
  assert.equal(rows[0].option, "SUNROOF");
  assert.throws(() => validateImportRows([{ ...validRow, packSequence: "X".repeat(19) }]), /packSequence.*printable limit/);
  assert.throws(() => validateImportRows([{ ...validRow, option: "X".repeat(41) }]), /option.*printable limit/);
});

test("JSON imports cannot declare fulfillment status or allocation results", () => {
  for (const field of ["status", "fulfilledAt", "fulfilledBy", "containerUniqueSerialNumber", "allocations"]) {
    assert.throws(() => validateImportRows([{ ...validRow, [field]: "PACKED" }]), /must be blank/);
  }
});

test("blank optional header quantities do not change a worked legacy demand on reimport", () => {
  const [original] = validateImportRows([validRow]);
  const existing = {
    id: 'legacy-line', headerId: 'legacy-header', batchId: 'old-batch', active: true,
    row: original, detailRevision: 0, headerRevision: 0, status: 'verified',
    verifiedAt: 'packed', loadedAt: 'loaded', inventoryItemId: null,
    fulfilledQuantity: 0, hasScanEvidence: true, hasLoadConfirmation: true,
  };
  for (const blank of [undefined, null, '', ' ']) {
    const [incoming] = validateImportRows([{ ...validRow, productionQuantity: blank, cartMaxQuantity: blank }]);
    assert.equal(incoming.productionQuantity, undefined);
    assert.equal(incoming.cartMaxQuantity, undefined);
    const plan = planDemandReconciliation({ incoming: [incoming], existing: [existing] });
    assert.equal(plan.lines[0].kind, 'preserve');
    assert.equal(plan.lines[0].existing.id, existing.id);
  }
  const [explicitZero] = validateImportRows([{ ...validRow, productionQuantity: 0, cartMaxQuantity: '0' }]);
  assert.equal(explicitZero.productionQuantity, 0);
  assert.equal(explicitZero.cartMaxQuantity, 0);
  assert.throws(() => planDemandReconciliation({ incoming: [explicitZero], existing: [existing] }), /changes to cartMaxQuantity, productionQuantity/);
});

test("picklist demand derives legacy cart references and preserves stable source identity", () => {
  const input = { ...validRow, sourceLineId: " Line-001 ", sourceScope: " ERP ", preferredSupplierId: "SUP-1" };
  delete input.cartNumber;
  delete input.cartId;
  delete input.palletId;
  const [row] = validateImportRows([input]);
  assert.equal(row.cartNumber, "1");
  assert.equal(row.cartId, input.picklistNumber);
  assert.equal(row.palletId, "");
  assert.equal(row.sourceLineId, "Line-001");
  assert.equal(row.sourceScope, "ERP");
  assert.equal(row.preferredSupplierId, "SUP-1");
  assert.throws(() => validateImportRows([input, { ...input, sequence: "020" }]), /repeats Source Line ID/);
  assert.equal(validateImportRows([input, { ...input, sequence: "020", sourceLineId: "line-001" }]).length, 2);
});

test("demand accepts measured units without treating vehicle quantities or colors as part demand", () => {
  const [row] = validateImportRows([{ ...validRow, quantity: "0.125", unitOfMeasure: "kg", productionQuantity: "300", cartMaxQuantity: "12.25", vehicleColor: "EXTERIOR/INTERIOR" }]);
  assert.equal(row.quantity, 0.125);
  assert.equal(row.unitOfMeasure, "KG");
  assert.equal(row.productionQuantity, 300);
  assert.equal(row.cartMaxQuantity, 12.25);
  assert.equal(row.vehicleColor, "EXTERIOR/INTERIOR");
  assert.equal(row.color, validRow.color);
  assert.throws(() => validateImportRows([{ ...validRow, cartMaxQuantity: "1.234" }]), /at most two decimal places/);
});

test("rejects fractional and sub-unit quantities", () => {
  assert.throws(
    () => validateImportRows([{ ...validRow, quantity: 0.5 }]),
    /positive whole number/,
  );
  assert.throws(
    () => validateImportRows([{ ...validRow, quantity: 1.9 }]),
    /positive whole number/,
  );
});

test("rejects identifiers that cannot be represented by the printed barcode", () => {
  assert.throws(
    () => validateImportRows([{ ...validRow, cartId: "CART_0187" }]),
    /cannot be printed as a Code 39 barcode/,
  );
});

test("rejects part marks and load payloads that cannot be rendered safely", () => {
  assert.throws(
    () => validateImportRows([{ ...validRow, color: "BLUE_1" }]),
    /Part Mark contains characters/,
  );
  assert.throws(
    () => validateImportRows([{
      ...validRow,
      areaType: "offsite",
      trainNumber: "",
      loadNumber: "12345678901",
    }]),
    /Load # is too long/,
  );
});

test("rejects conflicting cart-level metadata", () => {
  assert.throws(
    () => validateImportRows([
      validRow,
      { ...validRow, sequence: "020", aiagSerial: "AIAG-78241002", palletId: "PAL-9999" },
    ]),
    /conflicts with another row/,
  );
});

test("preserves explicit printable payloads and leading-zero document fields", () => {
  const [row] = validateImportRows([{
    ...validRow,
    shipCategory: "AA",
    trainNumber: "TE309771",
    cartSequenceNumber: "01",
    masterBarcode: "Z101AATE30977101",
    movementBarcode: "AE1TE309771X5AA",
  }]);
  assert.equal(row.cartSequenceNumber, "01");
  assert.equal(row.masterBarcode, "Z101AATE30977101");
});

test("rejects a second outbound card or order within the same picklist", () => {
  const offsite = {
    ...validRow,
    areaType: "offsite",
    trainNumber: "",
    loadNumber: "268954",
    chassisNumber: "Z101AHTE31016201",
    orderNumber: "09653867",
  };
  assert.throws(
    () => validateImportRows([
      offsite,
      { ...offsite, cartNumber: "CT-0188", cartId: "CART-0188-A", palletId: "PAL-0188", orderNumber: "09653868" },
    ]),
    /exactly one outbound card\/pallet\/order/,
  );
});

test("rejects the reserved composite-key delimiter", () => {
  assert.throws(
    () => validateImportRows([{ ...validRow, plant: "PLANT::OTHER" }]),
    /reserved :: delimiter/,
  );
});

test("rejects onsite demand that could be accepted but not printed", () => {
  assert.throws(
    () => validateImportRows([{ ...validRow, masterBarcode: "", checksheetNumber: "" }]),
    /requires a Master Barcode or Checksheet Number/,
  );
  assert.throws(
    () => validateImportRows([{ ...validRow, movementBarcode: "" }]),
    /requires a Movement Barcode/,
  );
  assert.throws(
    () => validateImportRows([{ ...validRow, masterBarcode: "A".repeat(29) }]),
    /Master Barcode is too long/,
  );
});

test("enforces the printable Code 39 layout boundaries", () => {
  const [row] = validateImportRows([{
    ...validRow,
    masterBarcode: "M".repeat(28),
    movementBarcode: "V".repeat(32),
  }]);
  assert.equal(row.masterBarcode.length, 28);
  assert.equal(row.movementBarcode.length, 32);
  assert.throws(
    () => validateImportRows([{ ...validRow, checksheetNumber: "C".repeat(29) }]),
    /Checksheet Number is too long/,
  );
  assert.throws(
    () => validateImportRows([{ ...validRow, picklistNumber: "P".repeat(29) }]),
    /Picklist # is too long/,
  );
});

test("rejects lossy, coerced, and out-of-database-range quantities", () => {
  for (const quantity of [true, [], "0x10", "1e3", "1,2", "12,,000", "1.0", 2_147_483_648, 9_007_199_254_740_992, Infinity]) {
    assert.throws(() => validateImportRows([{ ...validRow, quantity }]), /whole number|must be text/);
  }
  assert.equal(validateImportRows([{ ...validRow, quantity: "2,147,483,647" }])[0].quantity, 2_147_483_647);
  assert.equal(validateImportRows([{ ...validRow, quantity: "00024" }])[0].quantity, 24);
  for (const field of ["totalCarts", "containerTotal"]) {
    assert.throws(() => validateImportRows([{ ...validRow, [field]: 2_147_483_648 }]), /non-negative whole number/);
  }
});

test("bounds records, cells, and identifier precision before persistence", () => {
  assert.deepEqual(validateImportRows([]), []);
  assert.throws(() => validateImportRows(Array(MAX_IMPORT_ROWS + 1).fill(validRow)), /between 0 and 10,000/);
  assert.throws(() => validateImportRows([{ ...validRow, description: "A".repeat(513) }]), /512-character/);
  assert.throws(() => validateImportRows([{ ...validRow, cartId: 9_007_199_254_740_992 }]), /safe numeric precision/);
  assert.throws(() => validateImportRows([{ ...validRow, sequence: "01\n0" }]), /control characters/);
  assert.throws(() => validateImportRows([null]), /demand record/);
});

test("accepts the bounded 10,000-row demand contract without truncation", () => {
  const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, index) => ({ ...validRow,
    sourceLineId: `capacity-${index}`, sequence: String(index).padStart(5, "0") }));
  const validated = validateImportRows(rows);
  assert.equal(validated.length, 10_000);
  assert.equal(validated.at(-1).sourceLineId, "capacity-9999");
});

test("demand does not allocate serials and requires a unique sequence within each picklist", () => {
  const rows = validateImportRows([
    validRow, { ...validRow, sequence: "020", aiagSerial: validRow.aiagSerial.toLowerCase() },
  ]);
  assert.deepEqual(rows.map((row) => row.aiagSerial), ["", ""]);
  assert.throws(() => validateImportRows([
    validRow, { ...validRow, aiagSerial: "DIFFERENT-SERIAL" },
  ]), /repeats a Sequence/);
  assert.throws(() => validateImportRows([
    validRow, { ...validRow, cartNumber: "OTHER", cartId: "OTHER" },
  ]), /exactly one outbound card\/pallet\/order/);
  assert.equal(validateImportRows([
    validRow, { ...validRow, picklistNumber: "PICK-OTHER", cartNumber: "OTHER", cartId: "OTHER" },
  ]).length, 2);
});

test("accepts blank color and missing expected serial without weakening quantity validation", () => {
  const row = { ...validRow, color: "" };
  delete row.aiagSerial;
  assert.equal(validateImportRows([row])[0].color, "");
  assert.equal(validateImportRows([row])[0].aiagSerial, "");
});

test("prevents direct JSON imports from supplying fulfillment results", () => {
  for (const field of ["fulfilledQuantity", "inventoryItemId", "inventorySerialNumber"]) {
    assert.throws(() => validateImportRows([{ ...validRow, [field]: field === "fulfilledQuantity" ? 24 : "CONTAINER-1" }]), /must be blank/);
  }
});

test("rejects operational identifiers beyond supported readable print dimensions", () => {
  for (const [field, maximum] of Object.entries(PRINTABLE_FIELD_LIMITS)) {
    assert.throws(() => validateImportRows([{ ...validRow, [field]: "X".repeat(maximum + 1) }]), /printable limit|too long/);
  }
  assert.throws(() => validateImportRows([{ ...validRow, model: "MODEL-α" }]), /cannot be printed losslessly/);
  assert.throws(() => validateImportRows([{ ...validRow, cartNumber: "C".repeat(20), totalCarts: 10 }]), /cart sequence and total/);
});


test("one outbound card per picklist is enforced for each identity field, including case variants", () => {
  for (const field of ["cartId", "cartNumber", "palletId", "orderNumber"]) {
    assert.throws(() => validateImportRows([
      validRow, { ...validRow, sequence: "020", [field]: "OTHER-OUTBOUND" },
    ]), /exactly one outbound card\/pallet\/order/);
  }
  assert.throws(() => validateImportRows([
    validRow, { ...validRow, sequence: "020", picklistNumber: validRow.picklistNumber.toLowerCase(), cartId: "OTHER" },
  ]), /exactly one outbound card\/pallet\/order/);
  const separateMovement = { ...validRow, trainNumber: "TR-OTHER", sequence: "020", cartId: "OTHER" };
  assert.equal(validateImportRows([validRow, separateMovement]).length, 2);
});
