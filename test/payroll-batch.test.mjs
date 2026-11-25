import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDemoBatch } from '../src/payroll-batch.mjs';
const row=(id,status='approved',regularMinutes=1,hourlyCents=30)=>({id,status,regularMinutes,overtimeMinutes:0,hourlyCents});
test('rounds each example independently and reconciles the batch to its lines',()=>{
 const r=calculateDemoBatch([row('example-1'),row('example-2'),row('example-3','pending')]);
 assert.equal(r.grossCents,2);assert.equal(r.includedCount,2);assert.equal(r.excludedCount,1);
 assert.deepEqual(r.lines.map(l=>[l.exampleId,l.grossCents]),[['example-1',1],['example-2',1]]);
 assert.equal(r.submittable,false);assert.equal(r.netCents,null);assert.equal(r.taxCents,null);
});
test('zero approvals yield no payroll lines and no payable amount',()=>{
 const r=calculateDemoBatch([row('example-1','pending')]);assert.deepEqual(r.lines,[]);assert.equal(r.grossCents,0);
});
test('rejects duplicate IDs, non-demo IDs, extra data and invalid status',()=>{
 for(const rows of [[row('example-1'),row('example-1')],[row('real-worker')],[{...row('example-1'),name:'person'}],[row('example-1','paid')]])assert.throws(()=>calculateDemoBatch(rows),{status:400});
});
test('validates even excluded time records and never rounds a total twice',()=>{
 assert.throws(()=>calculateDemoBatch([row('example-1','pending',-1)]),{status:400});
 const r=calculateDemoBatch([row('example-1','approved',2400,2000)]);assert.equal(r.grossCents,80000);assert.equal(r.lines[0].calculation.regularNumerator,'9600000');
});
