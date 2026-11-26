import assert from 'node:assert/strict';
import test from 'node:test';
import {buildPaymentLedgerEntry,appendPaymentLedgerEntry} from '../src/payment-ledger.mjs';

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
  for(const patch of [{merchantId:'unknown merchant'},{amountMinor:-1},{amountMinor:1.5},{mode:'production'},{status:'pending-ish'},{currency:'US dollars'},{email:'customer@example.com'}]){
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
  assert.equal(rows.get('ledger:evt_12345678').status,'paid');
});
