import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { types as postgresTypes } from "@neondatabase/serverless";

const source = { sourceLineId:"ORDER-1", plant:"P1", areaType:"onsite", zone:"Z", shipCategory:"Production", trainNumber:"TRAIN-1", loadNumber:"", picklistNumber:"PICK-1", masterBarcode:"MASTER-1",movementBarcode:"MOVE-1", cartNumber:"1", cartId:"CART-1", palletId:"PAL-1", sequence:"010", packSequence:"2", partNumber:"PART", description:"Part", color:"BLUE", quantity:10, aiagSerial:"", option:"SPORT" };
const key = (line) => [line.plant,line.areaType,line.areaType === "onsite" ? line.trainNumber : line.loadNumber,line.picklistNumber,line.cartNumber,line.cartId].join("::");

test("configurable fulfillment ledger, shortages and reversal", async (t) => {
  const directory=await mkdtemp(join(tmpdir(),"ppa-modes-"));
  process.env.CARTFLOW_DATABASE_PATH=join(directory,"qa.sqlite");
  for (const name of ["DATABASE_URL","POSTGRES_URL","VERCEL"]) delete process.env[name];
  const store=await import("../db/cart-store.ts");
  const db=await store.ensureDatabase();
  t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  const actor={id:"boss",name:"Boss"};
  const setup=async(rows=[source],mode="multiple")=>{
    await store.clearAllData();
    await store.updateFulfillmentSettings({packingMode:mode,inventoryMode:"uploaded"},actor);
    await store.replaceImport("orders.csv",rows);
    const lines=(await store.getAppState()).lines;
    const line=[...lines].sort((a,b)=>Number(a.packSequence||a.sequence)-Number(b.packSequence||b.sequence))[0];
    const context={serialFormat:"canonical",cartKey:key(line),lineId:line.id,sessionId:"scanner",operatorName:"Packer",operatorId:"packer"};
    await store.manageLock({...context,action:"acquire"});
    await store.recordScan({...context,field:"cartBarcode",value:line.cartBarcode});
    return {lines,line,context};
  };
  const receive=(serial,quantity=10,extra={})=>store.receiveInventoryFromPhysicalLabel({captureId:randomUUID(),receiptSessionId:randomUUID(),rawValues:[`1S${serial}`,"PPART","CBLUE",`Q${quantity}`],operatorName:"Receiver",...extra});
  const pack=(context,serial,extra={})=>store.fulfillDemand({...context,serial,requestId:randomUUID(),...extra});

  await t.test("defaults persist and settings cannot change under a lease",async()=>{
    assert.deepEqual(await store.getFulfillmentSettings(),{packingMode:"exact",inventoryMode:"uploaded",partAttribute:"color"});
    assert.deepEqual((await store.getAppState()).settings,{packingMode:"exact",inventoryMode:"uploaded",partAttribute:"color"});
    const {context}=await setup();
    await assert.rejects(store.updateFulfillmentSettings({packingMode:"exact",inventoryMode:"scan"},actor),/Release active scanning/);
    await store.manageLock({...context,action:"release"});
    await store.updateFulfillmentSettings({packingMode:"multiple",inventoryMode:"scan",partAttribute:"part_level"},actor);
    await store.updateFulfillmentSettings({packingMode:"multiple",inventoryMode:"scan"},actor);
    const saved=execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e","const s=await import('./db/cart-store.ts'); console.log(JSON.stringify(await s.getFulfillmentSettings())); (await s.ensureDatabase()).close();"],{cwd:process.cwd(),env:process.env,encoding:"utf8"});
    assert.deepEqual(JSON.parse(saved.trim()),{packingMode:"multiple",inventoryMode:"scan",partAttribute:"color"});
    await store.clearAllData();
    assert.equal((await store.getAppState()).settings.inventoryMode,"scan","clearing operational data preserves configuration");
  });
  for (const mode of ["exact", "multiple"]) {
    await t.test(`${mode} packing accepts Neon's numeric text quantities`, async (t) => {
      const rows = mode === "exact" ? [source] : [source, { ...source, sourceLineId: "ORDER-2", sequence: "020", packSequence: "3", quantity: 4 }];
      const { context, lines } = await setup(rows, mode);
      await receive("NEON-NUMERIC", mode === "exact" ? 10 : 12);
      const execute = db.execute.bind(db);
      const numeric = postgresTypes.getTypeParser(1700, "text");
      assert.equal(numeric("10.000000"), "10.000000");
      // Keep the real allocation transaction, but reproduce the driver's wire
      // representation for NUMERIC(20,6) inventory columns instead of SQLite numbers.
      t.mock.method(db, "execute", async (statement) => {
        const result = await execute(statement);
        if (statement.query.includes("WHERE normalized_serial =")) {
          result.results = result.results.map((item) => ({
            ...item,
            quantity: numeric(Number(item.quantity).toFixed(6)),
            consumed_quantity: numeric(Number(item.consumed_quantity).toFixed(6)),
          }));
        }
        return result;
      });
      const request = { ...context, lineId: undefined, serial: "1SNEON-NUMERIC", serialFormat: "barcode", requestId: randomUUID() };
      const first = await store.fulfillDemand(request);
      assert.equal(first.verified, true);
      assert.equal(first.fulfilledQuantity, 10);
      assert.equal((await store.fulfillDemand(request)).alreadyFulfilled, true);
      if (mode === "multiple") {
        const second = await store.fulfillDemand({ ...request, requestId: randomUUID() });
        assert.equal(second.lineId, lines.find((line) => line.sourceLineId === "ORDER-2").id);
        assert.equal(second.verified, false);
        assert.equal(second.allocatedQuantity, 2);
        assert.equal(second.remainingQuantity, 2);
      }
      const inventory = (await store.listInventory()).items[0];
      assert.equal(inventory.status, "consumed");
      assert.equal(inventory.consumedQuantity, mode === "exact" ? 10 : 12);
      assert.equal(inventory.remainingQuantity, 0);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM fulfillment_allocations").first()).n, mode === "exact" ? 1 : 2);
    });
  }
  await t.test("multiple contributions and request/serial retries cannot double consume",async()=>{
    const {context,line}=await setup();
    await receive("A",4);await receive("B",12);
    const request={...context,serial:"A",requestId:randomUUID()};
    const [one,retry]=await Promise.all([store.fulfillDemand(request),store.fulfillDemand(request)]);
    assert.ok(one.ok&&retry.ok);assert.equal(Number(one.alreadyFulfilled)+Number(retry.alreadyFulfilled),1);
    assert.equal(one.fulfilledQuantity,4);assert.equal(one.verified,false);assert.equal(one.remainingQuantity,6);
    const repeated=await pack(context,"A");assert.equal(repeated.alreadyFulfilled,true);
    assert.equal((await store.fulfillDemand({...request,serial:"B"})).reason,"request_conflict");
    const two=await pack(context,"B");assert.equal(two.verified,true);assert.equal(two.allocatedQuantity,6);
    const saved=(await store.getAppState()).lines[0];
    assert.equal(saved.status,"verified");assert.equal(saved.fulfilledQuantity,10);assert.equal(saved.remainingQuantity,0);
    assert.equal(saved.option,"SPORT");assert.equal(saved.packSequence,"2");assert.deepEqual(saved.allocations.map(a=>[a.serial,a.quantity]),[["A",4],["B",6]]);
    const stock=await store.listInventory();const b=stock.items.find(i=>i.serial==="B");
    assert.equal(b.status,"partially_consumed");assert.equal(b.consumedQuantity,6);assert.equal(b.remainingQuantity,6);assert.deepEqual(b.fulfilledDemandIds,[line.id]);
    assert.deepEqual(stock.summary,{containers:1,units:6,quantitiesByUnit:{EA:6}});
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM fulfillment_allocations").first()).n,2);
    await store.manageLock({...context,action:"release"});
    await store.replaceImport("same.csv",[source]);
    assert.equal((await store.getAppState()).lines[0].allocations.length,2);
    const load=await store.confirmCartLoading({cartBarcode:line.cartBarcode,movementValue:line.trainNumber,operatorName:"Loader"});
    assert.equal(load.ok,true,"fulfilled ledger may load even if one shared container retains stock");
  });
  await t.test("explicit repeated demand can pack in arbitrary order, sharing remaining stock",async()=>{
    const {context,lines}=await setup([source,{...source,sourceLineId:"ORDER-2",sequence:"020",packSequence:"10",quantity:5}]);
    const later=lines.find(l=>l.sourceLineId==="ORDER-2");
    await receive("SHARED",15);
    const next=await pack({...context,lineId:later.id},"SHARED");assert.equal(next.fulfilledQuantity,5);assert.equal(next.verified,true);
    assert.equal((await store.getAppState()).lines.find(l=>l.id===context.lineId).fulfilledQuantity,0);
    assert.equal((await pack(context,"SHARED")).fulfilledQuantity,10);
    const item=(await store.listInventory()).items[0];assert.equal(item.status,"consumed");assert.equal(item.fulfilledDemandIds.length,2);
    assert.equal((await store.getAppState()).lines.filter(l=>l.status==="verified").length,2);
  });
  await t.test("serial-only multiple packing matches a later part and request retry stays on its allocation",async()=>{
    const later={...source,sourceLineId:"ORDER-2",sequence:"020",packSequence:"10",partNumber:"LATE-PART",quantity:8};
    const {context,lines}=await setup([source,later]);
    await store.receiveInventoryFromPhysicalLabel({captureId:randomUUID(),receiptSessionId:randomUUID(),rawValues:["1SLATE-MULTI","PLATE-PART","CBLUE","Q3"],operatorName:"Receiver"});
    const request={...context,lineId:undefined,serial:"1SLATE-MULTI", serialFormat: "barcode",requestId:randomUUID()};
    const result=await store.fulfillDemand(request);assert.equal(result.ok,true);assert.equal(result.verified,false);assert.equal(result.fulfilledQuantity,3);assert.equal(result.remainingQuantity,5);
    assert.equal(result.lineId,lines.find(l=>l.sourceLineId==="ORDER-2").id);
    assert.equal((await store.fulfillDemand(request)).alreadyFulfilled,true);
    assert.equal((await store.fulfillDemand({...request,requestId:randomUUID()})).alreadyFulfilled,true);
    assert.equal((await store.getAppState()).lines.find(l=>l.id===context.lineId).fulfilledQuantity,0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM fulfillment_allocations").first()).n,1);
  });
  await t.test("serial-only multiple packing moves remaining container stock to the next repeated row once",async()=>{
    const {context,lines}=await setup([{...source,quantity:5},{...source,sourceLineId:"ORDER-2",sequence:"020",packSequence:"10",quantity:4}]);
    const firstLine=lines.find(line=>line.sourceLineId===source.sourceLineId);
    const secondLine=lines.find(line=>line.sourceLineId==="ORDER-2");
    await receive("REPEATED-SHARED",7);
    const firstRequest={...context,lineId:undefined,serial:"1SREPEATED-SHARED", serialFormat: "barcode",requestId:randomUUID()};
    const first=await store.fulfillDemand(firstRequest);
    assert.equal(first.ok,true);assert.equal(first.lineId,firstLine.id);assert.equal(first.verified,true);
    assert.equal(first.allocatedQuantity,5);assert.equal(first.fulfilledQuantity,5);assert.equal(first.remainingQuantity,0);
    const firstRetry=await store.fulfillDemand(firstRequest);
    assert.equal(firstRetry.alreadyFulfilled,true);assert.equal(firstRetry.lineId,firstLine.id);assert.equal(firstRetry.fulfilledQuantity,5);
    assert.equal((await store.listInventory()).items[0].consumedQuantity,5);
    const secondRequest={...firstRequest,requestId:randomUUID()};
    const second=await store.fulfillDemand(secondRequest);
    assert.equal(second.ok,true);assert.equal(second.lineId,secondLine.id);assert.equal(second.verified,false);
    assert.equal(second.allocatedQuantity,2);assert.equal(second.fulfilledQuantity,2);assert.equal(second.remainingQuantity,2);
    const secondRetry=await store.fulfillDemand(secondRequest);
    assert.equal(secondRetry.alreadyFulfilled,true);assert.equal(secondRetry.lineId,secondLine.id);
    assert.equal(secondRetry.fulfilledQuantity,2);assert.equal(secondRetry.remainingQuantity,2);
    const lateFirstRetry=await store.fulfillDemand(firstRequest);
    assert.equal(lateFirstRetry.alreadyFulfilled,true);assert.equal(lateFirstRetry.lineId,firstLine.id);assert.equal(lateFirstRetry.fulfilledQuantity,5);
    const saved=(await store.getAppState()).lines;
    assert.equal(saved.find(line=>line.id===firstLine.id).fulfilledQuantity,5);
    assert.equal(saved.find(line=>line.id===secondLine.id).fulfilledQuantity,2);
    const stock=(await store.listInventory()).items[0];
    assert.equal(stock.status,"consumed");assert.equal(stock.consumedQuantity,7);assert.equal(stock.remainingQuantity,0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM fulfillment_allocations").first()).n,2);
  });
  await t.test("partial work survives reimport and cannot be edited or canceled",async()=>{
    const {context,line}=await setup();await receive("PARTIAL",3);await pack(context,"PARTIAL");
    await store.manageLock({...context,action:"release"});
    await store.replaceImport("same.csv",[source]);
    const saved=(await store.getAppState()).lines[0];assert.equal(saved.id,line.id);assert.equal(saved.status,"active");assert.equal(saved.fulfilledQuantity,3);assert.equal(saved.allocations.length,1);
    await assert.rejects(store.replaceImport("changed.csv",[{...source,quantity:11}]),/reconciliation required/);
    await assert.rejects(store.updateDemandLine(line.id,{quantity:11}),/cannot be edited/);
    await assert.rejects(store.updateFulfillmentSettings({packingMode:"exact",inventoryMode:"uploaded"},actor),/partial or short/);
  });
  await t.test("closing marks every unfinished line short, releases lease and survives imports",async()=>{
    const rows=[source,{...source,sourceLineId:"ORDER-2",sequence:"020",packSequence:"10"}];
    const {context,line}=await setup(rows);await receive("SHORT",4);await pack(context,"SHORT");
    const closed=await store.closePicklist(context);assert.equal(closed.shortLines,2);
    const state=await store.getAppState();assert.ok(state.lines.every(l=>l.status==="short"));assert.equal(state.locks.length,0);assert.equal(state.lines[0].fulfilledQuantity,4);
    assert.equal((await store.manageLock({...context,action:"acquire"})).reason,"picklist_closed");
    assert.equal((await store.closePicklist(context)).alreadyClosed,true);
    await store.replaceImport("short.csv",rows);assert.ok((await store.getAppState()).lines.every(l=>l.status==="short"));
    assert.equal((await store.confirmCartLoading({cartBarcode:line.cartBarcode,movementValue:line.trainNumber,operatorName:"Loader"})).reason,"not_packed");
    await assert.rejects(store.replaceImport("missing.csv",[source]),/reconciliation required/);
  });
  await t.test("reset reverses only its allocations, preserves other picklists, invalidates evidence",async()=>{
    const rows=[source,{...source,sourceLineId:"ORDER-2",picklistNumber:"PICK-2",masterBarcode:"MASTER-2",cartNumber:"2",cartId:"CART-2",quantity:5}];
    const {context,line,lines}=await setup(rows);await receive("SHARED",20);
    const firstRequest={...context,serial:"SHARED",requestId:randomUUID()};await store.fulfillDemand(firstRequest);
    await store.manageLock({...context,action:"release"});
    const other=lines.find(l=>l.id!==line.id),next={...context,lineId:other.id,cartKey:key(other),sessionId:"other"};
    await store.manageLock({...next,action:"acquire"});await store.recordScan({...next,field:"cartBarcode",value:other.cartBarcode});await pack(next,"SHARED");
    await assert.rejects(store.resetPicklist({cartKey:next.cartKey,sessionId:"foreign",operatorName:"Boss",operatorId:"boss"}),/Another scanner/);
    await store.resetPicklist({cartKey:context.cartKey,operatorName:"Boss",operatorId:"boss"});
    const stock=(await store.listInventory()).items[0];assert.equal(stock.consumedQuantity,5);assert.equal(stock.remainingQuantity,15);assert.equal(stock.fulfilledDemandIds.length,1);
    const state=await store.getAppState();const reset=state.lines.find(l=>l.id===line.id);assert.equal(reset.status,"pending");assert.equal(reset.fulfilledQuantity,0);assert.deepEqual(reset.allocations,[]);assert.equal(reset.aiagSerial,"");
    assert.ok((await db.prepare("SELECT invalidated_at FROM scan_events WHERE line_id=?").bind(line.id).all()).results.every(e=>e.invalidated_at));
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM fulfillment_allocations WHERE reversed_at IS NOT NULL").first()).n,1);
    await store.manageLock({...context,action:"acquire"});await store.recordScan({...context,field:"cartBarcode",value:line.cartBarcode});
    assert.equal((await store.fulfillDemand(firstRequest)).reason,"allocation_reversed");
    assert.equal((await pack(context,"SHARED")).verified,true);
  });
  await t.test("reset clears loaded state but a dispatched picklist cannot be reset",async()=>{
    const {context,line}=await setup();await receive("LOAD",10);await pack(context,"LOAD");
    const load={cartBarcode:line.cartBarcode,movementValue:line.trainNumber,operatorName:"Loader"};
    assert.equal((await store.confirmCartLoading(load)).ok,true);
    await store.resetPicklist({...context,operatorName:"Boss",operatorId:"boss"});
    assert.equal((await store.getAppState()).lines[0].loadedAt,null);assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM load_confirmations").first()).n,0);
    await store.manageLock({...context,action:"acquire"});await store.recordScan({...context,field:"cartBarcode",value:line.cartBarcode});await pack(context,"LOAD");
    await store.confirmCartLoading(load);await store.confirmPicklistDispatch(load);
    await assert.rejects(store.resetPicklist({...context,operatorName:"Boss",operatorId:"boss"}),/Dispatched/);
    assert.equal((await store.listInventory()).items[0].consumedQuantity,10);
  });
  await t.test("ledger and inventory updates roll back if auditing fails",async()=>{
    const {context}=await setup();await receive("ROLLBACK",5);
    await db.prepare("CREATE TRIGGER reject_pack BEFORE INSERT ON demand_audit_events WHEN NEW.action='fulfill' BEGIN SELECT RAISE(ABORT,'audit offline'); END").run();
    try { await assert.rejects(pack(context,"ROLLBACK"),/audit offline/); } finally { await db.prepare("DROP TRIGGER reject_pack").run(); }
    assert.equal((await store.getAppState()).lines[0].fulfilledQuantity,0);assert.equal((await store.listInventory()).items[0].consumedQuantity,0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM fulfillment_allocations").first()).n,0);
  });
  await t.test("measured quantities use exact decimals and explicit quantities are bounded",async()=>{
    const {context}=await setup([{...source,quantity:0.3,unitOfMeasure:"KG"}]);await receive("MEASURED",0.5,{unitOfMeasure:"KG"});
    assert.equal((await pack(context,"MEASURED",{quantity:0.4})).reason,"invalid_quantity");
    assert.equal((await pack(context,"MEASURED")).fulfilledQuantity,0.3);
    assert.equal((await store.listInventory()).items[0].remainingQuantity,0.2);
  });
  await t.test("legacy whole allocations migrate losslessly and reset returns stock",async()=>{
    const {context,line}=await setup([source],"exact");const inventory=await receive("LEGACY",10);await pack(context,"LEGACY");
    await db.prepare("DELETE FROM fulfillment_allocations").run();await db.prepare("UPDATE cartflow_schema SET version=11 WHERE name='primary'").run();
    execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e","const s=await import('./db/cart-store.ts'); (await s.ensureDatabase()).close();"],{cwd:process.cwd(),env:process.env,stdio:"pipe"});
    const migrated=await db.prepare("SELECT * FROM fulfillment_allocations").first();assert.equal(migrated.demand_detail_id,line.id);assert.equal(migrated.inventory_item_id,inventory.inventory.id);assert.equal(migrated.quantity,10);assert.equal(migrated.serial,"LEGACY");
    await store.resetPicklist({...context,operatorName:"Boss",operatorId:"boss"});assert.equal((await store.listInventory()).items[0].consumedQuantity,0);
  });
});
