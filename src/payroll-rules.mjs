// First-party illustrative gross rule, not a jurisdiction-specific payroll engine.
export const EXAMPLE_RULE_VERSION='synthetic-gross-v1';
const fields=['regularMinutes','overtimeMinutes','hourlyCents'];
const limits={regularMinutes:[0,2400],overtimeMinutes:[0,7680],hourlyCents:[1,1000000]};
const invalid=()=>{throw Object.assign(new Error('invalid_workforce_input'),{status:400});};
export function calculateGrossExample(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==fields.length||!fields.every(k=>Object.hasOwn(input,k)))invalid();
 for(const key of fields){const [min,max]=limits[key];if(!Number.isSafeInteger(input[key])||input[key]<min||input[key]>max)invalid();}
 const {regularMinutes,overtimeMinutes,hourlyCents}=input;
 const regularNumerator=BigInt(hourlyCents)*2n*BigInt(regularMinutes);
 const overtimeNumerator=BigInt(hourlyCents)*3n*BigInt(overtimeMinutes);
 const numerator=regularNumerator+overtimeNumerator;
 const grossCents=Number((numerator+60n)/120n);
 return {mode:'synthetic_preview',ruleVersion:EXAMPLE_RULE_VERSION,currency:'usd',grossCents,calculation:{regularNumerator:regularNumerator.toString(),overtimeNumerator:overtimeNumerator.toString(),denominator:120,rounding:'half_up_total'},netCents:null,taxCents:null,submittable:false,providerConnected:false,assumption:'Example only: 1.5x overtime. No tax, deductions or legal payroll determination.'};
}
