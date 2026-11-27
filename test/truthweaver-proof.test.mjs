import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const key='tw-monitor-'+ 'x'.repeat(40);
const sessionId='cs_live_testSession123';
const userId='11111111-1111-4111-8111-111111111111';
const analysisId='22222222-2222-4222-8222-222222222222';
const claimNonce='a'.repeat(43);
const account='acct_1U4xNyRs4gw4sfJH';
function fixture(changes={},accountId=account){
 const calls=[];
 const charge={id:'ch_live123',livemode:true,paid:true,refunded:false,disputed:false,amount:1000,amount_refunded:0,currency:'usd',payment_intent:'pi_live123'};
 const session={id:sessionId,livemode:true,mode:'payment',status:'complete',payment_status:'paid',currency:'usd',amount_subtotal:1000,amount_total:1000,created:1795780000,metadata:{offerKey:'snapshot',sku:'TW-SNAPSHOT-ONE',userId,analysisId,claimNonce,stripeAccount:account},payment_intent:{id:'pi_live123',livemode:true,status:'succeeded',currency:'usd',amount_received:1000,latest_charge:charge},...changes};
 const env={TW_REPORT_VERIFICATION_ENABLED:'true',TW_REPORT_SERVICE_KEY:key,TW_STRIPE_READ_KEY:'rk_live_fixture',TW_STRIPE_API_VERSION:'test-only',STRIPE_FETCH:async(url,init)=>{calls.push({url,method:init.method});return Response.json(new URL(url).pathname==='/v1/account'?{id:accountId}:session);}};
 const req=(provided=key,id=sessionId)=>new Request('https://pay.example/truthweaver/verify-paid',{method:'POST',headers:{'content-type':'application/json','x-tw-service-key':provided},body:JSON.stringify({sessionId:id})});
 return {env,req,calls,session};
}
test('central TruthWeaver proof verifies the exact merchant and paid unrefunded charge without issuing payment',async()=>{
 const h=fixture();const res=await worker.fetch(h.req(),h.env);
 assert.equal(res.status,200);const body=await res.json();
 assert.deepEqual(body,{schema:'jusspay/truthweaver-paid-proof@v1',paid:true,sessionId,offerKey:'snapshot',userId,analysisId,claimNonce,amountTotalMinor:1000,currency:'usd',createdAt:new Date(1795780000*1000).toISOString()});
 assert.equal(h.calls.length,2);assert.ok(h.calls.every(c=>c.method==='GET'));
 assert.equal(JSON.stringify(body).includes('rk_live_'),false);
});
test('central proof rejects unauthorized, disabled and sandbox requests before Stripe',async()=>{
 const h=fixture();
 assert.equal((await worker.fetch(h.req('wrong'),h.env)).status,401);
 assert.equal((await worker.fetch(h.req(key,'cs_test_wrong'),h.env)).status,400);
 assert.equal((await worker.fetch(h.req(),{...h.env,TW_REPORT_VERIFICATION_ENABLED:'false'})).status,503);
 assert.equal(h.calls.length,0);
});
test('central proof denies wrong merchant, unpaid, refund, dispute, wrong SKU and invalid claim',async()=>{
 const wrong=fixture({},'acct_wrong');assert.equal((await worker.fetch(wrong.req(),wrong.env)).status,503);
 for(const change of ['unpaid','refund','dispute','sku','claim','amount','mode']){
   const h=fixture();
   if(change==='unpaid')h.session.payment_status='unpaid';
   if(change==='refund')h.session.payment_intent.latest_charge.amount_refunded=1;
   if(change==='dispute')h.session.payment_intent.latest_charge.disputed=true;
   if(change==='sku')h.session.metadata.sku='WRONG';
   if(change==='claim')h.session.metadata.claimNonce='bad';
   if(change==='amount')h.session.amount_total=1;
   if(change==='mode')h.session.livemode=false;
   const r=await worker.fetch(h.req(),h.env);assert.equal(r.status,409,change);
   assert.equal((await r.json()).paid,undefined);
 }
});
