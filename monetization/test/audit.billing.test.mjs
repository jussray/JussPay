import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { generateApiKey, sha256 } from '../src/worker.mjs';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
class D1Mock {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(schema); }
  prepare(sql) { const db=this.db; return { bind(...args) { return { run: async()=>db.prepare(sql).run(...args), first: async()=>db.prepare(sql).get(...args) }; } }; }
  async batch(items){ this.db.exec('BEGIN'); try { for (const x of items) await x.run(); this.db.exec('COMMIT'); } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
}

test('PAID webhook with zero amount must not grant the configured paid credits', async()=>{
  const env={DB:new D1Mock(),STRIPE_WEBHOOK_SECRET:'whsec_test',CREDITS_PER_PURCHASE:'3',PREMIUM_ENABLED:'true',STRIPE_PRICE_ID:'price_required',STRIPE_EXPECTED_AMOUNT_MINOR:'300',STRIPE_EXPECTED_CURRENCY:'usd', STRIPE_SECRET_KEY:'sk_test_FAKE'};
  const key=generateApiKey(), hash=await sha256(key);
  env.DB.db.prepare("INSERT INTO access_tokens(token_hash, checkout_session_id, status, remaining, created_at, updated_at) VALUES (?, ?, 'pending', 0, 1, 1)").run(hash,'cs_test_existing');
  const event={id:'evt_zero_amount',livemode:false, type:'checkout.session.completed', data:{object:{id:'cs_test_existing',mode:'payment',payment_status:'paid',amount_total:0,currency:'usd',payment_intent:'pi_test_zero', metadata:{purpose:'jussco_api_credits',token_hash:hash}}}};
  const raw=JSON.stringify(event),ts=Math.floor(Date.now()/1000);
  const sig=`t=${ts},v1=${createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest('hex')}`;
  const result=await worker.fetch(new Request('https://paid.example.com/api/stripe/webhook',{method:'POST',headers:{'stripe-signature':sig},body:raw}),env);
  assert.equal(result.status,200);
  const credits=env.DB.db.prepare('SELECT remaining FROM access_tokens WHERE token_hash = ?').get(hash);
  assert.equal(credits.remaining,0,'A zero-dollar paid session must not create billable credits');
});