import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {combinedEnv} from './harness.mjs';

const productId='prod_VhYtj7P5WWqGvm';
const priceId='price_1Ug9m7Rs4gw4sfJHeR4RBBn7';
const couponId='coupon_chief_personal_1usd_test_v1';
const taxCode='txcd_10105001';
const termsUrl='https://merchant.example/test-terms';
const plan={approved:true,priceId,unitAmount:2900,currency:'usd',interval:'month',
  termsUrl,entitlements:['chief.fixture_access'],intro:{approved:true,couponId,
    firstInvoiceAmountMinor:100,renewalConsentRequired:true,tax:{behavior:'inclusive',productCode:taxCode}}};

function scenario(overrides={}){
  const {env,billing,state}=combinedEnv({subject:'person-a'});
  env.TEST_STRIPE_CONFIG=JSON.stringify({approved:true,accountId:'acct_1U4xNyRs4gw4sfJH',
    verificationReceipt:'local test only',products:{chief:productId}});
  env.APPROVED_PLANS=JSON.stringify({chief:plan});
  env.INTRODUCTORY_OFFERS_ENABLED='true';
  const calls=[];
  const session={id:'cs_fixture',customer:'cus_example',status:'open',mode:'subscription',livemode:false,
    amount_total:100,billing_address_collection:'required',automatic_tax:{enabled:true,status:'requires_location_inputs'},
    url:'https://checkout.stripe.com/c/fixture',...overrides.session};
  env.STRIPE_FETCH=async(url,request={})=>{
    const {pathname,searchParams}=new URL(url);
    calls.push({pathname,searchParams,request});
    if(pathname==='/v1/account')return Response.json({id:'acct_1U4xNyRs4gw4sfJH',charges_enabled:true,details_submitted:true});
    if(pathname==='/v1/customers')return Response.json({id:'cus_example'});
    if(pathname==='/v1/prices/'+priceId)return Response.json({id:priceId,active:true,livemode:false,
      unit_amount:2900,currency:'usd',tax_behavior:overrides.behavior??'inclusive',
      recurring:{interval:'month',interval_count:1,usage_type:'licensed'},product:{
        id:productId,active:true,livemode:false,tax_code:overrides.taxCode??taxCode}});
    if(pathname==='/v1/coupons/'+couponId){
      assert.deepEqual(searchParams.getAll('expand[]'),['applies_to']);
      return Response.json({id:couponId,valid:true,livemode:false,duration:'once',currency:'usd',
        amount_off:2800,percent_off:null,applies_to:{products:[productId]}});
    }
    if(pathname==='/v1/checkout/sessions/cs_fixture')return Response.json({...session,...overrides.reuse});
    if(pathname==='/v1/checkout/sessions')return Response.json(session);
    if(pathname==='/v1/subscriptions/sub_fixture')return Response.json({id:'sub_fixture',customer:'cus_example',
      status:'active',latest_invoice:'in_fixture',automatic_tax:{enabled:overrides.subscriptionTax??true},
      metadata:{jusspay_subject:'person-a',jusspay_product:'chief',jusspay_intro:'usd_100_first_month_v1'},
      items:{data:[{quantity:1,price:{id:priceId},current_period_end:Date.now()/1000+3600}]}});
    if(pathname==='/v1/invoices/in_fixture')return Response.json({id:'in_fixture',customer:'cus_example',
      subscription:'sub_fixture',livemode:false,status:'paid',billing_reason:'subscription_create',
      currency:'usd',total:100,amount_paid:100,amount_remaining:0,
      automatic_tax:{enabled:true,status:'complete'},...overrides.invoice,
      lines:{has_more:false,data:[{quantity:1,price:{id:priceId}}]}});
    throw new Error('Unexpected provider call '+pathname);
  };
  const checkout=()=>worker.fetch(new Request('https://billing.example/checkout',{
    method:'POST',headers:{authorization:'Bearer person-a','content-type':'application/json'},
    body:JSON.stringify({product:'chief',introConsent:{acceptsTerms:true,acceptsAutomaticRenewal:true,
      firstInvoiceAmountMinor:100,renewalAmountMinor:2900,interval:'month',termsUrl}})
  }),env);
  const paid=()=>billing.event({event:{id:'evt_paid_fixture',type:'invoice.paid',
    data:{object:{customer:'cus_example',subscription:'sub_fixture'}}},customerId:'cus_example',subject:'person-a'});
  return {calls,billing,state,checkout,paid};
}

test('inclusive intro uses the sandbox price and scoped coupon, requests tax, and collects billing address',async()=>{
  const s=scenario();
  const response=await s.checkout();
  assert.equal(response.status,200);
  assert.equal((await response.json()).renewalAmountMinor,2900);
  const params=s.calls.find(x=>x.pathname==='/v1/checkout/sessions').request.body;
  assert.equal(params.get('automatic_tax[enabled]'),'true');
  assert.equal(params.get('billing_address_collection'),'required');
  assert.equal(params.get('customer_update[address]'),'auto');
  assert.equal(params.get('line_items[0][price]'),priceId);
  assert.equal(params.get('discounts[0][coupon]'),couponId);
  assert.deepEqual(await s.billing.readEntitlements(),[]);
  assert.equal((await s.checkout()).status,200);
});

test('wrong Stripe tax settings prevent checkout; a bad initial or reused session is not shared',async()=>{
  for(const overrides of [{behavior:'exclusive'},{taxCode:'txcd_10103000'}]){
    const s=scenario(overrides);
    assert.equal((await (await s.checkout()).json()).error,'introductory_tax_configuration_mismatch');
    assert(!s.calls.some(x=>x.pathname==='/v1/checkout/sessions'));
  }
  for(const session of [{automatic_tax:{enabled:false}},{automatic_tax:{enabled:true,status:'failed'}},
    {billing_address_collection:null},{amount_total:108},{amount_total:null}]){
    const s=scenario({session});
    assert.equal((await (await s.checkout()).json()).error,'introductory_checkout_total_mismatch');
  }
  const s=scenario({reuse:{automatic_tax:{enabled:false}}});
  assert.equal((await s.checkout()).status,200);
  assert.equal((await (await s.checkout()).json()).error,'introductory_checkout_total_mismatch');
});

test('sandbox access requires exact paid invoice and successful tax assessment',async()=>{
  for(const overrides of [{invoice:{automatic_tax:{enabled:false}}},
    {invoice:{automatic_tax:{enabled:true,status:'requires_location_inputs'}}},{subscriptionTax:false},{}]){
    const s=scenario(overrides);
    assert.equal((await s.checkout()).status,200);
    assert.equal((await s.paid()).status,200);
    const shouldUnlock=Object.keys(overrides).length===0;
    assert.equal((await s.billing.readEntitlements()).length,shouldUnlock?1:0);
    assert.equal((await s.state.storage.get('introVerified:sub_fixture'))?.taxCode,shouldUnlock?taxCode:undefined);
  }
});
