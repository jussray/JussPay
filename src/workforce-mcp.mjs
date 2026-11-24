// Private synthetic JSON-RPC adapter; not a public OAuth/MCP server.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const version='2025-11-25';
export function handleDemoMcp(message,ctx){
 const id=object(message)&&Object.hasOwn(message,'id')?message.id:null;
 const error=(code,text)=>({jsonrpc:'2.0',id,error:{code,message:text}});
 const ok=result=>({jsonrpc:'2.0',id,result});
 if(!object(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||(id!==null&&typeof id!=='string'&&!(typeof id==='number'&&Number.isFinite(id))))return error(-32600,'Invalid request');
 if(!Object.hasOwn(message,'id'))return null;
 if(!ctx?.access)return error(-32001,'Authorization required');
 const params=message.params??{};
 if(!object(params))return error(-32602,'Invalid params');
 switch(message.method){
 case 'initialize':return ok({protocolVersion:version,capabilities:{tools:{}},serverInfo:{name:'jusspay-workforce-demo',version:'0.1.0'},instructions:'Fictional examples only. No live payroll or submission.'});
 case 'ping':return ok({});
 case 'tools/list':return ok({tools:ctx.list(ctx.access)});
 case 'tools/call':{
  if(typeof params.name!=='string'||!ctx.list(ctx.access).some(t=>t.name===params.name)||!object(params.arguments??{})||Object.keys(params).some(k=>!['name','arguments'].includes(k)))return error(-32602,'Invalid tool or arguments');
  try{const data=ctx.call(ctx.access,params.name,params.arguments??{});return ok({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});}
  catch{return ok({isError:true,content:[{type:'text',text:'Tool denied or unavailable'}]});}
 }
 default:return error(-32601,'Method not found');
 }
}
