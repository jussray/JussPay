import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const skuPattern = /^[A-Z0-9][A-Z0-9-]{1,63}$/;
const pricePattern = /^price_[A-Za-z0-9]+$/;
const productPattern = /^prod_[A-Za-z0-9]+$/;

// Read-only reconciliation. The inputs must come from the same approved catalog
// and the intended Stripe account/mode; this does not authorize fulfillment.
export function reconcile(catalog, exported, reviewed = {}, live) {
  if (typeof live !== 'boolean' || !record(catalog) || !Object.keys(catalog).length || !record(reviewed)) throw Error('Invalid catalog, mapping or mode');
  if (!record(exported) || !Array.isArray(exported.data) || exported.has_more !== false) throw Error('Complete Stripe price export required');
  for (const [sku, item] of Object.entries(catalog)) {
    if (!skuPattern.test(sku) || !record(item) || item.approved !== true || typeof item.name !== 'string' || !item.name.length || item.name.length > 120 || !Number.isSafeInteger(item.unitAmount) || item.unitAmount < 1 || item.currency !== 'usd' || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(item.vendor || '')) throw Error('Invalid catalog SKU: ' + sku);
  }
  for (const [sku, b] of Object.entries(reviewed)) {
    if (!own(catalog, sku) || !record(b) || !pricePattern.test(b.priceId || '') || !productPattern.test(b.productId || '')) throw Error('Invalid reviewed binding: ' + sku);
  }
  const prices = exported.data;
  if (prices.some(p => !record(p) || !pricePattern.test(p.id || '')) || new Set(prices.map(p => p.id)).size !== prices.length) throw Error('Invalid or duplicate Stripe prices');
  const tags = p => [p.lookup_key, p.metadata?.jbh_sku, p.metadata?.sku].filter(x => x !== null && x !== undefined && x !== '');
  const rows = Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)).map(([sku, item]) => {
    const binding = own(reviewed, sku) ? reviewed[sku] : null;
    const candidates = prices.filter(p => tags(p).includes(sku) || p.id === binding?.priceId);
    const row = {sku, status: 'missing'};
    if (!candidates.length) return binding ? {...row, status:'conflict', reason:'reviewed_price_missing'} : row;
    if (candidates.length !== 1) return {...row, status:'conflict', reason:'multiple_candidates'};
    const p = candidates[0];
    const result = {...row, priceId:p.id};
    if (tags(p).some(t => t !== sku) || p.active !== true || p.livemode !== live || p.type !== 'one_time' || p.currency !== item.currency || p.unit_amount !== item.unitAmount || !productPattern.test(p.product || '') || (binding && (p.id !== binding.priceId || p.product !== binding.productId))) return {...result, status:'conflict', reason:'price_or_identity_mismatch'};
    return {...result, status:p.lookup_key === sku && p.metadata?.jbh_sku === sku ? 'matched' : 'needs_tagging'};
  });
  for (const row of rows) {
    if (row.priceId && rows.filter(r => r.priceId === row.priceId).length > 1) {
      row.status = 'conflict'; row.reason = 'shared_price';
    }
  }
  return {ready:rows.every(r => r.status === 'matched'), rows};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, catalogPath, pricesPath, reviewedPath, ...extra] = process.argv.slice(2);
    if (!['live','sandbox'].includes(mode) || !catalogPath || !pricesPath || extra.length) throw Error('Usage: node scripts/jbh-stripe-catalog.mjs live|sandbox catalog.json prices.json [reviewed.json]');
    const read = path => JSON.parse(readFileSync(path, 'utf8'));
    const result = reconcile(read(catalogPath), read(pricesPath), reviewedPath ? read(reviewedPath) : {}, mode === 'live');
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
  } catch (error) {
    console.error(error.message); process.exitCode = 2;
  }
}
