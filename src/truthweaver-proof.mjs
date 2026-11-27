// Central read-only verification of existing TruthWeaver Stripe report orders.
// This is payment evidence, not an entitlement or authorization to charge.
// Prices mirror the inspected TruthWeaver report-catalog contract. No offer is
// activated by this module; changes to this catalog require explicit review.
import {boundedText,digest,fail,json,stripe} from './worker.mjs';

const MERCHANT='acct_1U4xNyRs4gw4sfJH';
const OFFERS=Object.freeze({
  snapshot:{sku:'TW-SNAPSHOT-ONE',amount:1000},
  guide:{sku:'TW-GUIDE-NOTICE',amount:1500},
  templates:{sku:'TW-TEMPLATES-NOTICE',amount:1200},
  course:{sku:'TW-COURSE-NOTICE',amount:1900},
  bundle:{sku:'TW-BUNDLE-NOTICE',amount:3900}
});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE=/^[A-Za-z0-9_-]{43}$/;
const SESSION=/^cs_live_[A-Za-z0-9_]{1,180}$/;
const INTENT=/^pi_[A-Za-z0-9_]{1,180}$/;
const CHARGE=/^ch_[A-Za-z0-9_]{1,180}$/;

async function matches(a,b){
  if(typeof a!=='string'||a.length>512||typeof b!=='string'||b.length<32||b.length>512)return false;
  const [left,right]=await Promise.all([digest(a),digest(b)]);
  let mismatch=0;for(let i=0;i<left.length;i++)mismatch|=left.charCodeAt(i)^right.charCodeAt(i);
  return mismatch===0;
}

export function reportProof(session,sessionId){
  const meta=session?.metadata;
  const offer=meta&&Object.hasOwn(OFFERS,meta.offerKey)?OFFERS[meta.offerKey]:null;
  const pi=session?.payment_intent,charge=pi?.latest_charge;
  if(!offer||session.id!==sessionId||session.livemode!==true||
    session.mode!=='payment'||session.status!=='complete'||session.payment_status!=='paid'||
    session.currency!=='usd'||session.amount_subtotal!==offer.amount||session.amount_total!==offer.amount||
    meta.sku!==offer.sku||meta.stripeAccount!==MERCHANT||
    typeof meta.userId!=='string'||!UUID.test(meta.userId)||
    typeof meta.analysisId!=='string'||!UUID.test(meta.analysisId)||
    typeof meta.claimNonce!=='string'||!NONCE.test(meta.claimNonce)||
    !Number.isSafeInteger(session.created)||session.created<1||session.created>8640000000000||
    !INTENT.test(pi?.id||'')||pi.livemode!==true||pi.status!=='succeeded'||
    pi.currency!=='usd'||pi.amount_received!==offer.amount||
    !CHARGE.test(charge?.id||'')||charge.livemode!==true||charge.paid!==true||
    charge.refunded!==false||charge.disputed!==false||charge.amount_refunded!==0||
    charge.currency!=='usd'||charge.amount!==offer.amount||
    (typeof charge.payment_intent==='string'?charge.payment_intent:charge.payment_intent?.id)!==pi.id)
      fail(409,'payment_not_proven');
  return {schema:'jusspay/truthweaver-paid-proof@v1',paid:true,sessionId,
    offerKey:meta.offerKey,userId:meta.userId,analysisId:meta.analysisId,
    claimNonce:meta.claimNonce,amountTotalMinor:offer.amount,currency:'usd',
    createdAt:new Date(session.created*1000).toISOString()};
}

export async function handleTruthWeaverProof(request,env){
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  const key=env.TW_REPORT_SERVICE_KEY;
  if([env.STRIPE_SECRET_KEY,env.TW_STRIPE_READ_KEY,env.JBH_OWNER_KEY,env.JBH_STOREFRONT_KEY,env.JBH_MONITOR_KEY].some(x=>x===key)||
    !await matches(request.headers.get('x-tw-service-key'),key))fail(401,'service_key_required');
  if(env.TW_REPORT_VERIFICATION_ENABLED!=='true'||
    typeof env.TW_STRIPE_READ_KEY!=='string'||!env.TW_STRIPE_READ_KEY.startsWith('rk_live_')||
    typeof env.TW_STRIPE_API_VERSION!=='string'||!env.TW_STRIPE_API_VERSION)
      fail(503,'report_verification_unavailable');
  let body;try{body=JSON.parse(await boundedText(request,1024));}catch(e){if(e.status)throw e;fail(400,'invalid_json');}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||
    typeof body.sessionId!=='string'||!SESSION.test(body.sessionId))fail(400,'invalid_session');
  const provider={STRIPE_SECRET_KEY:env.TW_STRIPE_READ_KEY,STRIPE_API_VERSION:env.TW_STRIPE_API_VERSION,STRIPE_FETCH:env.STRIPE_FETCH};
  const account=await stripe(provider,'account');
  if(account.id!==MERCHANT)fail(503,'report_merchant_mismatch');
  const session=await stripe(provider,'checkout/sessions/'+encodeURIComponent(body.sessionId)+'?expand%5B%5D=payment_intent.latest_charge');
  return json(reportProof(session,body.sessionId));
}
