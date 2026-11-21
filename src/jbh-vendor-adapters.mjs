// JBH vendor adapter authority. Private/JussPay-only: never shipped in the public bundle.
// This module plans fulfillment and guards *live* sales. It does not order, pay, or
// dispatch to suppliers. Integration credentials and receipts must be verified separately.
import {fail} from './worker.mjs';

const ADAPTERS=Object.freeze({
  'dropship-beauty':Object.freeze({
    mode:'verified-owner-handoff',kind:'dropship',
    handoff:'dropship-beauty-shopify-app',
    requirements:['fresh_supplier_inventory','exact_sku_mapping','working_order_handoff','owner_dispatch_receipt'],
  }),
  'faire':Object.freeze({
    mode:'stocked-on-hand',kind:'wholesale-stock',
    handoff:'owner-warehouse-fulfillment',
    requirements:['stock_received','exact_sku_mapping','reserved_local_inventory','owner_shipping'],
  }),
  'dsers':Object.freeze({
    mode:'verified-channel-handoff',kind:'channel-dropship',
    handoff:'dsers-connected-channel-or-csv',
    requirements:['connected_channel_or_csv','exact_supplier_sku','working_order_handoff','owner_dispatch_receipt'],
  }),
  'manual-procurement':Object.freeze({
    mode:'owner-stocked',kind:'owner-stock',
    handoff:'owner-fulfillment',
    requirements:['accepted_supplier_terms','stock_received','reserved_local_inventory','owner_shipping'],
  }),
});
const SKU=/^[A-Z0-9][A-Z0-9-]{1,63}$/;
const RECEIPT=/^[A-Za-z0-9][A-Za-z0-9:_./-]{7,199}$/;
const MAX_EVIDENCE_AGE_MS=7*24*60*60*1000;

export function jbhVendorAdapters(){
  return Object.fromEntries(Object.entries(ADAPTERS).map(([vendor,adapter])=>[
    vendor,{vendor,kind:adapter.kind,handoff:adapter.handoff,mode:adapter.mode,
      requirements:[...adapter.requirements],autoDispatch:false}
  ]));
}

// External input is always advisory until authenticated provider/stock checks pass.
// The capability receipt is only a founder-authored allowlist, NOT proof on its own
// that a supplier API is connected or stock is reserved.
export function liveVendorAuthority(env,items,now=Date.now()){
  if(!Array.isArray(items)||!items.length)fail(503,'jbh_vendor_items_unavailable');
  let authority;
  try{authority=JSON.parse(env.JBH_VENDOR_SALES_AUTHORITY||'null');}
  catch{fail(503,'jbh_vendor_authority_invalid');}
  if(!authority||typeof authority!=='object'||Array.isArray(authority))fail(503,'jbh_vendor_authority_required');
  const routes={};
  for(const item of items){
    const sku=item?.sku,vendor=item?.vendor;
    if(typeof sku!=='string'||!SKU.test(sku)||typeof vendor!=='string')fail(503,'jbh_vendor_item_invalid');
    const adapter=ADAPTERS[vendor];
    if(!adapter)fail(503,'jbh_vendor_unsupported');
    const entry=authority[vendor];
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||
      entry.enabled!==true||entry.mode!==adapter.mode||
      typeof entry.evidenceRef!=='string'||!RECEIPT.test(entry.evidenceRef)||
      !Number.isSafeInteger(entry.verifiedAt)||entry.verifiedAt>now||
      now-entry.verifiedAt>MAX_EVIDENCE_AGE_MS||
      !Array.isArray(entry.skus)||!entry.skus.includes(sku)||
      entry.skus.some(s=>typeof s!=='string'||!SKU.test(s)))fail(503,'jbh_vendor_not_verified');

    // Faire still has no approved on-hand stock reservation workflow.
    if(vendor==='faire')fail(503,'jbh_local_stock_reservation_required');
    // A manual vendor receipt is not itself inventory; the JbhOrderBook
    // separately reserves physically recorded stock before Stripe Checkout.
    if(vendor==='manual-procurement' &&
      (entry.stockReceived!==true||entry.ownerShippingVerified!==true)){
      fail(503,'jbh_vendor_handoff_not_verified');
    }
    if(entry.ownerHandoffVerified!==true||
      typeof entry.ownerReceiptRef!=='string'||!RECEIPT.test(entry.ownerReceiptRef)){
      fail(503,'jbh_vendor_handoff_not_verified');
    }
    routes[vendor]={kind:adapter.kind,handoff:adapter.handoff,autoDispatch:false};
  }
  return routes;
}

export function vendorOwnerPlan(vendors){
  if(!vendors||typeof vendors!=='object'||Array.isArray(vendors))return [];
  return Object.entries(vendors).map(([vendor,lines])=>{
    const adapter=ADAPTERS[vendor];
    const valid=Array.isArray(lines)&&lines.length>0&&lines.every(x=>
      x&&typeof x.sku==='string'&&SKU.test(x.sku)&&Number.isSafeInteger(x.quantity)&&x.quantity>0);
    return {
      vendor,
      kind:adapter?.kind||'unverified',
      handoff:adapter?.handoff||'owner-review-only',
      action:!adapter||!valid?'quarantine':'owner_review',
      autoDispatch:false,
      note:vendor==='faire'?'Purchase wholesale inventory to the business, never dropship a customer':
        vendor==='dropship-beauty'?'Use an actually verified Dropship Beauty app fulfillment handoff':
        vendor==='dsers'?'Use a verified DSers channel or supported CSV, not an assumed API':
        'Verify supplier, paid order, inventory and terms before fulfillment',
      lines:valid?lines.map(x=>({sku:x.sku,quantity:x.quantity})):[],
      requirements:adapter?[...adapter.requirements]:['verify_vendor','exact_mapping','manual_review'],
    };
  });
}
