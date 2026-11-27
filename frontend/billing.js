// Add to the existing immersive design without rewriting it or adding fake payments.
const api='/api/billing/';
const msg=(text,tag='p')=>Object.assign(document.createElement(tag),{textContent:text});
const dollars=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
let activeDialog;
async function data(route,body,signal){
  const r=await fetch(api+route,{method:body?'POST':'GET',redirect:'error',cache:'no-store',
    credentials:'same-origin',signal,headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined});
  if(!r.headers.get('content-type')?.startsWith('application/json'))throw Error('billing_unavailable');
  const payload=await r.json();
  if(!r.ok)throw Error(payload?.error||'billing_unavailable');
  return payload;
}
function exactCheckout(value){
  const u=new URL(value);
  if(u.origin!=='https://checkout.stripe.com'||u.username||u.password)throw Error('billing_unavailable');
  return u.href;
}
function validRenewal(cents){
  return Number.isSafeInteger(cents)&&cents>100;
}
async function openPricing(trigger){
  if(activeDialog){if(activeDialog.open)return;activeDialog.remove();}
  const dialog=activeDialog=document.createElement('dialog');
  dialog.className='jusspay-billing';
  dialog.setAttribute('aria-labelledby','jusspay-billing-title');
  const title=msg('Chief Personal','h2');title.id='jusspay-billing-title';
  const close=msg('Close','button');close.type='button';close.addEventListener('click',()=>dialog.close());
  const status=msg('Checking current checkout availability…');status.setAttribute('role','status');
  dialog.append(title,status,close);document.body.append(dialog);
  const controller=new AbortController();
  dialog.addEventListener('close',()=>{controller.abort();dialog.remove();if(activeDialog===dialog)activeDialog=null;trigger.focus();},{once:true});
  dialog.showModal();
  try{
    const list=await data('catalog',undefined,controller.signal);
    const item=Array.isArray(list)?list.find(row=>row?.id==='chief'):null;
    const intro=item?.introOffer;
    if(item?.purchaseStatus!=='requires_provider_validation'||intro?.approved!==true||
      intro?.firstInvoiceAmountMinor!==100||intro?.renewalAmountMinor!==item.unitAmount||
      !validRenewal(item.unitAmount)||item.unitAmount!==2900||item.currency!=='usd'||item.interval!=='month'||
      intro.renewalInterval!=='month'||!['test','live'].includes(intro.billingMode)){
      status.textContent='Checkout isn’t available yet.';return;
    }
    if(typeof item.termsUrl!=='string')throw Error('invalid_terms_url');
    const terms=new URL(item.termsUrl);
    if(terms.protocol!=='https:'||terms.username||terms.password)throw Error('invalid_terms_url');
    title.textContent=intro.billingMode==='test'?'Chief Personal · Sandbox':'Chief Personal';
    status.textContent=dollars(100)+' first month, then '+dollars(item.unitAmount)+'/month. Includes applicable tax.';
    const form=document.createElement('form');
    const label=document.createElement('label');
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.required=true;
    const link=msg('billing terms','a');link.href=terms.href;link.target='_blank';link.rel='noopener noreferrer';
    label.append(checkbox,' I accept the ',link,' and agree to automatic renewal at '+dollars(item.unitAmount)+'/month.');
    const submit=msg(intro.billingMode==='test'?'Continue to test checkout':'Continue to Stripe','button');
    submit.type='submit';
    const result=msg('');result.setAttribute('role','status');
    form.append(label,submit,result);close.before(form);
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(!checkbox.checked||submit.disabled)return;
      submit.disabled=true;result.textContent='Checking your account and opening Stripe…';
      try{
        const reply=await data('checkout',{product:'chief',firstInvoiceAmountMinor:100,renewalAmountMinor:item.unitAmount,
          interval:'month',termsUrl:item.termsUrl,acceptsTerms:true,acceptsAutomaticRenewal:true},controller.signal);
        if(reply?.billingMode!==intro.billingMode||reply.firstInvoiceAmountMinor!==100||
           reply.renewalAmountMinor!==item.unitAmount||reply.currency!=='usd'||
           reply.interval!=='month'||reply.termsUrl!==item.termsUrl)throw Error('offer_changed');
        location.assign(exactCheckout(reply.url));
      }catch(error){
        if(controller.signal.aborted)return;
        result.textContent=error.message==='authentication_required'
          ?'Sign in to your Chief account, then return to checkout.'
          :error.message==='offer_changed'
            ?'The offer changed. Close this window and check the price again.'
            :'Checkout isn’t available right now. You haven’t been charged.';
        submit.disabled=false;
      }
    });
  }catch{
    if(!controller.signal.aborted)status.textContent='Checkout isn’t available yet.';
  }
}
document.addEventListener('click',event=>{
  const signIn=event.target instanceof Element&&event.target.closest('button[data-jusspay-sign-in],#dialog-preview');
  const configured=document.querySelector('button[data-jusspay-sign-in]')?.dataset.jusspaySignIn;
  if(signIn&&configured){
    event.preventDefault();event.stopImmediatePropagation();
    if(/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(configured))location.assign(configured);
    return;
  }
  const target=event.target instanceof Element&&event.target.closest('button[data-info="Pricing"]');
  if(!target)return;
  event.preventDefault();event.stopImmediatePropagation();void openPricing(target);
},true);
