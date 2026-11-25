const roles=new Set(['owner','payroll_admin','reviewer']);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&v.length<=200&&v.trim()===v&&v.length>0;
const audience='jusspay-workforce';
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
async function read(request){
 const reader=request.body?.getReader();if(!reader)return {error:400};
 let count=0;const parts=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>2048){await reader.cancel();return {error:413};}parts.push(value);}}catch{return {error:400};}finally{reader.releaseLock();}
 const bytes=new Uint8Array(count);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
 try{return {body:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};}catch{return {error:400};}
}
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.origin!=='https://workforce-access.internal'||url.pathname!=='/verify'||url.search)return json({error:'not_found'},404);
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 if(env.WORKFORCE_ACCESS_MODE!=='synthetic_preview')return json({error:'access_unconfigured'},503);
 let grants;try{grants=JSON.parse(env.WORKFORCE_MEMBERSHIPS||'null');}catch{return json({error:'access_unconfigured'},503);}
 if(!Array.isArray(grants)||grants.length>1000||grants.some(g=>!object(g)||!id(g.subject)||!id(g.companyId)||!roles.has(g.role)||!Number.isSafeInteger(g.expiresAt)))return json({error:'access_unconfigured'},503);
 const {body,error}=await read(request);if(error)return json({error:'invalid_request'},error);
 if(!object(body)||Object.keys(body).length!==2||!id(body.subject)||body.audience!==audience)return json({error:'invalid_request'},400);
 const now=Math.floor(Date.now()/1000);
 const matches=grants.filter(g=>g.subject===body.subject&&g.expiresAt>now);
 if(matches.length!==1)return json({error:'role_denied'},403);
 const g=matches[0];return json({subject:g.subject,companyId:g.companyId,role:g.role,audience,expiresAt:Math.min(g.expiresAt,now+60)});
}};
