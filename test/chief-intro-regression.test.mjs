import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { combinedEnv } from './harness.mjs';

test('Chief rejects an intro request when no approved intro offer is configured', async () => {
  const {env}=combinedEnv({subject:'chief-test'});
  env.TEST_STRIPE_CONFIG=JSON.stringify({
    approved:true,accountId:'acct_1U4xNyRs4gw4sfJH',
    verificationReceipt:'local test fixture',products:{chief:'prod_fixtureChief'}
  });
  env.APPROVED_PLANS=JSON.stringify({chief:{
    approved:true,priceId:'price_fixtureChief',unitAmount:2900,currency:'usd',
    interval:'month',termsUrl:'https://merchant.example/chief-test-terms',
    entitlements:['chief.fixture_access']
  }});
  env.INTRODUCTORY_OFFERS_ENABLED='false';
  let providerCalls=0;
  env.STRIPE_FETCH=async()=>{providerCalls++;throw new Error('Must fail before calling Stripe');};
  const response=await worker.fetch(new Request('https://merchant.example/checkout',{
    method:'POST',headers:{Authorization:'Bearer chief-test','Content-Type':'application/json'},
    body:JSON.stringify({product:'chief',introConsent:{
      acceptsTerms:true,acceptsAutomaticRenewal:true,firstInvoiceAmountMinor:100,
      renewalAmountMinor:2900,interval:'month',termsUrl:'https://merchant.example/chief-test-terms'
    }})
  }),env);
  assert.equal(response.status,503);
  assert.equal((await response.json()).error,'introductory_offer_required');
  assert.equal(providerCalls,0);
});
