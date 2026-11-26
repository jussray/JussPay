import assert from 'node:assert/strict';
import test from 'node:test';
import {buildPaymentLedgerEntry,appendPaymentLedgerEntry} from '../src/payment-ledger.mjs';
import {BillingAccount} from '../src/worker.mjs';
import {memoryStorage} from './harness.mjs';

const valid=()=>buildPaymentLedgerEntry({merchantId:'juss-ray-beauty-co',source:'jbh-orders',eventId:'evt_12345678',eventType:'checkout.session.completed',orderId:'jbho_12345678',status:'paid',amountMinor:12999,currency:'usd',mode:'sandbox',paymentIntentId:'pi_12345678',recordedAt:100});

test('ledger records contain only validated payment facts and no customer fields',()=>{
  const entry=valid();
  assert.equal(entry.merchantId,'juss-ray-beauty-co');
  assert.equal(entry.amountMinor,12999);
  assert.equal(Object.hasOwn(entry,'email'),false);
  assert.equal(Object.hasOwn(entry,'shipTo'),false);
  assert.equal(Object.isFrozen(entry),true);
});

test('ledger rejects invalid merchant, amount, mode and unsafe customer payloads',()=>{
  const base={merchantId:'juss-ray-beauty-co',source:'jbh-orders',eventId:'evt_12345678',eventType:'checkout.session.completed',orderId:'jbho_12345678',status:'paid',amountMinor:100,currency:'usd',mode:'sandbox'};
  for(const patch of [{merchantId:'unknown merchant'},{amountMinor:-1},{amountMinor:1.5},{mode:'production'},{status:'pending-ish'},{referenceType:'invoice'},{currency:'US dollars'},{email:'customer@example.com'}]){
    if(patch.email){assert.equal(Object.hasOwn(buildPaymentLedgerEntry(base),'email'),false);continue;}
    assert.throws(()=>buildPaymentLedgerEntry({...base,...patch}),/invalid_ledger_entry/);
  }
});

test('append is immutable and idempotent for a source event id',async()=>{
  const rows=new Map();
  const txn={get:async key=>rows.get(key),put:async(key,value)=>rows.set(key,value)};
  const entry=valid();
  assert.equal(await appendPaymentLedgerEntry(txn,entry),true);
  assert.equal(await appendPaymentLedgerEntry(txn,{...entry,status:'refunded'}),false);
  assert.equal(rows.size,1);
  assert.equal(rows.get('ledger:juss-ray-beauty-co:evt_12345678').status,'paid');
  const portfolio=buildPaymentLedgerEntry({...entry,merchantId:'jussco',source:'portfolio-billing',referenceType:'subscription',orderId:'sub_12345678'});
  assert.equal(await appendPaymentLedgerEntry(txn,portfolio),true,'the same event key is isolated by merchant');
  assert.equal(rows.size,2);
});


test('JussCo subscription webhooks write merchant-scoped ledger receipts atomically and idempotently',async()=>{
  const storage=memoryStorage();
  const subscription={
    id:'sub_test_12345678',customer:'cus_test_12345678',status:'active',
    metadata:{jusspay_subject:'subject_1',jusspay_product:'promptos'},
    current_period_end:Math.floor(Date.now()/1000)+3600,
    items:{data:[{quantity:1,price:{id:'price_test_12345678',unit_amount:1900,currency:'usd'}}]}
  };
  const env={
    STRIPE_LIVE:'false',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_API_VERSION:'test',
    APPROVED_PLANS:JSON.stringify({promptos:{approved:true,priceId:'price_test_12345678',unitAmount:1900,currency:'usd',interval:'month',termsUrl:'https://example.test/terms',entitlements:['promptos_access']}}),
    STRIPE_FETCH:async url=>{
      if(String(url).endsWith('/v1/subscriptions/sub_test_12345678'))return Response.json(subscription);
      return new Response('{}',{status:404});
    }
  };
  const state={storage,blockConcurrencyWhile:fn=>fn()};
  const billing=new BillingAccount(state,env);
  const send=event=>billing.fetch(new Request('https://billing.internal/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event,customerId:subscription.customer,subject:'subject_1'})}));
  const event={id:'evt_1234567890',livemode:false,type:'customer.subscription.updated',data:{object:{id:subscription.id,customer:subscription.customer}}};
  assert.equal((await send(event)).status,200);
  const entry=await storage.get('ledger:jussco:evt_1234567890');
  assert.equal(entry.merchantId,'jussco');
  assert.equal(entry.source,'portfolio-billing');
  assert.equal(entry.referenceType,'subscription');
  assert.equal(entry.orderId,subscription.id);
  assert.equal(entry.status,'paid');
  assert.equal(entry.amountMinor,1900);
  assert.equal(entry.currency,'usd');
  assert.equal(entry.mode,'sandbox');
  assert.deepEqual(await (await send(event)).json(),{received:true,duplicate:true});

  const failed={id:'evt_1234567891',livemode:false,type:'invoice.payment_failed',data:{object:{subscription:subscription.id,amount_due:1900,currency:'usd'}}};
  assert.equal((await send(failed)).status,200);
  assert.equal((await storage.get('ledger:jussco:evt_1234567891')).status,'payment_failed');
  assert.equal((await storage.list({prefix:'ledger:jussco:'})).size,2);
});
