import {pathToFileURL} from 'node:url';

export async function smoke(origin,sha,{fetcher=globalThis.fetch,expectClosed=false}={}){
  const base=new URL(origin);
  // The loopback exception is limited to local sandbox verification.
  if(origin!==base.origin||!(base.protocol==='https:'||
     (base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname)))||
     !/^[a-f0-9]{40}$/.test(sha))throw Error('invalid_smoke_configuration');
  const get=async path=>{
    const r=await fetcher(new URL(path,base),{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!r.headers.get('content-type')?.startsWith('application/json'))throw Error(path+': expected JussPay JSON');
    return {status:r.status,body:await r.json()};
  };
  const [version,health,catalog]=await Promise.all(['/version','/health','/catalog'].map(get));
  if(version.status!==200||version.body?.ok!==true||version.body?.service!=='JussPay'||version.body?.sha!==sha)
    throw Error('/version: Worker identity or commit mismatch');
  if(![200,503].includes(health.status)||health.body?.service!=='JussPay'||
     typeof health.body?.configured!=='boolean'||health.body.configured!==(health.status===200)||
     health.body?.livePaymentsVerified!==false)throw Error('/health: invalid readiness response');
  if(catalog.status!==200||!Array.isArray(catalog.body)||!catalog.body.some(row=>row?.id==='chief')||
     catalog.body.some(row=>!['unavailable','requires_provider_validation'].includes(row?.purchaseStatus)||
       row?.providerAvailabilityVerified!==false))throw Error('/catalog: invalid catalog response');
  if(expectClosed&&catalog.body.some(row=>row.purchaseStatus!=='unavailable'))
    throw Error('/catalog: unexpected open offer');
  const chief=catalog.body.find(row=>row.id==='chief');
  return {sha,configured:health.body.configured,chief:chief.purchaseStatus,providerPaymentVerified:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [origin,sha,flag]=process.argv.slice(2);
  try{if(flag!==undefined&&flag!=='--expect-closed')throw Error('unknown argument');
    console.log(JSON.stringify(await smoke(origin,sha,{expectClosed:flag==='--expect-closed'})));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
