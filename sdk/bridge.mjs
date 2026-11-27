// Optional same-origin bridge for project apps with a verified server-side session.
import {introConsent,JussPayError} from './index.mjs';

const send=(value,status=200)=>Response.json(value,{status,headers:{
  'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'
}});

export function billingBridge({client, appOrigin, getAccessToken, products, billingMode}){
  if(new URL(appOrigin).origin!==appOrigin||!appOrigin.startsWith('https://')||
    !Array.isArray(products)||!products.length||products.some(p=>typeof p!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(p))||
    !['test','live'].includes(billingMode)||typeof getAccessToken!=='function')throw Error('invalid_billing_bridge_configuration');
  const allowed=new Set(products);
  const pathFor=(verb)=>'/api/billing/'+verb;
  return async request=>{
    const {origin,pathname}=new URL(request.url);
    if(origin!==appOrigin)return send({error:'not_found'},404);
    const isRead=[pathFor('catalog'),pathFor('entitlements')].includes(pathname);
    const isWrite=[pathFor('checkout'),pathFor('portal')].includes(pathname);
    if(!isRead&&!isWrite)return send({error:'not_found'},404);
    if(request.method!==(isRead?'GET':'POST'))return send({error:'method_not_allowed'},405);
    if(isWrite&&(request.headers.get('origin')!==appOrigin||
      request.headers.get('content-type')?.split(';')[0].trim()!=='application/json'))
      return send({error:'invalid_request_origin'},403);
    try{
      if(pathname===pathFor('catalog')){
        const items=(await client.catalog()).filter(item=>allowed.has(item.id));
        // No non-intro checkout with this bridge: the API response must attest billing mode.
        return send(items.map(item=>({...item,purchaseStatus:item.introOffer?.billingMode===billingMode
          ?item.purchaseStatus:'unavailable'})));
      }
      // Resolve the caller's identity from the installed app session, never from a
      // JSON user ID or forwarded browser Authorization header.
      const token=await getAccessToken(request);
      if(!token)return send({error:'authentication_required'},401);
      if(pathname===pathFor('entitlements')){
        const items=(await client.entitlements(token)).filter(item=>allowed.has(item.product));
        return send({entitlements:items});
      }
      if(pathname===pathFor('portal'))return send(await client.portal(token));

      // Bound user input before parse. The consent check sends only canonical fields.
      const reader=request.body?.getReader();
      if(!reader)return send({error:'invalid_json'},400);
      const chunks=[];let size=0;
      try{for(;;){
        const {done,value}=await reader.read();if(done)break;
        size+=value.byteLength;
        if(size>2048){await reader.cancel();return send({error:'payload_too_large'},413);}
        chunks.push(value);
      }}finally{reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      let body;
      try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return send({error:'invalid_json'},400);}
      if(!allowed.has(body?.product))return send({error:'product_not_available'},409);
      const item=(await client.catalog()).find(row=>row.id===body.product);
      if(item?.purchaseStatus!=='requires_provider_validation'||item.introOffer?.billingMode!==billingMode)
        return send({error:'product_not_available'},409);
      if(body.firstInvoiceAmountMinor!==item.introOffer.firstInvoiceAmountMinor||
         body.renewalAmountMinor!==item.introOffer.renewalAmountMinor||
         body.interval!==item.interval||body.termsUrl!==item.termsUrl)
        return send({error:'offer_changed'},409);
      if(body.acceptsTerms!==true||body.acceptsAutomaticRenewal!==true)return send({error:'renewal_consent_required'},409);
      const consent=introConsent(item,{terms:true,automaticRenewal:true});
      return send(await client.checkout({token,product:item.id,consent,expectedBillingMode:billingMode}));
    }catch(error){
      if(error instanceof JussPayError&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code))
        return send({error:error.code},error.status>=400&&error.status<=599?error.status:502);
      return send({error:'billing_unavailable'},502);
    }
  };
}
