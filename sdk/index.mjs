/**
 * Server-side JussPay SDK. Create a client with a deployment-owned origin and
 * supply the current user's short-lived identity token on each private call.
 */
export class JussPayError extends Error {
  constructor(code, status=0) {
    super(code);
    this.name='JussPayError';
    this.code=code;
    this.status=status;
  }
}

const fail=(code,status)=>{throw new JussPayError(code,status);};
function https(value,error) {
  // No usernames, passwords, non-HTTPS schemes, or parser coercion.
  let url;
  try{if(typeof value==='string')url=new URL(value);}catch{}
  if(!url || url.protocol!=='https:' || url.username || url.password)fail(error);
  return url;
}
const productId=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(value);
const feature=value=>typeof value==='string'&&value.length>0&&value.length<=100;

export function introConsent(offer, accepted) {
  const intro=offer?.introOffer;
  if(accepted?.terms!==true || accepted?.automaticRenewal!==true)fail('renewal_consent_required');
  if(intro?.approved!==true || intro.firstInvoiceAmountMinor!==100 ||
     !Number.isSafeInteger(offer.unitAmount) || offer.unitAmount<=100 ||
     intro.renewalAmountMinor!==offer.unitAmount || offer.currency!=='usd' ||
     offer.interval!=='month' || intro.renewalInterval!=='month' ||
     !['test','live'].includes(intro.billingMode))fail('invalid_intro_offer');
  https(offer.termsUrl,'invalid_terms_url');
  return {acceptsTerms:true,acceptsAutomaticRenewal:true,firstInvoiceAmountMinor:100,
    renewalAmountMinor:offer.unitAmount,interval:'month',termsUrl:offer.termsUrl};
}

export function createJussPayClient({origin, fetch:fetcher=globalThis.fetch, timeoutMs=8000}={}) {
  const base=https(origin,'invalid_jusspay_origin');
  if(origin!==base.origin || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>30000 ||
     typeof fetcher!=='function')fail('invalid_client_configuration');
  async function request(path,{token, privateCall=false, body}={}) {
    const headers={accept:'application/json'};
    if(privateCall){
      if(typeof token!=='string' || !token.length || token.length>8185 || /[\s\x00-\x1f\x7f]/.test(token))fail('authentication_required',401);
      headers.authorization='Bearer '+token;
    }
    if(body!==undefined)headers['content-type']='application/json';
    const signal=AbortSignal.timeout(timeoutMs);
    let response;
    try{
      response=await fetcher(new URL(path,base),{method:body===undefined?'GET':'POST',headers,
        body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'omit',
        redirect:'error',signal});
    }catch{fail('jusspay_unreachable',502);}
    let result;
    try{result=await response.json();}catch{fail('invalid_jusspay_response',502);}
    if(!response.ok){
      const code=result?.error;
      fail(typeof code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(code)?code:'jusspay_request_failed',response.status);
    }
    return result;
  }
  async function stripeLink(path,host,token,body){
    const result=await request(path,{privateCall:true,token,body});
    const url=https(result?.url,'invalid_stripe_url');
    if(url.origin!=='https://'+host)fail('invalid_stripe_url');
    return result;
  }
  async function entitlements(token){
    const result=await request('/entitlements',{privateCall:true,token});
    const rows=result?.entitlements;
    if(!Array.isArray(rows) || rows.some(row=>!productId(row?.product) ||
        !Number.isFinite(row?.until) || !Array.isArray(row?.entitlements) ||
        row.entitlements.some(x=>!feature(x))))fail('invalid_entitlements',502);
    const now=Date.now()/1000;
    return rows.filter(row=>row.until>now);
  }
  return Object.freeze({
    async catalog(){
      const result=await request('/catalog');
      if(!Array.isArray(result)||result.some(row=>!productId(row?.id)||typeof row?.name!=='string'||
         !['requires_provider_validation','unavailable'].includes(row?.purchaseStatus)))fail('invalid_catalog',502);
      return result;
    },
    async checkout({token, product, consent, expectedBillingMode}={}){
      if(!productId(product))fail('invalid_product');
      if(consent!==undefined && !['test','live'].includes(expectedBillingMode))fail('expected_billing_mode_required');
      const result=await stripeLink('/checkout','checkout.stripe.com',token,
        {product,...(consent!==undefined?{introConsent:consent}:{})});
      if(consent!==undefined && (result.billingMode!==expectedBillingMode || result.currency!=='usd' ||
         result.firstInvoiceAmountMinor!==consent?.firstInvoiceAmountMinor ||
         result.renewalAmountMinor!==consent?.renewalAmountMinor || result.interval!==consent?.interval ||
         result.termsUrl!==consent?.termsUrl))fail('checkout_terms_mismatch',502);
      return result;
    },
    async portal(token){return stripeLink('/portal','billing.stripe.com',token,{});},
    entitlements,
    async hasEntitlement({token,product,entitlement}={}){
      if(!productId(product)||!feature(entitlement))fail('invalid_entitlement_request');
      return (await entitlements(token)).some(row=>row.product===product&&row.entitlements.includes(entitlement));
    }
  });
}
