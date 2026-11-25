import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceDemoBook, routeDemoRecords } from '../src/workforce-records.mjs';
function env(){
 const books=new Map();
 return {WORKFORCE_RECORDS:{idFromName:name=>name,get:id=>{
  if(!books.has(id)){
   const data=new Map();
   const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v))};
   storage.transaction=async fn=>fn(storage);
   books.set(id,new WorkforceDemoBook({storage}));
  }
  return books.get(id);
 }},WORKFORCE_RECORDS_ENABLED:'true'};
}
const access=(companyId='demo-a',role='owner')=>({companyId,role});
const req=(path='/workforce/workspace/records',body)=>new Request('https://demo.invalid'+path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});
const read=async(e,a)=>{const r=await routeDemoRecords(req(),e,a);assert.equal(r.status,200);return r.json();};
const update=(e,a,body)=>routeDemoRecords(req('/workforce/workspace/records/time-approval',body),e,a);
const approval={exampleId:'example-3',status:'approved',expectedVersion:0};
test('missing flag or binding disables records',async()=>{assert.equal((await routeDemoRecords(req(),{},access())).status,503);assert.equal((await routeDemoRecords(req(),{WORKFORCE_RECORDS_ENABLED:'true'},access())).status,503);});
test('records are scoped by verified company and persisted across requests',async()=>{const e=env();assert.equal((await read(e,access())).version,0);assert.equal((await update(e,access(),approval)).status,200);const a=await read(e,access());const b=await read(e,access('demo-b'));assert.equal(a.version,1);assert.equal(a.timesheets[2].status,'approved');assert.equal(b.version,0);assert.equal(b.timesheets[2].status,'pending');assert.equal(a.submittable,false);});
test('reviewers can read but cannot change an approval',async()=>{const e=env();await read(e,access('demo-a','reviewer'));assert.equal((await update(e,access('demo-a','reviewer'),approval)).status,403);assert.equal((await read(e,access())).version,0);});
test('stale version cannot overwrite a committed approval',async()=>{const e=env();assert.equal((await update(e,access(),approval)).status,200);assert.equal((await update(e,access(),{...approval,status:'pending'})).status,409);assert.equal((await read(e,access())).timesheets[2].status,'approved');});
test('rejects extra data, unknown example and invalid values',async()=>{const e=env();for(const b of [{...approval,companyId:'demo-b'},{...approval,exampleId:'real-worker'},{...approval,status:'paid'},{...approval,expectedVersion:-1}])assert.equal((await update(e,access(),b)).status,400);assert.equal((await read(e,access())).version,0);});
test('one state change yields one receipt and a no-op retry creates none',async()=>{const e=env();await update(e,access(),approval);const r=await update(e,access(),{...approval,expectedVersion:1});assert.equal(r.status,200);const a=await read(e,access());assert.equal(a.version,1);assert.equal(a.receipts.length,1);assert.deepEqual(a.receipts[0],{version:1,exampleId:'example-3',from:'pending',to:'approved'});});
test('private object denies accidental tenant collision',async()=>{const e=env();await update(e,access(),approval);e.WORKFORCE_RECORDS.idFromName=()=> 'demo-a';assert.equal((await routeDemoRecords(req(),e,access('demo-b'))).status,403);});
