// JBH hair-order lane (founder ruling 2026-11-17): physical hair and beauty orders for
// jussbeautifulhair.com, sold by the Juss Ray Beauty Co Stripe account. Separate fact
// domain from the five-app subscription core: its own Stripe secrets, webhook secret,
// account binding and Durable Object (JbhOrderBook). OFF unless JBH_ORDERS_ENABLED=true,
// defaulting to sandbox; live checkout requires a separate explicit approval switch.
//
// Flow: the storefront Worker (server-side, holding JBH_STOREFRONT_KEY) posts SKUs and
// quantities; prices come only from the server catalog JBH_CATALOG. A paid order is
// written to the owner's fulfillment queue grouped by vendor with status
// awaiting_owner_dispatch. Nothing here contacts, pays or orders from a vendor.
import {verifySignature,digest,stripe,json,fail,boundedText} from './worker.mjs';
import {jbhVendorAdapters,liveVendorAuthority,vendorOwnerPlan} from './jbh-vendor-adapters.mjs';
import {jbhConfigurationReview} from './jbh-preflight.mjs';

// Juss Ray Beauty Co is the only permitted live merchant. Sandbox retains its own
// account ID and never shares the live order book.
export const JBH_LIVE_ACCOUNT='acct_1TfbELRp7J40bCrl';
export const JBH_EVENTS=new Set(['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired','charge.refunded','charge.dispute.created']);
const MAX_LINES=10,MAX_QTY=10;
const REQUEST_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORDER_ID=/^jbho_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function jbhCatalog(env){
  let values;try{values=JSON.parse(env.JBH_CATALOG||'{}');}catch{fail(503,'jbh_catalog_invalid');}
  if(!values||Array.isArray(values)||typeof values!=='object')fail(503,'jbh_catalog_invalid');
  for(const [sku,p] of Object.entries(values)){
    if(!/^[A-Z0-9][A-Z0-9-]{1,63}$/.test(sku)||p?.approved!==true||typeof p.name!=='string'||!p.name.length||p.name.length>120||!Number.isSafeInteger(p.unitAmount)||p.unitAmount<1||p.currency!=='usd'||!/^[a-z0-9][a-z0-9-]{1,39}$/.test(p.vendor||''))fail(503,'jbh_catalog_invalid');
  }
  return values;
}

// Shipping mirrors the storefront's posted terms; configured, never client-priced.
export function jbhShipping(env){
  let s;try{s=JSON.parse(env.JBH_SHIPPING||'null');}catch{fail(503,'jbh_shipping_invalid');}
  const amount=x=>Number.isSafeInteger(x)&&x>=0;
  if(!s||!amount(s.standard)||!amount(s.express)||!(s.freeStandardOver===null||amount(s.freeStandardOver)))fail(503,'jbh_shipping_invalid');
  return s;
}

// No implicit mode: every credential, event and session must agree with this switch.
export function jbhLive(env){
  if(env.JBH_STRIPE_LIVE!=='true'&&env.JBH_STRIPE_LIVE!=='false')fail(503,'jbh_mode_invalid');
  return env.JBH_STRIPE_LIVE==='true';
}

export function jbhReady(env,webhook=false){
  if(env.JBH_ORDERS_ENABLED!=='true')fail(503,'jbh_orders_disabled');
  const live=jbhLive(env);
  if(!new RegExp(`^(sk|rk)_${live?'live':'test'}_`).test(env.JBH_STRIPE_SECRET_KEY||''))fail(503,live?'jbh_live_key_required':'jbh_sandbox_key_required');
  if(!env.JBH_STRIPE_WEBHOOK_SECRET||!env.JBH_STRIPE_API_VERSION||!env.JBH_ORDERS||(!live&&!/^acct_[a-zA-Z0-9]+$/.test(env.JBH_TEST_ACCOUNT_ID||'')))fail(503,'jbh_not_configured');
  if(!webhook){
    if(!env.JBH_STOREFRONT_KEY||env.JBH_STOREFRONT_KEY.length<32)fail(503,'jbh_not_configured');
    let origin;try{origin=new URL(env.JBH_STOREFRONT_ORIGIN).origin;}catch{fail(503,'jbh_not_configured');}
    if(!origin.startsWith('https://')||origin!==env.JBH_STOREFRONT_ORIGIN)fail(503,'jbh_not_configured');
  }
}

// The core Stripe client, pointed at the beauty account's own key and pinned version.
export const jbhStripe=(env,path,method,data,key)=>stripe({STRIPE_SECRET_KEY:env.JBH_STRIPE_SECRET_KEY,STRIPE_API_VERSION:env.JBH_STRIPE_API_VERSION,STRIPE_FETCH:env.STRIPE_FETCH},path,method,data,key);

async function jbhAccount(env,forPurchase){
  const a=await jbhStripe(env,'account');
  if(a.id!==(jbhLive(env)?JBH_LIVE_ACCOUNT:env.JBH_TEST_ACCOUNT_ID))fail(503,'jbh_stripe_account_mismatch');
  if(forPurchase&&(!a.charges_enabled||!a.details_submitted))fail(503,'jbh_stripe_account_not_ready');
}

// Constant-time comparison through equal-length digests.
export async function sameSecret(given,expected){
  if(typeof given!=='string'||typeof expected!=='string'||!expected.length)return false;
  const [a,b]=await Promise.all([digest(given),digest(expected)]);
  let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

export function priceOrder(env,input){
  const catalog=jbhCatalog(env),ship=jbhShipping(env);
  const lines=input?.items;
  if(!Array.isArray(lines)||!lines.length||lines.length>MAX_LINES)fail(400,'invalid_items');
  if(input.shipping!==undefined&&input.shipping!=='standard'&&input.shipping!=='express')fail(400,'invalid_shipping');
  const merged=new Map();
  for(const line of lines){
    const qty=line?.quantity;
    if(typeof line?.sku!=='string'||!Number.isSafeInteger(qty)||qty<1||qty>MAX_QTY)fail(400,'invalid_items');
    if(!Object.hasOwn(catalog,line.sku))fail(409,'sku_not_available');
    merged.set(line.sku,(merged.get(line.sku)||0)+qty);
  }
  const items=[...merged].map(([sku,quantity])=>{
    if(quantity>MAX_QTY)fail(400,'invalid_items');
    const p=catalog[sku];return {sku,name:p.name,vendor:p.vendor,unitAmount:p.unitAmount,quantity};
  });
  const subtotal=items.reduce((n,x)=>n+x.unitAmount*x.quantity,0);
  const speed=input.shipping==='express'?'express':'standard';
  const shipping=speed==='express'?ship.express:(ship.freeStandardOver!==null&&subtotal>=ship.freeStandardOver?0:ship.standard);
  return {items,subtotal,shipping,shippingSpeed:speed,total:subtotal+shipping,currency:'usd'};
}

// The provider's own session is the only payment truth: every load-bearing field must match.
export function reconcileSession(session,order,live=false){
  return session?.id===order.sessionId&&session.client_reference_id===order.id&&session.metadata?.jbh_order_id===order.id
    &&session.mode==='payment'&&session.livemode===live&&session.currency===order.currency
    &&session.amount_subtotal===order.subtotal&&session.amount_total===order.total&&session.total_details?.amount_shipping===order.shipping;
}

function publicOrder(o){return {id:o.id,status:o.status,currency:o.currency,subtotal:o.subtotal,shipping:o.shipping,total:o.total,items:o.items.map(({sku,name,quantity})=>({sku,name,quantity}))};}

async function jsonBody(request,limit){
  let value;try{value=JSON.parse(await boundedText(request,limit));}catch(e){if(e.status)throw e;fail(400,'invalid_json');}
  if(!value||Array.isArray(value)||typeof value!=='object')fail(400,'invalid_json');
  return value;
}

const book=env=>env.JBH_ORDERS.get(env.JBH_ORDERS.idFromName(`${jbhLive(env)?'live':'test'}:jbh-orders`));
const toBook=(env,path,body)=>book(env).fetch(new Request(`https://jbh-orders.internal${path}`,{method:'POST',body:JSON.stringify(body)}));

function requireLiveOwnerQueue(env){
  // Never charge a live customer if nobody can securely retrieve their paid order.
  // Existing webhook processing and customer order readback must remain available
  // if the owner credential is accidentally removed after checkout.
  if(jbhLive(env)&&(typeof env.JBH_OWNER_KEY!=='string'||env.JBH_OWNER_KEY.length<32))
    fail(503,'jbh_owner_queue_unavailable');
}

function privateReceiptSettings(env){
  const live=jbhLive(env);
  const enabled=live?env.JBH_PRIVATE_LIVE_RECEIPTS_ENABLED:env.JBH_PRIVATE_RECEIPTS_ENABLED;
  const secret=live?env.JBH_PRIVATE_LIVE_RECEIPT_SECRET:env.JBH_PRIVATE_RECEIPT_SECRET;
  if(enabled!=='true'||typeof secret!=='string'||secret.length<32||secret.length>512||!env.JBH_PRIVATE_WORKER?.fetch)return null;
  if(live&&[env.JBH_PRIVATE_RECEIPT_SECRET,env.JBH_OWNER_KEY,env.JBH_OWNER_BRIDGE_KEY,env.JBH_STOREFRONT_KEY,env.JBH_MONITOR_KEY,env.JBH_STRIPE_SECRET_KEY,env.JBH_STRIPE_WEBHOOK_SECRET].includes(secret))return null;
  return {live,secret};
}

function requireLivePrivateReceiptConfig(env){
  if(jbhLive(env)&&!privateReceiptSettings(env))fail(503,'jbh_private_receipt_not_configured');
}

async function signedPrivateRequest(env,settings,path,payload){
  const raw=JSON.stringify(payload);
  const enc=new TextEncoder();
  const key=await crypto.subtle.importKey('raw',enc.encode(settings.secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(raw)));
  const signature=[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
  return env.JBH_PRIVATE_WORKER.fetch(new Request('http://localhost/internal/jusspay/'+(settings.live?'live':'sandbox')+'/'+path,
    {method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'content-type':'application/json','x-jbh-jusspay-signature':signature},body:raw}));
}

async function requireLivePrivateReceiverReady(env){
  if(!jbhLive(env))return;
  requireLivePrivateReceiptConfig(env);
  try{
    const schema='jbh-private/jusspay-live-readiness@v1';
    const response=await signedPrivateRequest(env,privateReceiptSettings(env),'readiness',{schema});
    if(response.ok){
      const result=await response.json();
      if(result?.schema===schema&&result.livemode===true&&result.configured===true&&/^[a-f0-9]{40}$/.test(result.releaseSha||''))return;
    }
  }catch{/* Never include receiver error bodies or credentials in a public response. */}
  fail(503,'jbh_private_receipt_unavailable');
}

async function requireOwner(request,env){
  if(!env.JBH_OWNER_KEY||env.JBH_OWNER_KEY.length<32||!await sameSecret(request.headers.get('x-jbh-owner-key'),env.JBH_OWNER_KEY))fail(401,'owner_key_required');
}

async function requireOwnerQueueRead(request,env){
  // The bridge credential is read-only. Never use it to dispatch orders,
  // inspect payment readiness or authorize any other privileged route.
  const supplied=request.headers.get('x-jbh-owner-key');
  if(typeof env.JBH_OWNER_KEY==='string'&&env.JBH_OWNER_KEY.length>=32&&await sameSecret(supplied,env.JBH_OWNER_KEY))return;
  if(typeof env.JBH_OWNER_BRIDGE_KEY==='string'&&env.JBH_OWNER_BRIDGE_KEY.length>=32&&await sameSecret(supplied,env.JBH_OWNER_BRIDGE_KEY))return;
  fail(401,'owner_key_required');
}

// Public entry for /jbh/* paths.
export async function handleJbh(request,env){
  const path=new URL(request.url).pathname;
  let webhookContext=null;
  const webhookStartedAt=path==='/jbh/webhook'?Date.now():0;
  try{
    if(path==='/jbh/webhook'){
      if(request.method!=='POST')return json({error:'method_not_allowed'},405);
      jbhReady(env,true);
      const raw=await boundedText(request,262144);
      if(!await verifySignature(raw,request.headers.get('stripe-signature'),env.JBH_STRIPE_WEBHOOK_SECRET))fail(400,'invalid_signature');
      let event;try{event=JSON.parse(raw);}catch{fail(400,'invalid_event');}
      webhookContext={eventId:event?.id,eventType:event?.type,livemode:event?.livemode};
      if(!/^evt_/.test(event.id||'')||event.livemode!==jbhLive(env)||(event.account&&event.account!==(jbhLive(env)?JBH_LIVE_ACCOUNT:env.JBH_TEST_ACCOUNT_ID)))fail(400,'wrong_event_context');
      if(!JBH_EVENTS.has(event.type)){
        console.info('[JBH_STRIPE_WEBHOOK] ignored',{...webhookContext,reason:'unsupported_event'});
        return json({received:true,ignored:true});
      }
      await jbhAccount(env,false);
      const response=await toBook(env,'/event',{event});
      console.info('[JBH_STRIPE_WEBHOOK] processed',{...webhookContext,status:response.status,elapsedMs:Date.now()-webhookStartedAt});
      return response;
    }
    if(path==='/jbh/monitoring-preflight'){
      if(request.method!=='GET')return json({error:'method_not_allowed'},405);
      const key=env.JBH_MONITOR_KEY;
      if(typeof key!=='string'||key.length<32||
        [env.JBH_OWNER_KEY,env.JBH_OWNER_BRIDGE_KEY,env.JBH_STOREFRONT_KEY,env.JBH_STRIPE_SECRET_KEY,env.JBH_STRIPE_WEBHOOK_SECRET].some(value=>value===key)||
        !await sameSecret(request.headers.get('x-jbh-monitor-key'),key))fail(401,'monitor_key_required');
      const result=jbhConfigurationReview(env,{
        ready:()=>jbhReady(env),catalog:()=>jbhCatalog(env),shipping:()=>jbhShipping(env),
        owner:()=>requireLiveOwnerQueue(env),privateReceiver:()=>requireLivePrivateReceiptConfig(env),authority:items=>liveVendorAuthority(env,items)
      });
      const releaseSha=/^[a-f0-9]{40}$/.test(env.RELEASE_SHA||'')?env.RELEASE_SHA:null;
      return new Response(JSON.stringify({schema:'jusspay/jbh-monitoring-preflight@v1',releaseSha,...result}),{
        status:result.configurationValid?200:503,
        headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}
      });
    }
    if(path==='/jbh/preflight'){
      if(request.method!=='GET')return json({error:'method_not_allowed'},405);
      await requireOwner(request,env);
      const result=jbhConfigurationReview(env,{
        ready:()=>jbhReady(env),catalog:()=>jbhCatalog(env),shipping:()=>jbhShipping(env),
        owner:()=>requireLiveOwnerQueue(env),privateReceiver:()=>requireLivePrivateReceiptConfig(env),authority:items=>liveVendorAuthority(env,items)
      });
      return json(result,result.configurationValid?200:503);
    }
    if(path==='/jbh/health'){
      if(request.method!=='GET')return json({error:'method_not_allowed'},405);
      jbhReady(env);
      if(!await sameSecret(request.headers.get('x-jbh-storefront-key'),env.JBH_STOREFRONT_KEY))fail(401,'storefront_key_required');
      const live=jbhLive(env);
      if(live&&env.JBH_LIVE_CHARGES_APPROVED!=='true')fail(503,'jbh_live_not_approved');
      requireLiveOwnerQueue(env);
      if(Object.keys(jbhCatalog(env)).length===0)fail(503,'jbh_catalog_unavailable');
      jbhShipping(env);
      if(live)liveVendorAuthority(env,Object.entries(jbhCatalog(env)).map(([sku,p])=>({sku,vendor:p.vendor})));
      await requireLivePrivateReceiverReady(env);
      await jbhAccount(env,true);
      return json({ready:true,mode:live?'live':'sandbox',chargesEnabled:true});
    }
    if(path==='/jbh/checkout'||path.startsWith('/jbh/orders/')){
      jbhReady(env);
      if(!await sameSecret(request.headers.get('x-jbh-storefront-key'),env.JBH_STOREFRONT_KEY))fail(401,'storefront_key_required');
      if(path==='/jbh/checkout'){
        if(request.method!=='POST')return json({error:'method_not_allowed'},405);
        if(jbhLive(env)&&env.JBH_LIVE_CHARGES_APPROVED!=='true')fail(503,'jbh_live_not_approved');
        requireLiveOwnerQueue(env);
        const input=await jsonBody(request,4096);
        // The storefront sends one requestId per shopper attempt and reuses it on retry.
        if(!REQUEST_ID.test(input.requestId||''))fail(400,'request_id_required');
        const priced=priceOrder(env,input);
        if(jbhLive(env))liveVendorAuthority(env,priced.items);
        await requireLivePrivateReceiverReady(env);
        await jbhAccount(env,true);
        return toBook(env,'/checkout',{requestId:input.requestId,priced});
      }
      if(request.method!=='GET')return json({error:'method_not_allowed'},405);
      const id=path.slice('/jbh/orders/'.length);
      if(!ORDER_ID.test(id))fail(404,'not_found');
      return toBook(env,'/order',{id});
    }
    if(path==='/jbh/launch-readiness'){
      // Owner-only, no-provider-call preflight. Configuration evidence is not
      // proof of merchant, inventory, or payment readiness.
      await requireOwner(request,env);
      if(request.method!=='GET')return json({error:'method_not_allowed'},405);
      let catalog=null,shippingConfigured=false,vendorEvidenceContractValid=false;
      try{
        const parsed=jbhCatalog(env);
        if(Object.keys(parsed).length>0)catalog=parsed;
      }catch{}
      try{jbhShipping(env);shippingConfigured=true;}catch{}
      if(catalog){
        try{
          liveVendorAuthority(env,Object.entries(catalog).map(([sku,p])=>({sku,vendor:p.vendor})));
          vendorEvidenceContractValid=true;
        }catch{}
      }
      let validOrigin=false;
      try{
        const origin=new URL(env.JBH_STOREFRONT_ORIGIN);
        validOrigin=origin.protocol==='https:'&&origin.origin===env.JBH_STOREFRONT_ORIGIN;
      }catch{}
      const checks={
        liveStripeMode:env.JBH_STRIPE_LIVE==='true',
        orderBookBound:typeof env.JBH_ORDERS?.get==='function'&&typeof env.JBH_ORDERS?.idFromName==='function',
        ordersEnabled:env.JBH_ORDERS_ENABLED==='true',
        liveStripeKeyConfigured:/^(?:sk|rk)_live_/.test(env.JBH_STRIPE_SECRET_KEY||''),
        webhookSecretConfigured:typeof env.JBH_STRIPE_WEBHOOK_SECRET==='string'&&env.JBH_STRIPE_WEBHOOK_SECRET.length>0,
        storefrontKeyConfigured:typeof env.JBH_STOREFRONT_KEY==='string'&&env.JBH_STOREFRONT_KEY.length>=32,
        storefrontOriginConfigured:validOrigin,
        approvedCatalogConfigured:catalog!==null,
        shippingConfigured,
        vendorEvidenceContractValid,
        privateLiveReceiptConfigured:env.JBH_STRIPE_LIVE==='true'&&Boolean(privateReceiptSettings(env)),
      };
      return json({
        readOnly:true,
        configurationComplete:Object.values(checks).every(Boolean),
        founderChargesApproved:env.JBH_LIVE_CHARGES_APPROVED==='true',
        providerVerified:false,
        checks
      });
    }
    if(path==='/jbh/vendor-adapters'){
      // Owner readback is deliberately independent of payment activation.
      // A missing or invalid owner key still denies access before any data returns.
      await requireOwner(request,env);
      if(request.method!=='GET')return json({error:'method_not_allowed'},405);
      return json({adapters:jbhVendorAdapters(),dispatchEnabled:false,ordersEnabled:env.JBH_ORDERS_ENABLED==='true'});
    }
    if(path==='/jbh/fulfillment'||path.startsWith('/jbh/fulfillment/')){
      jbhReady(env,true);
      if(path==='/jbh/fulfillment'){
        await requireOwnerQueueRead(request,env);
        if(request.method!=='GET')return json({error:'method_not_allowed'},405);
        return toBook(env,'/fulfillment',{});
      }
      await requireOwner(request,env);
      const m=path.match(/^\/jbh\/fulfillment\/(jbho_[0-9a-f-]{36})\/dispatched$/);
      if(!m||!ORDER_ID.test(m[1]))fail(404,'not_found');
      if(request.method!=='POST')return json({error:'method_not_allowed'},405);
      const input=await jsonBody(request,2048);
      if(input.note!==undefined&&(typeof input.note!=='string'||input.note.length>500))fail(400,'invalid_note');
      return toBook(env,'/dispatched',{id:m[1],note:input.note||null});
    }
    return json({error:'not_found'},404);
  }catch(e){
    if(path==='/jbh/webhook')console.warn('[JBH_STRIPE_WEBHOOK] rejected',{
      ...(webhookContext||{}),status:e.status||500,
      error:e.status?'request_rejected':'processing_error'
    });
    return json({error:e.status?e.message:'internal_error'},e.status||500);
  }
}

// One serialized order book per mode. Storage keys: order:<id>, request:<requestId>,
// session:<cs_id>, pi:<pi_id>, event:<evt_id>, fulfillment:<id>, queue:<id> (open
// dispatch work only), receipt:<id>:<n>.
export class JbhOrderBook{
  constructor(state,env){this.state=state;this.env=env;this.tail=Promise.resolve();}
  fetch(request){const run=this.tail.then(()=>this.handle(request));this.tail=run.catch(()=>{});return run;}
  async handle(request){try{
    const path=new URL(request.url).pathname;const input=await request.json();
    if(path==='/checkout')return await this.checkout(input.requestId,input.priced);
    if(path==='/order'){const o=await this.state.storage.get(`order:${input.id}`);return o?json(publicOrder(o)):json({error:'not_found'},404);}
    if(path==='/fulfillment'){
      const rows=[];for(const id of (await this.state.storage.list({prefix:'queue:'})).values()){const f=await this.state.storage.get(`fulfillment:${id}`);if(f)rows.push(f);}
      return json({queue:rows.map(f=>({...f,vendorPlans:vendorOwnerPlan(f.vendors)}))});
    }
    if(path==='/dispatched')return await this.dispatched(input.id,input.note);
    if(path==='/event')return await this.event(input.event);
    return json({error:'not_found'},404);
  }catch(e){return json({error:e.status?e.message:'internal_error'},e.status||500);}}

  async checkout(requestId,priced){
    const env=this.env,storage=this.state.storage;
    if(jbhLive(env)&&env.JBH_LIVE_CHARGES_APPROVED!=='true')fail(503,'jbh_live_not_approved');
    const fingerprint=await digest(JSON.stringify([priced.items.map(x=>[x.sku,x.quantity,x.unitAmount]),priced.shipping,priced.total]));
    let id=await storage.get(`request:${requestId}`);
    let order=id?await storage.get(`order:${id}`):null;
    if(order){
      if(order.fingerprint!==fingerprint)fail(409,'request_id_reused');
      if(order.status!=='pending')fail(409,'order_not_open');
      if(order.sessionUrl)return json({orderId:order.id,url:order.sessionUrl});
    }else{
      id=`jbho_${crypto.randomUUID()}`;
      order={id,status:'pending',...priced,fingerprint,createdAt:Date.now(),sessionId:null,sessionUrl:null,paymentIntent:null};
      // The order and request mapping exist before the provider side effect, so a retry
      // reuses the same Stripe idempotency key and an unknown outcome stays reconcilable.
      await storage.put(`order:${id}`,order);
      await storage.put(`request:${requestId}`,id);
    }
    const origin=env.JBH_STOREFRONT_ORIGIN;
    const form={mode:'payment',client_reference_id:id,'metadata[jbh_order_id]':id,'payment_intent_data[metadata][jbh_order_id]':id,
      success_url:`${origin}/checkout/success?order=${id}`,cancel_url:`${origin}/checkout?cancelled=1`,
      'shipping_address_collection[allowed_countries][0]':'US','phone_number_collection[enabled]':'true',
      'shipping_options[0][shipping_rate_data][type]':'fixed_amount',
      'shipping_options[0][shipping_rate_data][display_name]':order.shippingSpeed==='express'?'Express':'Standard',
      'shipping_options[0][shipping_rate_data][fixed_amount][amount]':String(order.shipping),
      'shipping_options[0][shipping_rate_data][fixed_amount][currency]':'usd'};
    order.items.forEach((x,i)=>{
      form[`line_items[${i}][quantity]`]=String(x.quantity);
      form[`line_items[${i}][price_data][currency]`]='usd';
      form[`line_items[${i}][price_data][unit_amount]`]=String(x.unitAmount);
      form[`line_items[${i}][price_data][product_data][name]`]=x.name;
      form[`line_items[${i}][price_data][product_data][metadata][jbh_sku]`]=x.sku;
    });
    // Recheck configuration and merchant inside the order book immediately before the charge-capable request.
    requireLivePrivateReceiptConfig(env);
    await jbhAccount(env,true);
    const s=await jbhStripe(env,'checkout/sessions','POST',form,`jbh-checkout-${id}`);
    if(!new RegExp(`^cs_${jbhLive(env)?'live':'test'}_`).test(s.id||'')||s.livemode!==jbhLive(env)||typeof s.url!=='string')fail(502,'stripe_unavailable');
    await storage.put(`order:${id}`,{...order,sessionId:s.id,sessionUrl:s.url});
    await storage.put(`session:${s.id}`,id);
    return json({orderId:id,url:s.url});
  }

  async dispatched(id,note){
    const storage=this.state.storage;
    const f=await storage.get(`fulfillment:${id}`);
    if(!f)fail(404,'not_found');
    if(f.status!=='awaiting_owner_dispatch')fail(409,'not_dispatchable');
    if(jbhLive(this.env)){
      const receipt=await storage.get('private-receipt:'+id);
      if(receipt?.delivered!==true||receipt.receiverState!=='awaiting_owner_review')fail(409,'private_receipt_unconfirmed');
    }
    await storage.transaction(async txn=>{
      await txn.put(`fulfillment:${id}`,{...f,status:'dispatched',dispatchedAt:Date.now(),note});
      await txn.delete(`queue:${id}`);
    });
    return json({id,status:'dispatched'});
  }

  async receipt(orderId,reason,detail){
    const n=Date.now();await this.state.storage.put(`receipt:${orderId}:${n}`,{orderId,reason,detail,at:n});
  }

  // Refunds and disputes resolve their order through the PaymentIntent's own
  // jbh_order_id metadata, so they apply even if they arrive before the paid event.
  async orderForCharge(chargeId){
    if(!/^ch_/.test(chargeId||''))fail(400,'missing_charge');
    const charge=await jbhStripe(this.env,`charges/${encodeURIComponent(chargeId)}`);
    // Live charge evidence must explicitly be live. Legacy sandbox fixtures omit livemode.
    if(jbhLive(this.env)?charge.livemode!==true:charge.livemode===true)fail(400,'wrong_charge_context');
    const pi=typeof charge.payment_intent==='string'?charge.payment_intent:charge.payment_intent?.id;
    if(!/^pi_/.test(pi||''))return {orderId:null,charge};
    let orderId=await this.state.storage.get(`pi:${pi}`);
    if(!orderId){
      const intent=await jbhStripe(this.env,`payment_intents/${encodeURIComponent(pi)}`);
      const candidate=intent.metadata?.jbh_order_id;
      if(intent.livemode===jbhLive(this.env)&&ORDER_ID.test(candidate||'')&&await this.state.storage.get(`order:${candidate}`))orderId=candidate;
    }
    return {orderId:orderId||null,charge,pi};
  }

  async forwardPrivate(kind,orderId){
    const env=this.env,storage=this.state.storage,key='private-'+kind+':'+orderId;
    const pending=await storage.get(key);
    if(!pending||pending.delivered===true)return;
    const settings=privateReceiptSettings(env);
    if(!settings)return;
    if(kind==='receipt'){
      const order=await storage.get('order:'+orderId);
      const fulfillment=await storage.get('fulfillment:'+orderId);
      if(order?.status!=='paid'||!fulfillment||(!settings.live&&fulfillment.status!=='awaiting_owner_dispatch'))return;
    }
    try{
      const response=await signedPrivateRequest(env,settings,'paid-receipt',pending.payload);
      if(!response.ok)return;
      if(!settings.live){await storage.put(key,{...pending,delivered:true});return;}
      const ack=await response.json();
      if(ack?.schema!=='jbh-private/jusspay-live-receipt@v1'||ack.received!==true||ack.livemode!==true||
         ack.orderId!==orderId||ack.eventId!==pending.payload.eventId||typeof ack.duplicate!=='boolean'||
         !['awaiting_owner_review','hold'].includes(ack.state)||(kind==='hold'&&ack.state!=='hold'))return;
      await storage.put(key,{...pending,delivered:true,receiverState:ack.state});
    }catch{/* Durable record retained; retry on signed webhook replay. */}
  }

  async forwardPrivateReceipt(orderId){return this.forwardPrivate('receipt',orderId);}
  async forwardPrivateHold(orderId){return this.forwardPrivate('hold',orderId);}

  confirmationConfig(){
    const e=this.env;
    return jbhLive(e)&&e.JBH_CONFIRMATIONS_ENABLED==='true'&&
      typeof e.JBH_RESEND_API_KEY==='string'&&e.JBH_RESEND_API_KEY.startsWith('re_')&&
      typeof e.JBH_CONFIRMATION_FROM==='string'&&/^[a-zA-Z0-9._+-]+@jussbeautifulhair\.com$/.test(e.JBH_CONFIRMATION_FROM);
  }

  privateDeliveryConfig(){return jbhLive(this.env)&&Boolean(privateReceiptSettings(this.env));}

  async armConfirmation(){
    if(!this.confirmationConfig()&&!this.privateDeliveryConfig())return;
    const storage=this.state.storage;
    const existing=await storage.getAlarm();
    if(existing===null||existing>Date.now()+1000)await storage.setAlarm(Date.now()+1000);
  }

  // Serialize with payment/refund handlers. Re-arm before network I/O so a
  // crash after provider acceptance leaves a recoverable pending job.
  alarm(){
    const run=this.tail.then(()=>this.processDeliveryJobs());
    this.tail=run.catch(()=>{});
    return run;
  }

  async processDeliveryJobs(){
    if(!this.privateDeliveryConfig()&&!this.confirmationConfig())return;
    const storage=this.state.storage;
    await storage.setAlarm(Date.now()+60000);
    if(this.privateDeliveryConfig())await this.processPrivateDeliveries();
    if(this.confirmationConfig())await this.processConfirmations();
    const pendingPrivate=this.privateDeliveryConfig()&&(await storage.list({prefix:'private-pending:',limit:1})).size>0;
    const pendingConfirmation=this.confirmationConfig()&&(await storage.list({prefix:'confirmation-pending:',limit:1})).size>0;
    if(!pendingPrivate&&!pendingConfirmation)await storage.deleteAlarm();
  }

  async privateDeliveryPending(id){
    const storage=this.state.storage;
    const hold=await storage.get('private-hold:'+id);
    if(hold&&hold.delivered!==true)return true;
    const paid=await storage.get('private-receipt:'+id);
    const order=await storage.get('order:'+id);
    return Boolean(paid&&paid.delivered!==true&&order?.status==='paid');
  }

  async settlePrivateDelivery(id){
    if(!jbhLive(this.env))return;
    const storage=this.state.storage;
    if(!await this.privateDeliveryPending(id)){
      await storage.delete('private-pending:'+id);
      await storage.delete('private-reconciliation:'+id);
    }
  }

  async processPrivateDeliveries(){
    const storage=this.state.storage;
    // Bounded batch; pending records survive a crash and provider outage.
    for(const [key,job] of await storage.list({prefix:'private-pending:',limit:20})){
      const id=job.id;
      if(!await this.privateDeliveryPending(id)){await this.settlePrivateDelivery(id);continue;}
      if(job.nextAttemptAt>Date.now())continue;
      if(job.attempts>=12){
        await storage.transaction(async tx=>{
          await tx.put('private-reconciliation:'+id,{reason:'receipt_retry_exhausted',attempts:job.attempts,at:Date.now()});
          await tx.delete(key);
        });
        continue;
      }
      // Persist attempt before the network call; receiver deduplicates exact events.
      await storage.put(key,{...job,attempts:job.attempts+1,nextAttemptAt:Date.now()+Math.min(3600000,60000*2**Math.min(job.attempts,6))});
      await this.forwardPrivateHold(id);
      await this.forwardPrivateReceipt(id);
      await this.settlePrivateDelivery(id);
    }
  }

  async processConfirmations(){
    if(!this.confirmationConfig())return;
    const storage=this.state.storage;
    const rows=await storage.list({prefix:'confirmation-pending:',limit:20});
    for(const [queueKey,id] of rows){
      const jobKey='confirmation:'+id;
      const job=await storage.get(jobKey);
      if(!job||job.status!=='pending'){await storage.delete(queueKey);continue;}
      const order=await storage.get('order:'+id);
      const f=await storage.get('fulfillment:'+id);
      if(order?.status!=='paid'){
        await storage.transaction(async tx=>{await tx.put(jobKey,{status:'held',createdAt:job.createdAt});await tx.delete(queueKey);});
        continue;
      }
      if(job.nextAttemptAt>Date.now())continue;
      const now=Date.now();
      if((job.firstAttemptAt&&now-job.firstAttemptAt>=23*3600000)||job.attempts>=10||now-job.createdAt>=7*86400000){
        await storage.transaction(async tx=>{await tx.put(jobKey,{status:'reconciliation_required',createdAt:job.createdAt,attempts:job.attempts});await tx.delete(queueKey);});
        continue;
      }
      if(typeof f?.email!=='string'||f.email.length>254||!/^\S+@\S+\.\S+$/.test(f.email)||/[\r\n]/.test(f.email)){
        await storage.transaction(async tx=>{await tx.put(jobKey,{status:'recipient_missing',createdAt:job.createdAt});await tx.delete(queueKey);});
        continue;
      }
      // Persist the exact immutable request before first attempt. Provider
      // idempotency lasts 24 hours; never retry beyond our narrower window.
      const payload=job.payload||{from:this.env.JBH_CONFIRMATION_FROM,to:[f.email],
        subject:'Juss Beautiful Hair — order confirmation',
        text:'Payment received. Thank you for your order from Juss Beautiful Hair.\nOrder: '+id+'\nTotal: USD '+(order.total/100).toFixed(2)+'\nYour order is awaiting fulfillment. This is not a shipping confirmation.'};
      const attempt={...job,payload,firstAttemptAt:job.firstAttemptAt||now,attempts:job.attempts+1,
        nextAttemptAt:now+Math.min(3600000,60000*2**Math.min(job.attempts,6))};
      await storage.put(jobKey,attempt);
      let accepted=null;
      try{
        const response=await (this.env.JBH_EMAIL_FETCH||fetch)('https://api.resend.com/emails',{
          method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
          headers:{Authorization:'Bearer '+this.env.JBH_RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'jbh-confirmation/'+id},
          body:JSON.stringify(payload)});
        if(response.ok){const result=await response.json();if(typeof result.id==='string'&&result.id.length>0&&result.id.length<200)accepted=result.id;}
      }catch{/* Retain pending attempt; never log email or provider response. */}
      if(accepted)await storage.transaction(async tx=>{
        await tx.put(jobKey,{status:'provider_accepted',createdAt:job.createdAt,acceptedAt:Date.now(),attempts:attempt.attempts,providerId:accepted});
        await tx.delete(queueKey);
      });
    }
  }

  async event(event){
    const storage=this.state.storage;
    if(await storage.get(`event:${event.id}`)){
      const existing=await storage.get(`event:${event.id}`);
      if(existing?.orderId){await this.armConfirmation();await this.forwardPrivateHold(existing.orderId);await this.forwardPrivateReceipt(existing.orderId);await this.settlePrivateDelivery(existing.orderId);}
      return json({received:true,duplicate:true});
    }
    const o=event.data?.object||{};
    let orderId=null,charge=null,pi=null;
    if(event.type.startsWith('checkout.session.'))orderId=(/^cs_/.test(o.id||'')&&await storage.get(`session:${o.id}`))||null;
    else({orderId,charge,pi}=await this.orderForCharge(event.type==='charge.dispute.created'?(typeof o.charge==='string'?o.charge:o.charge?.id):o.id));
    // Activity on the account that is not a JussPay hair order is acknowledged and ignored.
    if(!orderId){await storage.put(`event:${event.id}`,{type:event.type,ignored:true,processedAt:Date.now()});return json({received:true,ignored:true});}
    const order=await storage.get(`order:${orderId}`);
    if(!order)fail(409,'order_missing');

    let next=null,fulfillment=null,reason=null,queue=null;
    if(event.type.startsWith('checkout.session.')){
      await jbhAccount(this.env,false);
      const session=await jbhStripe(this.env,`checkout/sessions/${encodeURIComponent(order.sessionId)}`);
      if(!reconcileSession(session,order,jbhLive(this.env))){
        await this.receipt(orderId,'session_mismatch',{event:event.id,type:event.type});
        await storage.put(`event:${event.id}`,{type:event.type,mismatch:true,processedAt:Date.now()});
        return json({received:true,reconciliation_required:true});
      }
      if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)){
        if(session.payment_status!=='paid'){reason='awaiting_async_payment';}
        else if(order.status==='pending'){
          const paidPi=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
          const ship=session.collected_information?.shipping_details||session.shipping_details||null;
          if(!/^pi_/.test(paidPi||'')||!ship?.address){
            await this.receipt(orderId,'paid_without_shipping_or_intent',{event:event.id});
            await storage.put(`event:${event.id}`,{type:event.type,mismatch:true,processedAt:Date.now()});
            return json({received:true,reconciliation_required:true});
          }
          next={...order,status:'paid',paidAt:Date.now(),paymentIntent:paidPi};
          const byVendor={};for(const x of order.items)(byVendor[x.vendor]||=[]).push({sku:x.sku,name:x.name,quantity:x.quantity});
          fulfillment={orderId,status:'awaiting_owner_dispatch',vendors:byVendor,shipTo:{name:ship.name||null,address:ship.address,phone:session.customer_details?.phone||null},email:session.customer_details?.email||null,shippingSpeed:order.shippingSpeed,createdAt:Date.now()};
          queue='add';
        }
        // A refunded or disputed order stays held: a paid event never re-opens it.
      }else if(event.type==='checkout.session.async_payment_failed'&&order.status==='pending')next={...order,status:'payment_failed'};
      else if(event.type==='checkout.session.expired'&&order.status==='pending')next={...order,status:'expired'};
    }else{
      // Any refund or dispute holds dispatch for owner review, in any order state.
      // A dispute outranks a refund; a partial refund is recorded as such.
      const status=event.type==='charge.dispute.created'||order.status==='disputed'?'disputed':(charge.refunded===true?'refunded':'partially_refunded');
      next={...order,status,paymentIntent:order.paymentIntent||pi,holdReason:event.type};
      const f=await storage.get(`fulfillment:${orderId}`);
      if(f&&f.status==='awaiting_owner_dispatch'){fulfillment={...f,status:'hold',holdReason:event.type};queue='keep';}
      if(f&&f.status==='dispatched')await this.receipt(orderId,'refund_or_dispute_after_dispatch',{event:event.id,type:event.type});
    }

    // Schedule before committing the outbox so a crash cannot strand an enabled job.
    const privateWork=jbhLive(this.env)&&(queue==='add'||(next&&['refunded','partially_refunded','disputed'].includes(next.status)));
    if(privateWork)await this.armConfirmation();
    await storage.transaction(async txn=>{
      if(await txn.get(`event:${event.id}`))return;
      if(next){await txn.put(`order:${orderId}`,next);if(next.paymentIntent)await txn.put(`pi:${next.paymentIntent}`,orderId);}
      if(privateWork)await txn.put(`private-pending:${orderId}`,{id:orderId,attempts:0,nextAttemptAt:0});
      if(fulfillment)await txn.put(`fulfillment:${orderId}`,fulfillment);
      if(next && ['refunded','partially_refunded','disputed'].includes(next.status)){
        await txn.put(`private-hold:${orderId}`,{delivered:false,payload:{eventId:event.id,livemode:jbhLive(this.env),orderId,paymentIntentId:next.paymentIntent,state:next.status}});
      }
      if(queue==='add'){
        await txn.put(`queue:${orderId}`,orderId);
        if(jbhLive(this.env)){
          await txn.put(`confirmation:${orderId}`,{status:'pending',createdAt:Date.now(),attempts:0,nextAttemptAt:0});
          await txn.put(`confirmation-pending:${orderId}`,orderId);
        }
        await txn.put(`private-receipt:${orderId}`,{delivered:false,payload:{eventId:event.id,livemode:jbhLive(this.env),orderId,paymentIntentId:next.paymentIntent,state:'awaiting_owner_dispatch'}});
      }
      await txn.put(`event:${event.id}`,{type:event.type,orderId,processedAt:Date.now(),...(reason?{note:reason}:{})});
    });
    await this.forwardPrivateHold(orderId);
    await this.forwardPrivateReceipt(orderId);
    await this.settlePrivateDelivery(orderId);
    return json({received:true});
  }
}
