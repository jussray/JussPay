const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export default {async fetch(request,env){
  try{
    if(new URL(request.url).pathname!=='/verify'||request.method!=='POST')return json({error:'not_found'},404);
    let origin;
    try{const u=new URL(env.SUPABASE_URL);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.origin!==env.SUPABASE_URL)throw Error();origin=u.origin;}catch{return json({error:'auth_not_configured'},503);}
    if(!env.SUPABASE_API_KEY)return json({error:'auth_not_configured'},503);
    const authorization=request.headers.get('authorization');
    if(!authorization?.startsWith('Bearer ')||authorization.length>8192)return json({error:'invalid_token'},401);
    const token=authorization.slice(7);const segments=token.split('.');let claims;
    try{if(segments.length!==3||segments.some(s=>!s||!/^[a-zA-Z0-9_-]+$/.test(s)))throw Error();claims=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(segments[1].replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));}catch{return json({error:'invalid_token'},401);}
    const now=Date.now()/1000;const issuer=`${origin}/auth/v1`;
    // Parsed claims may deny a request here, but never authorize it without the provider verification below.
    if(claims.iss!==issuer || claims.aud!=='authenticated' || claims.role!=='authenticated' || claims.is_anonymous===true || typeof claims.sub!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.sub) || !Number.isSafeInteger(claims.exp)||claims.exp<=now || (claims.nbf!==undefined&&(!Number.isFinite(claims.nbf)||claims.nbf>now)))return json({error:'invalid_token'},401);
    // Only this fixed, configured issuer receives the token; redirects cannot forward it elsewhere.
    const r=await (env.SUPABASE_FETCH||fetch)(`${origin}/auth/v1/user`,{method:'GET',headers:{authorization,apikey:env.SUPABASE_API_KEY},redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!r.ok)return json({error:r.status>=500?'auth_provider_unavailable':'invalid_token'},r.status>=500?503:401);
    const user=await r.json();
    if(user.id!==claims.sub||user.aud!=='authenticated'||user.is_anonymous===true||claims.exp<=Date.now()/1000)return json({error:'invalid_token'},401);
    return json({subject:`${issuer}#${user.id}`,audience:'jusspay',expiresAt:claims.exp});
  }catch{return json({error:'auth_provider_unavailable'},503);}
}};
