import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import app from '../src/worker.mjs';
import {TEST_PLANS,priceMatches,subscriptionMatches} from '../src/subscriptions.mjs';

const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
class Orders {
  constructor(){this.db=new DatabaseSync(':memory:');this.db.exec(schema);}
  prepare(sql){const db=this.db;return{bind(...args){return{
    first:async()=>db.prepare(sql).get(...args),
    run:async()=>{const r=db.prepare(sql).run(...args);return{meta:{changes:r.changes}};}
  };}};}
  seed(plan='two'){
    const p=TEST_PLANS[plan];
    this.db.prepare("INSERT INTO orders(id,product_id,merchant_id,customer_id,currency,amount_total,status,plan) VALUES(?,?,?,?,?,?,'pending',?)")
      .run('purchase_123',p.product_id,p.merchant_id,'customer_1',p.currency,p.amount,plan);
  }
}
const env=(plan='two')=>{
  const ORDERS=new Orders();ORDERS.seed(plan);
  return {ORDERS,PAYMENTS_ENABLED:'true',SUBSCRIPTIONS_TEST_ENABLED:'true',
    CHECKOUT_AUTH_READY:'true',AUTH_SERVICE:{fetch:async()=>Response.json({subject:'customer_1'})},
    STRIPE_SECRET_KEY:'sk_test_FAKE',STRIPE_WEBHOOK_SECRET:'whsec_local',
    WEBHOOK_RECONCILIATION_READY:'true'};
};
const request=(path,method='POST',body={plan:'two',purchase_id:'purchase_123'},auth=true)=>
  new Request('https://pay.example'+path,{method,headers:{'content-type':'application/json',...(auth?{authorization:'Bearer valid_customer_token'}:{})},...(method!=='GET'?{body:JSON.stringify(body)}:{})});
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
async function sign(event,secret='whsec_local'){
  const raw=JSON.stringify(event),t=Math.floor(Date.now()/1000);
  return new Request('https://pay.example/stripe/webhook',{method:'POST',
    headers:{'stripe-signature':'t='+t+',v1='+createHmac('sha256',secret).update(t+'.'+raw).digest('hex')},body:raw});
}
const completion=p=>({id:'evt_123',livemode:false,type:'checkout.session.completed',
  data:{object:session(p)}});
function signedEvent(type,object){return sign({id:'evt_'+type,livemode:false,type,data:{object}});}
function withFetch(mock,fn){const before=globalThis.fetch;globalThis.fetch=mock;
  return Promise.resolve().then(fn).finally(()=>{globalThis.fetch=before});}

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
  const e=env();
  assert.equal((await app.fetch(request('/subscriptions/checkout'),{...e,SUBSCRIPTIONS_TEST_ENABLED:'false'})).status,503);
  assert.equal((await app.fetch(request('/subscriptions/checkout'),{...e,STRIPE_SECRET_KEY:'sk_live_FAKE'})).status,503);
  assert.equal((await app.fetch(request('/subscriptions/checkout','POST',{plan:'two',purchase_id:'purchase_123'},false),e)).status,401);
  const wrong={...e,AUTH_SERVICE:{fetch:async()=>Response.json({subject:'different'})}};
  assert.equal((await app.fetch(request('/subscriptions/checkout'),wrong)).status,403);
  assert.equal((await app.fetch(statusRequest(),wrong)).status,404);
});

test('Model One and Two approved price creates only an authenticated test subscription checkout',async()=>{
  for(const name of ['one','two']){
    const e=env(name),p=TEST_PLANS[name],mock=mockStripe(p);
    await withFetch(mock.fetch,async()=>{
      const start=await app.fetch(request('/subscriptions/checkout','POST',{plan:name,purchase_id:'purchase_123'}),e);
      assert.equal(start.status,200);
      const data=await start.json();
      assert.equal(data.checkout_url,'https://checkout.stripe.com/c/pay/test');
      assert.equal(data.monthly_amount_minor,p.amount);
      assert.equal(data.test_mode,true);
      const state=await (await app.fetch(statusRequest(),e)).json();
      assert.equal(state.billing_state,'pending');
      assert.equal(state.test_mode,true);
    });
    assert.equal(e.ORDERS.db.prepare("SELECT price_id FROM orders WHERE id='purchase_123'").get().price_id,p.price_id);
  }
});

test('a changed price or unrelated plan cannot initiate a checkout',async()=>{
  const e=env(),p=TEST_PLANS.two,mock=mockStripe(p,{wrongPrice:true});
  await withFetch(mock.fetch,async()=>{
    const result=await app.fetch(request('/subscriptions/checkout'),e);
    assert.equal(result.status,503);
    assert.equal((await result.json()).error,'approved_monthly_price_mismatch');
  });
  assert.equal(mock.seen.some(u=>u.endsWith('/checkout/sessions')),false);
  assert.equal((await app.fetch(request('/subscriptions/checkout','POST',{plan:'one',purchase_id:'purchase_123'}),e)).status,403);
});

test('signed and provider-verified subscription activates billing state once, then fails closed on failure/cancel',async()=>{
  const e=env(),p=TEST_PLANS.two,mock=mockStripe(p);
  await withFetch(mock.fetch,async()=>{
    assert.equal((await app.fetch(request('/subscriptions/checkout'),e)).status,200);
    const webhook=await sign(completion(p));
    assert.equal((await app.fetch(webhook,e)).status,200);
    assert.equal((await app.fetch(await sign(completion(p)),e)).status,200);
    assert.equal((await (await app.fetch(statusRequest(),e)).json()).billing_state,'active');
    assert.equal(e.ORDERS.db.prepare("SELECT subscription_id FROM orders WHERE id='purchase_123'").get().subscription_id,'sub_test_123');
    assert.equal((await app.fetch(await signedEvent('invoice.payment_failed',{subscription:'sub_test_123'}),e)).status,200);
    assert.equal((await (await app.fetch(statusRequest(),e)).json()).billing_state,'past_due');
    assert.equal((await app.fetch(await signedEvent('invoice.paid',{subscription:'sub_test_123',paid:true,amount_paid:1900,currency:'usd'}),e)).status,200);
    assert.equal((await (await app.fetch(statusRequest(),e)).json()).billing_state,'active');
    assert.equal((await app.fetch(await signedEvent('customer.subscription.deleted',{id:'sub_test_123'}),e)).status,200);
    assert.equal((await (await app.fetch(statusRequest(),e)).json()).billing_state,'canceled');
    assert.equal((await app.fetch(await sign(completion(p)),e)).status,200);
    assert.equal((await (await app.fetch(statusRequest(),e)).json()).billing_state,'canceled');
  });
});

test('unverified subscription price, state, mode, or signature never activates membership',async()=>{
  for(const bad of [{wrongLine:true},{wrongSubscription:true}]){
    const e=env(),p=TEST_PLANS.two,mock=mockStripe(p,bad);
    await withFetch(mock.fetch,async()=>{
      assert.equal((await app.fetch(request('/subscriptions/checkout'),e)).status,200);
      const result=await app.fetch(await sign(completion(p)),e);
      assert.equal(result.status,409);
      assert.equal((await (await app.fetch(statusRequest(),e)).json()).billing_state,'pending');
    });
  }
  const e=env(),p=TEST_PLANS.two,mock=mockStripe(p);
  await withFetch(mock.fetch,async()=>{
    assert.equal((await app.fetch(request('/subscriptions/checkout'),e)).status,200);
    const forged=completion(p);forged.data.object.amount_total=1;
    assert.equal((await app.fetch(await sign(forged),e)).status,409);
    assert.equal((await app.fetch(await sign(completion(p),'wrongsecret'),e)).status,400);
    assert.equal((await (await app.fetch(statusRequest(),e)).json()).billing_state,'pending');
  });
});

test('a paid subscription is not a completed Protect Me activation without downstream authorization',async()=>{
  const e=env(),p=TEST_PLANS.two,mock=mockStripe(p);
  await withFetch(mock.fetch,async()=>{
    assert.equal((await app.fetch(request('/subscriptions/checkout'),e)).status,200);
    assert.equal((await app.fetch(await sign(completion(p)),e)).status,200);
    const status=await (await app.fetch(statusRequest(),e)).json();
    assert.equal(status.billing_state,'active');
    assert.equal('api_key' in status,false);
    assert.equal('protection_active' in status,false);
  });
});


test('verified customer can create a server-priced order once, without supplying price or customer id',async()=>{
  const e={...env()};
  e.ORDERS.db.prepare('DELETE FROM orders').run();
  const first=await app.fetch(request('/subscriptions/orders','POST',{plan:'one',amount:1,customer_id:'attacker'}),e);
  assert.equal(first.status,201);
  const body=await first.json();
  assert.match(body.purchase_id,/^purchase_[a-f0-9]{32}$/);
  assert.equal(body.amount_minor,499);
  const stored=e.ORDERS.db.prepare('SELECT customer_id,amount_total,price_id,plan,subscription_state FROM orders WHERE id=?').get(body.purchase_id);
  assert.equal(stored.customer_id,'customer_1');
  assert.equal(stored.amount_total,499);
  assert.equal(stored.price_id,TEST_PLANS.one.price_id);
  assert.equal(stored.plan,'one');
  assert.equal(stored.subscription_state,'pending');
  const again=await app.fetch(request('/subscriptions/orders','POST',{plan:'one'}),e);
  assert.equal((await again.json()).purchase_id,body.purchase_id);
  assert.equal(e.ORDERS.db.prepare("SELECT COUNT(*) AS count FROM orders WHERE plan='one'").get().count,1);
});
test('another customer cannot read or reuse a pending order or claim entitlement',async()=>{
 const e=env('two');
 const different={...e,AUTH_SERVICE:{fetch:async()=>Response.json({subject:'customer_2'})}};
 const status=await app.fetch(statusRequest(),different);
 assert.equal(status.status,404);
 const ent=await app.fetch(request('/subscriptions/entitlement?plan=two','GET'),different);
 assert.equal(ent.status,200);
 assert.equal((await ent.json()).billing_active,false);
 const unauthorized=await app.fetch(request('/subscriptions/orders','POST',{plan:'one'},false),e);
 assert.equal(unauthorized.status,401);
});
test('membership billing entitlement never implies installed or connected protection',async()=>{
 const e=env(),p=TEST_PLANS.two,mock=mockStripe(p);
 const before=await (await app.fetch(request('/subscriptions/entitlement?plan=two','GET'),e)).json();
 assert.equal(before.billing_active,false);
 await withFetch(mock.fetch,async()=>{
   assert.equal((await app.fetch(request('/subscriptions/checkout'),e)).status,200);
   assert.equal((await app.fetch(await sign(completion(p)),e)).status,200);
 });
 const paid=await (await app.fetch(request('/subscriptions/entitlement?plan=two','GET'),e)).json();
 assert.equal(paid.billing_active,true);
 assert.equal(paid.service_activation,'not_verified');
 assert.equal('api_key' in paid,false);
 assert.equal('protection_active' in paid,false);
 assert.equal((await (await app.fetch(request('/subscriptions/entitlement?plan=one','GET'),e)).json()).billing_active,false);
 await app.fetch(await signedEvent('customer.subscription.deleted',{id:'sub_test_123'}),e);
 const canceled=await (await app.fetch(request('/subscriptions/entitlement?plan=two','GET'),e)).json();
 assert.equal(canceled.billing_active,false);
});
test('database prevents duplicate pending or active membership even under simultaneous writers',()=>{
 const e=env('one'),p=TEST_PLANS.one;
 assert.throws(()=>e.ORDERS.db.prepare("INSERT INTO orders(id,product_id,merchant_id,customer_id,currency,amount_total,status,plan,price_id,subscription_state) VALUES('purchase_other',?,?,?,?,?,'pending',?,?,'pending')").run(p.product_id,p.merchant_id,'customer_1',p.currency,p.amount,p.id,p.price_id),/UNIQUE constraint failed/);
});

test('malformed plan name and oversized payload fail closed rather than inheriting object properties',async()=>{
  const e=env();
  const malicious=await app.fetch(request('/subscriptions/orders','POST',{plan:'__proto__'}),e);
  assert.equal(malicious.status,400);
  const badEnt=await app.fetch(request('/subscriptions/entitlement?plan=constructor','GET'),e);
  assert.equal(badEnt.status,400);
  const huge=await app.fetch(request('/subscriptions/orders','POST',{plan:'one',note:'x'.repeat(3000)}),e);
  assert.equal(huge.status,413);
});
