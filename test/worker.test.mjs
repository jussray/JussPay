import test from "node:test";
import assert from "node:assert/strict";
import {validatePurchase,verifySignature} from "../src/worker.mjs";
const order={id:"purchase_123",product_id:"api",merchant_id:"juss",amount_total:1000,currency:"usd",session_id:"cs_test_1"};
const session={id:"cs_test_1",client_reference_id:"purchase_123",mode:"payment",payment_status:"paid",currency:"usd",amount_total:1000,metadata:{purchase_id:"purchase_123",product_id:"api",merchant_id:"juss"}};
test("accepts exact paid order",()=>assert.equal(validatePurchase(session,order),true));
for(const [name,patch] of Object.entries({unpaid:{payment_status:"unpaid"},wrong_amount:{amount_total:1},wrong_currency:{currency:"eur"},wrong_product:{metadata:{...session.metadata,product_id:"other"}},wrong_merchant:{metadata:{...session.metadata,merchant_id:"other"}},wrong_order:{client_reference_id:"other"},wrong_session:{id:"cs_other"},subscription:{mode:"subscription"}}))test("rejects "+name,()=>assert.equal(validatePurchase({...session,...patch},order),false));
test("rejects unsigned webhook",async()=>assert.equal(await verifySignature("{}","","secret"),false));
test("rejects expired webhook",async()=>assert.equal(await verifySignature("{}","t=1,v1="+ "a".repeat(64),"secret",1000),false));

import worker from "../src/worker.mjs";
const request=(path,body,headers={})=>new Request("https://pay.example"+path,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
test("checkout is disabled without feature gate",async()=>{const r=await worker.fetch(request("/checkout",{product_id:"api",purchase_id:"purchase_123"}),{});assert.equal(r.status,503);assert.equal((await r.json()).error,"payments_disabled")});
test("checkout rejects non-sandbox Stripe key",async()=>{const r=await worker.fetch(request("/checkout",{product_id:"api",purchase_id:"purchase_123"}),{PAYMENTS_ENABLED:"true",STRIPE_SECRET_KEY:"sk_live_not_real"});assert.equal((await r.json()).error,"sandbox_key_required")});
test("checkout blocks missing auth service",async()=>{const r=await worker.fetch(request("/checkout",{product_id:"api",purchase_id:"purchase_123"}),{PAYMENTS_ENABLED:"true",STRIPE_SECRET_KEY:"sk_test_dummy",CATALOG:JSON.stringify({api:{name:"API",amount:1000,currency:"usd",merchant_id:"juss"}}),APP_ORIGIN:"https://app.example",ORDERS:{}});assert.equal((await r.json()).error,"authorization_not_ready")});
test("checkout blocks unauthenticated request before order lookup",async()=>{const r=await worker.fetch(request("/checkout",{product_id:"api",purchase_id:"purchase_123"}),{PAYMENTS_ENABLED:"true",CHECKOUT_AUTH_READY:"true",AUTH_SERVICE:{fetch:async()=>{throw Error("must not call")}},STRIPE_SECRET_KEY:"sk_test_dummy",CATALOG:JSON.stringify({api:{name:"API",amount:1000,currency:"usd",merchant_id:"juss"}}),APP_ORIGIN:"https://app.example",ORDERS:{prepare:()=>{throw Error("must not query")}}});assert.equal(r.status,401)});
test("checkout rejects different customer without calling Stripe",async()=>{const r=await worker.fetch(request("/checkout",{product_id:"api",purchase_id:"purchase_123"},{authorization:"Bearer dummy"}),{PAYMENTS_ENABLED:"true",CHECKOUT_AUTH_READY:"true",AUTH_SERVICE:{fetch:async()=>new Response(JSON.stringify({subject:"other"}),{status:200})},STRIPE_SECRET_KEY:"sk_test_dummy",CATALOG:JSON.stringify({api:{name:"API",amount:1000,currency:"usd",merchant_id:"juss"}}),APP_ORIGIN:"https://app.example",ORDERS:{prepare:()=>({bind:()=>({first:async()=>({...order,customer_id:"actual",status:"pending"})})})}});assert.equal(r.status,403)});
test("webhook blocks until reconciliation is enabled",async()=>{const r=await worker.fetch(request("/stripe/webhook",{}),{PAYMENTS_ENABLED:"true",STRIPE_WEBHOOK_SECRET:"whsec_dummy",ORDERS:{}});assert.equal((await r.json()).error,"reconciliation_not_ready")});

test("accepts correctly signed current Stripe webhook",async()=>{
 const body=JSON.stringify({id:"evt_test"}),secret="whsec_local_test",timestamp=1700000000;
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const bytes=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(timestamp+"."+body));
 const signature=Buffer.from(bytes).toString("hex");
 assert.equal(await verifySignature(body,`t=${timestamp},v1=${signature}`,secret,timestamp),true);
 assert.equal(await verifySignature(body+" ",`t=${timestamp},v1=${signature}`,secret,timestamp),false);
 assert.equal(await verifySignature(body,`t=${timestamp},v1=${signature}`,"different_secret",timestamp),false);
});
test("rejects signature with nonnumeric timestamp",async()=>assert.equal(await verifySignature("{}","t=invalid,v1="+"a".repeat(64),"secret"),false));
test("rejects forged session metadata",()=>assert.equal(validatePurchase({...session,metadata:{...session.metadata,purchase_id:"another"}},order),false));
test("rejects paid session without order",()=>assert.equal(validatePurchase(session,null),false));

test("checkout fails closed on malformed catalog",async()=>{
 const r=await worker.fetch(request("/checkout",{product_id:"api",purchase_id:"purchase_123"}),{PAYMENTS_ENABLED:"true",STRIPE_SECRET_KEY:"sk_test_dummy",CATALOG:"{broken",APP_ORIGIN:"https://app.example",ORDERS:{}});
 assert.equal(r.status,503);
 assert.equal((await r.json()).error,"catalog_misconfigured");
});
test("checkout rejects catalog with null root",async()=>{
 const r=await worker.fetch(request("/checkout",{product_id:"api",purchase_id:"purchase_123"}),{PAYMENTS_ENABLED:"true",STRIPE_SECRET_KEY:"sk_test_dummy",CATALOG:"null",APP_ORIGIN:"https://app.example",ORDERS:{}});
 assert.equal(r.status,400);
 assert.equal((await r.json()).error,"unknown_product");
});

test("webhook does not acknowledge failed paid-state persistence",async()=>{
 const body=JSON.stringify({type:"checkout.session.completed",data:{object:session}});
 const secret="whsec_local_test",t=Math.floor(Date.now()/1000);
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const sig=Buffer.from(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(t+"."+body))).toString("hex");
 const originalFetch=globalThis.fetch;
 const database={prepare(sql){return {bind(){return {first:async()=>({...order,status:"pending"}),run:async()=>{throw Error("database unavailable")}}}}}};
 globalThis.fetch=async()=>new Response(JSON.stringify(session),{status:200});
 try{
  const r=await worker.fetch(new Request("https://pay.example/stripe/webhook",{method:"POST",headers:{"stripe-signature":`t=${t},v1=${sig}`},body}),{PAYMENTS_ENABLED:"true",STRIPE_WEBHOOK_SECRET:secret,WEBHOOK_RECONCILIATION_READY:"true",STRIPE_SECRET_KEY:"sk_test_dummy",ORDERS:database});
  assert.equal(r.status,503);
  assert.equal((await r.json()).error,"reconciliation_persist_failed");
 }finally{globalThis.fetch=originalFetch}
});
