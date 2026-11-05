// Adapted from PR #1 test/worker.test.mjs by the 2026-11-05 design merge.
// validatePurchase / verifySignature scenarios are PR #1's (verifySignature now
// exercises the core worker's implementation, which shares the contract).
// The one-time checkout moved to POST /orders/checkout (the core owns /checkout
// for catalog subscriptions), PR #1's separate AUTH_SERVICE / CHECKOUT_AUTH_READY
// flags were replaced by the core's AUTH service-binding identity, and its
// WEBHOOK_RECONCILIATION_READY flag by the core webhook's always-on provider
// readback. See docs/DESIGN-MERGE.md for the test-by-test mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{validatePurchase,verifySignature} from '../src/worker.mjs';
import {combinedEnv,withFetch} from './harness.mjs';

const order={id:'purchase_123',product_id:'api',merchant_id:'juss',customer_id:'customer_1',currency:'usd',amount_total:1000,session_id:'cs_test_1',status:'pending',plan:null,price_id:null,subscription_id:null,stripe_customer_id:null,subscription_state:'pending'};
const session={id:'cs_test_1',client_reference_id:'purchase_123',mode:'payment',payment_status:'paid',currency:'usd',amount_total:1000,customer:'cus_test_1',metadata:{purchase_id:'purchase_123',product_id:'api',merchant_id:'juss'}};
test('accepts exact paid order',()=>assert.equal(validatePurchase(session,order),true));
for(const [name,patch] of Object.entries({unpaid:{payment_status:'unpaid'},wrong_amount:{amount_total:1},wrong_currency:{currency:'eur'},wrong_product:{metadata:{...session.metadata,product_id:'other'}},wrong_merchant:{metadata:{...session.metadata,merchant_id:'other'}},wrong_order:{client_reference_id:'other'},wrong_session:{id:'cs_other'},subscription:{mode:'subscription'}}))test('rejects '+name,()=>assert.equal(validatePurchase({...session,...patch},order),false));
test('rejects unsigned webhook',async()=>assert.equal(await verifySignature('{}','','secret'),false));
test('rejects expired webhook',async()=>assert.equal(await verifySignature('{}','t=1,v1='+'a'.repeat(64),'secret',1000),false));

const request=(path,body,headers={})=>new Request('https://pay.example'+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
const CATALOG=JSON.stringify({api:{name:'API',amount:1000,currency:'usd',merchant_id:'juss'}});
async function ordersEnv(){
  const h=combinedEnv({subject:'customer_1'});
  h.env.CATALOG=CATALOG;
  await h.seedOrder(order);
  return h;
}
test('checkout is disabled without feature gate',async()=>{const r=await worker.fetch(request('/orders/checkout',{product_id:'api',purchase_id:'purchase_123'}),{});assert.equal(r.status,503);assert.equal((await r.json()).error,'payments_disabled')});
test('checkout rejects non-sandbox Stripe key',async()=>{const h=await ordersEnv();h.env.STRIPE_SECRET_KEY='sk_live_not_real';const r=await worker.fetch(request('/orders/checkout',{product_id:'api',purchase_id:'purchase_123'},{authorization:'Bearer <redacted>'}),h.env);assert.equal((await r.json()).error,'sandbox_key_required')});
test('checkout fails closed when the AUTH binding rejects the token',async()=>{const h=await ordersEnv();h.env.AUTH={fetch:async()=>new Response('',{status:401})};const r=await worker.fetch(request('/orders/checkout',{product_id:'api',purchase_id:'purchase_123'},{authorization:'Bearer <redacted>'}),h.env);assert.equal(r.status,401);assert.equal((await h.getOrder('purchase_123')).session_id,'cs_test_1')});
test('checkout blocks unauthenticated request before order lookup',async()=>{const h=await ordersEnv();const r=await worker.fetch(request('/orders/checkout',{product_id:'api',purchase_id:'purchase_123'}),h.env);assert.equal(r.status,401);assert.equal((await h.getOrder('purchase_123')).status,'pending')});
test('checkout rejects different customer without calling Stripe',async()=>{const other=combinedEnv({subject:'other'});other.env.CATALOG=CATALOG;const r=await worker.fetch(request('/orders/checkout',{product_id:'api',purchase_id:'purchase_123'},{authorization:'Bearer <redacted>'}),other.env);assert.equal(r.status,403)});

test('webhook never marks an order paid when provider readback disagrees',async()=>{
 const h=await ordersEnv();
 const body=JSON.stringify({id:'evt_readback',livemode:false,type:'checkout.session.completed',data:{object:session}});
 const secret='<redacted>',t=Math.floor(Date.now()/1000);
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(t+'.'+body))).toString('hex');
 h.env.STRIPE_WEBHOOK_SECRET=secret;
 await withFetch(async()=>new Response(JSON.stringify({...session,amount_total:1}),{status:200}),async()=>{
  const r=await worker.fetch(new Request('https://pay.example/webhook',{method:'POST',headers:{'stripe-signature':`t=${t},v1=${sig}`},body}),h.env);
  assert.equal(r.status,409);
 });
 assert.equal((await h.getOrder('purchase_123')).status,'pending');
});

test('accepts correctly signed current Stripe webhook',async()=>{
 const body=JSON.stringify({id:'evt_test'}),secret='<redacted>',timestamp=1700000000;
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+body));
 const signature=Buffer.from(bytes).toString('hex');
 assert.equal(await verifySignature(body,`t=${timestamp},v1=${signature}`,secret,timestamp),true);
 assert.equal(await verifySignature(body+' ',`t=${timestamp},v1=${signature}`,secret,timestamp),false);
 assert.equal(await verifySignature(body,`t=${timestamp},v1=${signature}`,'different_secret',timestamp),false);
});
test('rejects signature with nonnumeric timestamp',async()=>assert.equal(await verifySignature('{}','t=invalid,v1='+'a'.repeat(64),'secret'),false));
test('rejects forged session metadata',()=>assert.equal(validatePurchase({...session,metadata:{...session.metadata,purchase_id:'another'}},order),false));
test('rejects paid session without order',()=>assert.equal(validatePurchase(session,null),false));

test('checkout fails closed on malformed catalog',async()=>{
 const h=await ordersEnv();h.env.CATALOG='{broken';
 const r=await worker.fetch(request('/orders/checkout',{product_id:'api',purchase_id:'purchase_123'},{authorization:'Bearer <redacted>'}),h.env);
 assert.equal(r.status,503);
 assert.equal((await r.json()).error,'catalog_misconfigured');
});
test('checkout rejects catalog with null root',async()=>{
 const h=await ordersEnv();h.env.CATALOG='null';
 const r=await worker.fetch(request('/orders/checkout',{product_id:'api',purchase_id:'purchase_123'},{authorization:'Bearer <redacted>'}),h.env);
 assert.equal(r.status,400);
 assert.equal((await r.json()).error,'unknown_product');
});

test('webhook does not acknowledge failed paid-state persistence',async()=>{
 const h=await ordersEnv();
 const put=h.state.storage.put.bind(h.state.storage);
 h.state.storage.put=async(k,v)=>{if(k.startsWith('order:')&&k!=='order:index')throw Error('database unavailable');return put(k,v);};
 const body=JSON.stringify({id:'evt_persist',livemode:false,type:'checkout.session.completed',data:{object:session}});
 const secret='<redacted>',t=Math.floor(Date.now()/1000);
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(t+'.'+body))).toString('hex');
 h.env.STRIPE_WEBHOOK_SECRET=secret;
 await withFetch(async()=>new Response(JSON.stringify(session),{status:200}),async()=>{
  const r=await worker.fetch(new Request('https://pay.example/webhook',{method:'POST',headers:{'stripe-signature':`t=${t},v1=${sig}`},body}),h.env);
  assert.equal(r.status,503);
  assert.equal((await r.json()).error,'reconciliation_persist_failed');
 });
});
