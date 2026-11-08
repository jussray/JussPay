// Order + subscription lifecycle, harvested from PR #1 (chore/payment-safety-contract-20261029)
// into the canonical JussPay core by the 2026-11-05 design merge (see docs/DESIGN-MERGE.md).
//
// Storage decision: order and subscription state lives in the per-subject BillingAccount
// Durable Object (src/worker.mjs), which is the single source of truth for subscription and
// entitlement state. The lifecycle functions below run against a small store interface
// implemented by that Durable Object over its own storage:
//   getOrder(id)              -> row | null
//   putOrder(row)             -> persists the row (throws on storage failure)
//   listOrders()              -> all rows for the subject, insertion order
//   findOrderBySubscription(id) -> row | null
//   latestOrderForPlan(plan)  -> most recent row for the plan | null
//   findLiveOrder(plan)       -> most recent row with status in (pending, paid) and
//                                subscription_state in (pending, active, past_due) | null
// A row mirrors the columns of PR #1's D1 `orders` table (preserved for reference in
// docs/legacy-orders-schema.sql) plus its owning subject as customer_id. The D1 partial
// unique index that enforced "one live membership per customer and plan" is replaced by
// the Durable Object's serialized execution: check-and-insert is atomic per subject.
//
// Test-only recurring membership contract shared by Protect Me Model One and Model Two.
// No live Stripe key, anonymous checkout, public entitlement, or customer credentials.
export const TEST_PLANS=Object.freeze({
  one:Object.freeze({id:"one",product_id:"protect-model-one",merchant_id:"jussco",stripe_product_id:"prod_VZRcwIn9d0aHqX",price_id:"price_1UYIjBRs4gw4sfJHThjLPcpS",amount:499,currency:"usd",origin:"https://protect.jussco.company"}),
  two:Object.freeze({id:"two",product_id:"protect-model-two",merchant_id:"jussco",stripe_product_id:"prod_VZRc42RZZVrCS9",price_id:"price_1UYIjDRs4gw4sfJHm94eRNsJ",amount:1900,currency:"usd",origin:"https://protect2.jussco.company"})
});
const getPlan=key=>key==="one"?TEST_PLANS.one:key==="two"?TEST_PLANS.two:null;
export {getPlan};
export const testKey=env=>/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY||"");
const result=(status,body)=>({status,body});
async function fromStripe(env,path,fetchImpl){
  const response=await fetchImpl("https://api.stripe.com/v1/"+path,{headers:{authorization:"Bearer "+env.STRIPE_SECRET_KEY}});
  if(!response.ok)throw new Error("stripe_read_unavailable");
  return response.json();
}
export function priceMatches(price,plan){
  return !!(price&&price.id===plan.price_id&&price.product===plan.stripe_product_id&&
    price.active===true&&price.livemode===false&&price.type==="recurring"&&
    price.currency===plan.currency&&price.unit_amount===plan.amount&&
    price.recurring?.interval==="month"&&price.recurring.interval_count===1&&
    price.recurring.usage_type!=="metered");
}
export function subscriptionMatches(session,order,plan,items,subscription){
  const item=items?.data?.[0],subItem=subscription?.items?.data?.[0];
  return !!(session&&order&&plan&&session.id===order.session_id&&
    session.mode==="subscription"&&session.livemode===false&&session.payment_status==="paid"&&
    session.amount_total===plan.amount&&session.currency===plan.currency&&
    session.client_reference_id===order.id&&session.metadata?.purchase_id===order.id&&
    session.metadata?.product_id===plan.product_id&&session.metadata?.merchant_id===plan.merchant_id&&
    order.product_id===plan.product_id&&order.merchant_id===plan.merchant_id&&
    order.amount_total===plan.amount&&order.currency===plan.currency&&order.plan===plan.id&&
    typeof session.customer==="string"&&session.customer.startsWith("cus_")&&
    typeof session.subscription==="string"&&session.subscription.startsWith("sub_")&&
    items?.has_more===false&&items.data.length===1&&item.quantity===1&&
    item.price?.id===plan.price_id&&item.price?.type==="recurring"&&
    item.amount_total===plan.amount&&item.currency===plan.currency&&
    subscription.id===session.subscription&&subscription.customer===session.customer&&
    subscription.livemode===false&&subscription.status==="active"&&
    Array.isArray(subscription.items?.data)&&subscription.items.data.length===1&&
    subItem.quantity===1&&subItem.price?.id===plan.price_id&&
    subItem.price?.currency===plan.currency&&subItem.price?.unit_amount===plan.amount);
}
export function validatePurchase(session,order){
 return !!(session&&order&&session.id===order.session_id&&session.payment_status==="paid"&&session.mode==="payment"&&session.currency===order.currency&&session.amount_total===order.amount_total&&session.metadata?.purchase_id===order.id&&session.metadata?.product_id===order.product_id&&session.metadata?.merchant_id===order.merchant_id&&session.client_reference_id===order.id);
}
export function isSubscriptionEvent(event){
  return (["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event?.type)&&event.data?.object?.mode==="subscription")||
    ["invoice.paid","invoice.payment_failed","customer.subscription.deleted"].includes(event?.type);
}

// POST /subscriptions/orders — create (or reuse) the subject's server-priced test-plan order.
// Caller has already authenticated the subject and applied the subscriptions gates.
export async function createTestOrder(store,subject,input){
  const plan=getPlan(input?.plan);
  if(!plan)return result(400,{error:"invalid_plan"});
  const existing=await store.findLiveOrder(plan.id);
  if(existing)return result(200,{purchase_id:existing.id,plan:plan.id,amount_minor:plan.amount,currency:plan.currency,test_mode:true,reused:true});
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
  const purchaseId="purchase_"+[...bytes].map(v=>v.toString(16).padStart(2,"0")).join("");
  const row={id:purchaseId,product_id:plan.product_id,merchant_id:plan.merchant_id,customer_id:subject,currency:plan.currency,amount_total:plan.amount,session_id:null,status:"pending",plan:plan.id,price_id:plan.price_id,subscription_id:null,stripe_customer_id:null,subscription_state:"pending"};
  try{await store.putOrder(row);}catch{return result(409,{error:"order_conflict_or_unavailable"});}
  return result(201,{purchase_id:purchaseId,plan:plan.id,amount_minor:plan.amount,currency:plan.currency,test_mode:true});
}

// GET /subscriptions/entitlement?plan=one|two — billing state only; never a service activation.
export async function planEntitlement(store,planKey){
  const plan=getPlan(planKey);
  if(!plan)return result(400,{error:"invalid_plan"});
  let order;
  try{order=await store.latestOrderForPlan(plan.id);}catch{return result(503,{error:"orders_unavailable"});}
  const state=order?.subscription_state||"not_subscribed";
  return result(200,{plan:plan.id,billing_state:state,billing_active:order?.status==="paid"&&state==="active",service_activation:"not_verified",test_mode:true});
}

// GET /subscriptions/status?purchase_id=... — the subject's own order (the store is per-subject,
// so another subject's order is indistinguishable from a missing one: 404, as in PR #1).
export async function orderStatus(store,purchaseId){
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(purchaseId||""))return result(400,{error:"invalid_order"});
  const order=await store.getOrder(purchaseId);
  if(!order)return result(404,{error:"order_not_found"});
  return result(200,{purchase_id:order.id,product_id:order.product_id,billing_state:order.subscription_state||"pending",test_mode:true});
}

// POST /subscriptions/checkout — open a Stripe test subscription Checkout for a pending order.
// `customerId` is the subject's JussPay-managed Stripe customer when one exists, so webhook
// delivery routes back to the same BillingAccount via customer metadata; the session and
// subscription metadata always carry jusspay_subject + purchase_id as a second route.
export async function checkoutTestSubscription(store,env,fetchImpl,subject,input,ensureCustomer){
  const plan=getPlan(input?.plan);
  if(!plan||!/^[A-Za-z0-9_-]{8,100}$/.test(input?.purchase_id||""))return result(400,{error:"invalid_plan_or_order"});
  const order=await store.getOrder(input.purchase_id);
  if(!order||order.status!=="pending"||order.plan!==input.plan||
     order.product_id!==plan.product_id||order.merchant_id!==plan.merchant_id||
     order.amount_total!==plan.amount||order.currency!==plan.currency)
     return result(403,{error:"order_not_authorized"});
  let price;
  try{price=await fromStripe(env,"prices/"+encodeURIComponent(plan.price_id),fetchImpl)}
  catch{return result(503,{error:"stripe_price_unavailable"})}
  if(!priceMatches(price,plan))return result(503,{error:"approved_monthly_price_mismatch"});
  const params=new URLSearchParams({
    mode:"subscription","line_items[0][price]":plan.price_id,"line_items[0][quantity]":"1",
    client_reference_id:order.id,
    "metadata[purchase_id]":order.id,"metadata[product_id]":plan.product_id,
    "metadata[merchant_id]":plan.merchant_id,"metadata[jusspay_subject]":subject,
    "subscription_data[metadata][purchase_id]":order.id,"subscription_data[metadata][jusspay_subject]":subject,
    success_url:plan.origin+"/checkout?test_payment=return",
    cancel_url:plan.origin+"/checkout?test_payment=canceled"
  });
  // Customer ownership must be established before Checkout; Stripe-created
  // customers do not automatically inherit the session's routing metadata.
  let customerId;
  try{customerId=await ensureCustomer();}
  catch{return result(503,{error:"customer_binding_unavailable"})}
  if(typeof customerId!=="string"||!/^cus_[a-zA-Z0-9_]+$/.test(customerId))
    return result(503,{error:"customer_binding_unavailable"});
  params.set("customer",customerId);
  let response,session;
  try{
    response=await fetchImpl("https://api.stripe.com/v1/checkout/sessions",{
      method:"POST",headers:{authorization:"Bearer "+env.STRIPE_SECRET_KEY,
        "content-type":"application/x-www-form-urlencoded","idempotency-key":"jusspay-sub-"+order.id},body:params});
    session=await response.json();
  }catch{return result(503,{error:"checkout_provider_unavailable"})}
  if(!response.ok||!/^cs_test_/.test(session?.id||"")||session?.mode!=="subscription"||
     !/^https:\/\/checkout\.stripe\.com\//.test(session?.url||""))
     return result(502,{error:"invalid_checkout_response"});
  let saved;
  try{
    const current=await store.getOrder(order.id);
    if(!current||current.status!=="pending"||(current.session_id!==null&&current.session_id!==session.id))saved=false;
    else{await store.putOrder({...current,session_id:session.id,price_id:plan.price_id});saved=true;}
  }catch{return result(503,{error:"checkout_state_unavailable"})}
  if(!saved)return result(409,{error:"checkout_state_conflict"});
  return result(200,{checkout_url:session.url,plan:input.plan,monthly_amount_minor:plan.amount,currency:plan.currency,test_mode:true});
}

// POST /orders/checkout — PR #1's one-time, pre-authorized order checkout (sandbox keys only).
// Orders are created outside this route (PR #1 required a separate authenticated service;
// test-plan orders are created by createTestOrder). Prices come only from the server catalog.
export async function checkoutOneTimeOrder(store,env,fetchImpl,input){
  if(!testKey(env))return result(503,{error:"sandbox_key_required"});
  if(!env.STRIPE_SECRET_KEY||!env.CATALOG||!env.APP_ORIGIN)return result(503,{error:"not_configured"});
  if(typeof input?.product_id!=="string"||typeof input?.purchase_id!=="string"||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.purchase_id))return result(400,{error:"invalid_request"});
  let catalog;try{catalog=JSON.parse(env.CATALOG)}catch{return result(503,{error:"catalog_misconfigured"})}
  const product=catalog?.[input.product_id];
  if(!product||!Number.isSafeInteger(product.amount)||product.amount<=0||!/^[a-z]{3}$/.test(product.currency)||!product.merchant_id)return result(400,{error:"unknown_product"});
  const order=await store.getOrder(input.purchase_id);
  if(!order||order.product_id!==input.product_id||order.merchant_id!==product.merchant_id||order.amount_total!==product.amount||order.currency!==product.currency||order.status!=="pending")return result(403,{error:"order_not_authorized"});
  const params=new URLSearchParams({mode:"payment",success_url:env.APP_ORIGIN+"/payment/return?session_id={CHECKOUT_SESSION_ID}",cancel_url:env.APP_ORIGIN+"/payment/cancel",client_reference_id:order.id,"line_items[0][price_data][currency]":product.currency,"line_items[0][price_data][unit_amount]":String(product.amount),"line_items[0][price_data][product_data][name]":product.name,"line_items[0][quantity]":"1","metadata[purchase_id]":order.id,"metadata[product_id]":order.product_id,"metadata[merchant_id]":order.merchant_id});
  let response;try{response=await fetchImpl("https://api.stripe.com/v1/checkout/sessions",{method:"POST",headers:{authorization:"Bearer "+env.STRIPE_SECRET_KEY,"content-type":"application/x-www-form-urlencoded","idempotency-key":"jusspay-"+order.id},body:params})}catch{return result(503,{error:"checkout_provider_unavailable"})}
  if(!response.ok)return result(502,{error:"checkout_provider_error"});
  let session;try{session=await response.json()}catch{return result(502,{error:"invalid_provider_response"})}
  if(!session.id||!session.url)return result(502,{error:"invalid_provider_response"});
  let saved;
  try{
    const current=await store.getOrder(order.id);
    if(!current||current.status!=="pending"||(current.session_id!==null&&current.session_id!==session.id))saved=false;
    else{await store.putOrder({...current,session_id:session.id});saved=true;}
  }catch{return result(503,{error:"checkout_state_unavailable"})}
  if(!saved)return result(409,{error:"checkout_state_conflict"});
  return result(200,{checkout_url:session.url});
}

// Webhook lifecycle for orders. Called by the BillingAccount event handler after the core
// webhook pipeline (signature, mode, account, customer identity) has routed the event to the
// owning subject. Returns a result for order events, or null when the event is not an order
// event and the caller should apply the catalog-subscription path instead.
export async function orderWebhook(store,env,fetchImpl,event){
  if(isSubscriptionEvent(event))return subscriptionWebhook(store,env,fetchImpl,event);
  if(!["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event.type))return null;
  const s=event.data?.object;
  if(!s?.id||s.payment_status!=="paid")return result(200,{received:true});
  if(!s.metadata?.purchase_id)return null;
  const order=await store.getOrder(s.client_reference_id||"");
  if(!validatePurchase(s,order))return result(409,{error:"purchase_mismatch"});
  // Provider readback is required: never trust a signed event payload alone.
  if(!testKey(env))return result(503,{error:"sandbox_key_required"});
  let current;
  try{
    const check=await fetchImpl("https://api.stripe.com/v1/checkout/sessions/"+encodeURIComponent(s.id),{headers:{authorization:"Bearer "+env.STRIPE_SECRET_KEY}});
    if(!check.ok)return result(503,{error:"provider_reconciliation_failed"});
    current=await check.json();
  }catch{return result(503,{error:"provider_reconciliation_failed"})}
  if(!validatePurchase(current,order))return result(409,{error:"provider_purchase_mismatch"});
  // A local paid flag is not an entitlement; downstream fulfillment remains disabled.
  try{
    const latest=await store.getOrder(order.id);
    if(!latest||latest.status!=="pending"||latest.session_id!==s.id){
      if(!latest||latest.status!=="paid"||!validatePurchase(current,latest))return result(409,{error:"reconciliation_state_conflict"});
    }else{
      await store.putOrder({...latest,status:"paid"});
    }
  }catch{return result(503,{error:"reconciliation_persist_failed"})}
  return result(200,{received:true});
}

async function subscriptionWebhook(store,env,fetchImpl,event){
  if(env.SUBSCRIPTIONS_TEST_ENABLED!=="true"||!testKey(env))return result(503,{error:"subscriptions_not_enabled"});
  if(event?.livemode!==false)return result(400,{error:"mode_mismatch"});
  const data=event.data?.object||{};
  if(["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event.type)){
    if(data.payment_status!=="paid")return result(200,{received:true});
    const order=await store.getOrder(data.client_reference_id||"");
    const plan=order?getPlan(order.plan):null;
    if(!plan||order.session_id!==data.id)return result(409,{error:"unknown_subscription_order"});
    if(order.status==="paid"&&order.subscription_state!=="pending")return result(200,{received:true,duplicate:true});
    if(order.status!=="pending")return result(409,{error:"order_state_conflict"});
    let session,items,subscription;
    try{
      session=await fromStripe(env,"checkout/sessions/"+encodeURIComponent(data.id),fetchImpl);
      items=await fromStripe(env,"checkout/sessions/"+encodeURIComponent(data.id)+"/line_items?limit=10",fetchImpl);
      subscription=await fromStripe(env,"subscriptions/"+encodeURIComponent(session.subscription||""),fetchImpl);
    }catch{return result(503,{error:"provider_reconciliation_unavailable"})}
    if(!subscriptionMatches(session,order,plan,items,subscription)||
       data.subscription!==session.subscription||data.customer!==session.customer||
       data.amount_total!==session.amount_total||data.currency!==session.currency||
       data.metadata?.purchase_id!==session.metadata.purchase_id)
       return result(409,{error:"subscription_reconciliation_mismatch"});
    try{await store.putOrder({...order,status:"paid",subscription_state:"active",subscription_id:subscription.id,stripe_customer_id:session.customer,price_id:plan.price_id});}
    catch{return result(503,{error:"subscription_persist_unavailable"})}
    return result(200,{received:true});
  }
  const subscriptionId=event.type==="customer.subscription.deleted"?data.id:
    (typeof data.subscription==="string"?data.subscription:null);
  if(typeof subscriptionId!=="string"||!subscriptionId.startsWith("sub_"))return result(200,{received:true});
  const order=await store.findOrderBySubscription(subscriptionId);
  if(!order||!getPlan(order.plan))return result(200,{received:true});
  if(event.type==="customer.subscription.deleted"||event.type==="invoice.payment_failed"){
    const next=event.type==="customer.subscription.deleted"?"canceled":"past_due";
    // A duplicate or out-of-order failure must not reactivate a subscription.
    if(["active","past_due"].includes(order.subscription_state))
      await store.putOrder({...order,subscription_state:next});
    return result(200,{received:true});
  }
  if(event.type==="invoice.paid"&&order.subscription_state==="past_due"){
    if(data.paid!==true||data.amount_paid!==TEST_PLANS[order.plan].amount||data.currency!==TEST_PLANS[order.plan].currency)return result(200,{received:true});
    let subscription;
    try{subscription=await fromStripe(env,"subscriptions/"+encodeURIComponent(subscriptionId),fetchImpl)}
    catch{return result(503,{error:"renewal_verification_unavailable"})}
    const p=getPlan(order.plan),item=subscription.items?.data?.[0];
    if(subscription.livemode!==false||subscription.status!=="active"||subscription.customer!==order.stripe_customer_id||
       item?.price?.id!==p.price_id||item.quantity!==1)return result(409,{error:"renewal_mismatch"});
    await store.putOrder({...order,subscription_state:"active"});
  }
  return result(200,{received:true});
}
