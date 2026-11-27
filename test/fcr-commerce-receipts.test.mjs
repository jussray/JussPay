import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCommerceReceipt,sendCommerceReceipt} from '../src/fcr-commerce-receipts.mjs';
const env={JUSSPAY_FCR_HASH_KEY:'hash-'+ 'x'.repeat(40),RELEASE_SHA:'a'.repeat(40),JUSSPAY_FCR_RECEIPTS_ENABLED:'true',JUSSPAY_FCR_RECEIPT_KEY:'send-'+ 'y'.repeat(40)};
const fact={orderId:'jbho_11111111-1111-4111-8111-111111111111',eventId:'evt_fixture',product:'jbh',event:'payment_recorded',grossMinor:1000,occurredAt:1795780800000,livemode:true};
test('redacted receipt is deterministic, scoped to a live verified fact, with no raw identifier',async()=>{
 const receipt=await buildCommerceReceipt(env,fact);
 assert.deepEqual(Object.keys(receipt).sort(),['schema','receiptId','orderRefHash','product','mode','event','grossMinor','currency','occurredAt','releaseSha'].sort());
 assert.equal(receipt.schema,'jusspay/commerce-receipt@v1');
 assert.equal(receipt.grossMinor,1000);
 assert.match(receipt.orderRefHash,/^[a-f0-9]{64}$/);assert.match(receipt.receiptId,/^[a-f0-9]{64}$/);
 assert.deepEqual(await buildCommerceReceipt(env,fact),receipt);
 assert.notEqual((await buildCommerceReceipt(env,{...fact,eventId:'evt_hold',event:'refund_hold',grossMinor:null})).receiptId,receipt.receiptId);
 assert.equal((await buildCommerceReceipt(env,{...fact,eventId:'evt_hold',event:'refund_hold',grossMinor:null})).orderRefHash,receipt.orderRefHash);
 assert.doesNotMatch(JSON.stringify(receipt),/evt_fixture|jbho_|buyer@|send-|hash-/);
 for(const invalid of [{livemode:false},{grossMinor:0},{event:'dispute_hold'},{email:'buyer@example.test'}])assert.equal(await buildCommerceReceipt(env,{...fact,...invalid}),null);
 assert.equal(await buildCommerceReceipt({...env,JUSSPAY_FCR_HASH_KEY:env.JUSSPAY_FCR_RECEIPT_KEY},fact),null);
});
test('sender requires exact durable FCR acknowledgment and never treats generic HTTP success as delivery',async()=>{
 const receipt=await buildCommerceReceipt(env,fact);
 let n=0;
 const e={...env,JUSSPAY_FCR:{fetch:async req=>{
   n++;assert.equal(new URL(req.url).pathname,'/ingest/jusspay-receipts');
   assert.equal(req.headers.get('x-jusspay-receipt-key'),env.JUSSPAY_FCR_RECEIPT_KEY);
   assert.deepEqual(await req.json(),receipt);
   return Response.json(n===1?{accepted:true}:{accepted:true,receiptId:receipt.receiptId,duplicate:true});
 }}};
 assert.equal(await sendCommerceReceipt(e,receipt),false);
 assert.equal(await sendCommerceReceipt(e,receipt),true);
 assert.equal(await sendCommerceReceipt({...e,JUSSPAY_FCR_RECEIPTS_ENABLED:'false'},receipt),false);
 assert.equal(n,2);
});
