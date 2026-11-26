import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import auth from '../src/auth-supabase.mjs';
import worker from '../src/worker.mjs';
import {combinedEnv} from './harness.mjs';

const cryptoWeb=globalThis.crypto||webcrypto;
const clientId='813638397474-6pibutsimcafimrcttq7idnmugsin01c.apps.googleusercontent.com';
const {privateKey,publicKey}=await cryptoWeb.subtle.generateKey({
  name:'RSASSA-PKCS1-v1_5',modulusLength:2048,
  publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'
},true,['sign','verify']);
const jwk=await cryptoWeb.subtle.exportKey('jwk',publicKey);
Object.assign(jwk,{kid:'google-fixture-key',alg:'RS256',use:'sig'});
const unix=()=>Math.floor(Date.now()/1000);
const base64url=s=>Buffer.from(JSON.stringify(s)).toString('base64url');
async function googleToken(claimOverrides={},headerOverrides={},signingKey=privateKey){
  const header=base64url({alg:'RS256',kid:'google-fixture-key',typ:'JWT',...headerOverrides});
  const claims=base64url({iss:'https://accounts.google.com',aud:clientId,
    sub:'109876543210987654321',exp:unix()+1800,iat:unix()-10,email:'verified@example.com',email_verified:true,...claimOverrides});
  const content=header+'.'+claims;
  const signature=await cryptoWeb.subtle.sign('RSASSA-PKCS1-v1_5',signingKey,new TextEncoder().encode(content));
  return content+'.'+Buffer.from(signature).toString('base64url');
}
const reads=[];
const googleFetch=async (url,options={})=>{
  reads.push({url:String(url),method:options.method,redirect:options.redirect});
  assert.equal(url,'https://www.googleapis.com/oauth2/v3/certs');
  assert.equal(options.redirect,'error');
  return Response.json({keys:[jwk]});
};
const authEnv={PROMPTOS_GOOGLE_CLIENT_ID:clientId,GOOGLE_JWKS_FETCH:googleFetch};
const verify=(token,env=authEnv,extra={audience:'jusspay'})=>auth.fetch(new Request('https://auth.internal/verify',{
  method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
  body:JSON.stringify(extra)
}),env);

test('valid Google token produces a stable, issuer-qualified JussPay subject',async()=>{
  const r=await verify(await googleToken());assert.equal(r.status,200);
  const payload=await r.json();
  assert.deepEqual(payload,{
    subject:'https://accounts.google.com#109876543210987654321',
    audience:'jusspay',expiresAt:payload.expiresAt
  });
  assert(payload.expiresAt>unix());
  assert.equal(r.headers.get('cache-control'),'no-store');
  assert.deepEqual(reads.at(-1).redirect,'error');
});

test('signed but unverified or missing Google email claims cannot authorize billing',async()=>{
  for(const claims of [
    {email_verified:false},{email_verified:undefined},{email_verified:'false'},
    {email_verified:1},{email:undefined},{email:''}
  ]){
    const before=reads.length;
    assert.equal((await verify(await googleToken(claims))).status,401);
    assert.equal(reads.length,before);
  }
  assert.equal((await verify(await googleToken({email_verified:'true'}))).status,200);
});

test('Google identity must be configured in the private AUTH service',async()=>{
  const token=await googleToken();
  assert.equal((await verify(token,{})).status,503);
  assert.equal((await verify(token,{PROMPTOS_GOOGLE_CLIENT_ID:'malformed',GOOGLE_JWKS_FETCH:googleFetch})).status,503);
});

test('wrong audience, issuer, azp, expiration, future-issued, malformed or forged tokens cannot authorize',async()=>{
  const variants=[
    [{aud:'attacker.apps.googleusercontent.com'},{}],
    [{iss:'https://attacker.invalid'},{}],
    [{azp:'other.apps.googleusercontent.com'},{}],
    [{exp:unix()-60},{}],
    [{iat:unix()+300},{}],
    [{sub:'attacker'},{}],
    [{nbf:unix()+300},{}],
    [{},{alg:'HS256'}],
    [{},{kid:'unknown-key'}]
  ];
  for(const [claims,header] of variants){const response=await verify(await googleToken(claims,header));
    assert.notEqual(response.status,200,JSON.stringify({claims,header}));}
  const altered=await googleToken();
  const pieces=altered.split('.');
  const payload=JSON.parse(Buffer.from(pieces[1],'base64url').toString('utf8'));
  payload.sub='109876543210987654322';
  pieces[1]=base64url(payload);
  assert.equal((await verify(pieces.join('.'))).status,401);
  assert.equal((await verify('not-valid-token')).status,401);
  const malformedHeader='eyJub3QiOiJqc29uIg.invalid_payload.signature';
  assert.equal((await verify(malformedHeader)).status,401);
  const {privateKey:alienKey}=await cryptoWeb.subtle.generateKey({
    name:'RSASSA-PKCS1-v1_5',modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'
  },true,['sign','verify']);
  assert.equal((await verify(await googleToken({},{},alienKey))).status,401);
});

test('private AUTH endpoint refuses foreign caller audience before token verification',async()=>{
  const token=await googleToken();
  assert.equal((await verify(token,authEnv,{audience:'other-product'})).status,401);
  assert.equal((await verify(token,authEnv,{audience:undefined})).status,401);
});

test('Google JWKS outage, wrong key and remote redirect fail closed',async()=>{
  const token=await googleToken();
  const unavailable=await verify(token,{...authEnv,GOOGLE_JWKS_FETCH:async()=>new Response('',{status:503})});
  assert.equal(unavailable.status,503);
  const redirect=await verify(token,{...authEnv,GOOGLE_JWKS_FETCH:async()=>{throw new Error('blocked redirect')}});
  assert.equal(redirect.status,503);
  const missing=await verify(token,{...authEnv,GOOGLE_JWKS_FETCH:async()=>Response.json({keys:[]})});
  assert.equal(missing.status,401);
});

test('AUTH adapter keeps the existing Supabase issuer path independent of Google',async()=>{
  const uuid='11111111-1111-4111-8111-111111111111';
  const segments=[base64url({alg:'RS256'}),base64url({iss:'https://unit-test.supabase.co/auth/v1',
    aud:'authenticated',role:'authenticated',sub:uuid,exp:unix()+60}),'mock-sig'];
  const token=segments.join('.');
  const res=await verify(token,{SUPABASE_URL:'https://unit-test.supabase.co',SUPABASE_API_KEY:'unit-test-only',
    PROMPTOS_GOOGLE_CLIENT_ID:clientId,GOOGLE_JWKS_FETCH:()=>{throw new Error('Wrong provider')},
    SUPABASE_FETCH:async()=>Response.json({id:uuid,aud:'authenticated'})});
  assert.equal(res.status,200);
  assert.equal((await res.json()).subject,`https://unit-test.supabase.co/auth/v1#${uuid}`);
});

test('real JussPay /entitlements uses Google AUTH subject and denies a stolen user header',async()=>{
  const token=await googleToken();
  const {env}=combinedEnv({subject:'unused'});
  env.AUTH={fetch:r=>auth.fetch(r,authEnv)};
  const request=new Request('https://jusspay.test/entitlements',{headers:{
    authorization:'Bearer '+token,'x-user-id':'victim-account'
  }});
  const response=await worker.fetch(request,env);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{entitlements:[]});
  assert.equal((await worker.fetch(new Request('https://jusspay.test/entitlements',{
    headers:{'x-user-id':'victim-account'}}),env)).status,401);
  const foreign=await worker.fetch(new Request('https://jusspay.test/entitlements',{
    headers:{authorization:'Bearer '+await googleToken({aud:'different-client'})}}),env);
  assert.equal(foreign.status,401);
});

test('Wrangler declares private JussPay AUTH without enabling public billing',()=>{
  const worker=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  const authWorker=JSON.parse(readFileSync(new URL('../wrangler.auth.jsonc',import.meta.url),'utf8'));
  assert(worker.services.some(b=>b.binding==='AUTH'&&b.service==='jusspay-auth'));
  assert.equal(worker.workers_dev,false);
  assert.equal(worker.vars.STRIPE_LIVE,'false');
  assert.equal(worker.vars.INTRODUCTORY_OFFERS_ENABLED,'false');
  assert.equal(worker.vars.PAYMENTS_ENABLED,undefined);
  assert.equal(authWorker.workers_dev,false);
  assert.equal(authWorker.preview_urls,false);
  assert.equal(authWorker.vars.PROMPTOS_GOOGLE_CLIENT_ID,clientId);
});
