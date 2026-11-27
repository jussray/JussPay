import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{PRODUCT_IDS} from '../src/worker.mjs';
import {combinedEnv} from './harness.mjs';

const productId=PRODUCT_IDS.chief,priceId='price_ChiefLiveFixture',couponId='coupon_ChiefLiveFixture';
const subject='chief-user',customer='cus_ChiefLiveFixture',session='cs_live_ChiefFixture',sub='sub_ChiefFixture';
const plan={approved:true,priceId,unitAmount:2900,currency:'usd',interval:'month',
  termsUrl:'https://app.example/chief-terms',entitlements:['chief.local_fixture'],
  intro:{approved:true,firstInvoiceAmountMinor:100,couponId,renewalConsentRequired:true,
    tax:{behavior:'inclusive',productCode:'txcd_10105001'}}};

function fixture(){
  const {env,billing,state}=combinedEnv({subject});
  Object.assign(env,{STRIPE_LIVE:'true',STRIPE_SECRET_KEY:'sk_live_fixture_only',INTRODUCTORY_OFFERS_ENABLED:'true',
    CHIEF_LIVE_INTRO_APPROVED:'true',APPROVED_PLANS:JSON.stringify({chief:plan})});
  const calls=[],stateSwitch={completed:false,renewal:false,badCoupon:false,badSession:false,badInvoice:false,
    badIdentity:false,otherSubscription:false,badRenewal:false};
  const tax={enabled:true,status:'complete'};
  env.STRIPE_FETCH=async(url,init)=>{
    const {pathname}=new URL(url);calls.push({pathname,body:init.body});
    if(pathname==='/v1/account')return Response.json({id:'acct_1U4xNyRs4gw4sfJH',charges_enabled:true,details_submitted:true});
    if(pathname==='/v1/customers')return Response.json({id:customer});
    if(pathname==='/v1/customers/'+customer)return Response.json({id:customer,livemode:true,metadata:{jusspay_subject:subject}});
    if(pathname==='/v1/prices/'+priceId)return Response.json({id:priceId,active:true,livemode:true,tax_behavior:'inclusive',
      currency:'usd',unit_amount:2900,recurring:{interval:'month',interval_count:1},
      product:{id:productId,active:true,livemode:true,tax_code:'txcd_10105001'}});
    if(pathname==='/v1/coupons/'+couponId)return Response.json({id:couponId,valid:true,livemode:!stateSwitch.badCoupon,
      duration:'once',currency:'usd',amount_off:2800,applies_to:{products:[productId]}});
    if(pathname==='/v1/checkout/sessions'||pathname==='/v1/checkout/sessions/'+session)
      return Response.json({id:session,customer,client_reference_id:subject,livemode:!stateSwitch.badSession,mode:'subscription',
        status:stateSwitch.completed?'complete':'open',payment_status:stateSwitch.completed?'paid':'unpaid',
        subscription:stateSwitch.otherSubscription?'sub_other':sub,currency:'usd',amount_total:100,
        billing_address_collection:'required',automatic_tax:tax,url:'https://checkout.stripe.com/c/fixture'});
    if(pathname==='/v1/subscriptions/'+sub)return Response.json({id:sub,customer,livemode:true,status:'active',
      metadata:{jusspay_subject:stateSwitch.badIdentity?'another-user':subject,jusspay_product:'chief',jusspay_intro:'usd_100_first_month_v1'},
      automatic_tax:tax,latest_invoice:stateSwitch.renewal?'in_Renewal':'in_First',
      items:{data:[{quantity:1,price:{id:priceId},current_period_end:Date.now()/1000+3600}]}});
    if(pathname.startsWith('/v1/invoices/')){
      const amount=stateSwitch.renewal?(stateSwitch.badRenewal?2800:2900):100;
      return Response.json({id:pathname.split('/').at(-1),customer,livemode:!stateSwitch.badInvoice,subscription:sub,
        status:'paid',billing_reason:stateSwitch.renewal?'subscription_cycle':'subscription_create',
        total:amount,amount_paid:amount,amount_remaining:0,currency:'usd',automatic_tax:tax,
        lines:{has_more:false,data:[{quantity:1,price:{id:priceId}}]}});
    }
    throw Error('Unexpected provider request: '+pathname);
  };
  const checkout=(product='chief',consent=true)=>worker.fetch(new Request('https://billing.example/checkout',{
    method:'POST',headers:{authorization:'Bearer signed-in-fixture','content-type':'application/json'},
    body:JSON.stringify({product,...(consent?{introConsent:{acceptsTerms:true,acceptsAutomaticRenewal:true,
      firstInvoiceAmountMinor:100,renewalAmountMinor:2900,interval:'month',termsUrl:plan.termsUrl}}:{})})
  }),env);
  const paid=async(id,live=true)=>{
    const raw=JSON.stringify({id,type:'invoice.paid',livemode:live,data:{object:{customer,subscription:sub}}});
    const t=Math.floor(Date.now()/1000),key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
      {name:'HMAC',hash:'SHA-256'},false,['sign']);
    const sig=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(t+'.'+raw))).toString('hex');
    return worker.fetch(new Request('https://billing.example/webhook',{method:'POST',
      headers:{'stripe-signature':`t=${t},v1=${sig}`},body:raw}),env);
  };
  return {env,state,billing,calls,stateSwitch,checkout,paid};
}

test('Chief live is opt-in, never silently falls back, and does not enable another app',async()=>{
  const f=fixture();
  delete f.env.CHIEF_LIVE_INTRO_APPROVED;
  assert.equal((await (await f.checkout()).json()).error,'introductory_offer_disabled');
  f.env.CHIEF_LIVE_INTRO_APPROVED='true';
  f.env.APPROVED_PLANS=JSON.stringify({chief:{...plan,intro:undefined},promptos:plan});
  assert.equal((await (await f.checkout('chief',false)).json()).error,'introductory_offer_required');
  assert.equal((await (await f.checkout('promptos')).json()).error,'introductory_offer_disabled');
  assert.deepEqual(f.calls,[]);
});

test('live session and coupon must match mode and price; checkout sends automatic tax and respects reuse',async()=>{
  const f=fixture();
  f.stateSwitch.badCoupon=true;
  assert.equal((await (await f.checkout()).json()).error,'introductory_discount_mismatch');
  f.stateSwitch.badCoupon=false;
  f.stateSwitch.badSession=true;
  assert.equal((await (await f.checkout()).json()).error,'introductory_checkout_total_mismatch');
  f.stateSwitch.badSession=false;
  const ok=await f.checkout();assert.equal(ok.status,200);assert.equal((await ok.json()).billingMode,'live');
  assert.equal((await f.checkout()).status,200);
  const wire=f.calls.find(x=>x.pathname==='/v1/checkout/sessions').body;
  assert.equal(wire.get('automatic_tax[enabled]'),'true');
  assert.equal(wire.get('billing_address_collection'),'required');
  assert.equal(wire.get('discounts[0][coupon]'),couponId);
  f.stateSwitch.badSession=true;
  assert.equal((await (await f.checkout()).json()).error,'introductory_checkout_total_mismatch');
});

test('signed $1 first invoice unlocks only the matching Chief account; $29 renewal retains access',async()=>{
  const f=fixture();assert.equal((await f.checkout()).status,200);
  assert.deepEqual(await f.billing.readEntitlements(),[]);
  f.stateSwitch.completed=true;
  assert.equal((await f.paid('evt_wrong_mode',false)).status,400);
  f.stateSwitch.badInvoice=true;
  assert.equal((await f.paid('evt_wrong_invoice')).status,200);
  assert.deepEqual(await f.billing.readEntitlements(),[]);
  f.stateSwitch.badInvoice=false;f.stateSwitch.otherSubscription=true;
  await f.paid('evt_wrong_session_sub');assert.deepEqual(await f.billing.readEntitlements(),[]);
  f.stateSwitch.otherSubscription=false;f.stateSwitch.badIdentity=true;
  assert.equal((await f.paid('evt_wrong_subject')).status,403);
  f.stateSwitch.badIdentity=false;
  assert.equal((await f.paid('evt_first')).status,200);
  assert.equal((await f.billing.readEntitlements())[0]?.product,'chief');
  assert.equal((await f.state.storage.get('introVerified:'+sub))?.amountPaid,100);
  f.stateSwitch.renewal=true;f.stateSwitch.badRenewal=true;
  await f.paid('evt_bad_renewal');assert.deepEqual(await f.billing.readEntitlements(),[]);
  assert.equal((await f.state.storage.list({prefix:'reconciledInvoice:chief:'})).size,1);
  f.stateSwitch.badRenewal=false;
  delete f.env.CHIEF_LIVE_INTRO_APPROVED; // rollback stops sales, not renewal recognition.
  assert.equal((await f.paid('evt_renewal')).status,200);
  assert.equal((await f.paid('evt_another_delivery')).status,200);
  assert.equal((await f.billing.readEntitlements())[0]?.product,'chief');
  const ledger=await f.state.storage.list({prefix:'reconciledInvoice:chief:'});
  assert.equal(ledger.size,2);
  assert.equal(ledger.get('reconciledInvoice:chief:in_First').amountMinor,100);
  assert.deepEqual(ledger.get('reconciledInvoice:chief:in_Renewal'),{
    product:'chief',subscription:sub,invoiceId:'in_Renewal',livemode:true,
    kind:'renewal',amountMinor:2900,currency:'usd',taxComplete:true
  });
});
