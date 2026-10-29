const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const allowed=(url,base)=>{try{const u=new URL(url);return u.origin===new URL(base).origin&&u.protocol==="https:"}catch{return false}};
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
const eq=(a,b)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0};
export async function verifySignature(body,header,secret,now=Math.floor(Date.now()/1000)){
 if(!header||!secret)return false;
 const t=header.match(/(?:^|,)t=(\d+)(?:,|$)/)?.[1],sigs=[...header.matchAll(/(?:^|,)v1=([a-f0-9]{64})(?:,|$)/g)].map(m=>m[1]);
 if(!t||!sigs.length||Math.abs(now-Number(t))>300)return false;
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),"HMAC",false,["sign"]);
 const sig=hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(t+"."+body)));
 return sigs.some(s=>eq(s,sig));
}
export function validatePurchase(session,order){
 return !!(session&&order&&session.id===order.session_id&&session.payment_status==="paid"&&session.mode==="payment"&&session.currency===order.currency&&session.amount_total===order.amount_total&&session.metadata?.purchase_id===order.id&&session.metadata?.product_id===order.product_id&&session.metadata?.merchant_id===order.merchant_id&&session.client_reference_id===order.id);
}
export default {async fetch(req,env){
 const url=new URL(req.url);
 if(url.pathname==="/health"&&req.method==="GET")return json({service:"jusspay",payments:"disabled"});
 if(env.PAYMENTS_ENABLED!=="true")return json({error:"payments_disabled"},503);
 if(url.pathname==="/checkout"&&req.method==="POST"){
  if(!env.STRIPE_SECRET_KEY?.startsWith("rk_test_")&&!env.STRIPE_SECRET_KEY?.startsWith("sk_test_"))return json({error:"sandbox_key_required"},503);
  if(!env.STRIPE_SECRET_KEY||!env.CATALOG||!env.APP_ORIGIN||!env.ORDERS)return json({error:"not_configured"},503);
  let input;try{input=await req.json()}catch{return json({error:"invalid_json"},400)}
  if(typeof input?.product_id!=="string"||typeof input?.purchase_id!=="string"||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.purchase_id))return json({error:"invalid_request"},400);
  const product=JSON.parse(env.CATALOG)[input.product_id];
  if(!product||!Number.isSafeInteger(product.amount)||product.amount<=0||! /^[a-z]{3}$/.test(product.currency)||!product.merchant_id)return json({error:"unknown_product"},400);
  if(!allowed(env.APP_ORIGIN,env.APP_ORIGIN))return json({error:"invalid_origin"},503);
  // A separate authenticated order-creation service is still required before this route is exposed.
  if(env.CHECKOUT_AUTH_READY!=="true"||!env.AUTH_SERVICE)return json({error:"authorization_not_ready"},503);
  const token=req.headers.get("authorization");
  if(!token?.startsWith("Bearer "))return json({error:"unauthorized"},401);
  let identity;
  try{identity=await env.AUTH_SERVICE.fetch(new Request("https://auth.internal/verify",{method:"POST",headers:{authorization:token}}));}catch{return json({error:"auth_unavailable"},503)}
  if(!identity.ok)return json({error:"unauthorized"},401);
  let principal;try{principal=await identity.json()}catch{return json({error:"auth_unavailable"},503)}
  if(!principal?.subject||typeof principal.subject!=="string")return json({error:"unauthorized"},401);
  const order=await env.ORDERS.prepare("SELECT * FROM orders WHERE id=?").bind(input.purchase_id).first();
  if(!order||order.customer_id!==principal.subject||order.product_id!==input.product_id||order.merchant_id!==product.merchant_id||order.amount_total!==product.amount||order.currency!==product.currency||order.status!=="pending")return json({error:"order_not_authorized"},403);
  const params=new URLSearchParams({mode:"payment",success_url:env.APP_ORIGIN+"/payment/return?session_id={CHECKOUT_SESSION_ID}",cancel_url:env.APP_ORIGIN+"/payment/cancel",client_reference_id:order.id,"line_items[0][price_data][currency]":product.currency,"line_items[0][price_data][unit_amount]":String(product.amount),"line_items[0][price_data][product_data][name]":product.name,"line_items[0][quantity]":"1","metadata[purchase_id]":order.id,"metadata[product_id]":order.product_id,"metadata[merchant_id]":order.merchant_id});
  const response=await fetch("https://api.stripe.com/v1/checkout/sessions",{method:"POST",headers:{authorization:"Bearer "+env.STRIPE_SECRET_KEY,"content-type":"application/x-www-form-urlencoded","idempotency-key":"jusspay-"+order.id},body:params});
  if(!response.ok)return json({error:"checkout_provider_error"},502);
  const session=await response.json();
  if(!session.id||!session.url)return json({error:"invalid_provider_response"},502);
  const saved=await env.ORDERS.prepare("UPDATE orders SET session_id=? WHERE id=? AND status='pending' AND (session_id IS NULL OR session_id=?)").bind(session.id,order.id,session.id).run();
  if(saved.meta?.changes!==1)return json({error:"checkout_state_conflict"},409);
  return json({checkout_url:session.url});
 }
 if(url.pathname==="/stripe/webhook"&&req.method==="POST"){
  if(!env.STRIPE_WEBHOOK_SECRET||!env.ORDERS)return json({error:"not_configured"},503);
  if(env.WEBHOOK_RECONCILIATION_READY!=="true")return json({error:"reconciliation_not_ready"},503);
  const body=await req.text();
  if(!await verifySignature(body,req.headers.get("stripe-signature"),env.STRIPE_WEBHOOK_SECRET))return json({error:"invalid_signature"},400);
  let event;try{event=JSON.parse(body)}catch{return json({error:"invalid_json"},400)}
  if(!["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event.type))return json({received:true});
  const s=event.data?.object;
  if(!s?.id||s.payment_status!=="paid")return json({received:true});
  const order=await env.ORDERS.prepare("SELECT * FROM orders WHERE id=?").bind(s.client_reference_id||"").first();
  if(!validatePurchase(s,order))return json({error:"purchase_mismatch"},409);
  // Provider readback is required: never trust a signed event payload alone.
  if(!env.STRIPE_SECRET_KEY?.startsWith("rk_test_")&&!env.STRIPE_SECRET_KEY?.startsWith("sk_test_"))return json({error:"sandbox_key_required"},503);
  const check=await fetch("https://api.stripe.com/v1/checkout/sessions/"+encodeURIComponent(s.id),{headers:{authorization:"Bearer "+env.STRIPE_SECRET_KEY}});
  if(!check.ok)return json({error:"provider_reconciliation_failed"},503);
  const current=await check.json();
  if(!validatePurchase(current,order))return json({error:"provider_purchase_mismatch"},409);
  // A local paid flag is not an entitlement; downstream fulfillment remains disabled.
  await env.ORDERS.prepare("UPDATE orders SET status='paid' WHERE id=? AND status='pending' AND session_id=?").bind(order.id,s.id).run();
  return json({received:true});
 }
 return json({error:"not_found"},404);
}};
