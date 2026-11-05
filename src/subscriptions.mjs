// Test-only recurring membership contract shared by Protect Me Model One and Model Two.
// No live Stripe key, anonymous checkout, public entitlement, or customer credentials.
export const TEST_PLANS=Object.freeze({
  one:Object.freeze({id:"one",product_id:"protect-model-one",merchant_id:"jussco",stripe_product_id:"prod_VZRcwIn9d0aHqX",price_id:"price_1UYIjBRs4gw4sfJHThjLPcpS",amount:499,currency:"usd",origin:"https://protect.jussco.company"}),
  two:Object.freeze({id:"two",product_id:"protect-model-two",merchant_id:"jussco",stripe_product_id:"prod_VZRc42RZZVrCS9",price_id:"price_1UYIjDRs4gw4sfJHm94eRNsJ",amount:1900,currency:"usd",origin:"https://protect2.jussco.company"})
});
const respond=(data,status=200)=>Response.json(data,{status,headers:{"cache-control":"no-store","x-content-type-options":"nosniff"}});
const testKey=env=>/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY||"");
const bearer=req=>{const a=req.headers.get("authorization")||"";return a.startsWith("Bearer ")&&a.length>12?a:null};
async function principal(req,env){
  const token=bearer(req);
  if(!token||env.CHECKOUT_AUTH_READY!=="true"||!env.AUTH_SERVICE)return null;
  let response;
  try{response=await env.AUTH_SERVICE.fetch(new Request("https://auth.internal/verify",{method:"POST",headers:{authorization:token}}));}
  catch{return null;}
  if(!response.ok)return null;
  try{const data=await response.json();return typeof data?.subject==="string"&&data.subject.length>0?data.subject:null;}
  catch{return null;}
}
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
export async function subscriptionRequest(req,env,fetchImpl=fetch){
  if(env.SUBSCRIPTIONS_TEST_ENABLED!=="true")return respond({error:"subscriptions_not_enabled"},503);
  if(!testKey(env))return respond({error:"test_key_required"},503);
  if(!env.ORDERS)return respond({error:"orders_not_configured"},503);
  const subject=await principal(req,env);
  if(!subject)return respond({error:"authenticated_account_required"},401);
  const url=new URL(req.url);
  if(req.method==="GET"&&url.pathname==="/subscriptions/status"){
    const id=url.searchParams.get("purchase_id")||"";
    if(!/^[A-Za-z0-9_-]{8,100}$/.test(id))return respond({error:"invalid_order"},400);
    const order=await env.ORDERS.prepare("SELECT * FROM orders WHERE id=? AND customer_id=?").bind(id,subject).first();
    if(!order)return respond({error:"order_not_found"},404);
    return respond({purchase_id:order.id,product_id:order.product_id,billing_state:order.subscription_state||"pending",test_mode:true});
  }
  if(req.method!=="POST"||url.pathname!=="/subscriptions/checkout")return respond({error:"not_found"},404);
  let input;try{input=await req.json()}catch{return respond({error:"invalid_json"},400)}
  const plan=TEST_PLANS[input?.plan];
  if(!plan||! /^[A-Za-z0-9_-]{8,100}$/.test(input?.purchase_id||""))return respond({error:"invalid_plan_or_order"},400);
  const order=await env.ORDERS.prepare("SELECT * FROM orders WHERE id=? AND customer_id=?").bind(input.purchase_id,subject).first();
  if(!order||order.status!=="pending"||order.plan!==input.plan||
     order.product_id!==plan.product_id||order.merchant_id!==plan.merchant_id||
     order.amount_total!==plan.amount||order.currency!==plan.currency)
     return respond({error:"order_not_authorized"},403);
  let price;
  try{price=await fromStripe(env,"prices/"+encodeURIComponent(plan.price_id),fetchImpl)}
  catch{return respond({error:"stripe_price_unavailable"},503)}
  if(!priceMatches(price,plan))return respond({error:"approved_monthly_price_mismatch"},503);
  const params=new URLSearchParams({
    mode:"subscription","line_items[0][price]":plan.price_id,"line_items[0][quantity]":"1",
    client_reference_id:order.id,
    "metadata[purchase_id]":order.id,"metadata[product_id]":plan.product_id,
    "metadata[merchant_id]":plan.merchant_id,
    "subscription_data[metadata][purchase_id]":order.id,
    success_url:plan.origin+"/checkout?test_payment=return",
    cancel_url:plan.origin+"/checkout?test_payment=canceled"
  });
  let response,session;
  try{
    response=await fetchImpl("https://api.stripe.com/v1/checkout/sessions",{
      method:"POST",headers:{authorization:"Bearer "+env.STRIPE_SECRET_KEY,
        "content-type":"application/x-www-form-urlencoded","idempotency-key":"jusspay-sub-"+order.id},body:params});
    session=await response.json();
  }catch{return respond({error:"checkout_provider_unavailable"},503)}
  if(!response.ok||!/^cs_test_/.test(session?.id||"")||session?.mode!=="subscription"||
     !/^https:\/\/checkout\.stripe\.com\//.test(session?.url||""))
     return respond({error:"invalid_checkout_response"},502);
  let saved;
  try{saved=await env.ORDERS.prepare("UPDATE orders SET session_id=?,price_id=? WHERE id=? AND customer_id=? AND status='pending' AND (session_id IS NULL OR session_id=?)")
    .bind(session.id,plan.price_id,order.id,subject,session.id).run();}
  catch{return respond({error:"checkout_state_unavailable"},503)}
  if(saved.meta?.changes!==1)return respond({error:"checkout_state_conflict"},409);
  return respond({checkout_url:session.url,plan:input.plan,monthly_amount_minor:plan.amount,currency:plan.currency,test_mode:true});
}
export function isSubscriptionEvent(event){
  return (["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event?.type)&&event.data?.object?.mode==="subscription")||
    ["invoice.paid","invoice.payment_failed","customer.subscription.deleted"].includes(event?.type);
}
export async function subscriptionWebhook(event,env,fetchImpl=fetch){
  if(env.SUBSCRIPTIONS_TEST_ENABLED!=="true"||!testKey(env))return respond({error:"subscriptions_not_enabled"},503);
  if(!env.ORDERS)return respond({error:"orders_not_configured"},503);
  if(event?.livemode!==false)return respond({error:"mode_mismatch"},400);
  const data=event.data?.object||{};
  if(["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event.type)){
    if(data.payment_status!=="paid")return respond({received:true});
    const order=await env.ORDERS.prepare("SELECT * FROM orders WHERE id=?").bind(data.client_reference_id||"").first();
    const plan=order?TEST_PLANS[order.plan]:null;
    if(!plan||order.session_id!==data.id)return respond({error:"unknown_subscription_order"},409);
    if(order.status==="paid"&&order.subscription_state!=="pending")return respond({received:true,duplicate:true});
    if(order.status!=="pending")return respond({error:"order_state_conflict"},409);
    let session,items,subscription;
    try{
      session=await fromStripe(env,"checkout/sessions/"+encodeURIComponent(data.id),fetchImpl);
      items=await fromStripe(env,"checkout/sessions/"+encodeURIComponent(data.id)+"/line_items?limit=10",fetchImpl);
      subscription=await fromStripe(env,"subscriptions/"+encodeURIComponent(session.subscription||""),fetchImpl);
    }catch{return respond({error:"provider_reconciliation_unavailable"},503)}
    if(!subscriptionMatches(session,order,plan,items,subscription)||
       data.subscription!==session.subscription||data.customer!==session.customer||
       data.amount_total!==session.amount_total||data.currency!==session.currency||
       data.metadata?.purchase_id!==session.metadata.purchase_id)
       return respond({error:"subscription_reconciliation_mismatch"},409);
    let written;
    try{written=await env.ORDERS.prepare("UPDATE orders SET status='paid',subscription_state='active',subscription_id=?,stripe_customer_id=?,price_id=? WHERE id=? AND session_id=? AND status='pending' AND subscription_state='pending'")
      .bind(subscription.id,session.customer,plan.price_id,order.id,session.id).run();}
    catch{return respond({error:"subscription_persist_unavailable"},503)}
    if(written.meta?.changes!==1)return respond({error:"subscription_state_conflict"},409);
    return respond({received:true});
  }
  const subscriptionId=event.type==="customer.subscription.deleted"?data.id:
    (typeof data.subscription==="string"?data.subscription:null);
  if(typeof subscriptionId!=="string"||!subscriptionId.startsWith("sub_"))return respond({received:true});
  const order=await env.ORDERS.prepare("SELECT * FROM orders WHERE subscription_id=?").bind(subscriptionId).first();
  if(!order||!TEST_PLANS[order.plan])return respond({received:true});
  if(event.type==="customer.subscription.deleted"||event.type==="invoice.payment_failed"){
    const next=event.type==="customer.subscription.deleted"?"canceled":"past_due";
    // A duplicate or out-of-order failure must not reactivate a subscription.
    await env.ORDERS.prepare("UPDATE orders SET subscription_state=? WHERE id=? AND subscription_id=? AND subscription_state IN ('active','past_due')")
      .bind(next,order.id,subscriptionId).run();
    return respond({received:true});
  }
  if(event.type==="invoice.paid"&&order.subscription_state==="past_due"){
    if(data.paid!==true||data.amount_paid!==TEST_PLANS[order.plan].amount||data.currency!==TEST_PLANS[order.plan].currency)return respond({received:true});
    let subscription;
    try{subscription=await fromStripe(env,"subscriptions/"+encodeURIComponent(subscriptionId),fetchImpl)}
    catch{return respond({error:"renewal_verification_unavailable"},503)}
    const p=TEST_PLANS[order.plan],item=subscription.items?.data?.[0];
    if(subscription.livemode!==false||subscription.status!=="active"||subscription.customer!==order.stripe_customer_id||
       item?.price?.id!==p.price_id||item.quantity!==1)return respond({error:"renewal_mismatch"},409);
    await env.ORDERS.prepare("UPDATE orders SET subscription_state='active' WHERE id=? AND subscription_id=? AND subscription_state='past_due'")
      .bind(order.id,subscriptionId).run();
  }
  return respond({received:true});
}
