import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {smoke} from '../scripts/smoke-release.mjs';
import worker from '../src/worker.mjs';

const sha='08f089f0a9a2f5623e515ba11bbc56bcd1c37333';
const origin='https://checkout.example';
const fetcher=(url,init)=>worker.fetch(new Request(url,init),{RELEASE_SHA:sha});
test('runtime smoke confirms the exact Worker and refuses a placeholder or different revision',async()=>{
  assert.deepEqual(await smoke(origin,sha,{fetcher,expectClosed:true}),
    {sha,configured:false,chief:'unavailable',providerPaymentVerified:false});
  await assert.rejects(smoke(origin,'0'.repeat(40),{fetcher}),/commit mismatch/);
  await assert.rejects(smoke(origin,sha,{fetcher:()=>new Response('Hello world')}),/expected JussPay JSON/);
});

test('chief sandbox has isolated storage and authentication bindings and defaults every live lane to off',async()=>{
  const config=await readFile(new URL('../wrangler.chief-sandbox.jsonc',import.meta.url),'utf8');
  const sandbox=JSON.parse(config.replace(/^\s*\/\/.*$/gm,''));
  assert.equal(sandbox.name,'jusspay-chief-sandbox');
  assert.equal(sandbox.workers_dev,false);
  assert.equal(sandbox.preview_urls,false);
  assert.equal(sandbox.routes,undefined);
  assert.deepEqual(sandbox.services,[{binding:'AUTH',service:'jusspay-auth-sandbox'}]);
  assert.deepEqual(sandbox.durable_objects.bindings,[{name:'BILLING',class_name:'BillingAccount'}]);
  for(const name of ['STRIPE_LIVE','PAYMENTS_ENABLED','INTRODUCTORY_OFFERS_ENABLED','CHIEF_LIVE_INTRO_APPROVED',
    'SUBSCRIPTIONS_TEST_ENABLED','JBH_ORDERS_ENABLED','JBH_STRIPE_LIVE','JBH_LIVE_CHARGES_APPROVED']){
    assert.equal(sandbox.vars[name],'false',name);
  }
});
