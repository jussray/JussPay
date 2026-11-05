import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { sha256, generateApiKey } from '../src/worker.mjs';

const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
class DB {
  constructor(){this.db=new DatabaseSync(':memory:');this.db.exec(schema);}
  prepare(sql){const d=this.db;return {bind(...args){return {
    run: async()=>d.prepare(sql).run(...args),
    first: async()=>d.prepare(sql).get(...args)
  };}};}
  async batch(items){this.db.exec('BEGIN');try{for(const s of items)await s.run();this.db.exec('COMMIT');}catch(err){this.db.exec('ROLLBACK');throw err;}}
}
const makeEnv=()=>({DB:new DB(),STRIPE_SECRET_KEY:'sk_test_fake',STRIPE_WEBHOOK_SECRET:'whsec_fake',STRIPE_PRICE_ID:'price_expected',STRIPE_EXPECTED_AMOUNT_MINOR:'500',STRIPE_EXPECTED_CURRENCY:'usd',CREDITS_PER_PURCHASE:'4',CHECKOUT_ENABLED:'true',PREMIUM_ENABLED:'false',PUBLIC_BASE_URL:'https://paid.example.com'});
async function seed(e){const token=generateApiKey(),hash=await sha256(token);
  e.DB.db.prepare("INSERT INTO access_tokens(token_hash,checkout_session_id,status,remaining,created_at,updated_at) VALUES (?,?,'pending',0,1,1)").run(hash,'cs_test_known');
  return hash;
}
function paid(hash,override={}){
  return {id:'evt_paid_1',type:'checkout.session.completed',livemode:false,data:{object:{
    id:'cs_test_known',mode:'payment',payment_status:'paid',amount_total:500,currency:'usd',payment_intent:'pi_good',
    metadata:{purpose:'jussco_api_credits',token_hash:hash},...override
  }}};
}
async function send(e,event){const raw=JSON.stringify(event),ts=Math.floor(Date.now()/1000);
  const signature=createHmac('sha256',e.STRIPE_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest('hex');
  return worker.fetch(new Request('https://paid.example.com/api/stripe/webhook',{method:'POST',headers:{'stripe-signature':`t=${ts},v1=${signature}`},body:raw}),e);
}
function remaining(e,hash){return e.DB.db.prepare('SELECT remaining FROM access_tokens WHERE token_hash=?').get(hash).remaining;}
const validLineItem={has_more:false,data:[{price:{id:'price_expected',type:'one_time'},quantity:1,amount_total:500,currency:'usd'}]};
async function withStripeMock(payload,fn,{httpStatus=200}={}){
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async (url,opts)=>{calls++;assert.equal(url,'https://api.stripe.com/v1/checkout/sessions/cs_test_known/line_items?limit=10');
    assert.equal(opts.headers.authorization,'Bearer sk_test_fake');
    return new Response(JSON.stringify(payload),{status:httpStatus});
  };
  try {await fn(()=>calls);} finally {globalThis.fetch=old;}
}
test('signed 0-amount and wrong-currency events do not earn credits or call Stripe',async()=>{
  const e=makeEnv(),hash=await seed(e);const old=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error('unexpected provider lookup');};
  try {
    assert.equal((await send(e,paid(hash,{amount_total:0}))).status,200);
    assert.equal((await send(e,paid(hash,{currency:'eur'}))).status,200);
    assert.equal(remaining(e,hash),0);
  } finally {globalThis.fetch=old;}
});
test('wrong price ID, wrong quantity, multi-line and paginated sessions cannot grant credits',async()=>{
  for(const lines of [
    {...validLineItem,data:[{...validLineItem.data[0],price:{id:'price_other',type:'one_time'}}]},
    {...validLineItem,data:[{...validLineItem.data[0],quantity:2}]},
    {...validLineItem,data:[...validLineItem.data,...validLineItem.data]},
    {...validLineItem,has_more:true},
  ]){
    const e=makeEnv(),hash=await seed(e);
    await withStripeMock(lines,async(calls)=>{
      assert.equal((await send(e,paid(hash))).status,200);
      assert.equal(calls(),1);
      assert.equal(remaining(e,hash),0);
    });
  }
});
test('matching paid session grants credits exactly once even with distinct duplicate event IDs',async()=>{
  const e=makeEnv(),hash=await seed(e);
  await withStripeMock(validLineItem,async(calls)=>{
    assert.equal((await send(e,paid(hash))).status,200);
    assert.equal(remaining(e,hash),4);
    assert.equal((await send(e,{...paid(hash),id:'evt_paid_retry'})).status,200);
    assert.equal(remaining(e,hash),4);
    assert.equal(calls(),1);
  });
});
test('Stripe verification outage denies credits and returns retryable 503',async()=>{
  const e=makeEnv(),hash=await seed(e);
  await withStripeMock({error:'temporarily unavailable'},async()=>{
    assert.equal((await send(e,paid(hash))).status,503);
    assert.equal(remaining(e,hash),0);
  },{httpStatus:503});
  await withStripeMock(validLineItem,async()=>{
    assert.equal((await send(e,paid(hash))).status,200);
    assert.equal(remaining(e,hash),4);
  });
});
test('missing expected price configuration fails closed for checkout and fulfillment',async()=>{
  const e=makeEnv(),hash=await seed(e);
  delete e.STRIPE_EXPECTED_AMOUNT_MINOR;
  assert.equal((await worker.fetch(new Request('https://paid.example.com/api/checkout',{method:'POST'}),e)).status,503);
  assert.equal((await send(e,paid(hash))).status,503);
  assert.equal(remaining(e,hash),0);
});
test('mismatched Stripe test/live mode is rejected',async()=>{
  const e=makeEnv(),hash=await seed(e);
  assert.equal((await send(e,{...paid(hash),livemode:true})).status,400);
  assert.equal(remaining(e,hash),0);
});
test('checkout refuses to create a payment session if Stripe Price amount mismatches the approved amount',async()=>{
  const e=makeEnv();let calls=[];const old=globalThis.fetch;
  globalThis.fetch=async (url,opts)=>{
    calls.push([url,opts.method]);
    if(url==='https://api.stripe.com/v1/prices/price_expected')return new Response(JSON.stringify({
      id:'price_expected',active:true,livemode:false,type:'one_time',unit_amount:100,currency:'usd',recurring:null
    }),{status:200});
    if(url==='https://api.stripe.com/v1/checkout/sessions')return new Response(JSON.stringify({id:'cs_test_abc',url:'https://checkout.stripe.com/c/pay/test'}),{status:200});
    throw Error('Unexpected Stripe request');
  };
  try {
    const response=await worker.fetch(new Request('https://paid.example.com/api/checkout',{method:'POST'}),e);
    assert.equal(response.status,503);
    assert.equal(e.DB.db.prepare('SELECT COUNT(*) AS n FROM access_tokens').get().n,0);
    assert.equal(calls.some(([u])=>u==='https://api.stripe.com/v1/checkout/sessions'),false);
  }finally{globalThis.fetch=old;}
});