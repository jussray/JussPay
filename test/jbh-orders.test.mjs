// JBH hair-order lane (src/jbh-orders.mjs): gate, pricing authority, provider
// reconciliation, idempotency, refund hold and PII boundaries. Sandbox fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {JbhOrderBook,priceOrder,reconcileSession,JBH_LIVE_ACCOUNT} from '../src/jbh-orders.mjs';
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
      if(u==='account')return Response.json({id:env.__accountId||'acct_1TestJbhSandbox',charges_enabled:true,details_submitted:true});
      if(u==='checkout/sessions'&&init.method==='POST'){
        const k=init.headers['Idempotency-Key'];if(byKey.has(k))return Response.json(sessions.get(byKey.get(k)));
        const b=Object.fromEntries(init.body);const id=`cs_${env.JBH_STRIPE_LIVE==='true'?'live':'test'}_${sessions.size+1}`;byKey.set(k,id);
        intents.set(`pi_${env.JBH_STRIPE_LIVE==='true'?'live':'test'}_${sessions.size+1}`,{id:`pi_test_${sessions.size+1}`,livemode:env.JBH_STRIPE_LIVE==='true',metadata:{jbh_order_id:b['payment_intent_data[metadata][jbh_order_id]']}});
        let subtotal=0;for(let i=0;b[`line_items[${i}][quantity]`];i++)subtotal+=Number(b[`line_items[${i}][quantity]`])*Number(b[`line_items[${i}][price_data][unit_amount]`]);
        const shipping=Number(b['shipping_options[0][shipping_rate_data][fixed_amount][amount]']);
        sessions.set(id,{id,object:'checkout.session',mode:'payment',livemode:env.JBH_STRIPE_LIVE==='true',currency:'usd',client_reference_id:b.client_reference_id,metadata:{jbh_order_id:b['metadata[jbh_order_id]']},amount_subtotal:subtotal,amount_total:subtotal+shipping,total_details:{amount_shipping:shipping},payment_status:'unpaid',status:'open',url:`https://checkout.stripe.com/c/pay/${id}`});
        return Response.json(sessions.get(id));
      }
      if(u.startsWith('checkout/sessions/'))return Response.json(sessions.get(decodeURIComponent(u.split('/')[2])));
      if(u.startsWith('charges/'))return Response.json(charge);
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

async function paidOrder(h,items=[{sku:'BRAZ-SEW-BW-10-12-14',quantity:1},{sku:'JBH-BS-14',quantity:2}]){
  const r=await worker.fetch(post('/jbh/checkout',{items},sf),h.env);
  assert.equal(r.status,200);
  const {orderId}=await r.json();
  const sessionId=[...h.sessions.keys()].at(-1);
  Object.assign(h.sessions.get(sessionId),{payment_status:'paid',status:'complete',payment_intent:`pi_${h.env.JBH_STRIPE_LIVE==='true'?'live':'test'}_${sessionId.split('_').pop()}`,
    collected_information:{shipping_details:{name:'Test Buyer',address:{line1:'1 Test St',city:'Testville',state:'MD',postal_code:'21201',country:'US'}}},
    customer_details:{email:'buyer@example.test',phone:'+15555550100'}});
  return {orderId,sessionId};
}

test('the hair lane is off unless JBH_ORDERS_ENABLED is true',async()=>{
  const h=jbhEnv({JBH_ORDERS_ENABLED:'false'});
  const r=await worker.fetch(post('/jbh/checkout',{items:[{sku:'JBH-BS-14',quantity:1}]},sf),h.env);
  assert.equal(r.status,503);assert.equal((await r.json()).error,'jbh_orders_disabled');assert.equal(h.calls.length,0);
});

test('live keys and live mode are refused in this sandbox-only version',async()=>{
  for(const [o,code] of [[{JBH_STRIPE_SECRET_KEY:'sk_live_x'},'jbh_sandbox_key_required'],[{JBH_STRIPE_LIVE:'true'},'jbh_live_not_approved']]){
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
  const order={id:'jbho_1',sessionId:'cs_test_1',livemode:false,currency:'usd',subtotal:100,total:900,shipping:800};
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

// Live mode stays disabled without an explicit release switch and a matching Beauty Co account.
test('live Beauty Co checkout is gated and rejects wrong mode, key and account before charge',async()=>{
  const live={JBH_STRIPE_LIVE:'true',JBH_LIVE_CHARGES_APPROVED:'true',JBH_LIVE_ACCOUNT_ID:JBH_LIVE_ACCOUNT,JBH_STRIPE_SECRET_KEY:'sk_live_FAKE'};
  const attempt=async overrides=>{
    const h=jbhEnv({...live,...overrides});
    const r=await worker.fetch(post('/jbh/checkout',{items:[{sku:'JBH-BS-14',quantity:1}]},sf),h.env);
    return {h,r,body:await r.json()};
  };
  for(const [overrides,code] of [
    [{JBH_LIVE_CHARGES_APPROVED:'false'},'jbh_live_not_approved'],
    [{JBH_STRIPE_SECRET_KEY:'sk_test_FAKE'},'jbh_live_key_required'],
    [{JBH_LIVE_ACCOUNT_ID:'acct_other'},'jbh_live_account_not_configured']
  ]){
    const {h,body}=await attempt(overrides);
    assert.equal(body.error,code);assert.equal(h.calls.length,0);
  }
  const wrong=await attempt({__accountId:'acct_other'});
  assert.equal(wrong.body.error,'jbh_stripe_account_mismatch');
  assert.equal(wrong.h.calls.some(c=>c.path==='checkout/sessions'),false);
  const h=jbhEnv({...live,__accountId:JBH_LIVE_ACCOUNT});
  const r=await worker.fetch(post('/jbh/checkout',{items:[{sku:'JBH-BS-14',quantity:1}]},sf),h.env);
  assert.equal(r.status,200);
  assert.equal(h.calls.filter(c=>c.path==='checkout/sessions').length,1);
  assert.match((await r.json()).url,/cs_live_/);
});

test('live Beauty Co webhooks reject sandbox events and wrong account',async()=>{
  const h=jbhEnv({JBH_STRIPE_LIVE:'true',JBH_LIVE_CHARGES_APPROVED:'true',JBH_LIVE_ACCOUNT_ID:JBH_LIVE_ACCOUNT,JBH_STRIPE_SECRET_KEY:'sk_live_FAKE',__accountId:JBH_LIVE_ACCOUNT});
  const event={...completed('evt_live','cs_live_1'),livemode:true};
  const wrongMode=await worker.fetch(await signed({...event,livemode:false}),h.env);
  assert.equal((await wrongMode.json()).error,'wrong_event_context');
  const wrongAccount=await worker.fetch(await signed({...event,account:'acct_other'}),h.env);
  assert.equal((await wrongAccount.json()).error,'wrong_event_context');
  assert.equal(h.calls.length,0);
});
