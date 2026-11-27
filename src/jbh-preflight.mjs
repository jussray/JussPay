// Configuration-only diagnostics. Never call Stripe, the order book or a supplier.
// The caller must authenticate and supply the existing synchronous validators.
export function jbhConfigurationReview(env,checks){
  const blockers=[];
  const check=(name,fn,transform=value=>value)=>{
    try{
      const value=fn();
      if(value!=null&&typeof value.then==='function'){
        Promise.resolve(value).catch(()=>{});
        throw Error('deferred_validator');
      }
      return {ok:true,value:transform(value)};
    }catch{blockers.push(name);return {ok:false};}
  };
  if(env.JBH_STRIPE_LIVE!=='true')blockers.push('live_mode_not_selected');
  if(env.JBH_LIVE_CHARGES_APPROVED!=='true')blockers.push('live_approval_missing');
  check('runtime_configuration_invalid',checks.ready);
  const catalog=check('catalog_invalid',checks.catalog,value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_catalog');
    return Object.entries(value).map(([sku,p])=>{
      if(!p||typeof p!=='object'||Array.isArray(p)||typeof p.vendor!=='string'||!p.vendor.trim())throw Error('invalid_catalog_entry');
      return {sku,vendor:p.vendor};
    });
  });
  const items=catalog.ok?catalog.value:[];
  if(catalog.ok&&!items.length)blockers.push('catalog_empty');
  check('shipping_invalid',checks.shipping);
  check('owner_queue_invalid',checks.owner);
  if(checks.privateReceiver)check('private_receipt_configuration_invalid',checks.privateReceiver);
  if(items.length)check('vendor_authority_unverified',()=>checks.authority(items));
  else blockers.push('vendor_authority_unverified');
  return {mode:'configuration-review-only',configurationValid:blockers.length===0,blockers,ready:false,providerVerified:false,chargesCollected:false,orderDispatched:false};
}
