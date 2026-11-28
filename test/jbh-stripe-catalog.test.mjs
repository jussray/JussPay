import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../scripts/jbh-stripe-catalog.mjs';

const catalog = { 'TEST-SKU': { approved: true, name: 'Example', unitAmount: 7500, currency: 'usd', vendor: 'example' } };
const price = { id: 'price_example', product: 'prod_example', active: true, livemode: true, type: 'one_time', currency: 'usd', unit_amount: 7500, metadata: {}, lookup_key: null };
const run = (data, reviewed = {}, live = true, c = catalog) => reconcile(c, { data, has_more: false }, reviewed, live);

test('unlabelled prices are not guessed even when amount matches', () => {
  assert.equal(run([price]).rows[0].status, 'missing');
});
test('explicitly reviewed price with matching product and amount needs tagging', () => {
  assert.equal(run([price], {'TEST-SKU': {priceId: price.id, productId: price.product}}).rows[0].status, 'needs_tagging');
});
test('both exact SKU tags match', () => {
  assert.equal(run([{...price, lookup_key: 'TEST-SKU', metadata: {jbh_sku: 'TEST-SKU'}}]).ready, true);
});
test('wrong amount, mode or product cannot be selected', () => {
  const binding = {'TEST-SKU': {priceId: price.id, productId: price.product}};
  for (const p of [{...price, unit_amount: 7501}, {...price, livemode: false}, {...price, product: 'prod_other'}]) assert.equal(run([p], binding).rows[0].status, 'conflict');
});
test('conflicting tags, duplicate candidates, and shared price IDs are rejected', () => {
  assert.equal(run([{...price, lookup_key: 'TEST-SKU', metadata: {jbh_sku: 'OTHER-SKU'}}]).rows[0].status, 'conflict');
  assert.equal(run([{...price, lookup_key: 'TEST-SKU'}, {...price, id:'price_other', metadata:{jbh_sku:'TEST-SKU'}}]).rows[0].status, 'conflict');
  const c = {...catalog, 'OTHER-SKU': catalog['TEST-SKU']};
  const b = {priceId: price.id, productId: price.product};
  assert.equal(run([price], {'TEST-SKU':b,'OTHER-SKU':b}, true, c).rows.every(x => x.status === 'conflict'), true);
});
test('truncated exports and empty catalogs cannot report ready', () => {
  assert.throws(() => reconcile(catalog, {data:[price], has_more:true}, {}, true));
  assert.throws(() => run([], {}, true, {}));
});
