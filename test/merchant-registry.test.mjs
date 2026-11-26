import assert from 'node:assert/strict';
import test from 'node:test';
import {MERCHANTS,JUSSCO_LIVE_ACCOUNT_ID,JBH_LIVE_ACCOUNT_ID,merchantById,liveAccountBelongsToMerchant,assertDistinctLiveMerchantAccounts} from '../src/merchant-registry.mjs';

test('JussPay registers the portfolio merchant independently from JBH',()=>{
  assert.equal(merchantById('jussco').id,'jussco');
  assert.equal(merchantById('juss-ray-beauty-co').id,'juss-ray-beauty-co');
  assert.notEqual(JUSSCO_LIVE_ACCOUNT_ID,JBH_LIVE_ACCOUNT_ID);
  assert.equal(assertDistinctLiveMerchantAccounts(),true);
});

test('live Stripe account identity cannot cross merchant boundaries',()=>{
  assert.equal(liveAccountBelongsToMerchant('jussco',JUSSCO_LIVE_ACCOUNT_ID),true);
  assert.equal(liveAccountBelongsToMerchant('juss-ray-beauty-co',JBH_LIVE_ACCOUNT_ID),true);
  assert.equal(liveAccountBelongsToMerchant('jussco',JBH_LIVE_ACCOUNT_ID),false);
  assert.equal(liveAccountBelongsToMerchant('juss-ray-beauty-co',JUSSCO_LIVE_ACCOUNT_ID),false);
  assert.equal(liveAccountBelongsToMerchant('unknown',JUSSCO_LIVE_ACCOUNT_ID),false);
});

test('merchant registry is immutable and keeps product families separated',()=>{
  assert.ok(Object.isFrozen(MERCHANTS));
  assert.ok(Object.isFrozen(MERCHANTS.jussco.productFamilies));
  assert.ok(MERCHANTS.jussco.productFamilies.includes('portfolio-subscriptions'));
  assert.ok(MERCHANTS.jussRayBeautyCo.productFamilies.includes('physical-hair-orders'));
  assert.ok(!MERCHANTS.jussco.productFamilies.includes('physical-hair-orders'));
});
