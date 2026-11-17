// JBH hair-order lane (founder ruling 2026-11-17): physical hair and beauty orders for
// jussbeautifulhair.com, sold by the Juss Ray Beauty Co Stripe account. Separate fact
// domain from the five-app subscription core: its own Stripe secrets, webhook secret,
// account binding and Durable Object (JbhOrderBook). OFF unless JBH_ORDERS_ENABLED=true,
// and sandbox-only in this version: live keys and live events are rejected.
//
// Flow: the storefront Worker (server-side, holding JBH_STOREFRONT_KEY) posts SKUs and
// quantities; prices come only from the server catalog JBH_CATALOG. A paid order is
// written to the owner's fulfillment queue grouped by vendor with status
// awaiting_owner_dispatch. Nothing here contacts, pays or orders from a vendor.
import {verifySignature,digest} from './worker.mjs';

export const JBH_LIVE_ACCOUNT='acct_1TfbELRp7J40bCrl'; // Juss Ray Beauty Co, read via the Stripe connector 2026-11-17
export const JBH_EVENTS=new Set(['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired','charge.refunded','charge.dispute.created']);
const MAX_LINES=10,MAX_QTY=10;

const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex'}});
const fail=(status,code)=>{throw Object.assign(new Error(code),{status});};

export function jbhCatalog(env){
  let values;try{values=JSON.parse(env.JBH_CATALOG||'{}');}catch{fail(503,'jbh_catalog_invalid');}
  if(!values||Array.isArray(values)||typeof values!=='object')fail(503,'jbh_catalog_invalid');
  for(const [sku,p] of Object.entries(values)){
    if(!/^[A-Z0-9][A-Z0-9-]{1,63}$/.test(sku)||p?.approved!==true||typeof p.name!=='string'||!p.name.length||p.name.length>120||!Number.isSafeInteger(p.unitAmount)||p.unitAmount<1||p.currency!=='usd'||!/^[a-z0-9][a-z0-9-]{1,39}$/.test(p.vendor||''))fail(503,'jbh_catalog_invalid');
  }
  return values;
}

// Shipping mirrors the storefront's posted terms; configured, never client-chosen.
export function jbhShipping(env){
  let s;try{s=JSON.parse(env.JBH_SHIPPING||'null');}catch{fail(503,'jbh_shipping_invalid');}
  const amount=x=>Number.isSafeInteger(x)&&x>=0;
  if(!s||!amount(s.standard)||!amount(s.express)||!(s.freeStandardOver===null||amount(s.freeStandardOver)))fail(503,'jbh_shipping_invalid');
  return s;
}

function sandboxKey(env){return /^(sk|rk)_test_/.test(env.JBH_STRIPE_SECRET_KEY||'');}

export function jbhReady(env,webhook=false){
  if(env.JBH_ORDERS_ENABLED!=='true')fail(503,'jbh_orders_disabled');
  if(env.JBH_STRIPE_LIVE!=='false')fail(503,'jbh_sandbox_only');
  if(!sandboxKey(env))fail(503,'jbh_sandbox_key_required');
  if(!env.JBH_STRIPE_WEBHOOK_SECRET||!env.JBH_STRIPE_API_VERSION||!env.JBH_ORDERS||!/^acct_[a-zA-Z0-9]+$/.test(env.JBH_TEST_ACCOUNT_ID||''))fail(503,'jbh_not_configured');
  if(!webhook){
    if(!env.JBH_STOREFRONT_KEY||env.JBH_STOREFRONT_KEY.length<32)fail(503,'jbh_not_configured');
    let origin;try{origin=new URL(env.JBH_STOREFRONT_ORIGIN).origin;}catch{fail(503,'jbh_not_configured');}
    if(!origin.startsWith('https://')||origin!==env.JBH_STOREFRONT_ORIGIN)fail(503,'jbh_not_configured');
  }
}

export async function jbhStripe(env,path,method='GET',data,key){
  const headers={'authorization':`Bearer ${env.JBH_STRIPE_SECRET_KEY}`,'Stripe-Version':env.JBH_STRIPE_API_VERSION};
  if(key)headers['Idempotency-Key']=key;
  if(data)headers['Content-Type']='application/x-www-form-urlencoded';
  const r=await (env.STRIPE_FETCH||fetch)(`https://api.stripe.com/v1/${path}`,{method,headers,body:data?new URLSearchParams(data):undefined,signal:AbortSignal.timeout(8000)});
  if(!r.ok)fail(502,'stripe_unavailable');
  return r.json();
}

async function jbhAccount(env,forPurchase){
  const a=await jbhStripe(env,'account');
  if(a.id!==env.JBH_TEST_ACCOUNT_ID)fail(503,'jbh_stripe_account_mismatch');
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
export function reconcileSession(session,order){
  return session?.id===order.sessionId&&session.client_reference_id===order.id&&session.metadata?.jbh_order_id===order.id
    &&session.mode==='payment'&&session.livemode===false&&session.currency===order.currency
    &&session.amount_subtotal===order.subtotal&&session.amount_total===order.total&&session.total_details?.amount_shipping===order.shipping;
}

function publicOrder(o){return {id:o.id,status:o.status,currency:o.currency,subtotal:o.subtotal,shipping:o.shipping,total:o.total,items:o.items.map(({sku,name,quantity})=>({sku,name,quantity}))};}

async function boundedJson(request,limit){
  if(Number(request.headers.get('content-length')||0)>limit)fail(413,'payload_too_large');
  const text=await request.text();if(text.length>limit)fail(413,'payload_too_large');
  return text;
}

const book=env=>env.JBH_ORDERS.get(env.JBH_ORDERS.idFromName('test:jbh-orders'));
const toBook=(env,path,body)=>book(env).fetch(new Request(`https://jbh-orders.internal${path}`,{method:'POST',body:JSON.stringify(body)}));

// Public entry for /jbh/* paths. Returns null for paths it does not own.
export async function handleJbh(request,env){
  const url=new URL(request.url);const path=url.pathname;
  if(!path.startsWith('/jbh/'))return null;
  try{
    if(path==='/jbh/webhook'){
      if(request.method!=='POST')return json({error:'method_not_allowed'},405);
      jbhReady(env,true);
      const raw=await boundedJson(request,262144);
      if(!await verifySignature(raw,request.headers.get('stripe-signature'),env.JBH_STRIPE_WEBHOOK_SECRET))fail(400,'invalid_signature');
      let event;try{event=JSON.parse(raw);}catch{fail(400,'invalid_event');}
      if(!/^evt_/.test(event.id||'')||event.livemode!==false||(event.account&&event.account!==env.JBH_TEST_ACCOUNT_ID))fail(400,'wrong_event_context');
      if(!JBH_EVENTS.has(event.type))return json({received:true,ignored:true});
      return toBook(env,'/event',{event});
    }
    if(path==='/jbh/checkout'||path.startsWith('/jbh/orders/')){
      jbhReady(env);
      if(!await sameSecret(request.headers.get('x-jbh-storefront-key'),env.JBH_STOREFRONT_KEY))fail(401,'storefront_key_required');
      if(path==='/jbh/checkout'){
        if(request.method!=='POST')return json({error:'method_not_allowed'},405);
        let input;try{input=JSON.parse(await boundedJson(request,4096));}catch(e){if(e.status)throw e;fail(400,'invalid_json');}
        const priced=priceOrder(env,input);
        return toBook(env,'/checkout',{priced});
      }
      if(request.method!=='GET')return json({error:'method_not_allowed'},405);
      const id=path.slice('/jbh/orders/'.length);
      if(!/^jbho_[0-9a-f-]{36}$/.test(id))fail(404,'not_found');
      return toBook(env,'/order',{id});
    }
    if(path==='/jbh/fulfillment'){
      jbhReady(env,true);
      if(request.method!=='GET')return json({error:'method_not_allowed'},405);
      if(!env.JBH_OWNER_KEY||env.JBH_OWNER_KEY.length<32||!await sameSecret(request.headers.get('x-jbh-owner-key'),env.JBH_OWNER_KEY))fail(401,'owner_key_required');
      return toBook(env,'/fulfillment',{});
    }
    return json({error:'not_found'},404);
  }catch(e){return json({error:e.status?e.message:'internal_error'},e.status||500);}
}

// One serialized order book per mode. Storage keys: order:<id>, session:<cs_id>,
// pi:<pi_id>, event:<evt_id>, fulfillment:<id>, receipt:<id>:<n>.
export class JbhOrderBook{
  constructor(state,env){this.state=state;this.env=env;this.tail=Promise.resolve();}
  fetch(request){const run=this.tail.then(()=>this.handle(request));this.tail=run.catch(()=>{});return run;}
  async handle(request){try{
    const path=new URL(request.url).pathname;const input=await request.json();
    if(path==='/checkout')return await this.checkout(input.priced);
    if(path==='/order'){const o=await this.state.storage.get(`order:${input.id}`);return o?json(publicOrder(o)):json({error:'not_found'},404);}
    if(path==='/fulfillment'){const rows=await this.state.storage.list({prefix:'fulfillment:'});return json({queue:[...rows.values()].filter(x=>x.status==='awaiting_owner_dispatch'||x.status==='hold')});}
    if(path==='/event')return await this.event(input.event);
    return json({error:'not_found'},404);
  }catch(e){return json({error:e.status?e.message:'internal_error'},e.status||500);}}

  async checkout(priced){
    const env=this.env;
    await jbhAccount(env,true);
    const id=`jbho_${crypto.randomUUID()}`;
    const order={id,status:'pending',...priced,createdAt:Date.now(),sessionId:null,paymentIntent:null};
    // The order exists before the provider side effect, so an unknown outcome is reconcilable by id.
    await this.state.storage.put(`order:${id}`,order);
    const origin=env.JBH_STOREFRONT_ORIGIN;
    const form={mode:'payment',client_reference_id:id,'metadata[jbh_order_id]':id,'payment_intent_data[metadata][jbh_order_id]':id,
      success_url:`${origin}/checkout/success?order=${id}`,cancel_url:`${origin}/checkout?cancelled=1`,
      'shipping_address_collection[allowed_countries][0]':'US','phone_number_collection[enabled]':'true',
      'shipping_options[0][shipping_rate_data][type]':'fixed_amount',
      'shipping_options[0][shipping_rate_data][display_name]':priced.shippingSpeed==='express'?'Express':'Standard',
      'shipping_options[0][shipping_rate_data][fixed_amount][amount]':String(priced.shipping),
      'shipping_options[0][shipping_rate_data][fixed_amount][currency]':'usd'};
    priced.items.forEach((x,i)=>{
      form[`line_items[${i}][quantity]`]=String(x.quantity);
      form[`line_items[${i}][price_data][currency]`]='usd';
      form[`line_items[${i}][price_data][unit_amount]`]=String(x.unitAmount);
      form[`line_items[${i}][price_data][product_data][name]`]=x.name;
      form[`line_items[${i}][price_data][product_data][metadata][jbh_sku]`]=x.sku;
    });
    const s=await jbhStripe(env,'checkout/sessions','POST',form,`jbh-checkout-${id}`);
    if(!/^cs_test_/.test(s.id||'')||typeof s.url!=='string')fail(502,'stripe_unavailable');
    await this.state.storage.put(`order:${id}`,{...order,sessionId:s.id});
    await this.state.storage.put(`session:${s.id}`,id);
    return json({orderId:id,url:s.url});
  }

  async receipt(orderId,reason,detail){
    const n=Date.now();await this.state.storage.put(`receipt:${orderId}:${n}`,{orderId,reason,detail,at:n});
  }

  async event(event){
    const storage=this.state.storage;
    if(await storage.get(`event:${event.id}`))return json({received:true,duplicate:true});
    const o=event.data?.object||{};
    let orderId=null;
    if(event.type.startsWith('checkout.session.'))orderId=(/^cs_/.test(o.id||'')&&await storage.get(`session:${o.id}`))||null;
    else{
      let pi=typeof o.payment_intent==='string'?o.payment_intent:o.payment_intent?.id;
      if(event.type==='charge.dispute.created'){
        const chargeId=typeof o.charge==='string'?o.charge:o.charge?.id;
        if(!/^ch_/.test(chargeId||''))fail(400,'missing_charge');
        const charge=await jbhStripe(this.env,`charges/${encodeURIComponent(chargeId)}`);
        pi=typeof charge.payment_intent==='string'?charge.payment_intent:charge.payment_intent?.id;
      }
      orderId=(pi&&await storage.get(`pi:${pi}`))||null;
    }
    // Activity on the account that is not a JussPay hair order is acknowledged and ignored.
    if(!orderId){await storage.put(`event:${event.id}`,{type:event.type,ignored:true,processedAt:Date.now()});return json({received:true,ignored:true});}
    const order=await storage.get(`order:${orderId}`);
    if(!order)fail(409,'order_missing');

    let next=null,fulfillment=null,reason=null;
    if(event.type.startsWith('checkout.session.')){
      await jbhAccount(this.env,false);
      const session=await jbhStripe(this.env,`checkout/sessions/${encodeURIComponent(order.sessionId)}`);
      if(!reconcileSession(session,order)){
        await this.receipt(orderId,'session_mismatch',{event:event.id,type:event.type});
        await storage.put(`event:${event.id}`,{type:event.type,mismatch:true,processedAt:Date.now()});
        return json({received:true,reconciliation_required:true});
      }
      if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)){
        if(session.payment_status!=='paid'){reason='awaiting_async_payment';}
        else if(order.status==='pending'){
          const pi=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
          const ship=session.collected_information?.shipping_details||session.shipping_details||null;
          if(!/^pi_/.test(pi||'')||!ship?.address){
            await this.receipt(orderId,'paid_without_shipping_or_intent',{event:event.id});
            await storage.put(`event:${event.id}`,{type:event.type,mismatch:true,processedAt:Date.now()});
            return json({received:true,reconciliation_required:true});
          }
          next={...order,status:'paid',paidAt:Date.now(),paymentIntent:pi};
          const byVendor={};for(const x of order.items)(byVendor[x.vendor]||=[]).push({sku:x.sku,name:x.name,quantity:x.quantity});
          fulfillment={orderId,status:'awaiting_owner_dispatch',vendors:byVendor,shipTo:{name:ship.name||null,address:ship.address,phone:session.customer_details?.phone||null},email:session.customer_details?.email||null,shippingSpeed:order.shippingSpeed,createdAt:Date.now()};
        }
      }else if(event.type==='checkout.session.async_payment_failed'&&order.status==='pending')next={...order,status:'payment_failed'};
      else if(event.type==='checkout.session.expired'&&order.status==='pending')next={...order,status:'expired'};
    }else if(['paid','refunded','disputed'].includes(order.status)){
      // Refunds and disputes hold dispatch for the owner; nothing re-opens automatically.
      next={...order,status:event.type==='charge.refunded'?'refunded':'disputed'};
      const f=await storage.get(`fulfillment:${orderId}`);
      if(f&&f.status==='awaiting_owner_dispatch')fulfillment={...f,status:'hold',holdReason:event.type};
    }

    await storage.transaction(async txn=>{
      if(await txn.get(`event:${event.id}`))return;
      if(next){await txn.put(`order:${orderId}`,next);if(next.paymentIntent)await txn.put(`pi:${next.paymentIntent}`,orderId);}
      if(fulfillment)await txn.put(`fulfillment:${orderId}`,fulfillment);
      await txn.put(`event:${event.id}`,{type:event.type,processedAt:Date.now(),...(reason?{note:reason}:{})});
    });
    return json({received:true});
  }
}
