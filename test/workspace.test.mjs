import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeWorkspace, demoWorkspace, demoPayroll, workspaceToolDefinitions, callWorkspaceTool} from '../src/workforce-workspace.mjs';
const envFor=(grant)=>({WORKFORCE_ACCESS:{fetch:async request=>{assert.deepEqual(await request.json(),{subject:'u1',audience:'jusspay-workforce'});return Response.json(grant);}}});
const grant={subject:'u1',audience:'jusspay-workforce',companyId:'demo-company',role:'payroll_admin',expiresAt:Date.now()/1000+60};
test('missing service, mismatched subject, expiry and unknown role are denied',async()=>{
 await assert.rejects(authorizeWorkspace({},'u1'),{status:503});
 for(const change of [{subject:'u2'},{expiresAt:0},{role:'employee'},{audience:'jusspay'},{companyId:''}]) await assert.rejects(authorizeWorkspace(envFor({...grant,...change}),'u1'),{status:403});
});
test('company authority is derived from trusted service and never echoed in demo data',async()=>{
 const access=await authorizeWorkspace(envFor(grant),'u1');assert.equal(access.companyId,'demo-company');assert.equal(access.role,'payroll_admin');
 assert.equal(JSON.stringify(demoWorkspace(access)).includes('demo-company'),false);
});
test('demo workspace includes fictional people and approved time only',()=>{
 const view=demoWorkspace(grant);assert.equal(view.mode,'synthetic_preview');assert.equal(view.people.length,3);assert.equal(view.timesheets.filter(t=>t.status==='approved').length,2);assert.equal(view.providerConnected,false);
});
test('payroll preview excludes unapproved time and never submits',()=>{
 const p=demoPayroll(grant);assert.equal(p.grossCents,161000);assert.equal(p.includedCount,2);assert.equal(p.excludedCount,1);assert.equal(p.submittable,false);assert.equal(p.netCents,null);
});
test('reviewer cannot preview payroll',()=>{assert.throws(()=>demoPayroll({...grant,role:'reviewer'}),{status:403});});
test('agent tools are role-scoped and reject extra parameters or submission',()=>{
 assert.deepEqual(workspaceToolDefinitions({...grant,role:'reviewer'}).map(t=>t.name),['workforce_demo_overview']);
 assert.equal(callWorkspaceTool(grant,'workforce_demo_payroll',{}).grossCents,161000);
 assert.throws(()=>callWorkspaceTool(grant,'workforce_demo_payroll',{companyId:'other'}),{status:400});
 assert.throws(()=>callWorkspaceTool(grant,'submit_payroll',{}),{status:404});
});
