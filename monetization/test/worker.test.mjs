import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { generateApiKey, sha256, verifyStripeSignature } from '../src/worker.mjs';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
class D1Mock {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(schema); }
  prepare(sql) { const db = this.db; return { bind(...params) { return {
    run: async () => db.prepare(sql).run(...params),
    first: async () => db.prepare(sql).get(...params),
  }; } }; }
  async batch(items) { this.db.exec('BEGIN'); try { const results=[]; for (const p of items) results.push(await p.run()); this.db.exec('COMMIT'); return results; } catch(err) { this.db.exec('ROLLBACK'); throw err; } }
}
const signature = (payload, secret, t = Math.floor(Date.now()/1000)) => {
  const v = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v}`;
};
const env = () => ({ DB: new D1Mock(), STRIPE_SECRET_KEY: 'sk_test_FAKE', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_PRICE_ID: 'price_test_fake', STRIPE_EXPECTED_AMOUNT_MINOR: '300', STRIPE_EXPECTED_CURRENCY:'usd', PUBLIC_BASE_URL:'https://paid.example.com', CREDITS_PER_PURCHASE: '3', CHECKOUT_ENABLED: 'true', PREMIUM_ENABLED: 'true' });

async function webhook(event, e) {
  const body = JSON.stringify({livemode: false, ...event});
  return worker.fetch(new Request('https://paid.example.com/api/stripe/webhook', {method:'POST',headers:{'stripe-signature':signature(body,e.STRIPE_WEBHOOK_SECRET)},body}), e);
}

test('key format and cryptographic digest', async () => {
  const a=generateApiKey(),b=generateApiKey();
  assert.match(a, /^jco_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a,b);
  assert.equal((await sha256(a)).length,64);
});
test('webhook signature validates correct data, denies tampering and stale signature',async()=>{
  const body='{"id":"evt_test"}', secret='whsec_fake';
  assert.equal(await verifyStripeSignature(body,signature(body,secret),secret),true);
  assert.equal(await verifyStripeSignature(body+'x',signature(body,secret),secret),false);
  assert.equal(await verifyStripeSignature(body,signature(body,secret,Math.floor(Date.now()/1000)-900),secret),false);
});
test('unpaid access forbidden; signed paid webhook activates key; replay safe; refund revokes',async()=>{
  const e=env();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async (url,opts)=>{
    assert.match(opts.headers.authorization,/^Bearer sk_test_/);
    if (url === 'https://api.stripe.com/v1/prices/price_test_fake') {
      return new Response(JSON.stringify({id:'price_test_fake',active:true,livemode:false,type:'one_time',recurring:null,unit_amount:300,currency:'usd'}),{status:200});
    }
    if (url === 'https://api.stripe.com/v1/checkout/sessions') {
      assert.ok(opts.body.includes('price_test_fake'));
      return new Response(JSON.stringify({id:'cs_test_abc',url:'https://checkout.stripe.com/c/pay/example'}),{status:200});
    }
    assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions/cs_test_abc/line_items?limit=10');
    return new Response(JSON.stringify({has_more:false,data:[{price:{id:'price_test_fake',type:'one_time'},quantity:1,amount_total:300,currency:'usd'}]}),{status:200});
  };
  try {
    const start = await worker.fetch(new Request('https://paid.example.com/api/checkout',{method:'POST'}),e);
    assert.equal(start.status,200);
    const purchase=await start.json();
    assert.equal(purchase.credits_after_payment,3);
    const hdr={Authorization:`Bearer ${purchase.api_key}`};
    assert.equal((await worker.fetch(new Request('https://paid.example.com/api/premium/example',{headers:hdr}),e)).status,402);
    assert.equal((await (await worker.fetch(new Request('https://paid.example.com/api/credits',{headers:hdr}),e)).json()).status,'pending');
    const hash=await sha256(purchase.api_key);
    assert.ok(e.DB.db.prepare('SELECT token_hash FROM access_tokens WHERE token_hash=?').get(hash));
    const event={id:'evt_001',type:'checkout.session.completed',data:{object:{id:'cs_test_abc',mode:'payment',payment_status:'paid',amount_total:300,currency:'usd',payment_intent:'pi_123',metadata:{purpose:'jussco_api_credits',token_hash:hash}}}};
    assert.equal((await webhook(event,e)).status,200);
    assert.equal((await webhook(event,e)).status,200); // delivery replay does NOT grant extra credits
    assert.equal((await (await worker.fetch(new Request('https://paid.example.com/api/credits',{headers:hdr}),e)).json()).remaining,3);
    assert.equal((await worker.fetch(new Request('https://paid.example.com/api/premium/example',{headers:hdr}),e)).status,200);
    assert.equal((await (await worker.fetch(new Request('https://paid.example.com/api/credits',{headers:hdr}),e)).json()).remaining,2);
    assert.equal((await webhook({id:'evt_002',type:'charge.refunded',data:{object:{payment_intent:'pi_123'}}},e)).status,200);
    assert.equal((await (await worker.fetch(new Request('https://paid.example.com/api/credits',{headers:hdr}),e)).json()).status,'revoked');
    assert.equal((await worker.fetch(new Request('https://paid.example.com/api/premium/example',{headers:hdr}),e)).status,402);
  } finally { globalThis.fetch=originalFetch; }
});
test('unsigned and mismatched checkout events cannot create credits',async()=>{
  const e=env();
  const unsigned=await worker.fetch(new Request('https://paid.example.com/api/stripe/webhook',{method:'POST',body:'{}'}),e);
  assert.equal(unsigned.status,400);
  const mismatched={id:'evt_unknown',type:'checkout.session.completed',data:{object:{id:'cs_test_forge',mode:'payment',payment_status:'paid',payment_intent:'pi_unknown',metadata:{purpose:'jussco_api_credits',token_hash:'a'.repeat(64)}}}};
  assert.equal((await webhook(mismatched,e)).status,200);
  assert.equal(e.DB.db.prepare('SELECT COUNT(*) AS n FROM access_tokens').get().n,0);
});
test('unknown paths and public health are isolated',async()=>{
  const e=env();
  assert.equal((await worker.fetch(new Request('https://paid.example.com/health'),e)).status,200);
  assert.equal((await worker.fetch(new Request('https://paid.example.com/api/checkout'),e)).status,404);
  assert.equal((await worker.fetch(new Request('https://paid.example.com/api/checkout/me'),e)).status,404);
  assert.equal((await worker.fetch(new Request('https://paid.example.com/api/premium/example'),e)).status,401);
});

test('checkout and paid resources are disabled by default', async()=>{
  const e=env(); delete e.CHECKOUT_ENABLED; delete e.PREMIUM_ENABLED;
  assert.equal((await worker.fetch(new Request('https://paid.example.com/api/checkout',{method:'POST'}),e)).status,503);
  assert.equal((await worker.fetch(new Request('https://paid.example.com/api/premium/example'),e)).status,503);
});

test('refund-before-completion is remembered and prevents granting credits', async()=>{
  const e=env(), key=generateApiKey(), hash=await sha256(key);
  e.DB.db.prepare('INSERT INTO access_tokens(token_hash, checkout_session_id, status, remaining, created_at, updated_at) VALUES(?, ?, ?, 0, 1, 1)').run(hash,'cs_test_late','pending');
  assert.equal((await webhook({id:'evt_refund_early',type:'charge.refunded',data:{object:{payment_intent:'pi_early'}}},e)).status,200);
  assert.equal((await webhook({id:'evt_paid_late',type:'checkout.session.completed',data:{object:{id:'cs_test_late',mode:'payment',payment_status:'paid',amount_total:300,currency:'usd',payment_intent:'pi_early',metadata:{purpose:'jussco_api_credits',token_hash:hash}}}},e)).status,200);
  const result=await (await worker.fetch(new Request('https://paid.example.com/api/credits',{headers:{Authorization:'Bearer '+key}}),e)).json();
  assert.equal(result.status,'pending');
  assert.equal(result.remaining,0);
});