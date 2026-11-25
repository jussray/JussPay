import {calculateDemoBatch} from './payroll-batch.mjs';
import {overlayApprovals} from './workforce-sync.mjs';
const roles=new Set(['owner','payroll_admin','reviewer']);
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
function requireRole(access,payroll=false){if(!roles.has(access?.role)||(payroll&&access.role==='reviewer'))fail(403,'workforce_role_denied');}
export async function authorizeWorkspace(env,subject){
 if(typeof subject!=='string'||!subject.length||subject.length>200||subject.trim()!==subject)fail(401,'invalid_identity');
 if(!env.WORKFORCE_ACCESS)fail(503,'workforce_access_unconfigured');
 let response,grant;try{response=await env.WORKFORCE_ACCESS.fetch(new Request('https://workforce-access.internal/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subject,audience:'jusspay-workforce'})}));if(response.status===401||response.status===403)fail(403,'workforce_role_denied');if(!response.ok)fail(503,'workforce_access_unavailable');grant=await response.json();}catch(e){if(e.status===403)throw e;fail(503,'workforce_access_unavailable');}
 if(!grant||grant.subject!==subject||grant.audience!=='jusspay-workforce'||typeof grant.companyId!=='string'||!grant.companyId.trim()||grant.companyId.length>200||!Number.isFinite(grant.expiresAt)||grant.expiresAt<=Date.now()/1000)fail(403,'workforce_role_denied');
 requireRole(grant);return {companyId:grant.companyId,role:grant.role};
}
const people=[{id:'example-1',name:'Example A',status:'active',onboarding:'complete'},{id:'example-2',name:'Example B',status:'active',onboarding:'complete'},{id:'example-3',name:'Example C',status:'pending',onboarding:'pending'}];
const timesheets=[{id:'example-1',regularMinutes:2400,overtimeMinutes:300,hourlyCents:2000,status:'approved'},{id:'example-2',regularMinutes:1800,overtimeMinutes:0,hourlyCents:2200,status:'approved'},{id:'example-3',regularMinutes:1200,overtimeMinutes:0,hourlyCents:2000,status:'pending'}];
export function demoWorkspace(access,snapshot=null){requireRole(access);return {mode:'synthetic_preview',providerConnected:false,people:structuredClone(people),timesheets:overlayApprovals(timesheets,snapshot).map(row=>access.role==='reviewer'?{id:row.id,regularMinutes:row.regularMinutes,overtimeMinutes:row.overtimeMinutes,status:row.status}:row),ledgerVersion:snapshot?.version??null,canPreview:access.role!=='reviewer',submittable:false};}
export function demoPayroll(access,snapshot=null){requireRole(access,true);return {...calculateDemoBatch(overlayApprovals(timesheets,snapshot)),ledgerVersion:snapshot?.version??null};}
export function workspaceToolDefinitions(access){requireRole(access);return ['workforce_demo_overview',...(access.role==='reviewer'?[]:['workforce_demo_payroll'])].map(name=>({name,description:'Read fictional workforce preview data only',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}}));}
export function callWorkspaceTool(access,name,args,snapshot=null){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)fail(400,'invalid_tool_arguments');if(!workspaceToolDefinitions(access).some(t=>t.name===name))fail(404,'tool_unavailable');return name==='workforce_demo_overview'?demoWorkspace(access,snapshot):demoPayroll(access,snapshot);}
