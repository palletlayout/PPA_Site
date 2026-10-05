import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "../db/index.ts";

test("SQLite reports hold one snapshot while another connection commits, without reserving the writer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ppa-snapshot-db-"));
  const reader = new Database({sqlitePath:join(dir,"qa.sqlite")});
  const writer = new Database({sqlitePath:join(dir,"qa.sqlite")});
  t.after(async()=>{reader.close();writer.close();await rm(dir,{recursive:true,force:true});});
  await reader.prepare("CREATE TABLE sample (value INTEGER)").run();
  await reader.prepare("INSERT INTO sample VALUES (1)").run();
  const execute = reader.executeSqlite.bind(reader);
  let changed=false;
  reader.executeSqlite = statement => {
    const result=execute(statement);
    if(!changed) {changed=true;writer.executeSqlite(writer.prepare("UPDATE sample SET value=2"));}
    return result;
  };
  const result=await reader.readBatch([reader.prepare("SELECT value FROM sample"),reader.prepare("SELECT value FROM sample")]);
  reader.executeSqlite=execute;
  assert.deepEqual(result.map(r=>r.results[0].value),[1,1]);
  assert.equal((await reader.prepare("SELECT value FROM sample").first()).value,2);
  await assert.rejects(reader.readBatch([reader.prepare("DELETE FROM sample")]),/only accepts queries/);
  await reader.prepare("UPDATE sample SET value=3").run();
  assert.equal((await reader.prepare("SELECT value FROM sample").first()).value,3,"read-only setting must not leak to later writers");
});

test("Postgres snapshot batches request RepeatableRead READ ONLY without the writer advisory lock", async()=>{
  const db = new Database("postgresql://review:disposable@localhost/review");
  let captured;
  db.sql={query:(query,values)=>({query,values}),transaction:async(statements,options)=>{captured={statements,options};return statements.map(()=>({rows:[{value:1}],rowCount:1}));}};
  const result=await db.readBatch([db.prepare("SELECT ? AS value").bind(1)]);
  assert.deepEqual(captured.options,{isolationLevel:"RepeatableRead",readOnly:true});
  assert.deepEqual(captured.statements,[{query:"SELECT $1 AS value",values:[1]}]);
  assert.equal(result[0].results[0].value,1);
});

test("dashboard, CSV, PDF and inventory hydrate evidence inside their complete read snapshot",async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),"ppa-snapshot-store-"));
  process.env.CARTFLOW_DATABASE_PATH=join(dir,"qa.sqlite");
  for(const key of ["DATABASE_URL","POSTGRES_URL","VERCEL"])delete process.env[key];
  const store=await import("../db/cart-store.ts");
  const db=await store.ensureDatabase();
  t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
  const row={plant:"QA",zone:"A",areaType:"onsite",shipCategory:"Production",trainNumber:"TRAIN-1",loadNumber:"",picklistNumber:"PICK-1",cartNumber:"1",cartId:"CART-1",palletId:"PAL-1",masterBarcode:"MASTER-1",movementBarcode:"MOVE-1",sourceLineId:"ROW-1",sourceScope:"review",sequence:"1",partNumber:"PART",description:"",color:"BLUE",quantity:5,aiagSerial:""};
  await store.replaceImport("snapshot.csv",[row]);
  const line=(await store.getAppState()).lines[0];
  const context={lineId:line.id,cartKey:[line.plant,line.areaType,line.trainNumber,line.picklistNumber,line.cartNumber,line.cartId].join("::"),sessionId:"snapshot-session",operatorName:"Reviewer",operatorId:"reviewer"};
  await store.receiveInventoryFromPhysicalLabel({captureId:randomUUID(),receiptSessionId:randomUUID(),rawValues:["1SSNAPSHOT","PPART","CBLUE","Q5"],operatorName:"Receiver"});
  const pack=async()=>{await store.manageLock({...context,action:"acquire"});await store.recordScan({...context,field:"cartBarcode",value:line.cartBarcode});assert.equal((await store.fulfillDemand({...context,serial:"SNAPSHOT",serialFormat:"canonical",requestId:randomUUID()})).verified,true);};
  const runAcrossReset=async(read)=>{
    await pack();
    const original=db.readBatch.bind(db);let injected=false;
    db.readBatch=async statements=>{
      const result=await original(statements);
      if(!injected){injected=true;await store.resetPicklist(context);}
      return result;
    };
    try {const value=await read();assert.equal(injected,true);return value;}
    finally{db.readBatch=original;}
  };
  const state=await runAcrossReset(()=>store.getAppState());
  assert.equal(state.lines[0].status,"verified");assert.equal(state.lines[0].fulfilledQuantity,5);assert.equal(state.lines[0].allocations.length,1);
  const exported=await runAcrossReset(()=>store.getScannedDemandExport());
  const scan=exported.find(r=>r.scan_field==="aiagSerial"&&!r.scan_invalidated_at);
  assert.equal(scan.status,"verified");assert.equal(scan.fulfilled_quantity,5);assert.equal(JSON.parse(scan.allocations_json).length,1);
  const pdf=await runAcrossReset(()=>store.getSectionPdfLines("onsite","production"));
  assert.equal(pdf[0].status,"verified");assert.equal(pdf[0].allocations.length,1);
  const inventory=await runAcrossReset(()=>store.listInventory());
  assert.equal(inventory.items[0].consumedQuantity,5);assert.deepEqual(inventory.items[0].fulfilledDemandIds,[line.id]);
  assert.equal((await store.getAppState()).lines[0].fulfilledQuantity,0);
  assert.equal((await store.listInventory()).items[0].consumedQuantity,0);
});
