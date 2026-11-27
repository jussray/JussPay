import test from 'node:test';
import assert from 'node:assert/strict';
import {stripe} from '../src/worker.mjs';

test('a mode mismatch stops before any Stripe call, including writes',async()=>{
  const env={STRIPE_API_VERSION:'fixture',STRIPE_FETCH:()=>assert.fail('must not contact provider')};
  for(const [mode,key] of [['false','sk_live_fixture'],['true','rk_test_fixture'],
    ['false','pk_test_fixture'],['false','sk_test_x\n'],[undefined,'sk_test_fixture']]){
    await assert.rejects(stripe({...env,STRIPE_LIVE:mode,STRIPE_SECRET_KEY:key},'customers','POST',{}),
      {message:'stripe_key_mode_mismatch',status:503});
  }
});

test('the matching restricted key is accepted with provider redirects disabled',async()=>{
  const data=await stripe({STRIPE_LIVE:'false',STRIPE_SECRET_KEY:'rk_test_fixture',
    STRIPE_API_VERSION:'fixture',STRIPE_FETCH:async(url,init)=>{
      assert.equal(url,'https://api.stripe.com/v1/account');
      assert.equal(init.redirect,'error');
      assert.equal(init.headers.authorization,'Bearer rk_test_fixture');
      return Response.json({id:'acct_fixture'});
    }},'account');
  assert.equal(data.id,'acct_fixture');
});
