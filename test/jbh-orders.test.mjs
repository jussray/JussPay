// JBH hair-order lane (src/jbh-orders.mjs): gate, pricing authority, provider
// reconciliation, idempotency, refund hold and PII boundaries. Fake provider fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {JbhOrderBook,priceOrder,reconcileSession,JBH_LIVE_ACCOUNT} from '../src/jbh-orders.mjs';
import {jbhVendorAdapters,liveVendorAuthority,vendorOwnerPlan} from '../src/jbh-vendor-adapters.mjs';
import {memoryStorage} from './harness.mjs';

const STOREFRONT_KEY='sf_'+'a'.repeat(40);
const OWNER_KEY='ow_'+'b'.repeat(40);
const WEBHOOK_SECRET='whsec_jbh_local';
const CATALOG={
  'BRAZ-SEW-BW-10-12-14':{approved:true,name:'Body Wave Human Hair Bundle Deal 10/12/14',unitAmount:18900,currency:'usd',vendor:'dropship-beauty'},
  'BRAZ-TRANS-CLO-DW-12':{approved:true,name:'Deep Wave 4x4 Transparent Lace Closure 12',unitAmount:6900,currency:'usd',vendor:'dropship-beauty'},
  'JBH-BS-14':{approved:true,name:'Lawless Bone Straight Bundle 14',unitAmount:7500,currency:'usd',vendor:'manual-procurement'}
};

function jbhEnv(overrides={}){
  const calls=[];
  const sessions=new Map(),byKey=new Map(),intents=new Map();
  const charge={id:'ch_1',payment_intent:'pi_test_1',refunded:true};
  const env={
    JBH_ORDERS_ENABLED:'true',JBH_STRIPE_LIVE:'false',JBH_STRIPE_SECRET_KEY:'sk_test_FAKE',JBH_STRIPE_WEBHOOK_SECRET:WEBHOOK_SECRET,
    JBH_STRIPE_API_VERSION:'test-only',JBH_TEST_ACCOUNT_ID:'acct_1TestJbhSandbox',JBH_STOREFRONT_KEY:STOREFRONT_KEY,JBH_OWNER_KEY:OWNER_KEY,
    JBH_STOREFRONT_ORIGIN:'https://jussbeautifulhair.com',JBH_CATALOG:JSON.stringify(CATALOG),
    JBH_SHIPPING:JSON.stringify({standard:800,express:1500,freeStandardOver:7000}),
    STRIPE_FETCH:async(url,init={})=>{
      const u=String(url).replace('https://api.stripe.com/v1/','');calls.push({path:u,method:init.method||'GET',headers:init.headers,body:init.body?Object.fromEntries(init.body):null});
      if(u==='account')return Response.json({id:env.__accountId||(env.JBH_STRIPE_LIVE==='true'?JBH_LIVE_ACCOUNT:'acct_1TestJbhSandbox'),charges_enabled:true,details_submitted:true});
      if(u==='checkout/sessions'&&init.method==='POST'){
        const k=init.headers['Idempotency-Key'];if(byKey.has(k))return Response.json(sessions.get(byKey.get(k)));
        const b=Object.fromEntries(init.body);const live=env.JBH_STRIPE_LIVE==='true';const id=`cs_${live?'live':'test'}_${sessions.size+1}`;byKey.set(k,id);
        intents.set(`pi_${live?'live':'test'}_${sessions.size+1}`,{id:`pi_${live?'live':'test'}_${sessions.size+1}`,livemode:live,metadata:{jbh_order_id:b['payment_intent_data[metadata][jbh_order_id]']}});
        let subtotal=0;for(let i=0;b[`line_items[${i}][quantity]`];i++)subtotal+=Number(b[`line_items[${i}][quantity]`])*Number(b[`line_items[${i}][price_data][unit_amount]`]);
        const shipping=Number(b['shipping_options[0][shipping_rate_data][fixed_amount][amount]']);
        sessions.set(id,{id,object:'checkout.session',mode:'payment',livemode:live,currency:'usd',client_reference_id:b.client_reference_id,metadata:{jbh_order_id:b['metadata[jbh_order_id]']},amount_subtotal:subtotal,amount_total:subtotal+shipping,total_details:{amount_shipping:shipping},payment_status:'unpaid',status:'open',url:`https://checkout.stripe.com/c/pay/${id}`});
        return Response.json(sessions.get(id));
      }
      if(u.startsWith('checkout/sessions/'))return Response.json(sessions.get(decodeURIComponent(u.split('/')[2])));
      if(u.startsWith('charges/'))return Response.json({...charge,payment_intent:env.JBH_STRIPE_LIVE==='true'?'pi_live_1':'pi_test_1',livemode:env.JBH_STRIPE_LIVE==='true'});
      if(u.startsWith('payment_intents/'))return intents.has(u.split('/')[1])?Response.json(intents.get(u.split('/')[1])):new Response('{}',{status:404});
      return new Response('{}',{status:404});
    },
    ...overrides
  };
  const book=new JbhOrderBook({storage:memoryStorage()},env);
  env.JBH_ORDERS={idFromName:n=>n,get:()=>book};
  return {env,calls,sessions,book,charge};
}

const post=(path,body,headers={})=>new Request('https://pay.example'+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(path==='/jbh/checkout'&&body&&!('requestId' in body)?{...body,requestId:crypto.randomUUID()}:body)});
const get=(path,headers={})=>new Request('https://pay.example'+path,{headers});
const sf={'x-jbh-storefront-key':STOREFRONT_KEY};

async function signed(event,secret=WEBHOOK_SECRET){
  const raw=JSON.stringify(event),t=Math.floor(Date.now()/1000);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=[...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${t}.${raw}`)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  return new Request('https://pay.example/jbh/webhook',{method:'POST',headers:{'stripe-signature':`t=${t},v1=${sig}`},body:raw});
}
const completed=(id,sessionId,extra={})=>({id,livemode:false,type:'checkout.session.completed',data:{object:{id:sessionId,...extra}}});

async function paidOrder(h,items){
  const selected=items || (h.env.JBH_STRIPE_LIVE==='true'?[{sku:'BRAZ-SEW-BW-10-12-14',quantity:1}]:[{sku:'BRAZ-SEW-BW-10-12-14',quantity:1},{sku:'JBH-BS-14',quantity:2}]);
  const r=await worker.fetch(post('/jbh/checkout',{items:selected},sf),h.env);
  assert.equal(r.status,200);
  const {orderId}=await r.json();
  const sessionId=[...h.sessions.keys()].at(-1);
  Object.assign(h.sessions.get(sessionId),{payment_status:'paid',status:'complete',payment_intent:`pi_${h.env.JBH_STRIPE_LIVE==='true'?'live':'test'}_${sessionId.split('_').pop()}`,
    collected_information:{shipping_details:{name:'Test Buyer',address:{line1:'1 Test St',city:'Testville',state:'MD',postal_code:'21201',country:'US'}}},
    customer_details:{email:'buyer@example.test',phone:'+15555550100'}});
  return {orderId,sessionId};
}

test('health requires a matching storefront secret and never opens a payment session',async()=>{
  const h=jbhEnv();
  const unauthorized=await worker.fetch(get('/jbh/health'),h.env);
  assert.equal(unauthorized.status,401);
  assert.equal((await unauthorized.json()).error,'storefront_key_required');
  assert.equal(h.calls.length,0);
  const ready=await worker.fetch(get('/jbh/health',sf),h.env);
  assert.equal(ready.status,200);
  assert.deepEqual(await ready.json(),{ready:true,mode:'sandbox',chargesEnabled:true});
  assert.equal(h.calls.some(c=>c.path==='checkout/sessions'),false);
  const invalidMethod=await worker.fetch(post('/jbh/health',{},sf),h.env);
  assert.equal(invalidMethod.status,405);
  h.env.JBH_ORDERS_ENABLED='false';
  const disabled=await worker.fetch(get('/jbh/health',sf),h.env);
  assert.equal(disabled.status,503);
  assert.equal((await disabled.json()).error,'jbh_orders_disabled');
});

test('health refuses live checkout without approval and the exact Beauty Co account',async()=>{
  const h=liveEnv({JBH_LIVE_CHARGES_APPROVED:'false',
    JBH_CATALOG:JSON.stringify({'BRAZ-SEW-BW-10-12-14':CATALOG['BRAZ-SEW-BW-10-12-14']})});
  const held=await worker.fetch(get('/jbh/health',sf),h.env);
  assert.equal(held.status,503);
  assert.equal((await held.json()).error,'jbh_live_not_approved');
  assert.equal(h.calls.length,0);
  h.env.JBH_LIVE_CHARGES_APPROVED='true';
  const ready=await worker.fetch(get('/jbh/health',sf),h.env);
  assert.equal(ready.status,200);
  assert.deepEqual(await ready.json(),{ready:true,mode:'live',chargesEnabled:true});
  h.env.__accountId='acct_wrong';
  const wrong=await worker.fetch(get('/jbh/health',sf),h.env);
  assert.equal(wrong.status,503);
  assert.equal((await wrong.json()).error,'jbh_stripe_account_mismatch');
  assert.equal(h.calls.some(c=>c.path==='checkout/sessions'),false);
});

test('health fails closed on missing approved catalog and shipping contract',async()=>{
  const h=jbhEnv({JBH_CATALOG:'{}'});
  const empty=await worker.fetch(get('/jbh/health',sf),h.env);
  assert.equal(empty.status,503);
  assert.equal((await empty.json()).error,'jbh_catalog_unavailable');
  h.env.JBH_CATALOG=JSON.stringify(CATALOG);
  h.env.JBH_SHIPPING='{}';
  const shipping=await worker.fetch(get('/jbh/health',sf),h.env);
  assert.equal(shipping.status,503);
  assert.equal((await shipping.json()).error,'jbh_shipping_invalid');
  assert.equal(h.calls.length,0);
});

test('the hair lane is off unless JBH_ORDERS_ENABLED is true',async()=>{
  const h=jbhEnv({JBH_ORDERS_ENABLED:'false'});
  const r=await worker.fetch(post('/jbh/checkout',{items:[{sku:'JBH-BS-14',quantity:1}]},sf),h.env);
  assert.equal(r.status,503);assert.equal((await r.json()).error,'jbh_orders_disabled');assert.equal(h.calls.length,0);
});

test('sandbox mode refuses live keys and live mode refuses sandbox keys',async()=>{
  for(const [o,code] of [[{JBH_STRIPE_SECRET_KEY:'sk_live_x'},'jbh_sandbox_key_required'],[{JBH_STRIPE_LIVE:'true'},'jbh_live_key_required']]){
    const h=jbhEnv(o);const r=await worker.fetch(post('/jbh/checkout',{items:[{sku:'JBH-BS-14',quantity:1}]},sf),h.env);
    assert.equal((await r.json()).error,code);assert.equal(h.calls.length,0);
  }
  assert.equal(JBH_LIVE_ACCOUNT,'acct_1TfbELRp7J40bCrl');
});

test('checkout needs the storefront key and calls Stripe only after it matches',async()=>{
  const h=jbhEnv();
  for(const headers of [{},{'x-jbh-storefront-key':'wrong'}]){
    const r=await worker.fetch(post('/jbh/checkout',{items:[{sku:'JBH-BS-14',quantity:1}]},headers),h.env);
    assert.equal(r.status,401);
  }
  assert.equal(h.calls.length,0);
});

test('prices, totals and shipping come only from the server catalog',()=>{
  const env=jbhEnv().env;
  const a=priceOrder(env,{items:[{sku:'JBH-BS-14',quantity:1,unitAmount:1,price:1}]});
  assert.equal(a.subtotal,7500);assert.equal(a.shipping,0);assert.equal(a.total,7500);
  const b=priceOrder(env,{items:[{sku:'BRAZ-TRANS-CLO-DW-12',quantity:1}]});
  assert.equal(b.shipping,800);assert.equal(b.total,7700);
  assert.equal(priceOrder(env,{items:[{sku:'JBH-BS-14',quantity:1}],shipping:'express'}).shipping,1500);
  const merged=priceOrder(env,{items:[{sku:'JBH-BS-14',quantity:2},{sku:'JBH-BS-14',quantity:3}]});
  assert.deepEqual(merged.items.map(x=>[x.sku,x.quantity]),[['JBH-BS-14',5]]);
  for(const items of [[],[{sku:'JBH-BS-14',quantity:0}],[{sku:'JBH-BS-14',quantity:11}],[{sku:'JBH-BS-14',quantity:6},{sku:'JBH-BS-14',quantity:6}],[{sku:'JBH-BS-14',quantity:1.5}]])
    assert.throws(()=>priceOrder(env,{items}),{message:'invalid_items'});
  assert.throws(()=>priceOrder(env,{items:[{sku:'NOT-LISTED',quantity:1}]}),{message:'sku_not_available'});
});

test('an unapproved or malformed catalog entry fails closed',()=>{
  const bad={...CATALOG,'JBH-X':{approved:false,name:'x',unitAmount:100,currency:'usd',vendor:'v1'}};
  assert.throws(()=>priceOrder(jbhEnv({JBH_CATALOG:JSON.stringify(bad)}).env,{items:[{sku:'JBH-BS-14',quantity:1}]}),{message:'jbh_catalog_invalid'});
  const eur={'JBH-BS-14':{...CATALOG['JBH-BS-14'],currency:'eur'}};
  assert.throws(()=>priceOrder(jbhEnv({JBH_CATALOG:JSON.stringify(eur)}).env,{items:[{sku:'JBH-BS-14',quantity:1}]}),{message:'jbh_catalog_invalid'});
});

test('checkout creates one Stripe session at server prices on the bound sandbox account',async()=>{
  const h=jbhEnv();
  const r=await worker.fetch(post('/jbh/checkout',{items:[{sku:'BRAZ-SEW-BW-10-12-14',quantity:1}],total:1},sf),h.env);
  const body=await r.json();
  assert.equal(r.status,200);assert.match(body.orderId,/^jbho_/);assert.match(body.url,/^https:\/\/checkout\.stripe\.com\//);
  const create=h.calls.find(c=>c.path==='checkout/sessions');
  assert.equal(create.headers['Idempotency-Key'],`jbh-checkout-${body.orderId}`);
  assert.equal(create.body['line_items[0][price_data][unit_amount]'],'18900');
  assert.equal(create.body.mode,'payment');
  assert.equal(create.body['shipping_address_collection[allowed_countries][0]'],'US');
  assert.equal(create.body.success_url,`https://jussbeautifulhair.com/checkout/success?order=${body.orderId}`);
  const status=await worker.fetch(get(`/jbh/orders/${body.orderId}`,sf),h.env);
  assert.equal((await status.json()).status,'pending');
});

test('checkout refuses when the Stripe key belongs to a different account',async()=>{
  const h=jbhEnv();h.env.__accountId='acct_someone_else';
  const r=await worker.fetch(post('/jbh/checkout',{items:[{sku:'JBH-BS-14',quantity:1}]},sf),h.env);
  assert.equal(r.status,503);assert.equal((await r.json()).error,'jbh_stripe_account_mismatch');
  assert.equal(h.calls.some(c=>c.path==='checkout/sessions'),false);
});

test('webhook rejects bad signatures and live events',async()=>{
  const h=jbhEnv();
  assert.equal((await worker.fetch(await signed(completed('evt_1','cs_test_1'),'whsec_wrong'),h.env)).status,400);
  const live=await worker.fetch(await signed({...completed('evt_2','cs_test_1'),livemode:true}),h.env);
  assert.equal((await live.json()).error,'wrong_event_context');
});

test('a verified paid session marks the order paid and queues it for the owner by vendor',async()=>{
  const h=jbhEnv();const {orderId,sessionId}=await paidOrder(h);
  const r=await worker.fetch(await signed(completed('evt_paid',sessionId,{payment_status:'paid'})),h.env);
  assert.deepEqual(await r.json(),{received:true});
  const order=await (await worker.fetch(get(`/jbh/orders/${orderId}`,sf),h.env)).json();
  assert.equal(order.status,'paid');assert.equal(order.total,18900+15000);
  assert.equal(JSON.stringify(order).includes('Test St'),false,'public order status carries no shipping PII');
  assert.equal(JSON.stringify(order).includes('buyer@example.test'),false);
  assert.equal((await worker.fetch(get('/jbh/fulfillment'),h.env)).status,401);
  const q=await (await worker.fetch(get('/jbh/fulfillment',{'x-jbh-owner-key':OWNER_KEY}),h.env)).json();
  assert.equal(q.queue.length,1);
  const f=q.queue[0];
  assert.equal(f.status,'awaiting_owner_dispatch');
  assert.deepEqual(Object.keys(f.vendors).sort(),['dropship-beauty','manual-procurement']);
  assert.equal(f.vendors['manual-procurement'][0].quantity,2);
  assert.equal(f.shipTo.address.postal_code,'21201');
});

test('duplicate and replayed paid events do not queue a second fulfillment',async()=>{
  const h=jbhEnv();const {sessionId}=await paidOrder(h);
  await worker.fetch(await signed(completed('evt_a',sessionId)),h.env);
  const dup=await worker.fetch(await signed(completed('evt_a',sessionId)),h.env);
  assert.equal((await dup.json()).duplicate,true);
  await worker.fetch(await signed({...completed('evt_b',sessionId),type:'checkout.session.async_payment_succeeded'}),h.env);
  const q=await (await worker.fetch(get('/jbh/fulfillment',{'x-jbh-owner-key':OWNER_KEY}),h.env)).json();
  assert.equal(q.queue.length,1);
});

test('the event payload is never trusted: provider readback must match the order',async()=>{
  for(const patch of [{amount_total:1},{amount_subtotal:1},{currency:'eur'},{client_reference_id:'jbho_other'},{livemode:true},{total_details:{amount_shipping:999}}]){
    const h=jbhEnv();const {orderId,sessionId}=await paidOrder(h);
    Object.assign(h.sessions.get(sessionId),patch);
    const r=await worker.fetch(await signed(completed('evt_m',sessionId,{payment_status:'paid',amount_total:33900})),h.env);
    assert.equal((await r.json()).reconciliation_required,true,JSON.stringify(patch));
    assert.equal((await (await worker.fetch(get(`/jbh/orders/${orderId}`,sf),h.env)).json()).status,'pending');
    const receipts=await h.book.state.storage.list({prefix:`receipt:${orderId}:`});
    assert.equal(receipts.size,1);
  }
});

test('an unpaid completed session waits; a session unknown to the order book is ignored',async()=>{
  const h=jbhEnv();const {orderId,sessionId}=await paidOrder(h);
  h.sessions.get(sessionId).payment_status='unpaid';
  await worker.fetch(await signed(completed('evt_u',sessionId)),h.env);
  assert.equal((await (await worker.fetch(get(`/jbh/orders/${orderId}`,sf),h.env)).json()).status,'pending');
  const other=await worker.fetch(await signed(completed('evt_x','cs_test_unknown')),h.env);
  assert.equal((await other.json()).ignored,true);
});

test('refunds and disputes hold dispatch and are never undone by a later paid event',async()=>{
  const h=jbhEnv();const {orderId,sessionId}=await paidOrder(h);
  await worker.fetch(await signed(completed('evt_p',sessionId)),h.env);
  await worker.fetch(await signed({id:'evt_r',livemode:false,type:'charge.refunded',data:{object:{id:'ch_1',payment_intent:'pi_test_1'}}}),h.env);
  assert.equal((await (await worker.fetch(get(`/jbh/orders/${orderId}`,sf),h.env)).json()).status,'refunded');
  await worker.fetch(await signed({...completed('evt_late',sessionId),type:'checkout.session.async_payment_succeeded'}),h.env);
  assert.equal((await (await worker.fetch(get(`/jbh/orders/${orderId}`,sf),h.env)).json()).status,'refunded');
  const q=await (await worker.fetch(get('/jbh/fulfillment',{'x-jbh-owner-key':OWNER_KEY}),h.env)).json();
  assert.equal(q.queue[0].status,'hold');assert.equal(q.queue[0].holdReason,'charge.refunded');

  const d=jbhEnv();const p=await paidOrder(d);
  await worker.fetch(await signed(completed('evt_p2',p.sessionId)),d.env);
  await worker.fetch(await signed({id:'evt_d',livemode:false,type:'charge.dispute.created',data:{object:{id:'dp_1',charge:'ch_1'}}}),d.env);
  assert.equal((await (await worker.fetch(get(`/jbh/orders/${p.orderId}`,sf),d.env)).json()).status,'disputed');
});

test('reconcileSession requires every load-bearing field',()=>{
  const order={id:'jbho_1',sessionId:'cs_test_1',currency:'usd',subtotal:100,total:900,shipping:800};
  const s={id:'cs_test_1',client_reference_id:'jbho_1',metadata:{jbh_order_id:'jbho_1'},mode:'payment',livemode:false,currency:'usd',amount_subtotal:100,amount_total:900,total_details:{amount_shipping:800}};
  assert.equal(reconcileSession(s,order),true);
  assert.equal(reconcileSession({...s,metadata:{jbh_order_id:'jbho_2'}},order),false);
  assert.equal(reconcileSession({...s,mode:'subscription'},order),false);
});

test('the hair lane leaves the subscription core untouched',async()=>{
  const h=jbhEnv();
  const r=await worker.fetch(new Request('https://pay.example/checkout',{method:'POST',body:'{}'}),h.env);
  assert.equal((await r.json()).error,'payments_disabled');
  assert.equal(h.calls.length,0);
});

// --- Review fixes (PR #8): retries, event order, partial refunds, dispatch, bounds.
const refunded=(id,chargeId='ch_1')=>({id,livemode:false,type:'charge.refunded',data:{object:{id:chargeId}}});
const disputed=(id,chargeId='ch_1')=>({id,livemode:false,type:'charge.dispute.created',data:{object:{id:'dp_1',charge:chargeId}}});
const orderStatus=async(h,id)=>(await (await worker.fetch(get(`/jbh/orders/${id}`,sf),h.env)).json()).status;
const queue=async h=>(await (await worker.fetch(get('/jbh/fulfillment',{'x-jbh-owner-key':OWNER_KEY}),h.env)).json()).queue;

test('a storefront retry with the same requestId reuses the order and the Stripe session',async()=>{
  const h=jbhEnv();const requestId=crypto.randomUUID();const body={requestId,items:[{sku:'JBH-BS-14',quantity:1}]};
  const a=await (await worker.fetch(post('/jbh/checkout',body,sf),h.env)).json();
  const b=await (await worker.fetch(post('/jbh/checkout',body,sf),h.env)).json();
  assert.equal(a.orderId,b.orderId);assert.equal(a.url,b.url);assert.equal(h.sessions.size,1);
  const reused=await worker.fetch(post('/jbh/checkout',{requestId,items:[{sku:'JBH-BS-14',quantity:2}]},sf),h.env);
  assert.equal(reused.status,409);assert.equal((await reused.json()).error,'request_id_reused');
  const missing=await worker.fetch(post('/jbh/checkout',{requestId:'nope',items:[{sku:'JBH-BS-14',quantity:1}]},sf),h.env);
  assert.equal((await missing.json()).error,'request_id_required');
});

test('a retry after a lost Stripe response replays the same idempotency key, never a second session',async()=>{
  const h=jbhEnv();const requestId=crypto.randomUUID();const body={requestId,items:[{sku:'JBH-BS-14',quantity:1}]};
  const real=h.env.STRIPE_FETCH;let drop=true;
  h.env.STRIPE_FETCH=async(url,init)=>{const r=await real(url,init);if(drop&&String(url).endsWith('/checkout/sessions')){drop=false;return new Response('{}',{status:502});}return r;};
  assert.equal((await worker.fetch(post('/jbh/checkout',body,sf),h.env)).status,502);
  const ok=await (await worker.fetch(post('/jbh/checkout',body,sf),h.env)).json();
  assert.match(ok.url,/cs_test_1$/);assert.equal(h.sessions.size,1);
  const keys=h.calls.filter(c=>c.path==='checkout/sessions').map(c=>c.headers['Idempotency-Key']);
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
});

test('a refund that arrives before the paid event is never lost and blocks dispatch',async()=>{
  const h=jbhEnv();const {orderId,sessionId}=await paidOrder(h);
  const r=await worker.fetch(await signed(refunded('evt_early')),h.env);
  assert.deepEqual(await r.json(),{received:true});
  assert.equal(await orderStatus(h,orderId),'refunded');
  await worker.fetch(await signed(completed('evt_late_paid',sessionId)),h.env);
  assert.equal(await orderStatus(h,orderId),'refunded');
  assert.equal((await queue(h)).length,0,'a refunded order must never reach the dispatch queue');
});

test('a dispute on an order whose paid step needed reconciliation is still recorded',async()=>{
  const h=jbhEnv();const {orderId,sessionId}=await paidOrder(h);
  h.sessions.get(sessionId).amount_total=1;
  await worker.fetch(await signed(completed('evt_mis',sessionId)),h.env);
  assert.equal(await orderStatus(h,orderId),'pending');
  await worker.fetch(await signed(disputed('evt_dsp')),h.env);
  assert.equal(await orderStatus(h,orderId),'disputed');
});

test('a partial refund is recorded as partial, and a dispute is never hidden by a refund',async()=>{
  const h=jbhEnv();const {orderId,sessionId}=await paidOrder(h);
  await worker.fetch(await signed(completed('evt_ok',sessionId)),h.env);
  h.charge.refunded=false;
  await worker.fetch(await signed(refunded('evt_part')),h.env);
  assert.equal(await orderStatus(h,orderId),'partially_refunded');
  assert.equal((await queue(h))[0].status,'hold');
  await worker.fetch(await signed(disputed('evt_dsp2')),h.env);
  h.charge.refunded=true;
  await worker.fetch(await signed(refunded('evt_full')),h.env);
  assert.equal(await orderStatus(h,orderId),'disputed');
});

test('the owner marks an order dispatched, which removes it from the queue exactly once',async()=>{
  const h=jbhEnv();const {orderId,sessionId}=await paidOrder(h);
  await worker.fetch(await signed(completed('evt_q',sessionId)),h.env);
  const path=`/jbh/fulfillment/${orderId}/dispatched`;
  assert.equal((await worker.fetch(post(path,{note:'DSB order 123'}),h.env)).status,401);
  const r=await worker.fetch(post(path,{note:'DSB order 123'},{'x-jbh-owner-key':OWNER_KEY}),h.env);
  assert.deepEqual(await r.json(),{id:orderId,status:'dispatched'});
  assert.equal((await queue(h)).length,0);
  assert.equal((await worker.fetch(post(path,{},{'x-jbh-owner-key':OWNER_KEY}),h.env)).status,409);
  await worker.fetch(await signed(refunded('evt_after')),h.env);
  assert.equal(await orderStatus(h,orderId),'refunded');
  assert.equal((await h.book.state.storage.list({prefix:`receipt:${orderId}:`})).size,1,'a refund after dispatch leaves an owner receipt');
});

test('an unknown shipping choice is rejected, not silently charged as standard',async()=>{
  const env=jbhEnv().env;
  for(const shipping of ['Express','overnight',1,null])assert.throws(()=>priceOrder(env,{items:[{sku:'JBH-BS-14',quantity:1}],shipping}),{message:'invalid_shipping'});
});

test('an oversized webhook body without Content-Length is refused before buffering it whole',async()=>{
  const h=jbhEnv();
  const big=new ReadableStream({start(c){for(let i=0;i<70;i++)c.enqueue(new TextEncoder().encode('x'.repeat(4096)));c.close();}});
  const r=await worker.fetch(new Request('https://pay.example/jbh/webhook',{method:'POST',body:big,duplex:'half',headers:{'stripe-signature':'t=1,v1='+'0'.repeat(64)}}),h.env);
  assert.equal(r.status,413);
});


test('private sandbox receipt is signed, retryable and sent only once after verified payment',async()=>{
  const deliveries=[];
  let unavailable=true;
  const h=jbhEnv({
    JBH_PRIVATE_RECEIPTS_ENABLED:'true',
    JBH_PRIVATE_RECEIPT_SECRET:'r'.repeat(40),
    JBH_PRIVATE_WORKER:{fetch:async request=>{
      const raw=await request.text();
      deliveries.push({raw,signature:request.headers.get('x-jbh-jusspay-signature')});
      return new Response('{}',{status:unavailable?503:200});
    }}
  });
  const {orderId,sessionId}=await paidOrder(h);
  assert.equal(deliveries.length,0);
  await worker.fetch(await signed(completed('evt_private_paid',sessionId)),h.env);
  assert.equal(deliveries.length,1);
  const receipt=JSON.parse(deliveries[0].raw);
  assert.deepEqual(receipt,{eventId:'evt_private_paid',livemode:false,orderId,paymentIntentId:'pi_test_1',state:'awaiting_owner_dispatch'});
  assert.match(deliveries[0].signature,/^[0-9a-f]{64}$/);
  unavailable=false;
  await worker.fetch(await signed(completed('evt_private_paid',sessionId)),h.env);
  assert.equal(deliveries.length,2);
  await worker.fetch(await signed(completed('evt_private_paid',sessionId)),h.env);
  assert.equal(deliveries.length,2);
});

test('refund hold blocks replay delivery of a pending private receipt',async()=>{
  const deliveries=[];
  const h=jbhEnv({
    JBH_PRIVATE_RECEIPTS_ENABLED:'true',
    JBH_PRIVATE_RECEIPT_SECRET:'r'.repeat(40),
    JBH_PRIVATE_WORKER:{fetch:async request=>{deliveries.push(JSON.parse(await request.text()));return new Response('{}',{status:503});}}
  });
  const {sessionId}=await paidOrder(h);
  await worker.fetch(await signed(completed('evt_hold_paid',sessionId)),h.env);
  assert.deepEqual(deliveries.map(x=>x.state),['awaiting_owner_dispatch']);
  await worker.fetch(await signed(refunded('evt_hold_refund')),h.env);
  await worker.fetch(await signed(completed('evt_hold_paid',sessionId)),h.env);
  assert.deepEqual(deliveries.map(x=>x.state),['awaiting_owner_dispatch','refunded','refunded']);
});


test('signed refund hold is forwarded and replay does not duplicate a delivered hold',async()=>{
  const deliveries=[];
  const h=jbhEnv({
    JBH_PRIVATE_RECEIPTS_ENABLED:'true',
    JBH_PRIVATE_RECEIPT_SECRET:'r'.repeat(40),
    JBH_PRIVATE_WORKER:{fetch:async request=>{deliveries.push(JSON.parse(await request.text()));return new Response('{}',{status:200});}}
  });
  const {orderId,sessionId}=await paidOrder(h);
  await worker.fetch(await signed(completed('evt_hold_first',sessionId)),h.env);
  await worker.fetch(await signed(refunded('evt_hold_second')),h.env);
  assert.deepEqual(deliveries.map(x=>x.state),['awaiting_owner_dispatch','refunded']);
  assert.equal(deliveries[1].orderId,orderId);
  await worker.fetch(await signed(refunded('evt_hold_second')),h.env);
  assert.equal(deliveries.length,2);
});


// Live-mode behavior is tested only with fake provider responses. No real Stripe calls.
const liveEnv=(overrides={})=>jbhEnv({
  JBH_STRIPE_LIVE:'true',JBH_STRIPE_SECRET_KEY:'sk_live_FAKE',
  JBH_LIVE_CHARGES_APPROVED:'true',
  // Fake receipts exist only in the test provider harness, never production.
  JBH_VENDOR_SALES_AUTHORITY:JSON.stringify({
    'dropship-beauty':{enabled:true,mode:'verified-owner-handoff',
      evidenceRef:'test:inventory:receipt-12345678',ownerReceiptRef:'test:handoff:receipt-12345678',
      ownerHandoffVerified:true,verifiedAt:Date.now(),
      skus:['BRAZ-SEW-BW-10-12-14','BRAZ-TRANS-CLO-DW-12']}
  }),
  ...overrides
});



test('vendor adapters distinguish Faire stocked inventory, Dropship Beauty handoff, DSers and manual procurement',()=>{
  const adapters=jbhVendorAdapters();
  assert.equal(adapters['faire'].handoff,'owner-warehouse-fulfillment');
  assert.equal(adapters['faire'].autoDispatch,false);
  assert.equal(adapters['dropship-beauty'].handoff,'dropship-beauty-shopify-app');
  assert.equal(adapters['dsers'].handoff,'dsers-connected-channel-or-csv');
  assert.equal(adapters['manual-procurement'].handoff,'owner-fulfillment');
  const plans=vendorOwnerPlan({'faire':[{sku:'FAIRE-01',quantity:2}],
    'dropship-beauty':[{sku:'BRAZ-SEW-BW-10-12-14',quantity:1}],
    'supplier-unknown':[{sku:'ACME-01',quantity:1}]});
  assert.equal(plans[0].action,'owner_review');
  assert.equal(plans[0].autoDispatch,false);
  assert.match(plans[0].note,/never dropship/);
  assert.equal(plans[2].action,'quarantine');
});

test('owner-only vendor adapter view contains no supplier credentials or public dispatch action',async()=>{
  const h=jbhEnv();
  const unauth=await worker.fetch(get('/jbh/vendor-adapters'),h.env);
  assert.equal(unauth.status,401);
  const allowed=await worker.fetch(get('/jbh/vendor-adapters',{'x-jbh-owner-key':OWNER_KEY}),h.env);
  assert.equal(allowed.status,200);
  const response=await allowed.json();
  assert.equal(response.dispatchEnabled,false);
  assert.equal(response.adapters.faire.kind,'wholesale-stock');
  assert.equal(response.adapters.dsers.autoDispatch,false);
  assert.equal(JSON.stringify(response).includes('sk_test_'),false);
});

test('owner can inspect vendor adapters with charging disabled and no Stripe configuration',async()=>{
  const h=jbhEnv({JBH_ORDERS_ENABLED:'false',JBH_STRIPE_SECRET_KEY:undefined,JBH_STRIPE_WEBHOOK_SECRET:undefined});
  h.env.JBH_ORDERS=undefined;
  const anonymous=await worker.fetch(get('/jbh/vendor-adapters'),h.env);
  assert.equal(anonymous.status,401);
  const wrong=await worker.fetch(get('/jbh/vendor-adapters',{'x-jbh-owner-key':'not-the-owner'}),h.env);
  assert.equal(wrong.status,401);
  const authorized=await worker.fetch(get('/jbh/vendor-adapters',{'x-jbh-owner-key':OWNER_KEY}),h.env);
  assert.equal(authorized.status,200);
  const result=await authorized.json();
  assert.equal(result.ordersEnabled,false);
  assert.equal(result.dispatchEnabled,false);
  assert.equal(result.adapters.faire.kind,'wholesale-stock');
  assert.equal(h.calls.length,0,'inspection must never contact Stripe');
  const checkout=await worker.fetch(post('/jbh/checkout',{items:[{sku:'JBH-BS-14',quantity:1}]},sf),h.env);
  assert.equal(checkout.status,503,'readiness inspection must not enable charges');
});

test('vendor adapter inspection refuses absent owner secret even if payment is disabled',async()=>{
  const h=jbhEnv({JBH_ORDERS_ENABLED:'false',JBH_OWNER_KEY:undefined});
  const response=await worker.fetch(get('/jbh/vendor-adapters',{'x-jbh-owner-key':OWNER_KEY}),h.env);
  assert.equal(response.status,401);
  assert.equal(h.calls.length,0);
});

test('live vendor authority fails closed before contacting Stripe on unverified channels, unsupported suppliers and Faire dropshipping',async()=>{
  const sku='BRAZ-SEW-BW-10-12-14';
  const item={sku,vendor:'dropship-beauty'};
  assert.throws(()=>liveVendorAuthority({},[item]),{message:'jbh_vendor_authority_required'});
  const h=liveEnv({JBH_VENDOR_SALES_AUTHORITY:'{}'});
  const unauthorized=await worker.fetch(post('/jbh/checkout',{items:[{sku,quantity:1}]},sf),h.env);
  assert.equal(unauthorized.status,503);
  assert.equal((await unauthorized.json()).error,'jbh_vendor_not_verified');
  assert.equal(h.calls.length,0,'unverified supplier must be stopped before Stripe');

  const manual=liveEnv();
  const restricted=await worker.fetch(post('/jbh/checkout',{items:[{sku:'JBH-BS-14',quantity:1}]},sf),manual.env);
  assert.equal((await restricted.json()).error,'jbh_vendor_not_verified');
  assert.equal(manual.calls.length,0);
  const faire=liveEnv();
  const stocked={enabled:true,mode:'stocked-on-hand',evidenceRef:'test:faire:receipt-12345678',
    verifiedAt:Date.now(),skus:['FAIRE-01']};
  faire.env.JBH_VENDOR_SALES_AUTHORITY=JSON.stringify({'faire':stocked});
  assert.throws(()=>liveVendorAuthority(faire.env,[{sku:'FAIRE-01',vendor:'faire'}]),{message:'jbh_local_stock_reservation_required'});
  assert.throws(()=>liveVendorAuthority(faire.env,[{sku:'NEW-01',vendor:'unverified-supplier'}]),{message:'jbh_vendor_unsupported'});
});

test('live checkout is disabled independently until the founder approval switch is set',async()=>{
  const h=liveEnv({JBH_LIVE_CHARGES_APPROVED:'false'});
  const r=await worker.fetch(post('/jbh/checkout',{items:[{sku:'JBH-BS-14',quantity:1}]},sf),h.env);
  assert.equal(r.status,503);assert.equal((await r.json()).error,'jbh_live_not_approved');
  assert.equal(h.calls.length,0,'approval failure must precede provider calls');
});

test('live Stripe key must authenticate as Beauty Co before any session is created',async()=>{
  const h=liveEnv();h.env.__accountId='acct_wrong_merchant';
  const r=await worker.fetch(post('/jbh/checkout',{items:[{sku:'BRAZ-SEW-BW-10-12-14',quantity:1}]},sf),h.env);
  assert.equal(r.status,503);assert.equal((await r.json()).error,'jbh_stripe_account_mismatch');
  assert.equal(h.calls.some(c=>c.path==='checkout/sessions'),false);
});

test('approved live checkout uses separate order storage and accepts only signed live paid sessions',async()=>{
  const h=liveEnv(),names=[];
  h.env.JBH_ORDERS={idFromName:n=>{names.push(n);return n;},get:()=>h.book};
  const {orderId,sessionId}=await paidOrder(h);
  assert.match(sessionId,/^cs_live_/);
  assert.deepEqual([...new Set(names)],['live:jbh-orders']);
  const testEvent=await worker.fetch(await signed(completed('evt_live_wrong_mode',sessionId)),h.env);
  assert.equal((await testEvent.json()).error,'wrong_event_context');
  const response=await worker.fetch(await signed({...completed('evt_live_paid',sessionId),livemode:true}),h.env);
  assert.deepEqual(await response.json(),{received:true});
  assert.equal(await orderStatus(h,orderId),'paid');
  assert.equal((await queue(h)).length,1);
});

test('live provider readback refuses a mismatched test session and leaves order pending',async()=>{
  const h=liveEnv();const {orderId,sessionId}=await paidOrder(h);
  h.sessions.get(sessionId).livemode=false;
  const r=await worker.fetch(await signed({...completed('evt_live_mismatch',sessionId),livemode:true}),h.env);
  assert.equal((await r.json()).reconciliation_required,true);
  assert.equal(await orderStatus(h,orderId),'pending');
});

test('revoking checkout approval does not drop webhooks for previously created live orders',async()=>{
  const h=liveEnv();const {orderId,sessionId}=await paidOrder(h);
  h.env.JBH_LIVE_CHARGES_APPROVED='false';
  const r=await worker.fetch(await signed({...completed('evt_live_after_pause',sessionId),livemode:true}),h.env);
  assert.deepEqual(await r.json(),{received:true});
  assert.equal(await orderStatus(h,orderId),'paid');
  const blocked=await worker.fetch(post('/jbh/checkout',{items:[{sku:'JBH-BS-14',quantity:1}]},sf),h.env);
  assert.equal((await blocked.json()).error,'jbh_live_not_approved');
});

test('live paid orders never forward PII to the sandbox-only private receipt worker',async()=>{
  let delivered=0;
  const h=liveEnv({
    JBH_PRIVATE_RECEIPTS_ENABLED:'true',JBH_PRIVATE_RECEIPT_SECRET:'r'.repeat(40),
    JBH_PRIVATE_WORKER:{async fetch(){delivered++;return Response.json({});}}
  });
  const {orderId,sessionId}=await paidOrder(h);
  const r=await worker.fetch(await signed({...completed('evt_live_private',sessionId),livemode:true}),h.env);
  assert.deepEqual(await r.json(),{received:true});
  assert.equal(await orderStatus(h,orderId),'paid');
  assert.equal(delivered,0);
});

test('live refund enters hold without automatic vendor dispatch',async()=>{
  const h=liveEnv();const {orderId,sessionId}=await paidOrder(h);
  await worker.fetch(await signed({...completed('evt_live_ok',sessionId),livemode:true}),h.env);
  const r=await worker.fetch(await signed({...refunded('evt_live_refund'),livemode:true}),h.env);
  assert.deepEqual(await r.json(),{received:true});
  assert.equal(await orderStatus(h,orderId),'refunded');
  assert.equal((await queue(h))[0].status,'hold');
});

test('live readiness checks approved vendor handoff before contacting Stripe',async()=>{
  const sku='BRAZ-SEW-BW-10-12-14';
  const h=liveEnv({
    JBH_VENDOR_SALES_AUTHORITY:'{}',
    JBH_CATALOG:JSON.stringify({[sku]:CATALOG[sku]})
  });
  const r=await worker.fetch(get('/jbh/health',sf),h.env);
  assert.equal(r.status,503);
  assert.equal((await r.json()).error,'jbh_vendor_not_verified');
  assert.equal(h.calls.length,0,'health must not call Stripe when vendor handoff is unverified');
});

test('live readiness confirms the Beauty Co account without creating a Checkout Session',async()=>{
  const sku='BRAZ-SEW-BW-10-12-14';
  const h=liveEnv({JBH_CATALOG:JSON.stringify({[sku]:CATALOG[sku]})});
  const r=await worker.fetch(get('/jbh/health',sf),h.env);
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{ready:true,mode:'live',chargesEnabled:true});
  assert.deepEqual(h.calls.map(c=>c.path),['account']);
});


test('live checkout and health refuse an inaccessible owner fulfillment queue before Stripe',async()=>{
  const h=liveEnv({JBH_OWNER_KEY:undefined});
  const health=await worker.fetch(get('/jbh/health',sf),h.env);
  assert.equal(health.status,503);
  assert.equal((await health.json()).error,'jbh_owner_queue_unavailable');
  const checkout=await worker.fetch(post('/jbh/checkout',{items:[{sku:'BRAZ-SEW-BW-10-12-14',quantity:1}]},sf),h.env);
  assert.equal(checkout.status,503);
  assert.equal((await checkout.json()).error,'jbh_owner_queue_unavailable');
  assert.equal(h.calls.length,0,'no Stripe calls without owner fulfillment access');
});

test('owner launch preflight reports configuration without opening a payment session',async()=>{
  const sku='BRAZ-SEW-BW-10-12-14';
  const h=liveEnv({JBH_LIVE_CHARGES_APPROVED:'false',JBH_CATALOG:JSON.stringify({[sku]:CATALOG[sku]})});
  const r=await worker.fetch(get('/jbh/launch-readiness',{'x-jbh-owner-key':OWNER_KEY}),h.env);
  assert.equal(r.status,200);
  const body=await r.json();
  assert.equal(body.readOnly,true);
  assert.equal(body.configurationComplete,true);
  assert.equal(body.founderChargesApproved,false);
  assert.equal(body.providerVerified,false);
  assert.equal(body.checks.vendorEvidenceContractValid,true);
  assert.equal(h.calls.length,0,'read-only preflight must never call Stripe');
});

test('owner launch preflight is private, GET-only and fail-closed',async()=>{
  const h=liveEnv();
  const denied=await worker.fetch(get('/jbh/launch-readiness'),h.env);
  assert.equal(denied.status,401);
  const wrong=await worker.fetch(get('/jbh/launch-readiness',{'x-jbh-owner-key':'wrong'}),h.env);
  assert.equal(wrong.status,401);
  const method=await worker.fetch(post('/jbh/launch-readiness',{}, {'x-jbh-owner-key':OWNER_KEY}),h.env);
  assert.equal(method.status,405);
  assert.equal(h.calls.length,0);
});

test('owner launch preflight identifies missing vendor proof and catalog without provider calls',async()=>{
  const sku='BRAZ-SEW-BW-10-12-14';
  const h=liveEnv({JBH_CATALOG:JSON.stringify({[sku]:CATALOG[sku]}),JBH_VENDOR_SALES_AUTHORITY:'{}'});
  const bad=await worker.fetch(get('/jbh/launch-readiness',{'x-jbh-owner-key':OWNER_KEY}),h.env);
  assert.equal(bad.status,200);
  const missingVendor=await bad.json();
  assert.equal(missingVendor.configurationComplete,false);
  assert.equal(missingVendor.checks.vendorEvidenceContractValid,false);
  h.env.JBH_CATALOG='{}';
  const empty=await worker.fetch(get('/jbh/launch-readiness',{'x-jbh-owner-key':OWNER_KEY}),h.env);
  assert.equal(empty.status,200);
  assert.equal((await empty.json()).checks.approvedCatalogConfigured,false);
  assert.equal(h.calls.length,0);
});
