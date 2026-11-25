import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeWorkspace,demoWorkspace,demoPayroll,callWorkspaceTool} from '../src/workforce-workspace.mjs';
const access={companyId:'demo-company',role:'payroll_admin'};
const grant={...access,subject:'u1',audience:'jusspay-workforce',expiresAt:Date.now()/1000+60};
const binding=(response)=>({WORKFORCE_ACCESS:{fetch:async()=>response}});
test('malformed subjects never reach the private authority',async()=>{
 let calls=0;const env={WORKFORCE_ACCESS:{fetch:async()=>{calls++;return Response.json(grant);}}};
 for(const subject of [undefined,null,'',' ',' u1','u1 ','x'.repeat(201),42])await assert.rejects(authorizeWorkspace(env,subject),{status:401});
 assert.equal(calls,0);
});
test('authority outage is not reported as membership denial',async()=>{
 for(const status of [429,500,503])await assert.rejects(authorizeWorkspace(binding(Response.json({}, {status})),'u1'),{status:503});
 await assert.rejects(authorizeWorkspace(binding(Response.json({}, {status:403})),'u1'),{status:403});
 assert.deepEqual(await authorizeWorkspace(binding(Response.json(grant)),'u1'),access);
});
test('reviewer overview does not disclose compensation inputs',()=>{
 const reviewer={...access,role:'reviewer'};
 for(const view of [demoWorkspace(reviewer),callWorkspaceTool(reviewer,'workforce_demo_overview',{})]){
  assert.equal(view.canPreview,false);assert.equal(view.timesheets.length,3);assert.ok(view.timesheets.every(row=>!Object.hasOwn(row,'hourlyCents')));
 }
 assert.ok(demoWorkspace(access).timesheets.every(row=>Object.hasOwn(row,'hourlyCents')));
});
test('batch totals and lines reconcile after approval changes',()=>{
 const snap={version:1,timesheets:['example-1','example-2','example-3'].map(exampleId=>({exampleId,status:'approved'}))};
 const p=demoPayroll(access,snap);assert.equal(p.grossCents,201000);assert.equal(p.grossCents,p.lines.reduce((s,line)=>s+line.grossCents,0));assert.equal(p.ledgerVersion,1);assert.deepEqual(callWorkspaceTool(access,'workforce_demo_payroll',{},snap),p);
});
