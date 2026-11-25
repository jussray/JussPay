// Fixed fictional IDs only; never a payable payroll batch.
import {calculateGrossExample,EXAMPLE_RULE_VERSION} from './payroll-rules.mjs';
const ids=new Set(['example-1','example-2','example-3']);
const fields=['id','status','regularMinutes','overtimeMinutes','hourlyCents'];
const invalid=()=>{throw Object.assign(new Error('invalid_demo_batch'),{status:400});};
export function calculateDemoBatch(rows){
 if(!Array.isArray(rows)||rows.length>ids.size)invalid();
 const seen=new Set(),lines=[];
 for(const row of rows){
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==fields.length||!fields.every(k=>Object.hasOwn(row,k))||!ids.has(row.id)||seen.has(row.id)||!['approved','pending'].includes(row.status))invalid();
  seen.add(row.id);
  const result=calculateGrossExample({regularMinutes:row.regularMinutes,overtimeMinutes:row.overtimeMinutes,hourlyCents:row.hourlyCents});
  if(row.status==='approved')lines.push({exampleId:row.id,grossCents:result.grossCents,calculation:result.calculation});
 }
 return {mode:'synthetic_preview',grossCents:lines.reduce((sum,line)=>sum+line.grossCents,0),currency:'usd',ruleVersion:EXAMPLE_RULE_VERSION,includedCount:lines.length,excludedCount:rows.length-lines.length,lines,netCents:null,taxCents:null,providerConnected:false,submittable:false};
}
