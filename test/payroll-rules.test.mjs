import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateGrossExample, EXAMPLE_RULE_VERSION} from '../src/payroll-rules.mjs';
const input={regularMinutes:2400,overtimeMinutes:300,hourlyCents:2000};
test('versioned gross example is exact and non-submittable',()=>{const r=calculateGrossExample(input);assert.equal(r.grossCents,95000);assert.equal(r.ruleVersion,EXAMPLE_RULE_VERSION);assert.equal(r.submittable,false);assert.equal(r.netCents,null);assert.equal(r.taxCents,null);});
test('rounds once in integer cents',()=>{assert.equal(calculateGrossExample({regularMinutes:1,overtimeMinutes:1,hourlyCents:1999}).grossCents,83);});
test('rejects unsupported rule versions and extra fields',()=>{for(const b of [{...input,ruleVersion:'live'},{...input,employeeId:'real'},{...input,hourlyCents:0},{...input,regularMinutes:-1},{...input,overtimeMinutes:7681},{...input,regularMinutes:1.5}])assert.throws(()=>calculateGrossExample(b),{status:400});});
test('maximum allowed integer arithmetic stays exact',()=>{assert.equal(calculateGrossExample({regularMinutes:2400,overtimeMinutes:7680,hourlyCents:1000000}).grossCents,232000000);});
