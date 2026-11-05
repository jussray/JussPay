const ACCOUNT = 'acct_1U4xNyRs4gw4sfJH';
export const PRODUCTS = Object.freeze({promptos:'PromptOS',chief:'Chief',thinktank:'Think Tank',sol:'SolContinuity',fcr:'Founder Control Room'});
export const PRODUCT_IDS=Object.freeze({promptos:'prod_VZSVPKfsqwNYrQ',chief:'prod_VZSVv3oRoIAd8k',thinktank:'prod_VZSV48t06PDhP6',sol:'prod_VZSVrCa3mDPDtl',fcr:'prod_VZSVoNjmYqE90K'});
export function stripeConfiguration(env){
  if(env.STRIPE_LIVE==='true')return {accountId:ACCOUNT,products:PRODUCT_IDS};
  let config;try{config=JSON.parse(env.TEST_STRIPE_CONFIG||'null');}catch{fail(503,'sandbox_mapping_required');}
  if(!config || config.approved!==true || !/^acct_[a-zA-Z0-9]+$/.test(config.accountId||'') || typeof config.verificationReceipt!=='string' || !config.verificationReceipt.length || !config.products || Object.entries(config.products).some(([key,id])=>!Object.hasOwn(PRODUCTS,key)||!/^prod_[a-zA-Z0-9]+$/.test(id)))fail(503,'sandbox_mapping_required');
  return config;
}
const EVENTS = new Set(['checkout.session.completed','checkout.session.async_payment_succeeded','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed','charge.refunded','charge.dispute.created']);
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex'}});
const fail = (status,code) => { throw Object.assign(new Error(code),{status}); };
const enc = new TextEncoder();
export async function digest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function verifySignature(raw,header,secret,now=Math.floor(Date.now()/1000)){
  if(!secret || !header) return false;
  const parts=header.split(',').map(x=>x.split('='));
  const timestamps=parts.filter(([k])=>k==='t');
  if(timestamps.length!==1 || !/^\d+$/.test(timestamps[0][1])) return false;
  const t=Number(timestamps[0][1]);
  if(Math.abs(now-t)>300) return false;
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  for(const [k,v] of parts){
    if(k==='v1' && /^[0-9a-f]{64}$/.test(v) && await crypto.subtle.verify('HMAC',key,Uint8Array.from(v.match(/../g),h=>parseInt(h,16)),enc.encode(`${t}.${raw}`))) return true;
  }
  return false;
}
export function plans(env){
  let values;
  try{values=JSON.parse(env.APPROVED_PLANS || '{}');}catch{fail(503,'invalid_catalog');}
  if(!values || Array.isArray(values) || typeof values!=='object') fail(503,'invalid_catalog');
  for(const [product,p] of Object.entries(values)){
    if(!Object.hasOwn(PRODUCTS,product) || p.approved!==true || !/^price_[a-zA-Z0-9]+$/.test(p.priceId || '') || !Array.isArray(p.entitlements) || !p.entitlements.length || p.entitlements.some(x=>typeof x!=='string'||!x.length||x.length>100) || !Number.isSafeInteger(p.unitAmount) || p.unitAmount<1 || !/^[a-z]{3}$/.test(p.currency || '') || !['month','year'].includes(p.interval) || typeof p.termsUrl!=='string' || !p.termsUrl.startsWith('https://')) fail(503,'unapproved_catalog');
  }
  return values;
}
function ready(env,webhook=false){stripeConfiguration(env);if(!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_API_VERSION || !env.BILLING || !['true','false'].includes(env.STRIPE_LIVE))fail(503,'billing_not_configured');if(!webhook&&(!env.AUTH || !env.APP_ORIGIN || !env.APP_ORIGIN.startsWith('https://') || new URL(env.APP_ORIGIN).origin!==env.APP_ORIGIN)) fail(503,'billing_not_configured');}
export async function stripe(env,path,method='GET',data,key){
  const headers={'authorization':`Bearer ${env.STRIPE_SECRET_KEY}`,'Stripe-Version':env.STRIPE_API_VERSION};
  if(key) headers['Idempotency-Key']=key;
  if(data) headers['Content-Type']='application/x-www-form-urlencoded';
  const r=await (env.STRIPE_FETCH || fetch)(`https://api.stripe.com/v1/${path}`,{method,headers,body:data?new URLSearchParams(data):undefined,signal:AbortSignal.timeout(8000)});
  if(!r.ok) fail(502,'stripe_unavailable');
  return r.json();
}
async function account(env,forPurchase=false){const a=await stripe(env,'account');if(a.id!==stripeConfiguration(env).accountId)fail(503,'stripe_account_mismatch');if(forPurchase&&(!a.charges_enabled||!a.details_submitted))fail(503,'stripe_account_not_ready');}
async function identity(request,env){
  const token=request.headers.get('authorization');
  if(!token?.startsWith('Bearer ') || token.length>8192) fail(401,'authentication_required');
  // AUTH is a private Cloudflare service binding, never a caller-selected URL.
  const r=await env.AUTH.fetch(new Request('https://auth.internal/verify',{method:'POST',headers:{authorization:token,'content-type':'application/json'},body:JSON.stringify({audience:'jusspay'})}));
  if(!r.ok) fail(401,'authentication_required');
  const u=await r.json();
  if(typeof u.subject!=='string'||!u.subject.length||u.subject.length>200||u.audience!=='jusspay'||!Number.isFinite(u.expiresAt)||u.expiresAt<=Date.now()/1000) fail(401,'invalid_identity');
  return u.subject;
}
async function boundedText(request,limit){
  if(Number(request.headers.get('content-length')||0)>limit)fail(413,'payload_too_large');
  const reader=request.body?.getReader();if(!reader)return '';
  const chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();fail(413,'payload_too_large');}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
async function routeUser(env,subject,path,body){return env.BILLING.get(env.BILLING.idFromName(`${env.STRIPE_LIVE==='true'?'live':'test'}:${subject}`)).fetch(new Request(`https://billing.internal${path}`,{method:'POST',body:JSON.stringify({...body,subject})}));}
export default {async fetch(request,env){try{
  const url=new URL(request.url);
  if(url.pathname==='/health' && request.method==='GET'){
    let configured=true;try{ready(env);if(env.APPROVED_REFUND_POLICY!=='account_hold'||!Object.keys(plans(env)).length)fail(503,'no_approved_offers');}catch{configured=false;}
    return json({service:'JussPay',configured,livePaymentsVerified:false},configured?200:503);
  }
  if(url.pathname==='/catalog' && request.method==='GET'){
    const catalog=plans(env);let operational=true;try{ready(env);if(env.APPROVED_REFUND_POLICY!=='account_hold')fail(503,'refund_policy_not_approved');}catch{operational=false;}return json(Object.entries(PRODUCTS).map(([id,name])=>({id,name,purchaseStatus:operational&&catalog[id]?'requires_provider_validation':'unavailable',providerAvailabilityVerified:false,offerConfigured:Boolean(catalog[id]),...(catalog[id]?{unitAmount:catalog[id].unitAmount,currency:catalog[id].currency,interval:catalog[id].interval,termsUrl:catalog[id].termsUrl,entitlements:catalog[id].entitlements}:{})})));
  }
  ready(env,url.pathname==='/webhook');
  if(url.pathname==='/webhook' && request.method==='POST'){
    const raw=await boundedText(request,262144);
    if(!await verifySignature(raw,request.headers.get('stripe-signature'),env.STRIPE_WEBHOOK_SECRET)) fail(400,'invalid_signature');
    let event;try{event=JSON.parse(raw);}catch{fail(400,'invalid_event');}
    if(!/^evt_/.test(event.id||'') || event.livemode!==(env.STRIPE_LIVE==='true') || (event.account && event.account!==stripeConfiguration(env).accountId)) fail(400,'wrong_event_context');
    if(!EVENTS.has(event.type))return json({received:true,ignored:true});
    let object=event.data?.object;
    if(event.type==='charge.dispute.created'){
      const chargeId=typeof object?.charge==='string'?object.charge:object?.charge?.id;
      if(!/^ch_/.test(chargeId||''))fail(400,'missing_charge');
      object=await stripe(env,`charges/${encodeURIComponent(chargeId)}`);
    }
    const customerId=typeof object?.customer==='string'?object.customer:object?.customer?.id;
    if(!/^cus_/.test(customerId||'')) fail(400,'missing_customer');
    await account(env);
    const customer=await stripe(env,`customers/${encodeURIComponent(customerId)}`);
    if(customer.livemode!==(env.STRIPE_LIVE==='true'))fail(400,'wrong_customer_mode');
    const subject=customer.metadata?.jusspay_subject;
    // Unrelated account activity is acknowledged without exposing or assigning access.
    if(typeof subject!=='string'||!subject.length)return json({received:true,ignored:true});
    return routeUser(env,subject,'/event',{event,customerId});
  }
  if(!['/checkout','/portal','/entitlements'].includes(url.pathname))return json({error:'not_found'},404);
  if(request.method!==(url.pathname==='/entitlements'?'GET':'POST'))return json({error:'method_not_allowed'},405);
  // No ambient cookies, no CORS: app servers call this with a visitor-scoped token.
  const subject=await identity(request,env);
  let input={};if(request.method==='POST'){const text=await boundedText(request,4096);try{input=JSON.parse(text);if(!input || Array.isArray(input) || typeof input!=='object')fail(400,'invalid_json');}catch{fail(400,'invalid_json');}}
  return routeUser(env,subject,url.pathname,{product:input.product});
}catch(e){return json({error:e.status?e.message:'internal_error'},e.status||500);}}};

export class BillingAccount {
  constructor(state,env){this.state=state;this.env=env;this.tail=Promise.resolve();}
  fetch(request){const run=this.tail.then(()=>this.handle(request));this.tail=run.catch(()=>{});return run;}
  async handle(request){try{
    const input=await request.json();const path=new URL(request.url).pathname;
    const existing=await this.state.storage.get('subject');
    if(existing && existing!==input.subject) fail(403,'identity_mismatch');
    if(!existing)await this.state.storage.put('subject',input.subject);
    if(path==='/event')return await this.event(input);
    if(path==='/entitlements')return json({entitlements:await this.readEntitlements()});
    if(!['/checkout','/portal'].includes(path))fail(404,'not_found');
    const catalog=plans(this.env);
    const selectedPlan=path==='/checkout'&&Object.hasOwn(catalog,input.product)?catalog[input.product]:null;
    if(path==='/checkout'&&!selectedPlan)fail(409,'product_not_available');
    if(path==='/checkout'&&this.env.APPROVED_REFUND_POLICY!=='account_hold')fail(503,'refund_policy_not_approved');
    if(path==='/checkout'&&await this.state.storage.get('suspended'))fail(409,'billing_account_suspended');
    await account(this.env,path==='/checkout');
    let customer=await this.state.storage.get('customer');
    if(!customer){
      if(path==='/portal')fail(404,'no_billing_account');
      const c=await stripe(this.env,'customers','POST',{'metadata[jusspay_subject]':input.subject},`customer-${await digest(input.subject)}`);
      customer=c.id;await this.state.storage.put('customer',customer);
    }
    if(path==='/portal'){
      const s=await stripe(this.env,'billing_portal/sessions','POST',{customer,return_url:`${this.env.APP_ORIGIN}/account`});return json({url:s.url});
    }
    const p=selectedPlan;
    const rights=await this.readEntitlements();if(rights.some(x=>x.product===input.product))fail(409,'already_subscribed');
    const price=await stripe(this.env,`prices/${encodeURIComponent(p.priceId)}?expand%5B%5D=product`);
    if(!price.product?.active || price.product.livemode!==(this.env.STRIPE_LIVE==='true') || price.product?.id!==stripeConfiguration(this.env).products[input.product] || !price.active || price.livemode!==(this.env.STRIPE_LIVE==='true') || price.unit_amount!==p.unitAmount || price.currency!==p.currency || price.recurring?.interval!==p.interval || price.recurring?.interval_count!==1)fail(503,'price_configuration_mismatch');
    const fingerprint=await digest(JSON.stringify([p.priceId,p.unitAmount,p.currency,p.interval,p.entitlements,p.termsUrl,this.env.APP_ORIGIN]));
    let attempt=await this.state.storage.get(`checkout:${input.product}`);
    // Upgrade any pre-release string receipt to an explicit attempt record.
    if(typeof attempt==='string')attempt={id:attempt};
    if(attempt&&!attempt.id&&(!attempt.key||attempt.fingerprint!==fingerprint||!Number.isSafeInteger(attempt.createdAt)||Date.now()-attempt.createdAt>23*60*60*1000||attempt.createdAt>Date.now()))fail(409,'checkout_reconciliation_required');
    if(attempt?.id){
      const session=await stripe(this.env,`checkout/sessions/${encodeURIComponent(attempt.id)}`);
      if(session.customer!==customer)fail(403,'checkout_identity_mismatch');
      if(session.status==='open'){
        if(attempt.fingerprint===fingerprint)return json({url:session.url});
        await stripe(this.env,`checkout/sessions/${encodeURIComponent(attempt.id)}/expire`,'POST',{},`expire-${attempt.key||attempt.id}`);
      }
      if(session.status==='complete'){
        const subscription=typeof session.subscription==='string'?session.subscription:session.subscription?.id;
        if(!subscription)fail(409,'payment_processing');
        const {row,status}=await this.subscriptionRow(subscription,customer,input.subject);
        if(row.product!==input.product)fail(403,'checkout_product_mismatch');
        await this.state.storage.put(`subscription:${subscription}`,row);
        if(row.active)fail(409,'already_subscribed');
        if(!['canceled','incomplete_expired'].includes(status))fail(409,status==='incomplete'?'payment_processing':'billing_attention_required');
      }else if(!['expired','open'].includes(session.status))fail(503,'unknown_checkout_state');
      attempt=null;
    }
    if(!attempt){attempt={key:crypto.randomUUID(),fingerprint,createdAt:Date.now()};await this.state.storage.put(`checkout:${input.product}`,attempt);}
    const s=await stripe(this.env,'checkout/sessions','POST',{mode:'subscription',customer,'line_items[0][price]':p.priceId,'line_items[0][quantity]':'1',success_url:`${this.env.APP_ORIGIN}/account?checkout=processing`,cancel_url:`${this.env.APP_ORIGIN}/account?checkout=cancelled`,'client_reference_id':input.subject,'metadata[jusspay_product]':input.product,'subscription_data[metadata][jusspay_subject]':input.subject,'subscription_data[metadata][jusspay_product]':input.product},`checkout-${await digest(`${input.subject}:${input.product}:${attempt.key}`)}`);
    await this.state.storage.put(`checkout:${input.product}`,{...attempt,id:s.id});return json({url:s.url});
  }catch(e){return json({error:e.status?e.message:'internal_error'},e.status||500);}}
  async readEntitlements(){
    if(await this.state.storage.get('suspended'))return [];
    const rows=await this.state.storage.list({prefix:'subscription:'});const now=Date.now()/1000;const catalog=plans(this.env);
    return [...rows.values()].filter(x=>x.active&&x.until>now&&catalog[x.product]?.priceId===x.priceId).map(({product,until})=>({product,entitlements:catalog[product].entitlements,until}));
  }
  async subscriptionRow(subscription,customerId,subject){
    const s=await stripe(this.env,`subscriptions/${encodeURIComponent(subscription)}`);
    if((typeof s.customer==='string'?s.customer:s.customer?.id)!==customerId || s.metadata?.jusspay_subject!==subject)fail(403,'subscription_identity_mismatch');
    const product=s.metadata?.jusspay_product;let catalog={};try{catalog=plans(this.env);}catch{}const p=Object.hasOwn(catalog,product)?catalog[product]:null;
    const items=s.items?.data || [];const item=items.length===1?items[0]:null;
    const until=item?.current_period_end || s.current_period_end || 0;
    return {status:s.status,row:{product:product||null,priceId:item?.price?.id||null,active:Boolean(p && s.status==='active' && item?.price?.id===p.priceId && item.quantity===1 && until>Date.now()/1000),entitlements:p?.entitlements||[],until}};
  }
  async event({event,customerId,subject}){
    if(await this.state.storage.get(`event:${event.id}`))return json({received:true,duplicate:true});
    const existingCustomer=await this.state.storage.get('customer');if(existingCustomer && existingCustomer!==customerId)fail(403,'customer_mismatch');
    let subscription;
    const o=event.data.object;
    if(event.type.startsWith('customer.subscription.'))subscription=o.id;
    else if(event.type.startsWith('checkout.session.'))subscription=typeof o.subscription==='string'?o.subscription:o.subscription?.id;
    else if(event.type.startsWith('invoice.'))subscription=o.parent?.subscription_details?.subscription || o.subscription;
    let row;
    if(subscription){
      // Fetch inside serialized account object; old deliveries cannot overwrite a newer snapshot.
      ({row}=await this.subscriptionRow(subscription,customerId,subject));
    }else if(!['charge.refunded','charge.dispute.created'].includes(event.type))fail(400,'missing_subscription');
    await this.state.storage.transaction(async txn=>{
      if(await txn.get(`event:${event.id}`))return;
      await txn.put('customer',customerId);
      // Conservative account-wide suspension requires founder review; renewals cannot undo refunds/disputes.
      if(['charge.refunded','charge.dispute.created'].includes(event.type))await txn.put('suspended',{event:event.id,reason:event.type});
      if(row)await txn.put(`subscription:${subscription}`,row);
      await txn.put(`event:${event.id}`,{type:event.type,processedAt:Date.now()});
    });
    return json({received:true});
  }
}
