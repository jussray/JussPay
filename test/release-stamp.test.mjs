import test from 'node:test';
import assert from 'node:assert/strict';
import { stampReleaseConfig } from '../scripts/stamp-release.mjs';

const SAMPLE = JSON.stringify({
  name:'jusspay',
  services:[{binding:'AUTH',service:'jusspay-auth'},{binding:'JBH_PRIVATE_WORKER',service:'jbh-private-payment-control'}],
  vars:{STRIPE_LIVE:'false',APPROVED_PLANS:'{}',JBH_ORDERS_ENABLED:'true',JBH_STRIPE_LIVE:'true',JBH_LIVE_CHARGES_APPROVED:'false',RELEASE_SHA:'f8872857fc6f020580d0a3b71b02a9b5d45c6ece'},
  previews:{vars:{STRIPE_LIVE:'false',JBH_ORDERS_ENABLED:'false',JBH_STRIPE_LIVE:'false',JBH_LIVE_CHARGES_APPROVED:'false',JBH_PRIVATE_RECEIPTS_ENABLED:'false',RELEASE_SHA:'preview-not-production'},durable_objects:{bindings:[{name:'JBH_ORDERS',class_name:'JbhOrderBook'}]}}
});
const SHA='7519f3231f567d6aac5cae6beb6abc2097a13152';

test('stamps exact build commit but preserves bindings, payment locks and isolated preview',()=>{
  const before=JSON.parse(SAMPLE);
  const stamped=JSON.parse(stampReleaseConfig(SAMPLE,SHA));
  assert.equal(stamped.vars.RELEASE_SHA,SHA);
  stamped.vars.RELEASE_SHA=before.vars.RELEASE_SHA;
  assert.deepEqual(stamped,before);
});
test('rejects missing, abbreviated, malformed or forged commit ids',()=>{
  for(const id of ['',undefined,'abc',SHA.toUpperCase(),'0'.repeat(39)+'z'])
    assert.throws(()=>stampReleaseConfig(SAMPLE,id),/WORKERS_CI_COMMIT_SHA/);
});
test('refuses a production config with live charging enabled',()=>{
  const config=JSON.parse(SAMPLE);config.vars.JBH_LIVE_CHARGES_APPROVED='true';
  assert.throws(()=>stampReleaseConfig(JSON.stringify(config),SHA),/payment/);
});
test('refuses a preview with live payments enabled or production services',()=>{
  const config=JSON.parse(SAMPLE);config.previews.vars.JBH_STRIPE_LIVE='true';
  assert.throws(()=>stampReleaseConfig(JSON.stringify(config),SHA),/preview/);
  config.previews.vars.JBH_STRIPE_LIVE='false';config.previews.services=[{binding:'JBH_PRIVATE_WORKER',service:'jbh-private-payment-control'}];
  assert.throws(()=>stampReleaseConfig(JSON.stringify(config),SHA),/preview/);
});
