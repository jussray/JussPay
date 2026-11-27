import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {combinedEnv} from './harness.mjs';
import {createJussPayClient,introConsent} from '../sdk/index.mjs';

const origin='https://billing.example';
const termsUrl='https://chief.example/terms';
const offer={unitAmount:2900,currency:'usd',interval:'month',termsUrl,
  introOffer:{approved:true,firstInvoiceAmountMinor:100,renewalAmountMinor:2900,
    renewalInterval:'month',billingMode:'test'}};
const accepts={terms:true,automaticRenewal:true};
const consent=introConsent(offer,accepts);

test('SDK reads the actual Worker catalog, respects closed payments, and requires authenticated entitlement checks',async()=>{
  const {env}=combinedEnv();
  env.PAYMENTS_ENABLED='false';
  const auth=env.AUTH.fetch;
  env.AUTH.fetch=req=>req.headers.get('authorization')==='Bearer test-user'?auth(req):Promise.resolve(new Response(null,{status:401}));
  const calls=[];
  const sdk=createJussPayClient({origin,fetch:(url,options)=>{
    calls.push([url.pathname,options]);
    return worker.fetch(new Request(url,options),env);
  }});
  assert.equal((await sdk.catalog()).find(row=>row.id==='chief').purchaseStatus,'unavailable');
  assert.equal(calls[0][1].headers.authorization,undefined);
  await assert.rejects(sdk.checkout({token:'test-user',product:'chief',consent,expectedBillingMode:'test'}),
    {code:'payments_disabled',status:503});
  await assert.rejects(sdk.entitlements('wrong-user'),{code:'authentication_required',status:401});
  assert.equal(await sdk.hasEntitlement({token:'test-user',product:'chief',entitlement:'chief.personal'}),false);
  assert.equal(calls.at(-1)[1].redirect,'error');
  assert.equal(calls.at(-1)[1].cache,'no-store');
});

test('SDK refuses insecure configuration, missing consent, and unapproved or inconsistent intro offers',async()=>{
  for(const bad of ['http://billing.example','https://x@billing.example','https://billing.example/checkout']){
    assert.throws(()=>createJussPayClient({origin:bad}),{name:'JussPayError'});
  }
  assert.throws(()=>introConsent(offer,{terms:true}),{code:'renewal_consent_required'});
  assert.throws(()=>introConsent({...offer,unitAmount:3000},accepts),{code:'invalid_intro_offer'});
  assert.throws(()=>introConsent({...offer,termsUrl:'javascript:1'},accepts),{code:'invalid_terms_url'});
  const sdk=createJussPayClient({origin,fetch:()=>assert.fail('must not contact backend')});
  await assert.rejects(sdk.checkout({product:'chief',consent,token:'test-user'}),{code:'expected_billing_mode_required'});
  await assert.rejects(sdk.entitlements('bad token'),{code:'authentication_required'});
});

test('SDK refuses link host lookalikes and a different billing mode or renewal price',async()=>{
  const reply={url:'https://checkout.stripe.com/c/foo',billingMode:'test',currency:'usd',
    firstInvoiceAmountMinor:100,renewalAmountMinor:2900,interval:'month',termsUrl};
  let next=reply;
  const sdk=createJussPayClient({origin,fetch:(url,req)=>{
    if(url.pathname==='/checkout')assert.deepEqual(JSON.parse(req.body),{product:'chief',introConsent:consent});
    return Response.json(next);
  }});
  const input={token:'test-user',product:'chief',consent,expectedBillingMode:'test'};
  assert.equal((await sdk.checkout(input)).url,reply.url);
  for(const extra of [{billingMode:'live'},{renewalAmountMinor:3000},{firstInvoiceAmountMinor:2900}]){
    next={...reply,...extra};
    await assert.rejects(sdk.checkout(input),{code:'checkout_terms_mismatch'});
  }
  next={...reply,url:'https://checkout.stripe.com.evil.example/'};
  await assert.rejects(sdk.checkout(input),{code:'invalid_stripe_url'});
  await assert.rejects(sdk.portal('test-user'),{code:'invalid_stripe_url'});
});

test('SDK scopes entitlements to the product and filters expired rows without swallowing service errors',async()=>{
  let reply=Response.json({entitlements:[
    {product:'fcr',entitlements:['chief.personal'],until:Date.now()/1000+1000},
    {product:'chief',entitlements:['chief.personal'],until:Date.now()/1000-1}
  ]});
  const sdk=createJussPayClient({origin,fetch:()=>reply.clone()});
  const input={token:'test-user',product:'chief',entitlement:'chief.personal'};
  assert.equal(await sdk.hasEntitlement(input),false);
  reply=Response.json({entitlements:[{product:'chief',entitlements:['chief.personal'],until:Date.now()/1000+1000}]});
  assert.equal(await sdk.hasEntitlement(input),true);
  reply=Response.json({error:'billing_not_configured'},{status:503});
  await assert.rejects(sdk.hasEntitlement(input),{code:'billing_not_configured',status:503});
});
