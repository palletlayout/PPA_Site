import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const row = { plant: "PLT-01", zone: "A-12", areaType: "onsite", shipCategory: "Production", loadNumber: "", trainNumber: "TR-204", picklistNumber: "PL-1001", cartNumber: "CT-001", cartId: "CART-001", palletId: "PAL-001", sequence: "010", partNumber: "PART-001", description: "Part", color: "BLUE", quantity: 24, aiagSerial: "", masterBarcode: "MASTER-001", movementBarcode: "MOVEMENT-001" };
const cartKey = (line) => [line.plant,line.areaType,line.trainNumber,line.picklistNumber,line.cartNumber,line.cartId].join("::");

test("inventory serial fulfillment is atomic and independent of demand identifiers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ppa-fulfillment-"));
  process.env.CARTFLOW_DATABASE_PATH = join(directory, "qa.sqlite");
  for (const key of ["DATABASE_URL", "POSTGRES_URL", "VERCEL"]) delete process.env[key];
  const store = await import("../db/cart-store.ts");
  const db = await store.ensureDatabase();
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const receive = (serial, data = row, metadata = {}) => store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: [`1S${serial}`, `P${data.partNumber}`, `2P${data.color}`, `Q${data.quantity}`], operatorName: "Receiver", ...metadata });
  const setup = async (rows = [row]) => {
    await store.clearAllData(); await store.replaceImport("demand.csv", rows);
    const lines = (await store.getAppState()).lines;
    const context = { serialFormat: "canonical", lineId: lines[0].id, cartKey: cartKey(lines[0]), sessionId: "scanner-one", operatorName: "Packer", operatorId: "packer-id" };
    await store.manageLock({ ...context, action: "acquire" });
    return { lines, context };
  };
  const scanCart = (line, context) => store.recordScan({ ...context, field: "cartBarcode", value: line.cartBarcode });

  await t.test("receiving does not fulfil demand and serial alone requires a cart scan", async () => {
    const { lines, context } = await setup();
    await receive("CONTAINER-A");
    assert.equal((await store.getAppState()).lines[0].status, "pending");
    assert.equal(lines[0].aiagSerial, ""); assert.equal(lines[0].inventoryItemId, null);
    assert.equal((await store.fulfillDemand({ ...context, serial: "CONTAINER-A" })).reason, "cart_not_scanned");
    await scanCart(lines[0], context);
    const result = await store.fulfillDemand({ ...context, serial: "1SCONTAINER-A", serialFormat: "barcode" });
    assert.equal(result.verified, true);
    const saved = (await store.getAppState()).lines[0];
    assert.equal(saved.id, lines[0].id); assert.equal(saved.aiagSerial, "CONTAINER-A");
    assert.equal(saved.fulfilledQuantity, 24); assert.equal(saved.inventoryItemId, result.inventoryItemId);
    const stock = await store.listInventory();
    assert.equal(stock.items[0].status, "consumed"); assert.equal(stock.items[0].consumedFlag, "Y");
    assert.equal(stock.items[0].consumedQuantity, 24); assert.deepEqual(stock.summary, { containers: 0, units: 0, quantitiesByUnit: {} });
    assert.equal(stock.total, 1);
  });
  await t.test("two demand IDs cannot consume the same container, including concurrent requests", async () => {
    const { lines, context } = await setup([row, { ...row, sequence: "020" }]);
    await receive("ONLY-ONE"); await scanCart(lines[0], context);
    const attempts = await Promise.all(lines.map((line) => store.fulfillDemand({ ...context, lineId: line.id, serial: "ONLY-ONE" })));
    assert.equal(attempts.filter((r) => r.ok).length, 1);
    assert.equal(attempts.find((r) => !r.ok).reason, "inventory_consumed");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_details WHERE inventory_item_id IS NOT NULL").first()).n, 1);
    const winner = attempts.find((r) => r.ok);
    const retries = await Promise.all(Array.from({length: 5}, () => store.fulfillDemand({ ...context, lineId: winner.lineId, serial: "ONLY-ONE" })));
    assert.ok(retries.every((r) => r.ok && r.alreadyFulfilled));
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events WHERE action = 'fulfill'").first()).n, 1);
    await assert.rejects(store.setInventoryDeleted({ id: winner.inventoryItemId, deleted: true, operatorName: "Boss", operatorId: "boss" }), /current status/);
    await assert.rejects(store.updateDemandLine(winner.lineId, {quantity: 50}), /cannot be edited/);
    await assert.rejects(store.deleteDemandLine(winner.lineId), /cannot be deleted/);
  });
  await t.test("serial-only retries identify the fulfilled line before searching remaining demand", async () => {
    const { lines, context } = await setup([row, { ...row, sequence: "020" }]);
    await receive("REPLAY"); await scanCart(lines[0], context);
    const serialContext = { ...context, lineId: undefined };
    const first = await store.fulfillDemand({ ...serialContext, serial: "REPLAY" });
    const again = await store.fulfillDemand({ ...serialContext, serial: "1SREPLAY", serialFormat: "barcode" });
    assert.equal(again.alreadyFulfilled, true);
    assert.equal(again.lineId, first.lineId);
    assert.equal((await store.getAppState()).lines.filter((line) => line.status === "pending").length, 1);
    await receive("SECOND");
    assert.equal((await store.fulfillDemand({ ...serialContext, serial: "SECOND" })).verified, true);
    assert.equal((await store.fulfillDemand({ ...serialContext, serial: "REPLAY" })).alreadyFulfilled, true);
    await receive("EXTRA");
    assert.equal((await store.fulfillDemand({ ...serialContext, serial: "EXTRA" })).reason, "demand_fulfilled");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events WHERE action='fulfill'").first()).n, 2);
  });
  await t.test("persisted fulfillment is recognized even if legacy stock status is stale", async () => {
    const { lines, context } = await setup([row, { ...row, sequence: "020", partNumber: "OTHER" }]);
    const original = lines.find((line) => line.sequence === "010");
    await receive("LINKED"); await scanCart(original, { ...context, lineId: original.id });
    const serialContext = { ...context, lineId: undefined };
    const first = await store.fulfillDemand({ ...serialContext, serial: "LINKED" });
    assert.equal(first.verified, true);
    for (const status of ["available", "expected", "deleted"]) {
      await db.prepare("UPDATE inventory_items SET status=?,consumed_quantity=0 WHERE id=?").bind(status, first.inventoryItemId).run();
      const retry = await store.fulfillDemand({ ...serialContext, serial: "LINKED" });
      assert.equal(retry.reason, "demand_fulfilled");
      assert.match(retry.error, /already fulfilled/);
    }
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM demand_audit_events WHERE action='fulfill'").first()).n, 1);
  });
  await t.test("a consumed serial on another picklist is reported even when its contents differ", async () => {
    const { lines, context } = await setup([row, { ...row, picklistNumber: "OTHER", cartNumber: "OTHER", cartId: "OTHER", masterBarcode: "OTHER-MASTER", partNumber: "DIFFERENT" }]);
    const original = lines.find((line) => line.picklistNumber === row.picklistNumber);
    await store.manageLock({ ...context, action: "release" });
    const firstContext = { ...context, cartKey: cartKey(original), lineId: original.id };
    await store.manageLock({ ...firstContext, action: "acquire" });
    await receive("USED-ELSEWHERE"); await scanCart(original, firstContext);
    await store.fulfillDemand({ ...firstContext, serial: "USED-ELSEWHERE" });
    const other = lines.find((line) => line.picklistNumber === "OTHER");
    const next = { ...context, cartKey: cartKey(other), lineId: other.id };
    await store.manageLock({ ...next, action: "acquire" }); await scanCart(other, next);
    const serialContext = { ...next, lineId: undefined };
    assert.equal((await store.fulfillDemand({ ...serialContext, serial: "USED-ELSEWHERE" })).reason, "inventory_consumed");
  });
  await t.test("fallback card-color scans match a later formatted part before earlier demand", async () => {
    const target = { ...row, sequence: "020", partNumber: "83280-TYA-A011-M1", color: "NH900L", quantity: 15 };
    const { lines, context } = await setup([row, target]);
    await scanCart(lines[0], context);
    const serialContext = { ...context, lineId: undefined };
    assert.equal((await store.fulfillDemand({ ...serialContext, serial: "FALLBACK" })).reason, "inventory_not_found");
    const rawValues = ["1SFALLBACK", "P83280TYAA011M1", "CNH900L", "Q00015"];
    const { capturedPackingContents, checkPackingDemand } = await import("../lib/packing-demand.ts");
    const check = checkPackingDemand(lines, capturedPackingContents(rawValues, "EA", ""));
    assert.equal(check.line.sequence, "020");
    await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues, operatorName: "Receiver" });
    const result = await store.fulfillDemand({ ...serialContext, serial: "FALLBACK" });
    assert.equal(result.verified, true);
    assert.equal(result.lineId, check.line.id);
    assert.equal((await store.getAppState()).lines.find((line) => line.sequence === "010").status, "pending");
  });
  await t.test("known serial chooses any matching unfulfilled row and keeps identical rows independent", async () => {
    const later = { ...row, sequence: "020", partNumber: "LATER-PART", quantity: 12 };
    const { lines, context } = await setup([row, later, { ...later, sequence: "030" }]);
    await scanCart(lines[0], context);
    const serialContext = { ...context, lineId: undefined };
    await receive("LATE-A", later); await receive("LATE-B", later);
    const request = { ...serialContext, serial: "1SLATE-A", serialFormat: "barcode", requestId: randomUUID() };
    const first = await store.fulfillDemand(request);
    assert.equal(first.verified, true); assert.equal(first.lineId, lines.find(line => line.sequence === "020").id);
    assert.equal((await store.fulfillDemand(request)).alreadyFulfilled, true);
    assert.equal((await store.fulfillDemand({ ...serialContext, serial: "1SLATE-A", serialFormat: "barcode", requestId: randomUUID() })).alreadyFulfilled, true);
    const second = await store.fulfillDemand({ ...serialContext, serial: "1SLATE-B", serialFormat: "barcode", requestId: randomUUID() });
    assert.equal(second.verified, true); assert.equal(second.lineId, lines.find(line => line.sequence === "030").id);
    assert.equal((await store.getAppState()).lines.find(line => line.sequence === "010").status, "pending");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM fulfillment_allocations").first()).n, 2);
  });
  await t.test("unknown serial returns capture signal and newly captured contents can fulfill a later row", async () => {
    const later = { ...row, sequence: "020", partNumber: "NEW-PART", color: "GREEN", quantity: 8 };
    const { lines, context } = await setup([row, later]); await scanCart(lines[0], context);
    const request = { ...context, lineId: undefined, serial: "1SNEW-MISSING", serialFormat: "barcode", requestId: randomUUID() };
    const missing = await store.fulfillDemand(request);
    assert.equal(missing.reason, "inventory_not_found"); assert.equal(missing.serial, "NEW-MISSING");
    assert.equal((await store.listInventory()).total, 0); assert.ok((await store.getAppState()).lines.every(line => line.fulfilledQuantity === 0));
    await store.receiveInventoryFromPhysicalLabel({ captureId: randomUUID(), receiptSessionId: randomUUID(), rawValues: ["PNEW-PART", "CGREEN", "Q8", "1SNEW-MISSING"], operatorName: "Receiver" });
    const result = await store.fulfillDemand(request);
    assert.equal(result.verified, true); assert.equal(result.lineId, lines.find(line => line.sequence === "020").id);
    assert.equal((await store.getAppState()).lines.find(line => line.sequence === "010").fulfilledQuantity, 0);
  });
  await t.test("wrong label fields at serial entry never open unknown-container capture", async () => {
    const { lines, context } = await setup(); await scanCart(lines[0], context);
    for (const serial of ["PPART-001", "CBLUE", "2PBLUE", "Q24", "]C1PPART-001", "1S"]) {
      const result = await store.fulfillDemand({ ...context, lineId: undefined, serial, serialFormat: "barcode", requestId: randomUUID() });
      assert.equal(result.reason, "invalid_serial", serial);
    }
    assert.equal((await store.listInventory()).total, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM fulfillment_allocations").first()).n, 0);
    await receive("P-LITERAL");
    assert.equal((await store.fulfillDemand({ ...context, serial: "P-LITERAL" })).verified, true, "stored canonical API serials retain exact lookup compatibility");
  });
  await t.test("part, color and whole-container quantity must each match exactly", async () => {
    const { lines, context } = await setup(); await scanCart(lines[0], context);
    for (const [index, differences] of [{partNumber:"OTHER"},{color:"RED"},{quantity:12},{quantity:48}].entries()) {
      const serial = `WRONG-${index}`; await receive(serial, {...row,...differences});
      assert.equal((await store.fulfillDemand({...context,serial})).reason,"inventory_mismatch");
    }
    assert.ok((await store.listInventory()).items.every((i) => i.status === "available"));
    assert.equal((await store.getAppState()).lines[0].fulfilledQuantity, 0);
    const rejected = (await db.prepare("SELECT * FROM scan_events WHERE field = 'aiagSerial' AND matched = 0 ORDER BY scanned_value").all()).results;
    assert.equal(rejected.length, 4);
    assert.deepEqual(rejected.map((event) => event.scanned_value), ["WRONG-0", "WRONG-1", "WRONG-2", "WRONG-3"]);
    assert.ok(rejected.every((event) => event.line_id === lines[0].id && event.operator_id === "packer-id" && event.lease_id));
    await receive("CORRECT");
    assert.equal((await store.fulfillDemand({ ...context, serial: "CORRECT" })).verified, true);
    const state = await store.getAppState();
    assert.equal(state.lines[0].status, "verified");
    assert.equal(state.events.filter((event) => event.lineId === lines[0].id && event.matched === 0).length, 4);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM scan_events WHERE field = 'aiagSerial' AND matched = 1").first()).count, 1);
  });
  await t.test("missing inventory can be received during packing, including blank color", async () => {
    const blank = {...row,color:""}; const {lines,context}=await setup([blank]); await scanCart(lines[0],context);
    assert.equal((await store.fulfillDemand({...context,serial:"1SNEW-CONTAINER", serialFormat: "barcode"})).reason,"inventory_not_found");
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM scan_events WHERE matched = 0").first()).count, 0);
    await receive("NEW-CONTAINER",blank);
    assert.equal((await store.fulfillDemand({...context,serial:"NEW-CONTAINER"})).verified,true);
  });
  await t.test("explicit serial format selects either prefix-colliding container", async () => {
    const {lines,context}=await setup([row,{...row,sequence:"020"}]); await scanCart(lines[0],context);
    await receive("ABC"); await receive("1SABC");
    assert.equal((await store.fulfillDemand({...context,serial:"1SABC", serialFormat: "barcode"})).serial,"ABC");
    assert.equal((await store.fulfillDemand({...context,lineId:undefined,serial:"1S1SABC", serialFormat: "barcode"})).serial,"1SABC");
  });
  await t.test("deleted inventory and a renewed lease cannot bypass stock or cart checks", async () => {
    const {lines,context}=await setup(); const received=await receive("DELETED"); await scanCart(lines[0],context);
    await store.setInventoryDeleted({id:received.inventory.id,deleted:true,operatorName:"Boss",operatorId:"boss"});
    assert.equal((await store.fulfillDemand({...context,serial:"DELETED"})).reason,"inventory_unavailable");
    await receive("AVAILABLE"); await store.manageLock({...context,action:"release"}); await store.manageLock({...context,action:"acquire"});
    assert.equal((await store.fulfillDemand({...context,serial:"AVAILABLE"})).reason,"cart_not_scanned");
  });
  await t.test("audit failure rolls both demand and stock back", async () => {
    const {lines,context}=await setup(); await receive("ROLLBACK"); await scanCart(lines[0],context);
    await db.prepare(`CREATE TRIGGER reject_fulfill BEFORE INSERT ON demand_audit_events WHEN NEW.action='fulfill' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`).run();
    try {await assert.rejects(store.fulfillDemand({...context,serial:"ROLLBACK"}),/audit unavailable/);} finally {await db.prepare("DROP TRIGGER reject_fulfill").run();}
    assert.equal((await store.listInventory()).items[0].status,"available");
    assert.equal((await store.getAppState()).lines[0].fulfilledQuantity,0);
    assert.equal((await store.fulfillDemand({...context,serial:"ROLLBACK"})).verified,true);
  });
  await t.test("retired scans cannot complete a line and consumed stock survives demand reimport", async () => {
    const {lines,context}=await setup(); await receive("USED"); await scanCart(lines[0],context);
    for (const field of ["aiagSerial","partNumber","color","quantity"]) assert.equal((await store.recordScan({...context,field,value:"anything"})).ok,false);
    assert.equal((await store.recordScanBatch({...context,scans:[{field:"partNumber",rawValue:"PPART-001"}]})).ok,false);
    await store.fulfillDemand({...context,serial:"USED"}); await store.manageLock({...context,action:"release"});
    await store.replaceImport("replacement.csv",[row]); const line=(await store.getAppState()).lines[0];
    const next={...context,lineId:line.id}; await store.manageLock({...next,action:"acquire"}); await scanCart(line,next);
    assert.equal(line.id, lines[0].id, "refresh preserves the allocated demand identity");
    assert.equal(line.status, "verified");
    assert.equal(line.aiagSerial, "USED");
    const replay = await store.fulfillDemand({...next,serial:"USED"});
    assert.equal(replay.ok, true);
    assert.equal(replay.alreadyFulfilled, true);
    assert.equal((await store.listInventory()).items[0].status, "consumed");
  });
  await t.test("inventory metadata round-trips, and conflicting duplicate metadata is rejected", async () => {
    await setup(); const first=await receive("META",row,{weight:3.5,unitCost:2.2,receiveDate:"2026-09-15"});
    assert.equal(first.inventory.weight,3.5); assert.equal(first.inventory.receiveDate,"2026-09-15");
    assert.equal((await store.getInventoryExport())[0].unitCost,2.2);
    await assert.rejects(receive("META",row,{weight:4}),/different inventory metadata/);
    await assert.rejects(receive("INVALID",row,{receiveDate:"2026-02-30"}),/valid YYYY-MM-DD/);
  });
  await t.test("loading checks actual allocation and remains idempotent", async () => {
    const {lines,context}=await setup(); await scanCart(lines[0],context);
    await db.prepare("UPDATE demand_details SET status='verified' WHERE id=?").bind(lines[0].id).run();
    const load=()=>store.confirmCartLoading({cartBarcode:lines[0].cartBarcode,movementValue:lines[0].movementBarcode,operatorName:"Loader"});
    assert.equal((await load()).reason,"not_packed");
    await db.prepare("UPDATE demand_details SET status='pending' WHERE id=?").bind(lines[0].id).run();
    await receive("LOAD"); await store.fulfillDemand({...context,serial:"LOAD"});
    const results=await Promise.all([load(),load()]); assert.ok(results.every((r)=>r.ok)); assert.equal(results.filter((r)=>r.alreadyLoaded).length,1);
  });
  await t.test("test demand uses test inventory scope while physical stock stays available", async () => {
    await store.clearAllData();
    const capture=await store.appendTestDemandFromPhysicalLabel({captureId:randomUUID(),testSessionId:randomUUID(),rawValues:["1SSHARED","PPART-001","2PBLUE","Q24"],operatorName:"Tester"});
    assert.equal(capture.projectionStatus,"created");
    await receive("SHARED");
    const line=(await store.getAppState()).lines[0];
    assert.equal(line.aiagSerial,"");
    const context={lineId:line.id,cartKey:[line.plant,line.areaType,line.loadNumber,line.picklistNumber,line.cartNumber,line.cartId].join("::"),sessionId:"test-scanner",operatorName:"Tester"};
    await store.manageLock({...context,action:"acquire"}); await scanCart(line,context);
    const result=await store.fulfillDemand({...context,serial:"1SSHARED", serialFormat: "barcode"});
    assert.equal(result.verified,true); assert.equal(result.inventoryItemId,capture.inventoryId);
    assert.equal((await store.listInventory()).items[0].status,"available");
    assert.equal((await store.listInventory()).items[0].fulfilledDemandId,null);
  });
  await t.test("legacy migration preserves source serial and history, and requires reconciliation for proven loaded stock", async () => {
    const historical={...row,picklistNumber:"PL-OLD",cartNumber:"OLD",cartId:"OLD",sequence:"010"};
    const {lines,context}=await setup([row,historical]); await store.manageLock({...context,action:"release"});
    const old=lines.find((l)=>l.cartNumber==="OLD"); const current=lines.find((l)=>l.cartNumber!=="OLD");
    const now=new Date().toISOString();
    await db.prepare("UPDATE demand_details SET status='verified', aiag_serial=CASE WHEN id=? THEN 'HISTORIC' ELSE 'EXPECTED-ONLY' END").bind(old.id).run();
    await db.prepare("UPDATE demand_headers SET loaded_at=? WHERE id=(SELECT header_id FROM demand_details WHERE id=?)").bind(now,old.id).run();
    await db.prepare(`INSERT INTO scan_events (id,line_id,cart_key,session_id,field,scanned_value,matched,is_test,operator_name,created_at) VALUES (?,?,?,'legacy','aiagSerial','1SHISTORIC',1,0,'Old operator',?)`).bind(randomUUID(),old.id,cartKey(old),now).run();
    await db.prepare("UPDATE cartflow_schema SET version=8 WHERE name='primary'").run();
    execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e","const s=await import('./db/cart-store.ts'); const db=await s.ensureDatabase(); db.close();"],{cwd:process.cwd(),env:process.env,stdio:"pipe"});
    const legacy=await db.prepare("SELECT * FROM demand_details WHERE id=?").bind(old.id).first();
    assert.equal(legacy.legacy_expected_serial,"HISTORIC"); assert.equal(legacy.aiag_serial,""); assert.equal(legacy.status,"verified");
    assert.equal(legacy.fulfilled_quantity,0); assert.equal(legacy.inventory_item_id,null);
    assert.equal((await db.prepare("SELECT status FROM demand_details WHERE id=?").bind(current.id).first()).status,"pending");
    await receive("HISTORIC"); await receive("FRESH");
    const next={...context,lineId:current.id,cartKey:cartKey(current)};
    await store.manageLock({...next,action:"acquire"}); await scanCart(current,next);
    assert.equal((await store.fulfillDemand({...next,serial:"HISTORIC"})).reason,"inventory_legacy_review");
    assert.equal((await store.fulfillDemand({...next,serial:"FRESH"})).verified,true);
    assert.equal((await store.listInventory({q:"FRESH"})).items[0].fulfilledDemandId,current.id);
    assert.ok((await store.getScannedDemandExport("history")).some((entry)=>entry.legacy_expected_serial==="HISTORIC"));
  });

});
