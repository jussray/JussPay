import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const key='monitor-'+ 'm'.repeat(40);
const owner='owner-'+ 'o'.repeat(40);
const base={JBH_MONITOR_KEY:key,JBH_OWNER_KEY:owner,JBH_STRIPE_LIVE:'true',JBH_LIVE_CHARGES_APPROVED:'false',RELEASE_SHA:'a'.repeat(40),STRIPE_FETCH:()=>{throw Error('unexpected provider call')},JBH_ORDERS:{get(){throw Error('unexpected order book access')}}};
const req=(path='/jbh/monitoring-preflight',headers={},method='GET')=>new Request('https://pay.example'+path,{headers,method});

test('monitoring receipt reports configuration blockers without authority or provider claims',async()=>{
 const res=await worker.fetch(req(undefined,{'x-jbh-monitor-key':key}),base);
 assert.equal(res.status,503);
 assert.equal(res.headers.get('cache-control'),'no-store');
 const body=await res.json();
 assert.equal(body.schema,'jusspay/jbh-monitoring-preflight@v1');
 assert.equal(body.releaseSha,'a'.repeat(40));
 assert.equal(body.ready,false);
 assert.equal(body.providerVerified,false);
 assert.equal(body.chargesCollected,false);
 assert.equal(body.orderDispatched,false);
 assert.ok(body.blockers.includes('live_approval_missing'));
 assert.ok(body.blockers.includes('catalog_empty'));
 assert.equal(JSON.stringify(body).includes(key),false);
});
test('monitoring is disabled without a distinct configured credential',async()=>{
 for(const env of [{...base,JBH_MONITOR_KEY:undefined},{...base,JBH_MONITOR_KEY:owner},{...base,JBH_MONITOR_KEY:'short'}]){
 const res=await worker.fetch(req(undefined,{'x-jbh-monitor-key':env.JBH_MONITOR_KEY||key}),env);
 assert.equal(res.status,401);
 }
});
test('monitor key cannot use owner-only preflight or mutate state',async()=>{
 assert.equal((await worker.fetch(req(),base)).status,401);
 assert.equal((await worker.fetch(req(undefined,{'x-jbh-monitor-key':key},'POST'),base)).status,405);
 assert.equal((await worker.fetch(req('/jbh/preflight',{'x-jbh-owner-key':key}),base)).status,401);
});
