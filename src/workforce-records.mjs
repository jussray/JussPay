// Synthetic approval ledger only. No employee records, payment or provider access.
const roles=new Set(['owner','payroll_admin','reviewer']);
const ids=new Set(['example-1','example-2','example-3']);
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const denied=(error,status)=>json({error},status);
const validAccess=a=>typeof a?.companyId==='string'&&a.companyId.length>0&&a.companyId.length<=200&&roles.has(a.role);
const validUpdate=b=>b&&typeof b==='object'&&!Array.isArray(b)&&Object.keys(b).length===3&&ids.has(b.exampleId)&&['approved','pending'].includes(b.status)&&Number.isSafeInteger(b.expectedVersion)&&b.expectedVersion>=0;
const initial=companyId=>({companyId,version:0,timesheets:[{exampleId:'example-1',status:'approved'},{exampleId:'example-2',status:'approved'},{exampleId:'example-3',status:'pending'}],receipts:[]});
const view=({version,timesheets,receipts})=>({mode:'synthetic_preview',version,timesheets,receipts,submittable:false,providerConnected:false});
async function readSmall(request){
 const reader=request.body?.getReader();if(!reader)return {error:400};
 const chunks=[];let length=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>2048){await reader.cancel();return {error:413};}chunks.push(value);}}catch{return {error:400};}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return {body:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};}catch{return {error:400};}
}
export async function routeDemoRecords(request,env,access){
 if(env.WORKFORCE_RECORDS_ENABLED!=='true'||!env.WORKFORCE_RECORDS)return denied('records_disabled',503);
 if(!validAccess(access))return denied('role_denied',403);
 const path=new URL(request.url).pathname;
 let action,update=null;
 if(path==='/workforce/workspace/records'&&request.method==='GET')action='read';
 else if(path==='/workforce/workspace/records/time-approval'&&request.method==='POST'){
  if(access.role==='reviewer')return denied('role_denied',403);
  const {body,error}=await readSmall(request);if(error)return denied('invalid_request',error);
  if(!validUpdate(body))return denied('invalid_update',400);
  action='update';update=body;
 }else return denied('method_or_route_denied',405);
 const ns=env.WORKFORCE_RECORDS;
 return ns.get(ns.idFromName(access.companyId)).fetch(new Request('https://workforce-records.internal/record',{method:'POST',body:JSON.stringify({access,action,update})}));
}
export class WorkforceDemoBook {
 constructor(state){this.storage=state.storage;}
 async fetch(request){
  if(request.url!=='https://workforce-records.internal/record'||request.method!=='POST')return denied('not_found',404);
  const {body,error}=await readSmall(request);if(error)return denied('invalid_request',error);
  if(!validAccess(body?.access))return denied('role_denied',403);
  const {access,action,update}=body;
  if(!['read','update'].includes(action))return denied('invalid_action',400);
  if(action==='update'&&access.role==='reviewer')return denied('role_denied',403);
  if(action==='update'&&!validUpdate(update))return denied('invalid_update',400);
  return this.storage.transaction(async tx=>{
   const record=await tx.get('record')||initial(access.companyId);
   if(record.companyId!==access.companyId)return denied('tenant_mismatch',403);
   if(action==='read')return json(view(record));
   if(update.expectedVersion!==record.version)return denied('version_conflict',409);
   const row=record.timesheets.find(t=>t.exampleId===update.exampleId);
   if(row.status===update.status)return json(view(record));
   if(record.receipts.length>=100)return denied('demo_receipt_limit',409);
   const from=row.status;row.status=update.status;record.version++;
   record.receipts.push({version:record.version,exampleId:row.exampleId,from,to:row.status});
   await tx.put('record',record);return json(view(record));
  });
 }
}
