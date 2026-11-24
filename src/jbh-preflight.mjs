// Configuration-only diagnostics. Never call Stripe, the order book or a supplier.
// The caller must authenticate and supply the existing synchronous validators.
export function jbhConfigurationReview(env,checks){
  const blockers=[];
  const check=(name,fn)=>{try{return {ok:true,value:fn()};}catch{blockers.push(name);return {ok:false};}};
  if(env.JBH_STRIPE_LIVE!=='true')blockers.push('live_mode_not_selected');
  if(env.JBH_LIVE_CHARGES_APPROVED!=='true')blockers.push('live_approval_missing');
  check('runtime_configuration_invalid',checks.ready);
  const catalog=check('catalog_invalid',checks.catalog);
  const items=catalog.ok?Object.entries(catalog.value||{}).map(([sku,p])=>({sku,vendor:p.vendor})):[];
  if(catalog.ok&&!items.length)blockers.push('catalog_empty');
  check('shipping_invalid',checks.shipping);
  check('owner_queue_invalid',checks.owner);
  if(items.length)check('vendor_authority_unverified',()=>checks.authority(items));
  else blockers.push('vendor_authority_unverified');
  return {mode:'configuration-review-only',configurationValid:blockers.length===0,blockers,ready:false,providerVerified:false,chargesCollected:false,orderDispatched:false};
}
