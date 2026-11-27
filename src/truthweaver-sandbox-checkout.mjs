// Isolated checkout creation proof. This route never creates live Stripe sessions.
import {boundedText,digest,fail,json,stripe} from './worker.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nonce=/^[A-Za-z0-9_-]{43}$/;
const sandboxAccount='acct_1U4xNyRs4gw4sfJH';
const sessionId=/^cs_test_[A-Za-z0-9_]{1,180}$/;
const fields=['offerKey','userId','analysisId','claimNonce'];
const origin='https://truthweaver.jussco.company';

export async function handleTruthWeaverSandboxCheckout(request,env){
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  const key=env.TW_SANDBOX_CHECKOUT_SERVICE_KEY;
  const supplied=request.headers.get('x-tw-sandbox-checkout-key');
  if(typeof key!=='string'||key.length<32||key.length>512||!supplied||supplied.length>512||
    [env.TW_REPORT_SERVICE_KEY,env.TW_STRIPE_READ_KEY,env.TW_SANDBOX_STRIPE_KEY,env.STRIPE_SECRET_KEY,env.JBH_OWNER_KEY,env.JBH_STOREFRONT_KEY,env.JBH_MONITOR_KEY].includes(key))
    fail(401,'service_key_required');
  const [left,right]=await Promise.all([digest(key),digest(supplied)]);
  let mismatch=0;for(let i=0;i<left.length;i++)mismatch|=left.charCodeAt(i)^right.charCodeAt(i);
  if(mismatch)fail(401,'service_key_required');
  if(env.TW_SANDBOX_CHECKOUT_ENABLED!=='true'||env.STRIPE_LIVE!=='false'||
    !/^rk_test_[A-Za-z0-9]+$/.test(env.TW_SANDBOX_STRIPE_KEY||'')||
    !env.TW_STRIPE_API_VERSION)fail(503,'sandbox_checkout_unavailable');
  let data;try{data=JSON.parse(await boundedText(request,1024));}catch(e){if(e.status)throw e;fail(400,'invalid_json');}
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==fields.length||
    !fields.every(k=>typeof data[k]==='string'&&Object.hasOwn(data,k))||
    data.offerKey!=='snapshot'||!uuid.test(data.userId)||!uuid.test(data.analysisId)||!nonce.test(data.claimNonce))
    fail(400,'invalid_checkout_claim');

  const provider={STRIPE_SECRET_KEY:env.TW_SANDBOX_STRIPE_KEY,STRIPE_API_VERSION:env.TW_STRIPE_API_VERSION,STRIPE_FETCH:env.STRIPE_FETCH};
  const account=await stripe(provider,'account');
  if(account.id!==sandboxAccount||account.charges_enabled!==true)fail(503,'sandbox_merchant_not_ready');
  const created=await stripe(provider,'checkout/sessions','POST',{
    mode:'payment', 'payment_method_types[0]':'card','automatic_tax[enabled]':'true',
    success_url:origin+'/fulfillment',cancel_url:origin+'/shop',
    'line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':'1000',
    'line_items[0][price_data][tax_behavior]':'inclusive','line_items[0][quantity]':'1',
    'line_items[0][price_data][product_data][name]':'TruthWeaver Notice Snapshot (sandbox)',
    'metadata[offerKey]':'snapshot','metadata[sku]':'TW-SNAPSHOT-ONE',
    'metadata[stripeAccount]':sandboxAccount,'metadata[userId]':data.userId,
    'metadata[analysisId]':data.analysisId,'metadata[claimNonce]':data.claimNonce
  },'tw-snapshot-sandbox:'+await digest(JSON.stringify(fields.map(k=>data[k]))));
  let url;try{url=new URL(created?.url);}catch{fail(502,'sandbox_session_unverified');}
  if(created?.livemode!==false||created?.mode!=='payment'||!sessionId.test(created?.id||'')||
    url.origin!=='https://checkout.stripe.com'||url.username||url.password||
    url.pathname!=='/c/pay/'+created.id||created?.automatic_tax?.enabled!==true||
    created?.currency!=='usd'||created?.amount_subtotal!==1000||created?.amount_total!==1000)
    fail(502,'sandbox_session_unverified');
  return json({schema:'jusspay/truthweaver-sandbox-checkout@v1',sessionId:created.id,url:created.url});
}
