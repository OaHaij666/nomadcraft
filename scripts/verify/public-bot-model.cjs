// Deterministic local OpenAI transport for actual public-Harness lifecycle verification; never calls a paid API.
const http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
async function createModelFixture({ysm=false}={}){
 const key='NC_FIXTURE_KEY_'+crypto.randomBytes(20).toString('hex'),requests=[];let failure;
 const server=http.createServer(async(req,res)=>{
  try{
   assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer '+key);
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;assert(size<2*1024*1024);chunks.push(chunk)}
   const body=JSON.parse(Buffer.concat(chunks).toString());assert(Array.isArray(body.messages));assert(requests.length<150,'Unexpected fixture inference loop');
   const last=body.messages.map(m=>m.role==='user'?String(m.content):'').join('\n').match(/NC_(?:(?:SOURCE|TARGET|REOPEN)_HARNESS|YSM_(?:SOURCE|TARGET))/g)?.at(-1);
   const marker=last||'NC_IDLE_HARNESS';
   const sourceSeen=body.messages.some(m=>String(m.content).includes('NC_SOURCE_HARNESS'));
   const hasTool=body.messages.at(-1)?.role==='tool';const serialized=JSON.stringify(body.messages);requests.push({marker,sourceSeen,toolReceipt:hasTool,toolError:hasTool&&/\b(?:error|exception)\b|错误|失败/iu.test(String(body.messages.at(-1).content)),nativeSource:serialized.includes('NC_NATIVE_SOURCE'),nativeTarget:serialized.includes('NC_NATIVE_TARGET'),nativeTargetUuids:[...new Set(body.messages.filter(message=>String(message.content).includes('NC_NATIVE_TARGET')).flatMap(message=>String(message.content).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig)||[]))],identityUuids:[...new Set(serialized.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig)||[])],at:Date.now()});
   const ysmTask=ysm&&marker.startsWith('NC_YSM_');const lastTool=body.messages.at(-1);const lastCall=hasTool?body.messages.findLast(message=>Array.isArray(message.tool_calls)&&message.tool_calls.some(call=>call.id===lastTool.tool_call_id))?.tool_calls.find(call=>call.id===lastTool.tool_call_id):undefined;
   if(ysmTask&&hasTool&&lastCall?.function?.name==='lua'){assert(String(lastTool.content).includes(marker+' model=nc-proof texture=default'),'Actual YSM Lua receipt did not confirm model and texture: '+String(lastTool.content).slice(0,1600));requests.at(-1).ysmReceipt=String(lastTool.content);}
   const ysmCode='ysm.model.switch("nc-proof", {texture = "default"})\nlocal look = ysm.model.options()\nassert(look.current_model == "nc-proof", "Unexpected YSM model")\nassert(look.current_texture == "default", "Unexpected YSM texture")\nprint("'+marker+' model=" .. look.current_model .. " texture=" .. look.current_texture)';
   const message=ysmTask&&!hasTool?{role:'assistant',content:null,tool_calls:[{id:'call_'+crypto.randomBytes(8).toString('hex'),type:'function',function:{name:'lua',arguments:JSON.stringify({code:ysmCode})}}]}:ysmTask&&hasTool&&lastCall?.function?.name==='lua'?{role:'assistant',content:null,tool_calls:[{id:'call_'+crypto.randomBytes(8).toString('hex'),type:'function',function:{name:'say',arguments:JSON.stringify({text:marker+'_SPEECH'})}}]}:hasTool?{role:'assistant',content:'ACK '+marker}:{role:'assistant',content:null,tool_calls:[{id:'call_'+crypto.randomBytes(8).toString('hex'),type:'function',function:{name:'say',arguments:JSON.stringify({text:marker+'_SPEECH'})}}]};
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'chatcmpl-fixture',object:'chat.completion',created:Math.floor(Date.now()/1000),model:'local-proof',choices:[{index:0,message,finish_reason:hasTool?'stop':'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  }catch(error){failure=error;res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'fixture_failure'}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {key,requests,baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',assertHealthy(){if(failure)throw failure;},async close(){await new Promise(r=>server.close(r));}};
}
module.exports={createModelFixture};
