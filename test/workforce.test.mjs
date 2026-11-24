import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {previewPayroll, workforceOverview, workforceTools} from '../src/workforce.mjs';

test('synthetic hourly preview calculates gross in integer cents, not net pay', () => {
  const p = previewPayroll({regularMinutes:2400,overtimeMinutes:300,hourlyCents:2000});
  assert.equal(p.grossCents,95000);
  assert.equal(p.netCents,null);
  assert.equal(p.taxCents,null);
  assert.equal(p.submittable,false);
});
test('rejects fractional, negative, oversized and extra fields', () => {
  for(const bad of [{regularMinutes:-1},{regularMinutes:1.5},{regularMinutes:2401},{overtimeMinutes:10081},{hourlyCents:0},{hourlyCents:1000001},{employeeId:'real-person'},{currency:'eur'}]){
    assert.throws(()=>previewPayroll({regularMinutes:2400,overtimeMinutes:0,hourlyCents:2000,...bad}));
  }
});
test('rounds only once at gross total', () => {
  assert.equal(previewPayroll({regularMinutes:1,overtimeMinutes:1,hourlyCents:1999}).grossCents,83);
});
test('overview and agent tools never advertise submission or real payroll', () => {
  assert.equal(workforceOverview().mode,'synthetic_preview');
  assert.equal(workforceOverview().providerConnected,false);
  assert.deepEqual(workforceTools().map(t=>t.name),['workforce_overview','preview_payroll']);
});
const req=(path,method='GET',body,token)=>new Request('https://jusspay.invalid'+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
const AUTH={fetch:async r=>new Response(JSON.stringify({subject:'demo-subject',audience:'jusspay',expiresAt:Date.now()/1000+60}),{status:r.headers.get('authorization')==='Bearer sample'?200:401})};
const env={AUTH,WORKFORCE_PREVIEW_ENABLED:'true'};
test('workforce gate fails closed by default; auth remains mandatory',async()=>{
  assert.equal((await worker.fetch(req('/workforce/overview'),{AUTH})).status,503);
  assert.equal((await worker.fetch(req('/workforce/overview'),env)).status,401);
  assert.equal((await worker.fetch(req('/workforce/overview','GET',undefined,'wrong'),env)).status,401);
  assert.equal((await worker.fetch(req('/workforce/overview','GET',undefined,'sample'),env)).status,200);
});
test('preview route works independently of Stripe; submission does not exist',async()=>{
  const p=await worker.fetch(req('/workforce/preview','POST',{regularMinutes:2400,overtimeMinutes:300,hourlyCents:2000},'sample'),env);
  assert.equal(p.status,200);
  assert.equal((await p.json()).grossCents,95000);
  assert.equal((await worker.fetch(req('/workforce/submit','POST',{},'sample'),env)).status,404);
  assert.equal((await worker.fetch(req('/workforce/preview','GET',undefined,'sample'),env)).status,405);
});
test('agent tool call is authenticated, allowlisted and unable to submit',async()=>{
  const call=(name,args={})=>req('/workforce/tools/call','POST',{name,arguments:args},'sample');
  assert.equal((await worker.fetch(call('workforce_overview'),env)).status,200);
  assert.equal((await worker.fetch(call('submit_payroll'),env)).status,400);
  assert.equal((await worker.fetch(call('workforce_overview',{employeeId:'real-person'}),env)).status,400);
});
test('workforce refuses non-JSON and oversized request bodies',async()=>{
  const malformed=new Request('https://jusspay.invalid/workforce/preview',{method:'POST',headers:{authorization:'Bearer sample'},body:'not json'});
  assert.equal((await worker.fetch(malformed,env)).status,400);
  assert.equal((await worker.fetch(req('/workforce/preview','POST',{padding:'x'.repeat(5000)},'sample'),env)).status,413);
});
