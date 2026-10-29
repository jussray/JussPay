import test from "node:test";
import assert from "node:assert/strict";
import {validatePurchase,verifySignature} from "../src/worker.mjs";
const order={id:"purchase_123",product_id:"api",merchant_id:"juss",amount_total:1000,currency:"usd",session_id:"cs_test_1"};
const session={id:"cs_test_1",client_reference_id:"purchase_123",mode:"payment",payment_status:"paid",currency:"usd",amount_total:1000,metadata:{purchase_id:"purchase_123",product_id:"api",merchant_id:"juss"}};
test("accepts exact paid order",()=>assert.equal(validatePurchase(session,order),true));
for(const [name,patch] of Object.entries({unpaid:{payment_status:"unpaid"},wrong_amount:{amount_total:1},wrong_currency:{currency:"eur"},wrong_product:{metadata:{...session.metadata,product_id:"other"}},wrong_merchant:{metadata:{...session.metadata,merchant_id:"other"}},wrong_order:{client_reference_id:"other"},wrong_session:{id:"cs_other"},subscription:{mode:"subscription"}}))test("rejects "+name,()=>assert.equal(validatePurchase({...session,...patch},order),false));
test("rejects unsigned webhook",async()=>assert.equal(await verifySignature("{}","","secret"),false));
test("rejects expired webhook",async()=>assert.equal(await verifySignature("{}","t=1,v1="+ "a".repeat(64),"secret",1000),false));
