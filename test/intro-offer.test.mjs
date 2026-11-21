import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { plans } from '../src/worker.mjs';
import { combinedEnv } from './harness.mjs';

const product='promptos';
const plan=Object.freeze({
  approved:true,priceId:'price_introrenewal',unitAmount:1900,currency:'usd',
  interval:'month',termsUrl:'https://merchant.example/promptos-terms',
  entitlements:['promptos.personal_prompts'],
  intro:{approved:true,firstInvoiceAmountMinor:100,couponId:'coupon_intro_once',renewalConsentRequired:true}
});
const consent=Object.freeze({
  acceptsTerms:true,acceptsAutomaticRenewal:true,firstInvoiceAmountMinor:100,
  renewalAmountMinor:1900,interval:'month',termsUrl:plan.termsUrl
});

function scenario({intro=plan.intro,renewalConsent=consent,invalidCoupon=false,firstInvoicePaid=true,
  sessionTotal=100,invoiceTotal=100,invoicePrice=plan.priceId,wrongMode=false}={}) {
  const {env,billing,state}=combinedEnv({subject:'person-a'});
  const config={...plan,intro};
  env.APPROVED_PLANS=JSON.stringify({[product]:config});
  env.INTRODUCTORY_OFFERS_ENABLED='true';
  env.APP_ORIGIN='https://merchant.example';
  const calls=[];
  let latestInvoice='in_first';
  env.STRIPE_FETCH=async (url,options={})=>{
    const path=new URL(url).pathname;const method=options.method||'GET';
    const params=options.body||new URLSearchParams();
    calls.push({path,method,params});
    if(path==='/v1/account')return Response.json({id:'acct_1U4xNyRs4gw4sfJH',charges_enabled:true,details_submitted:true});
    if(path==='/v1/customers')return Response.json({id:'cus_persona'});
    if(path==='/v1/customers/cus_persona')return Response.json({id:'cus_persona',livemode:false,metadata:{jusspay_subject:'person-a'}});
    if(path==='/v1/prices/price_introrenewal')return Response.json({
      id:plan.priceId,active:true,livemode:false,unit_amount:1900,currency:'usd',
      product:{id:'prod_VZSVPKfsqwNYrQ',active:true,livemode:false},
      recurring:{interval:'month',interval_count:1,usage_type:'licensed'}
    });
    if(path==='/v1/coupons/coupon_intro_once')return Response.json({
      id:'coupon_intro_once',valid:true,livemode:false,duration:invalidCoupon?'forever':'once',
      amount_off:1800,currency:'usd',percent_off:null,
      applies_to:{products:['prod_VZSVPKfsqwNYrQ']}
    });
    if(path==='/v1/checkout/sessions/cs_intro')return Response.json({
      id:'cs_intro',customer:'cus_persona',status:'open',mode:'subscription',
      livemode:false,amount_total:100,url:'https://checkout.stripe.com/c/test_intro'
    });
    if(path==='/v1/checkout/sessions')return Response.json({id:'cs_intro',mode:'subscription',
      livemode:false,amount_total:sessionTotal,url:'https://checkout.stripe.com/c/test_intro'});
    if(path==='/v1/subscriptions/sub_intro')return Response.json({
      id:'sub_intro',customer:'cus_persona',status:'active',latest_invoice:latestInvoice,
      metadata:{jusspay_subject:'person-a',jusspay_product:'promptos',jusspay_intro:'usd_100_first_month_v1'},
      items:{data:[{quantity:1,price:{id:plan.priceId},current_period_end:Date.now()/1000+3600}]}
    });
    if(path==='/v1/invoices/in_first')return Response.json({
      id:'in_first',customer:'cus_persona',subscription:wrongMode?'sub_other':'sub_intro',
      livemode:false,status:firstInvoicePaid?'paid':'open',billing_reason:'subscription_create',
      currency:'usd',total:invoiceTotal,amount_paid:firstInvoicePaid?invoiceTotal:0,
      amount_remaining:firstInvoicePaid?0:invoiceTotal,
      lines:{has_more:false,data:[{quantity:1,price:{id:invoicePrice}}]}
    });
    throw new Error('Unexpected provider call '+path);
  };
  const checkout=()=>worker.fetch(new Request('https://billing.example/checkout',{
    method:'POST',headers:{authorization:'Bearer person-a','Content-Type':'application/json'},
    body:JSON.stringify({product,introConsent:renewalConsent,unitAmount:1,priceId:'price_attacker'})
  }),env);
  const ev=(id='evt_first')=>billing.event({event:{id,type:'invoice.paid',data:{object:{
    customer:'cus_persona',subscription:'sub_intro'
  }}},customerId:'cus_persona',subject:'person-a'});
  return {env,billing,state,calls,checkout,ev,paidInvoice:()=>{latestInvoice='in_first';},
    renew:()=>{latestInvoice='in_renewal';}};
}

test('optional introductory contract must be exact, approved and first USD $1',()=>{
  for(const invalid of [
    {approved:false}, {firstInvoiceAmountMinor:99}, {couponId:'bad_coupon'},
    {renewalConsentRequired:false}
  ])assert.throws(()=>plans({APPROVED_PLANS:JSON.stringify({promptos:{...plan,intro:{...plan.intro,...invalid}}})}),/unapproved_intro_offer/);
  assert.equal(plans({APPROVED_PLANS:JSON.stringify({promptos:plan})}).promptos.intro.firstInvoiceAmountMinor,100);
});

test('no live or unapproved introductory activation; no checkout without renewal consent',async()=>{
  for(const change of [
    s=>{s.env.INTRODUCTORY_OFFERS_ENABLED='false'},
    s=>{s.env.STRIPE_LIVE='true'},
    s=>{s.env.APPROVED_PLANS=JSON.stringify({promptos:{...plan,intro:undefined}})}
  ]){
    const s=scenario();change(s);const r=await s.checkout();
    assert.equal(r.status,503);
    assert(!s.calls.some(x=>x.path==='/v1/checkout/sessions'));
  }
  for(const denied of [null,{...consent,renewalAmountMinor:900},{...consent,acceptsAutomaticRenewal:false},
    {...consent,termsUrl:'https://attacker.example/terms'}]){
    const s=scenario({renewalConsent:denied});const r=await s.checkout();
    assert.equal(r.status,409);
    assert.equal((await r.json()).error,'renewal_consent_required');
    assert(!s.calls.some(x=>x.path==='/v1/checkout/sessions'));
  }
});

test('provider discount must be once-only and reconcile to exactly USD $1',async()=>{
  const s=scenario({invalidCoupon:true});const r=await s.checkout();
  assert.equal(r.status,503);
  assert.equal((await r.json()).error,'introductory_discount_mismatch');
  assert(!s.calls.some(x=>x.path==='/v1/checkout/sessions'));
  const wrong=scenario({sessionTotal:500});const rr=await wrong.checkout();
  assert.equal(rr.status,503);
  assert.equal((await rr.json()).error,'introductory_checkout_total_mismatch');
});

test('valid sandbox introduction creates a single provider-priced checkout with $1 total',async()=>{
  const s=scenario();const r=await s.checkout();
  assert.equal(r.status,200);
  const body=await r.json();assert.equal(body.firstInvoiceAmountMinor,100);
  assert.equal(body.renewalAmountMinor,1900);
  assert.equal(body.termsUrl,plan.termsUrl);
  const create=s.calls.find(x=>x.path==='/v1/checkout/sessions');
  assert.equal(create.params.get('discounts[0][coupon]'),'coupon_intro_once');
  assert.equal(create.params.get('line_items[0][price]'),plan.priceId);
  assert.equal(create.params.get('subscription_data[metadata][jusspay_intro]'),'usd_100_first_month_v1');
  assert.equal(create.params.get('client_reference_id'),'person-a');
  assert.deepEqual(await s.billing.readEntitlements(),[]);
  const recorded=await s.state.storage.get('introConsent:promptos');
  assert.equal(recorded.firstInvoiceAmountMinor,100);
  assert.equal(recorded.renewalAmountMinor,1900);
  assert.equal(recorded.session,'cs_intro');
  const reused=await s.checkout();
  assert.equal(reused.status,200);
  assert.equal((await reused.json()).renewalAmountMinor,1900);
  assert.equal(s.calls.filter(x=>x.path==='/v1/checkout/sessions').length,1);
});

test('active subscription cannot grant access before verified first paid invoice',async()=>{
  for(const cfg of [{firstInvoicePaid:false},{invoiceTotal:110},{invoicePrice:'price_wrong'},{wrongMode:true}]){
    const s=scenario(cfg);await s.state.storage.put('customer','cus_persona');
    assert.equal((await s.ev()).status,200);
    assert.deepEqual(await s.billing.readEntitlements(),[]);
    assert.equal(await s.state.storage.get('introRedeemed:promptos'),undefined);
  }
});

test('paid first invoice grants entitlement, persists redemption and blocks another $1 after cancel',async()=>{
  const s=scenario();await s.state.storage.put('customer','cus_persona');
  assert.equal((await s.ev()).status,200);
  const rows=await s.billing.readEntitlements();
  assert.equal(rows.length,1);assert.equal(rows[0].product,'promptos');
  assert.deepEqual(rows[0].entitlements,['promptos.personal_prompts']);
  assert.equal((await s.state.storage.get('introVerified:sub_intro')).amountPaid,100);
  assert.equal((await s.state.storage.get('introRedeemed:promptos')).invoiceId,'in_first');
  const replay=await s.ev('evt_second');assert.equal(replay.status,200);
  assert.equal((await s.billing.readEntitlements()).length,1);
  const again=await s.checkout();assert.equal(again.status,409);
  assert.equal((await again.json()).error,'introductory_offer_already_redeemed');
  assert(!s.calls.some(x=>x.path==='/v1/checkout/sessions'));
});

test('signed Stripe invoice webhook verifies the $1 and refund revokes access without checkout redirect',async()=>{
  const s=scenario();
  async function signedEvent(id,type,object){
    const event={id,livemode:false,type,data:{object}};
    const raw=JSON.stringify(event),t=Math.floor(Date.now()/1000);
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(s.env.STRIPE_WEBHOOK_SECRET),
      {name:'HMAC',hash:'SHA-256'},false,['sign']);
    const digest=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${t}.${raw}`));
    const signature=`t=${t},v1=${Buffer.from(digest).toString('hex')}`;
    return worker.fetch(new Request('https://billing.example/webhook',{method:'POST',
      headers:{'stripe-signature':signature,'content-type':'application/json'},body:raw}),s.env);
  }
  const invoice={id:'in_first',customer:'cus_persona',subscription:'sub_intro'};
  const bad=await worker.fetch(new Request('https://billing.example/webhook',{method:'POST',
    headers:{'stripe-signature':'invalid'},body:JSON.stringify({id:'evt_invalid',livemode:false,
      type:'invoice.paid',data:{object:invoice}})}),s.env);
  assert.equal(bad.status,400);
  assert.equal((await s.billing.readEntitlements()).length,0);
  const paid=await signedEvent('evt_signed_intro','invoice.paid',invoice);
  assert.equal(paid.status,200);
  assert.equal((await s.billing.readEntitlements()).length,1);
  const replay=await signedEvent('evt_signed_intro','invoice.paid',invoice);
  assert.equal(replay.status,200);
  assert.equal((await s.billing.readEntitlements()).length,1);
  const refunded=await signedEvent('evt_refund_intro','charge.refunded',{
    id:'ch_refunded',customer:'cus_persona'
  });
  assert.equal(refunded.status,200);
  assert.deepEqual(await s.billing.readEntitlements(),[]);
});
