import {handleDemoMcp} from './workforce-mcp.mjs';
import {authorizeWorkspace,demoWorkspace,demoPayroll,workspaceToolDefinitions,callWorkspaceTool} from './workforce-workspace.mjs';
// Synthetic weekly examples only. No worker records, provider calls or payments.
const fields=['regularMinutes','overtimeMinutes','hourlyCents'];
const inputSchema={type:'object',additionalProperties:false,required:fields,properties:{regularMinutes:{type:'integer',minimum:0,maximum:2400},overtimeMinutes:{type:'integer',minimum:0,maximum:7680},hourlyCents:{type:'integer',minimum:1,maximum:1000000}}};
function invalid(){throw Object.assign(new Error('invalid_workforce_input'),{status:400});}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function keys(value,expected){return object(value)&&Object.keys(value).length===expected.length&&expected.every(k=>Object.hasOwn(value,k));}
export function previewPayroll(input){
  if(!keys(input,fields))invalid();
  for(const key of fields){
    const {minimum,maximum}=inputSchema.properties[key];
    if(!Number.isSafeInteger(input[key])||input[key]<minimum||input[key]>maximum)invalid();
  }
  const {regularMinutes,overtimeMinutes,hourlyCents}=input;
  if(regularMinutes+overtimeMinutes>10080)invalid();
  // Illustrative 1.5x overtime; not a jurisdiction-specific wage calculation.
  const grossCents=Math.round(hourlyCents*(2*regularMinutes+3*overtimeMinutes)/120);
  return {mode:'synthetic_preview',currency:'usd',grossCents,netCents:null,taxCents:null,submittable:false,providerConnected:false,assumption:'Example only: 1.5x overtime. No tax, deductions or legal payroll determination.'};
}
export function workforceOverview(){
  return {mode:'synthetic_preview',providerConnected:false,livePayrollVerified:false,submittable:false,modules:{people:'not_implemented',onboarding:'not_implemented',timesheets:'example_inputs_only',payroll:'gross_example_only',taxes:'provider_required',reconciliation:'provider_required',approval:'no_submission_available'}};
}
export function workforceTools(){
  return [{name:'workforce_overview',description:'Show synthetic preview status and missing capabilities',inputSchema:{type:'object',additionalProperties:false,properties:{}}},{name:'preview_payroll',description:'Calculate an illustrative weekly gross amount from fictional inputs only',inputSchema:structuredClone(inputSchema)}];
}
export async function handleWorkforce(request,env,{identity,boundedText,json}){
  if(env.WORKFORCE_PREVIEW_ENABLED!=='true'||!env.AUTH)return json({error:'workforce_preview_disabled'},503);
  const subject=await identity(request,env);
  const path=new URL(request.url).pathname;
  if(path==='/workforce/workspace'||path.startsWith('/workforce/workspace/')){
    const access=await authorizeWorkspace(env,subject);
    if(path==='/workforce/workspace'||path==='/workforce/workspace/payroll'||path==='/workforce/workspace/tools'){
      if(request.method!=='GET')return json({error:'method_not_allowed'},405);
      if(path==='/workforce/workspace')return json(demoWorkspace(access));
      if(path.endsWith('/payroll'))return json(demoPayroll(access));
      return json({tools:workspaceToolDefinitions(access)});
    }
    if(path==='/workforce/workspace/mcp-demo'){
      if(env.WORKFORCE_MCP_DEMO_ENABLED!=='true')return json({error:'mcp_demo_disabled'},503);
      if(request.method!=='POST')return json({error:'method_not_allowed'},405);
      const raw=await boundedText(request,4096);
      let data;try{data=JSON.parse(raw);}catch{return json({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}},400);}
      const result=handleDemoMcp(data,{access,list:workspaceToolDefinitions,call:callWorkspaceTool});
      return result===null?new Response(null,{status:202,headers:{'cache-control':'no-store'}}):json(result);
    }
    if(path==='/workforce/workspace/tools/call'){
      if(request.method!=='POST')return json({error:'method_not_allowed'},405);
      let data;const raw=await boundedText(request,4096);try{data=JSON.parse(raw);}catch{invalid();}
      if(!keys(data,['name','arguments']))invalid();
      return json(callWorkspaceTool(access,data.name,data.arguments));
    }
    return json({error:'not_found'},404);
  }
  if(path==='/workforce/overview'||path==='/workforce/tools'){
    if(request.method!=='GET')return json({error:'method_not_allowed'},405);
    return json(path.endsWith('/tools')?{tools:workforceTools()}:workforceOverview());
  }
  if(!['/workforce/preview','/workforce/tools/call'].includes(path))return json({error:'not_found'},404);
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  const raw=await boundedText(request,4096);
  let data;try{data=JSON.parse(raw);}catch{invalid();}
  if(path==='/workforce/preview')return json(previewPayroll(data));
  if(!keys(data,['name','arguments']))invalid();
  if(data.name==='preview_payroll')return json(previewPayroll(data.arguments));
  if(data.name==='workforce_overview'&&keys(data.arguments,[]))return json(workforceOverview());
  invalid();
}
