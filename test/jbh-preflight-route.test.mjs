import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
test('owner-only JBH preflight cannot create orders or call providers',async()=>{
 const key='test-owner-'+ 'a'.repeat(40);
 const env={JBH_OWNER_KEY:key,JBH_STRIPE_LIVE:'true',JBH_LIVE_CHARGES_APPROVED:'false',STRIPE_FETCH:()=>{throw Error('unexpected provider call')},JBH_ORDERS:{get(){throw Error('unexpected order book access')}}};
 const request=(headers={},method='GET')=>new Request('https://pay.example/jbh/preflight',{headers,method});
 const unauthorized=await worker.fetch(request(),env);assert.equal(unauthorized.status,401);
 const method=await worker.fetch(request({'x-jbh-owner-key':key},'POST'),env);assert.equal(method.status,405);
 const response=await worker.fetch(request({'x-jbh-owner-key':key}),env);assert.equal(response.status,503);
 const body=await response.json();assert.equal(body.ready,false);assert.equal(body.chargesCollected,false);assert.equal(body.orderDispatched,false);assert.ok(body.blockers.includes('live_approval_missing'));assert.ok(body.blockers.includes('catalog_empty'));
});
