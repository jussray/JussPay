import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateGrossExample} from '../src/payroll-rules.mjs';

test('gross example exposes exact regular and overtime components before rounding',()=>{
 const p=calculateGrossExample({regularMinutes:2400,overtimeMinutes:300,hourlyCents:2000});
 assert.deepEqual(p.calculation,{regularNumerator:'9600000',overtimeNumerator:'1800000',denominator:120,rounding:'half_up_total'});
 assert.equal(p.grossCents,95000);
});
test('fractional-cent components reconcile to the rounded total without double rounding',()=>{
 const p=calculateGrossExample({regularMinutes:1,overtimeMinutes:1,hourlyCents:1999});
 const c=p.calculation;
 assert.equal(Number((BigInt(c.regularNumerator)+BigInt(c.overtimeNumerator)+60n)/BigInt(c.denominator)),p.grossCents);
 assert.equal(p.grossCents,83);
});
test('zero minutes produce an auditable zero amount and never a payable record',()=>{
 const p=calculateGrossExample({regularMinutes:0,overtimeMinutes:0,hourlyCents:1});
 assert.equal(p.calculation.regularNumerator,'0');assert.equal(p.calculation.overtimeNumerator,'0');
 assert.equal(p.grossCents,0);assert.equal(p.submittable,false);assert.equal(p.taxCents,null);
});
