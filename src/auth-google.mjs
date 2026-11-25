// JussPay private AUTH verifier for the existing PromptOS Google Sign-In.
// Parsed token fields only select the issuer path. Signature verification below
// is the sole authority; never rely on an unverified browser-paid claim.
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const json = (body, status) => Response.json(body, {status, headers: {'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}});
const decode = input => {
  if(typeof input!=='string' || !/^[A-Za-z0-9_-]+$/.test(input)) throw Error('malformed_token');
  const padded=input.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-input.length%4)%4);
  return Uint8Array.from(atob(padded),v=>v.charCodeAt(0));
};
const parse = s => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(s)));

export function isGoogleIssuer(iss) { return ISSUERS.has(iss); }

export async function verifyPromptosGoogle(token, env) {
  const audience=env.PROMPTOS_GOOGLE_CLIENT_ID;
  if(typeof audience!=='string' || !/^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/.test(audience))
    return json({error:'auth_not_configured'},503);
  if(typeof token!=='string'||token.length>8192) return json({error:'invalid_token'},401);
  const parts=token.split('.');
  if(parts.length!==3) return json({error:'invalid_token'},401);
  let h,c;
  try {h=parse(parts[0]);c=parse(parts[1]);}catch{return json({error:'invalid_token'},401);}
  try {
    const now=Math.floor(Date.now()/1000);
    if(h.alg!=='RS256' || typeof h.kid!=='string' || !/^[A-Za-z0-9_\-.]{1,128}$/.test(h.kid) ||
      !ISSUERS.has(c.iss) || c.aud!==audience || (c.azp!==undefined && c.azp!==audience) ||
      typeof c.sub!=='string'|| !/^\d{10,32}$/.test(c.sub) ||
      typeof c.email!=='string'||!c.email.trim()|| (c.email_verified!==true&&c.email_verified!=='true') ||
      !Number.isSafeInteger(c.exp)||c.exp<=now || c.exp>now+3700 ||
      !Number.isSafeInteger(c.iat)||c.iat>now+60 ||c.iat>c.exp ||
      (c.nbf!==undefined && (!Number.isSafeInteger(c.nbf)||c.nbf>now)))
      return json({error:'invalid_token'},401);
    const response=await (env.GOOGLE_JWKS_FETCH||fetch)(GOOGLE_JWKS,{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(5000)
    });
    if(!response.ok)return json({error:response.status>=500?'auth_provider_unavailable':'invalid_token'},response.status>=500?503:401);
    const keys=await response.json();
    const jwk=keys?.keys?.find(k=>k && k.kid===h.kid && k.kty==='RSA' &&
      (!k.alg||k.alg==='RS256') && (!k.use||k.use==='sig'));
    if(!jwk) return json({error:'invalid_token'},401);
    const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
    if(!valid||c.exp<=Date.now()/1000)return json({error:'invalid_token'},401);
    // Issuer-scoped subjects cannot collide with Supabase or other app identities.
    return json({subject:'https://accounts.google.com#'+c.sub,audience:'jusspay',expiresAt:c.exp});
  }catch {return json({error:'auth_provider_unavailable'},503);}
}
