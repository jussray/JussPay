import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const key='tw-sandbox-fixture-'+ 'x'.repeat(40);
const account='acct_1U4xNyRs4gw4sfJH';
const claim={offerKey:'snapshot',userId:'11111111-1111-4111-8111-111111111111',
  analysisId:'22222222-2222-4222-8222-222222222222',claimNonce:'a'.repeat(43)};
const session={id:'cs_test_fixture',url:'https://checkout.stripe.com/c/pay/cs_test_fixture#opaque',mode:'payment',
  livemode:false,automatic_tax:{enabled:true,status:'requires_location_inputs'},currency:'usd',amount_subtotal:1000,amount_total:1000};
function fixture(patch={},acct={id:account,charges_enabled:true}){
 const calls=[];
 const env={STRIPE_LIVE:'false',TW_SANDBOX_CHECKOUT_ENABLED:'true',TW_SANDBOX_CHECKOUT_SERVICE_KEY:key,
   TW_SANDBOX_STRIPE_KEY:'rk_test_fixture',TW_STRIPE_API_VERSION:'fixture',
   STRIPE_FETCH:async(url,init)=>{calls.push({path:new URL(url).pathname,...init});return Response.json(calls.at(-1).path==='/v1/account'?acct:{...session,...patch});}};
 const request=(body=claim,auth=key)=>new Request('https://pay.example/truthweaver/sandbox/checkout',{method:'POST',
   headers:{'x-tw-sandbox-checkout-key':auth,'content-type':'application/json'},body:JSON.stringify(body)});
 return {env,request,calls};
}
test('JussPay creates only the exact USD sandbox Snapshot, with automatic tax and a stable retry idempotency key',async()=>{
 const h=fixture();
 for(let i=0;i<2;i++){
  const r=await worker.fetch(h.request(),h.env);
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{schema:'jusspay/truthweaver-sandbox-checkout@v1',sessionId:session.id,url:session.url});
 }
 assert.deepEqual(h.calls.map(x=>[x.path,x.method]),[['/v1/account','GET'],['/v1/checkout/sessions','POST'],['/v1/account','GET'],['/v1/checkout/sessions','POST']]);
 const a=h.calls[1],b=h.calls[3];
 assert.match(a.headers['Idempotency-Key'],/^tw-snapshot-sandbox:[a-f0-9]{64}$/);
 assert.equal(a.headers['Idempotency-Key'],b.headers['Idempotency-Key']);
 assert.equal(a.body.get('automatic_tax[enabled]'),'true');
 assert.equal(a.body.get('line_items[0][price_data][unit_amount]'),'1000');
 assert.equal(a.body.get('line_items[0][price_data][tax_behavior]'),'inclusive');
 assert.equal(a.body.get('metadata[claimNonce]'),claim.claimNonce);
 assert.equal(a.body.get('customer_email'),null);
});
test('wrong secret, cross-purpose secret, unset gate, live environment, live key and extra fields do not contact Stripe',async()=>{
 const h=fixture();
 assert.equal((await worker.fetch(h.request(claim,'wrong'),h.env)).status,401);
 for(const [patch,status] of [[{TW_REPORT_SERVICE_KEY:key},401],[{TW_SANDBOX_CHECKOUT_ENABLED:'false'},503],
 [{STRIPE_LIVE:'true'},503],[{TW_SANDBOX_STRIPE_KEY:'rk_live_fixture'},503]]){
  assert.equal((await worker.fetch(h.request(),{...h.env,...patch})).status,status);
 }
 for(const bad of [{...claim,offerKey:'bundle'},{...claim,successUrl:'https://other.example/'},{...claim,claimNonce:'bad'},{...claim,amount:1}]){
  assert.equal((await worker.fetch(h.request(bad),h.env)).status,400);
 }
 assert.equal(h.calls.length,0);
});
test('wrong merchant cannot create; live, off-origin or wrongly priced responses are not returned',async()=>{
 const wrong=fixture({}, {id:'acct_wrong',charges_enabled:true});
 assert.equal((await worker.fetch(wrong.request(),wrong.env)).status,503);
 assert.deepEqual(wrong.calls.map(x=>x.method),['GET']);
 for(const override of [{livemode:true},{url:'https://other.example/c/pay/cs_test_fixture'},{url:'https://checkout.stripe.com/c/pay/cs_test_another'},
 {amount_total:1040},{automatic_tax:{enabled:false}}]){
  const h=fixture(override);assert.equal((await worker.fetch(h.request(),h.env)).status,502);
 }
});
