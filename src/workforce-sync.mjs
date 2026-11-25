// One server-read synthetic approval snapshot per request. Never accept a client snapshot.
const ids=new Set(['example-1','example-2','example-3']);
const fail=()=>{throw Object.assign(new Error('workforce_ledger_unavailable'),{status:503});};
function validate(value){
 if(!value||value.mode!=='synthetic_preview'||value.submittable!==false||value.providerConnected!==false||!Number.isSafeInteger(value.version)||value.version<0||!Array.isArray(value.timesheets)||value.timesheets.length!==ids.size)fail();
 const seen=new Set();for(const row of value.timesheets){if(!ids.has(row?.exampleId)||seen.has(row.exampleId)||!['approved','pending'].includes(row.status))fail();seen.add(row.exampleId);}
 return {version:value.version,timesheets:value.timesheets.map(({exampleId,status})=>({exampleId,status}))};
}
export async function readApprovalSnapshot(env,access,route){
 if(env.WORKFORCE_RECORDS_ENABLED!=='true')return null;
 try{const response=await route(new Request('https://workforce.internal/workforce/workspace/records'),env,access);if(!response.ok)fail();return validate(await response.json());}catch{fail();}
}
export function overlayApprovals(rows,snapshot){
 if(snapshot===null||snapshot===undefined)return structuredClone(rows);
 const byId=new Map(snapshot.timesheets.map(t=>[t.exampleId,t.status]));
 if(rows.length!==ids.size||byId.size!==ids.size||new Set(rows.map(r=>r.id)).size!==ids.size||rows.some(r=>!ids.has(r.id)||!['approved','pending'].includes(byId.get(r.id))))fail();
 return rows.map(row=>({...row,status:byId.get(row.id)}));
}
