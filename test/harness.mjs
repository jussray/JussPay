// Shared test harness for the combined JussPay core (design merge, 2026-11-05).
// Builds a full combined-worker environment around ONE in-memory BillingAccount
// Durable Object, mirroring the storage double used by test/security.test.mjs.
// The returned env object is shared by reference with the Durable Object, so
// tests configure scenarios by mutating it (Object.assign / direct assignment)
// and passing the same object to worker.fetch — never by spreading it.
// The STRIPE_FETCH adapter answers the core webhook pipeline's account/customer
// reads and delegates everything else to the ambient fetch (which tests replace
// with their Stripe mock via withFetch), exactly as the production worker would
// call the provider.
import {BillingAccount} from '../src/worker.mjs';

export function memoryStorage(){
  let db=new Map();
  return {
    async get(k){return structuredClone(db.get(k));},
    async put(k,v){db.set(k,structuredClone(v));},
    async list({prefix}){return new Map([...db].filter(([k])=>k.startsWith(prefix)));},
    async transaction(fn){const before=structuredClone(db);try{return await fn(this);}catch(e){db=before;throw e;}}
  };
}

export const WEBHOOK_SECRET='whsec_local';

export const SANDBOX_CONFIG=JSON.stringify({approved:true,accountId:'acct_1U4xNyRs4gw4sfJH',verificationReceipt:'unit-test fixture, not deployed',products:{promptos:'prod_VZSVPKfsqwNYrQ'}});

export function combinedEnv({subject='customer_1'}={}){
  const state={storage:memoryStorage(),blockConcurrencyWhile:fn=>fn()};
  const env={
    STRIPE_SECRET_KEY:'sk_test_FAKE',
    STRIPE_WEBHOOK_SECRET:'whsec_local',
    STRIPE_API_VERSION:'test-only',
    STRIPE_LIVE:'false',
    TEST_STRIPE_CONFIG:SANDBOX_CONFIG,
    APPROVED_PLANS:'{}',
    APPROVED_REFUND_POLICY:'account_hold',
    APP_ORIGIN:'https://app.example',
    PAYMENTS_ENABLED:'true',
    SUBSCRIPTIONS_TEST_ENABLED:'true',
    AUTH:{fetch:async()=>Response.json({subject,audience:'jusspay',expiresAt:Math.floor(Date.now()/1000)+60})},
    STRIPE_FETCH:async(url,init)=>{
      const u=String(url);
      if(u.endsWith('/v1/account'))return Response.json({id:'acct_1U4xNyRs4gw4sfJH',charges_enabled:true,details_submitted:true});
      if(u.endsWith('/v1/customers')&&init?.method==='POST'){
        const body=new URLSearchParams(init.body.toString());
        if(body.get('metadata[jusspay_subject]')!==subject)
          return Response.json({error:'customer_subject_mismatch'},{status:403});
        return Response.json({id:'cus_test_123',livemode:false,metadata:{jusspay_subject:subject}});
      }
      if(u.includes('/v1/customers/'))return Response.json({id:decodeURIComponent(u.split('/v1/customers/')[1]),livemode:false,metadata:{jusspay_subject:subject}});
      return fetch(url,init);
    }
  };
  const billing=new BillingAccount(state,env);
  env.BILLING={idFromName:s=>s,get:()=>billing};
  return {
    env,state,billing,
    async seedOrder(row){
      await state.storage.put(`order:${row.id}`,row);
      const idx=(await state.storage.get('order:index'))||[];
      if(!idx.includes(row.id)){idx.push(row.id);await state.storage.put('order:index',idx);}
    },
    async getOrder(id){return (await state.storage.get(`order:${id}`))||null;}
  };
}

export function withFetch(mock,fn){
  const before=globalThis.fetch;
  globalThis.fetch=mock;
  return Promise.resolve().then(fn).finally(()=>{globalThis.fetch=before;});
}
