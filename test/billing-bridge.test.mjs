import test from 'node:test';
import assert from 'node:assert/strict';
import {billingBridge} from '../sdk/bridge.mjs';
import {createJussPayClient} from '../sdk/index.mjs';

const appOrigin='https://app.example';
const termsUrl='https://app.example/terms';
const body={product:'chief',firstInvoiceAmountMinor:100,renewalAmountMinor:2900,interval:'month',
  termsUrl,acceptsTerms:true,acceptsAutomaticRenewal:true};
const catalog=[{id:'chief',name:'Chief',purchaseStatus:'requires_provider_validation',unitAmount:2900,currency:'usd',interval:'month',
  termsUrl,introOffer:{approved:true,firstInvoiceAmountMinor:100,renewalAmountMinor:2900,renewalInterval:'month',billingMode:'test'}},
  {id:'fcr',name:'Founder Control Room',purchaseStatus:'requires_provider_validation'}];
const relay=(path,body,headers={})=>new Request(appOrigin+'/api/billing/'+path,{method:body?'POST':'GET',
  body:body?JSON.stringify(body):undefined,headers:body?{origin:appOrigin,'content-type':'application/json',...headers}:headers});
function scenario(){
  const calls=[];
  const client=createJussPayClient({origin:'https://payments.example',fetch:(url,request)=>{
    calls.push({path:url.pathname,headers:request.headers,body:request.body});
    if(url.pathname==='/catalog')return Response.json(catalog);
    if(url.pathname==='/entitlements')return Response.json({entitlements:[]});
    return Response.json({url:'https://checkout.stripe.com/c/demo',billingMode:'test',
      currency:'usd',firstInvoiceAmountMinor:100,renewalAmountMinor:2900,interval:'month',termsUrl});
  }});
  const handler=billingBridge({client,appOrigin,products:['chief'],billingMode:'test',
    getAccessToken:req=>req.headers.get('cookie')==='app_session=fixture'?'verified-session-token':null});
  return {handler,calls};
}
test('bridge publishes only the approved app catalog, and relays exact consent using only the app session token',async()=>{
  const {handler,calls}=scenario();
  assert.deepEqual((await (await handler(relay('catalog'))).json()).map(item=>item.id),['chief']);
  const checkout=await handler(relay('checkout',{...body,priceId:'not-trusted',subject:'not-trusted'},
    {cookie:'app_session=fixture',authorization:'Bearer not-trusted'}));
  assert.equal(checkout.status,200);
  assert.equal((await checkout.json()).billingMode,'test');
  assert.equal(calls.at(-1).headers.authorization,'Bearer verified-session-token');
  const {product,...introConsent}=body;
  assert.deepEqual(JSON.parse(calls.at(-1).body),{product,introConsent});
  assert.deepEqual(await (await handler(relay('entitlements',null,{cookie:'app_session=fixture'}))).json(),{entitlements:[]});
});
test('bridge blocks cross-origin, unbound and changed offers before the Worker can open checkout',async()=>{
  const {handler,calls}=scenario(),cookie='app_session=fixture';
  const checks=[
    [relay('checkout',body,{origin:'https://elsewhere.example',cookie}),403],
    [relay('checkout',body,{authorization:'Bearer forged'}),401],
    [relay('checkout',{...body,product:'fcr'},{cookie}),409],
    [relay('checkout',{...body,renewalAmountMinor:1},{cookie}),409],
    [relay('checkout',{...body,acceptsTerms:false},{cookie}),409],
    [relay('checkout',{...body,filler:'a'.repeat(2049)},{cookie}),413]
  ];
  for(const [request,status] of checks)assert.equal((await handler(request)).status,status);
  assert.ok(calls.every(call=>call.path==='/catalog'));
});
