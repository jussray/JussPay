// Adapted from PR #1 test/subscriptions.test.mjs by the 2026-11-05 design merge.
// Scenarios and assertions are PR #1's; the plumbing changed: orders now live in the
// subject's BillingAccount Durable Object (test/harness.mjs) instead of a D1 fake,
// webhooks arrive at the core /webhook endpoint, and invoice/subscription fixtures
// carry the customer id the core webhook pipeline requires. See docs/DESIGN-MERGE.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import worker from '../src/worker.mjs';
import {TEST_PLANS,priceMatches,subscriptionMatches} from '../src/subscriptions.mjs';
import {combinedEnv,withFetch,WEBHOOK_SECRET} from './harness.mjs';

async function subsEnv(plan='two'){
  const h=combinedEnv({subject:'customer_1'});
  const p=TEST_PLANS[plan];
  await h.seedOrder({id:'purchase_123',product_id:p.product_id,merchant_id:p.merchant_id,customer_id:'customer_1',currency:p.currency,amount_total:p.amount,session_id:null,status:'pending',plan,price_id:null,subscription_id:null,stripe_customer_id:null,subscription_state:'pending'});
  return h;
}
const request=(path,method='POST',body={plan:'two',purchase_id:'purchase_123'},auth=true)=>
  new Request('https://pay.example'+path,{method,headers:{'content-type':'application/json',...(auth?{authorization:'Bearer <redacted>'}:{})},...(method!=='GET'?{body:JSON.stringify(body)}:{})});
const statusRequest=()=>request('/subscriptions/status?purchase_id=purchase_123','GET');
const info=p=>({id:p.price_id,product:p.stripe_product_id,active:true,livemode:false,
  type:'recurring',currency:p.currency,unit_amount:p.amount,
  recurring:{interval:'month',interval_count:1,usage_type:'licensed'}});
const session=p=>({id:'cs_test_123',url:'https://checkout.stripe.com/c/pay/test',mode:'subscription',
  livemode:false,payment_status:'paid',currency:p.currency,amount_total:p.amount,
  client_reference_id:'purchase_123',customer:'cus_test_123',subscription:'sub_test_123',
  metadata:{purchase_id:'purchase_123',product_id:p.product_id,merchant_id:p.merchant_id}});
const lineItems=p=>({has_more:false,data:[{price:{id:p.price_id,type:'recurring'},quantity:1,amount_total:p.amount,currency:p.currency}]});
const activeSubscription=p=>({id:'sub_test_123',customer:'cus_test_123',livemode:false,status:'active',
  items:{data:[{price:{id:p.price_id,currency:p.currency,unit_amount:p.amount},quantity:1}]}});
function mockStripe(p,{wrongPrice=false,wrongLine=false,wrongSubscription=false}={}){
  const seen=[];
  const fetch=async (url,options={})=>{
    seen.push(String(url));
    if(String(url).includes('/prices/'))return Response.json({...info(p),unit_amount:wrongPrice?5:p.amount});
    if(String(url).endsWith('/checkout/sessions')&&options.method==='POST'){
      const form=new URLSearchParams(options.body.toString());
      assert.equal(form.get('mode'),'subscription');
      assert.equal(form.get('line_items[0][price]'),p.price_id);
      assert.equal(form.get('line_items[0][quantity]'),'1');
      assert.equal(form.get('customer_email'),null);
      return Response.json(session(p));
    }
    if(String(url).endsWith('/line_items?limit=10'))return Response.json({
      ...lineItems(p),data:[{...lineItems(p).data[0],amount_total:wrongLine?1:p.amount}]
    });
    if(String(url).includes('/subscriptions/'))return Response.json({
      ...activeSubscription(p),status:wrongSubscription?'past_due':'active'
    });
    if(String(url).includes('/checkout/sessions/'))return Response.json(session(p));
    throw new Error('Unexpected provider call: '+url);
  };
  return {fetch,seen};
}
async function sign(event,secret=WEBHOOK_SECRET){
  const raw=JSON.stringify(event),t=Math.floor(Date.now()/1000);
  return new Request('https://pay.example/webhook',{method:'POST',
    headers:{'stripe-signature':'t='+t+',v1='+createHmac('sha256',secret).update(t+'.'+raw).digest('hex')},body:raw});
}
const completion=p=>({id:'evt_123',livemode:false,type:'checkout.session.completed',
  data:{object:session(p)}});
function signedEvent(type,object){return sign({id:'evt_'+type,livemode:false,type,data:{object}});}

test('both approved recurring prices match their Stripe test catalog amounts',()=>{
  assert.equal(TEST_PLANS.one.amount,499);
  assert.equal(TEST_PLANS.two.amount,1900);
  for(const plan of Object.values(TEST_PLANS)){
    assert.equal(priceMatches(info(plan),plan),true);
    assert.equal(priceMatches({...info(plan),livemode:true},plan),false);
    assert.equal(priceMatches({...info(plan),recurring:{interval:'year',interval_count:1}},plan),false);
    assert.equal(priceMatches({...info(plan),unit_amount:1},plan),false);
    assert.equal(priceMatches({...info(plan),product:'prod_other'},plan),false);
  }
});

test('sandbox subscription checkout fails closed without gate, sandbox key or authenticated account',async()=>{
  const h=await subsEnv();const e=h.env;
  e.SUBSCRIPTIONS_TEST_ENABLED='false';
  assert.equal((await worker.fetch(request('/subscriptions/checkout'),e)).status,503);
  e.SUBSCRIPTIONS_TEST_ENABLED='true';e.STRIPE_SECRET_KEY='sk_live_FAKE';
  assert.equal((await worker.fetch(request('/subscriptions/checkout'),e)).status,503);
  e.STRIPE_SECRET_KEY='sk_test_FAKE';
  assert.equal((await worker.fetch(request('/subscriptions/checkout','POST',{plan:'two',purchase_id:'purchase_123'},false),e)).status,401);
  const wrong=combinedEnv({subject:'customer_2'}).env;
  assert.equal((await worker.fetch(request('/subscriptions/checkout'),wrong)).status,403);
  assert.equal((await worker.fetch(statusRequest(),wrong)).status,404);
});

test('first sandbox subscription checkout binds the customer to the authenticated subject before opening Checkout',async()=>{
  const h=await subsEnv('two'),e=h.env,p=TEST_PLANS.two,mock=mockStripe(p);
  const original=e.STRIPE_FETCH;
  let customerCreates=0;
  e.STRIPE_FETCH=async(url,options={})=>{
    if(String(url).endsWith('/v1/customers')&&options.method==='POST'){
      const form=new URLSearchParams(options.body.toString());
      assert.equal(form.get('metadata[jusspay_subject]'),'customer_1');
      customerCreates++;
      return Response.json({id:'cus_test_123',livemode:false,metadata:{jusspay_subject:'customer_1'}});
    }
    return original(url,options);
  };
  await withFetch(async(url,options={})=>{
    if(String(url).endsWith('/checkout/sessions')&&options.method==='POST'){
      const form=new URLSearchParams(options.body.toString());
      assert.equal(form.get('customer'),'cus_test_123');
    }
    return mock.fetch(url,options);
  },async()=>{
    const response=await worker.fetch(request('/subscriptions/checkout'),e);
    assert.equal(response.status,200);
  });
  assert.equal(customerCreates,1);
  assert.equal(await h.state.storage.get('customer'),'cus_test_123');
});

test('Model One and Two approved price creates only an authenticated test subscription checkout',async()=>{
  for(const name of ['one','two']){
    const h=await subsEnv(name),e=h.env,p=TEST_PLANS[name],mock=mockStripe(p);
    await withFetch(mock.fetch,async()=>{
      const start=await worker.fetch(request('/subscriptions/checkout','POST',{plan:name,purchase_id:'purchase_123'}),e);
      assert.equal(start.status,200);
      const data=await start.json();
      assert.equal(data.checkout_url,'https://checkout.stripe.com/c/pay/test');
      assert.equal(data.monthly_amount_minor,p.amount);
      assert.equal(data.test_mode,true);
      const state=await (await worker.fetch(statusRequest(),e)).json();
      assert.equal(state.billing_state,'pending');
      assert.equal(state.test_mode,true);
    });
    assert.equal((await h.getOrder('purchase_123')).price_id,p.price_id);
  }
});

test('a changed price or unrelated plan cannot initiate a checkout',async()=>{
  const h=await subsEnv(),e=h.env,p=TEST_PLANS.two,mock=mockStripe(p,{wrongPrice:true});
  await withFetch(mock.fetch,async()=>{
    const result=await worker.fetch(request('/subscriptions/checkout'),e);
    assert.equal(result.status,503);
    assert.equal((await result.json()).error,'approved_monthly_price_mismatch');
  });
  assert.equal(mock.seen.some(u=>u.endsWith('/checkout/sessions')),false);
  assert.equal((await worker.fetch(request('/subscriptions/checkout','POST',{plan:'one',purchase_id:'purchase_123'}),e)).status,403);
});

test('signed and provider-verified subscription activates billing state once, then fails closed on failure/cancel',async()=>{
  const h=await subsEnv(),e=h.env,p=TEST_PLANS.two,mock=mockStripe(p);
  await withFetch(mock.fetch,async()=>{
    assert.equal((await worker.fetch(request('/subscriptions/checkout'),e)).status,200);
    const webhook=await sign(completion(p));
    assert.equal((await worker.fetch(webhook,e)).status,200);
    assert.equal((await worker.fetch(await sign(completion(p)),e)).status,200);
    assert.equal((await (await worker.fetch(statusRequest(),e)).json()).billing_state,'active');
    assert.equal((await h.getOrder('purchase_123')).subscription_id,'sub_test_123');
    assert.equal((await worker.fetch(await signedEvent('invoice.payment_failed',{subscription:'sub_test_123',customer:'cus_test_123'}),e)).status,200);
    assert.equal((await (await worker.fetch(statusRequest(),e)).json()).billing_state,'past_due');
    assert.equal((await worker.fetch(await signedEvent('invoice.paid',{subscription:'sub_test_123',customer:'cus_test_123',paid:true,amount_paid:1900,currency:'usd'}),e)).status,200);
    assert.equal((await (await worker.fetch(statusRequest(),e)).json()).billing_state,'active');
    assert.equal((await worker.fetch(await signedEvent('customer.subscription.deleted',{id:'sub_test_123',customer:'cus_test_123'}),e)).status,200);
    assert.equal((await (await worker.fetch(statusRequest(),e)).json()).billing_state,'canceled');
    assert.equal((await worker.fetch(await sign(completion(p)),e)).status,200);
    assert.equal((await (await worker.fetch(statusRequest(),e)).json()).billing_state,'canceled');
  });
});

test('unverified subscription price, state, mode, or signature never activates membership',async()=>{
  for(const bad of [{wrongLine:true},{wrongSubscription:true}]){
    const h=await subsEnv(),e=h.env,p=TEST_PLANS.two,mock=mockStripe(p,bad);
    await withFetch(mock.fetch,async()=>{
      assert.equal((await worker.fetch(request('/subscriptions/checkout'),e)).status,200);
      const result=await worker.fetch(await sign(completion(p)),e);
      assert.equal(result.status,409);
      assert.equal((await (await worker.fetch(statusRequest(),e)).json()).billing_state,'pending');
    });
  }
  const h=await subsEnv(),e=h.env,p=TEST_PLANS.two,mock=mockStripe(p);
  await withFetch(mock.fetch,async()=>{
    assert.equal((await worker.fetch(request('/subscriptions/checkout'),e)).status,200);
    const forged=completion(p);forged.data.object.amount_total=1;
    assert.equal((await worker.fetch(await sign(forged),e)).status,409);
    assert.equal((await worker.fetch(await sign(completion(p),'wrongsecret'),e)).status,400);
    assert.equal((await (await worker.fetch(statusRequest(),e)).json()).billing_state,'pending');
  });
});

test('a paid subscription is not a completed Protect Me activation without downstream authorization',async()=>{
  const h=await subsEnv(),e=h.env,p=TEST_PLANS.two,mock=mockStripe(p);
  await withFetch(mock.fetch,async()=>{
    assert.equal((await worker.fetch(request('/subscriptions/checkout'),e)).status,200);
    assert.equal((await worker.fetch(await sign(completion(p)),e)).status,200);
    const status=await (await worker.fetch(statusRequest(),e)).json();
    assert.equal(status.billing_state,'active');
    assert.equal('api_key' in status,false);
    assert.equal('protection_active' in status,false);
  });
});

test('verified customer can create a server-priced order once, without supplying price or customer id',async()=>{
  const h=combinedEnv({subject:'customer_1'}),e=h.env;
  const first=await worker.fetch(request('/subscriptions/orders','POST',{plan:'one',amount:1,customer_id:'attacker'}),e);
  assert.equal(first.status,201);
  const body=await first.json();
  assert.match(body.purchase_id,/^purchase_[a-f0-9]{32}$/);
  assert.equal(body.amount_minor,499);
  const stored=await h.getOrder(body.purchase_id);
  assert.equal(stored.customer_id,'customer_1');
  assert.equal(stored.amount_total,499);
  assert.equal(stored.price_id,TEST_PLANS.one.price_id);
  assert.equal(stored.plan,'one');
  assert.equal(stored.subscription_state,'pending');
  const again=await worker.fetch(request('/subscriptions/orders','POST',{plan:'one'}),e);
  assert.equal((await again.json()).purchase_id,body.purchase_id);
  assert.equal((await h.billing.orderStore().listOrders()).filter(r=>r.plan==='one').length,1);
});
test('another customer cannot read or reuse a pending order or claim entitlement',async()=>{
 const h=await subsEnv('two');
 const different=combinedEnv({subject:'customer_2'}).env;
 const status=await worker.fetch(statusRequest(),different);
 assert.equal(status.status,404);
 const ent=await worker.fetch(request('/subscriptions/entitlement?plan=two','GET'),different);
 assert.equal(ent.status,200);
 assert.equal((await ent.json()).billing_active,false);
 const unauthorized=await worker.fetch(request('/subscriptions/orders','POST',{plan:'one'},false),h.env);
 assert.equal(unauthorized.status,401);
});
test('membership billing entitlement never implies installed or connected protection',async()=>{
 const h=await subsEnv(),e=h.env,p=TEST_PLANS.two,mock=mockStripe(p);
 const before=await (await worker.fetch(request('/subscriptions/entitlement?plan=two','GET'),e)).json();
 assert.equal(before.billing_active,false);
 await withFetch(mock.fetch,async()=>{
   assert.equal((await worker.fetch(request('/subscriptions/checkout'),e)).status,200);
   assert.equal((await worker.fetch(await sign(completion(p)),e)).status,200);
 });
 const paid=await (await worker.fetch(request('/subscriptions/entitlement?plan=two','GET'),e)).json();
 assert.equal(paid.billing_active,true);
 assert.equal(paid.service_activation,'not_verified');
 assert.equal('api_key' in paid,false);
 assert.equal('protection_active' in paid,false);
 assert.equal((await (await worker.fetch(request('/subscriptions/entitlement?plan=one','GET'),e)).json()).billing_active,false);
 await worker.fetch(await signedEvent('customer.subscription.deleted',{id:'sub_test_123',customer:'cus_test_123'}),e);
 const canceled=await (await worker.fetch(request('/subscriptions/entitlement?plan=two','GET'),e)).json();
 assert.equal(canceled.billing_active,false);
});
test('membership uniqueness invariant holds in Durable Object storage (adapted from the D1 unique-index proof)',async()=>{
 const h=combinedEnv({subject:'customer_1'}),e=h.env;
 // The DO fetch tail serializes both creations; exactly one order may exist afterwards.
 const [a,b]=await Promise.all([
   worker.fetch(request('/subscriptions/orders','POST',{plan:'one'}),e),
   worker.fetch(request('/subscriptions/orders','POST',{plan:'one'}),e)
 ]);
 const ids=new Set([(await a.json()).purchase_id,(await b.json()).purchase_id]);
 assert.equal(ids.size,1);
 assert.equal((await h.billing.orderStore().listOrders()).filter(r=>r.plan==='one').length,1);
});

test('malformed plan name and oversized payload fail closed rather than inheriting object properties',async()=>{
  const h=await subsEnv(),e=h.env;
  const malicious=await worker.fetch(request('/subscriptions/orders','POST',{plan:'__proto__'}),e);
  assert.equal(malicious.status,400);
  const badEnt=await worker.fetch(request('/subscriptions/entitlement?plan=constructor','GET'),e);
  assert.equal(badEnt.status,400);
  const huge=await worker.fetch(request('/subscriptions/orders','POST',{plan:'one',note:'x'.repeat(3000)}),e);
  assert.equal(huge.status,413);
});
