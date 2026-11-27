// FCR receives redacted observations, never customer data or payment authority.
const SHA=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
const ORDER=/^jbho_[a-f0-9-]{36}$/;
const EVENT=/^evt_[A-Za-z0-9_]{1,180}$/;
const SCHEMA='jusspay/commerce-receipt@v1';
const kinds=['payment_recorded','refund_hold','dispute_hold'];
const fields=['orderId','eventId','product','event','grossMinor','occurredAt','livemode'];
const validKey=k=>typeof k==='string'&&k.length>=32&&k.length<=512;
function distinctKeys(env){
 const a=env.JUSSPAY_FCR_HASH_KEY,b=env.JUSSPAY_FCR_RECEIPT_KEY;
 return validKey(a)&&validKey(b)&&a!==b&&![env.JBH_OWNER_KEY,env.JBH_STOREFRONT_KEY,env.JBH_STRIPE_SECRET_KEY,env.JBH_PRIVATE_LIVE_RECEIPT_SECRET].some(k=>k===a||k===b);
}
export function fcrReceiptEnabled(env){
 return env.JUSSPAY_FCR_RECEIPTS_ENABLED==='true'&&distinctKeys(env)&&typeof env.JUSSPAY_FCR?.fetch==='function';
}
async function keyedHash(secret,input){
 const enc=new TextEncoder();
 const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(input))),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function buildCommerceReceipt(env,fact){
 if(!distinctKeys(env)||!SHA.test(env.RELEASE_SHA||'')||!fact||typeof fact!=='object'||Object.keys(fact).length!==fields.length||fields.some(k=>!Object.hasOwn(fact,k))||
 fact.livemode!==true||fact.product!=='jbh'||typeof fact.orderId!=='string'||!ORDER.test(fact.orderId)||
 typeof fact.eventId!=='string'||!EVENT.test(fact.eventId)||!kinds.includes(fact.event)||
 !Number.isSafeInteger(fact.occurredAt)||fact.occurredAt<1||fact.occurredAt>8640000000000000)return null;
 if(fact.event==='payment_recorded'?(!Number.isSafeInteger(fact.grossMinor)||fact.grossMinor<1||fact.grossMinor>100000000):fact.grossMinor!==null)return null;
 const key=env.JUSSPAY_FCR_HASH_KEY;
 const [receiptId,orderRefHash]=await Promise.all([keyedHash(key,'jbh:receipt:v1:'+fact.eventId),keyedHash(key,'jbh:order:v1:'+fact.orderId)]);
 return {schema:SCHEMA,receiptId,orderRefHash,product:'jbh',mode:'live',event:fact.event,grossMinor:fact.grossMinor,currency:'usd',occurredAt:new Date(fact.occurredAt).toISOString(),releaseSha:env.RELEASE_SHA};
}
export async function sendCommerceReceipt(env,receipt){
 if(!fcrReceiptEnabled(env)||receipt?.schema!==SCHEMA||!HASH.test(receipt.receiptId||''))return false;
 try{
  const response=await env.JUSSPAY_FCR.fetch(new Request('https://fcr.internal/ingest/jusspay-receipts',{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json','x-jusspay-receipt-key':env.JUSSPAY_FCR_RECEIPT_KEY},body:JSON.stringify(receipt)}));
  if(!response.ok)return false;
  const ack=await response.json();
  return ack?.accepted===true&&ack.receiptId===receipt.receiptId&&typeof ack.duplicate==='boolean';
 }catch{return false;}
}
