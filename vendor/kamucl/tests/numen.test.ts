import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { AI_DEFAULTS, type NumenPhase, type NumenTool, type NumenToolResult } from '../src/shared/numen'
import { NumenMcpClient, localMcpEndpoint, parseCompanions, resultText, boundedText } from '../src/main/core/numen/mcp'
import { AiModelClient, modelPayload, modelEndpoint, parseModelReply, type BrainMessage, type ModelReply } from '../src/main/core/numen/model'
import { NumenHarness, harnessTools, settleHistory } from '../src/main/core/numen/harness'
const text=(value:string):NumenToolResult=>({content:[{type:'text',text:value}]})
const tools:NumenTool[]=['list_companions','create_companion','get_events','say','lua'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{companion:{type:'string'},code:{type:'string'}},required:['companion']}}))
const reply=(content='',calls:ModelReply['calls']=[]):ModelReply=>({text:content,calls,inputTokens:8,outputTokens:4})
async function until(predicate:()=>boolean,timeout=2500){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('timed out');await delay(10)}}
async function fixture(handler:(request:any)=>any){
  const requests:any[]=[]
  const server=http.createServer(async(req,res)=>{try{let body='';for await(const chunk of req)body+=chunk;const parsed=JSON.parse(body);requests.push({headers:req.headers,url:req.url,body:parsed});const value=handler(parsed);if(value===null){res.writeHead(202);res.end();return}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value))}catch{res.writeHead(500);res.end()}})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address() as {port:number}
  return {base:'http://127.0.0.1:'+address.port,requests,close:()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections()})}
}
function bodyStub(events:string[]=[]){const calls:Array<{name:string;args:Record<string,unknown>}>=[];const mcp={instructions:'Numen fixture instructions',tools,async call(name:string,args:Record<string,unknown>){calls.push({name,args});return name==='get_events'?text(events.shift()??'(no new events — keep polling; the owner\'s words and world happenings land here)'):text(name==='lua'?'ok · observed body':'said')}} as unknown as NumenMcpClient;return{mcp,calls}}
function hostFixture(){const phases:NumenPhase[]=[];const logs:string[]=[];let saved:BrainMessage[]=[];return{phases,logs,get saved(){return saved},host:{log:(_kind:string,value:string)=>logs.push(value),phase:(phase:NumenPhase)=>phases.push(phase),usage:()=>{},save:(history:BrainMessage[])=>{saved=structuredClone(history)}}}}

test('MCP endpoint only accepts explicit loopback /mcp without credentials',()=>{
  assert.equal(localMcpEndpoint('http://127.0.0.1:8765/mcp'),'http://127.0.0.1:8765/mcp')
  assert.ok(localMcpEndpoint('http://[::1]:8765/mcp'))
  for(const url of ['https://evil.test/mcp','http://192.168.1.2/mcp','http://user:token@localhost/mcp','http://localhost/mcp?token=x','http://localhost/other'])assert.throws(()=>localMcpEndpoint(url))
})
test('MCP handshake and schema discovery use real HTTP JSON-RPC with bearer auth',async()=>{
  const f=await fixture(req=>req.id===undefined?null:{jsonrpc:'2.0',id:req.id,result:req.method==='initialize'?{serverInfo:{name:'numen-mcp'},instructions:'drive one body'}:req.method==='tools/list'?{tools}:text('Live companions:\n- NomadBot  (id: 1234-5678)')})
  try{const client=new NumenMcpClient(f.base+'/mcp','test-secret');await client.initialize();assert.equal(client.instructions,'drive one body');assert.deepEqual(await client.companions(),[{name:'NomadBot',id:'1234-5678'}]);assert.deepEqual(client.scriptArgs('return numen.status.self()','1234-5678'),{code:'return numen.status.self()',companion:'1234-5678'});assert.ok(f.requests.every(req=>req.headers.authorization==='Bearer test-secret'));assert.equal(f.requests[1].body.method,'notifications/initialized');assert.ok(!JSON.stringify(f.requests.map(req=>req.body)).includes('test-secret'))}finally{await f.close()}
})
test('MCP rejects other servers, missing tools and stale response ids',async()=>{
  const bad=async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:999,result:{}}))
  await assert.rejects(new NumenMcpClient('http://localhost:8765/mcp','',bad as typeof fetch).initialize(),/编号不匹配/)
  const other=async(_url:any,init:any)=>new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{serverInfo:{name:'other'}}}))
  await assert.rejects(new NumenMcpClient('http://localhost:8765/mcp','',other as typeof fetch).initialize(),/不是 Numen/)
})
test('MCP unauthorized errors do not reflect response secrets',async()=>{
  const deny=async()=>new Response('numen-my-private-token',{status:401})
  await assert.rejects(new NumenMcpClient('http://localhost:8765/mcp','secret',deny as typeof fetch).initialize(),error=>!/private|secret/.test(String(error))&&/令牌/.test(String(error)))
})
test('bounded network reads stop oversized responses',async()=>{await assert.rejects(boundedText(new Response('x'.repeat(50)),20),/大小限制/)})
test('companion roster parser uses upstream line format',()=>{assert.deepEqual(parseCompanions('Live companions:\n- Alice  (id: aaaa)\n- Bob_2  (id: bbbb)'),[{id:'aaaa',name:'Alice'},{id:'bbbb',name:'Bob_2'}]);assert.deepEqual(parseCompanions('No companions are live in the world right now.'),[])})
test('OpenAI and Anthropic payloads preserve ordered tool calls and error receipts',()=>{
  const history:BrainMessage[]=[{role:'user',text:'观察'},{role:'assistant',text:'',calls:[{id:'c1',name:'lua',arguments:{code:'return 1'}}]},{role:'tool',text:'failed',callId:'c1',isError:true}]
  const chat=modelPayload(AI_DEFAULTS,'system',history,tools) as any
  assert.equal(chat.messages[2].tool_calls[0].function.name,'lua');assert.equal(chat.messages[3].tool_call_id,'c1')
  const anthropic=modelPayload({...AI_DEFAULTS,protocol:'anthropic'},'system',history,tools) as any
  assert.equal(anthropic.messages[1].content[0].type,'tool_use');assert.equal(anthropic.messages[2].content[0].is_error,true);assert.equal(anthropic.tools[0].input_schema.type,'object')
})
test('model transport calls compatible API over real HTTP, not renderer network',async()=>{
  const f=await fixture(()=>({choices:[{message:{content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}}))
  try{const client=new AiModelClient({...AI_DEFAULTS,baseUrl:f.base+'/v1',model:'fixture'},'private-api-key');const response=await client.call('test',[{role:'user',text:'ping'}],[],new AbortController().signal);assert.equal(response.text,'OK');assert.equal(response.inputTokens,2);assert.equal(f.requests[0].url,'/v1/chat/completions');assert.equal(f.requests[0].headers.authorization,'Bearer private-api-key');assert.ok(!JSON.stringify(f.requests[0].body).includes('private-api-key'))}finally{await f.close()}
})
test('provider URLs and truncated/incomplete tool output fail clearly',()=>{
  assert.equal(modelEndpoint('https://example.test/v1/','anthropic'),'https://example.test/v1/messages')
  assert.equal(modelEndpoint('https://example.test/v1/chat/completions','openai'),'https://example.test/v1/chat/completions')
  assert.throws(()=>modelEndpoint('http://example.test/v1','openai'))
  assert.throws(()=>parseModelReply({choices:[{finish_reason:'length',message:{content:''}}]},'openai'),/截断/)
  assert.throws(()=>parseModelReply({choices:[{message:{tool_calls:[{id:'x',function:{name:'lua',arguments:'not json'}}]}}]},'openai'),/工具参数/)
})
test('harness hides roster mutations, consumes only its own event queue and strips companion schema',()=>{const scoped=harnessTools(tools);assert.deepEqual(scoped.map(tool=>tool.name),['say','lua']);assert.ok(!('companion' in (scoped[1].inputSchema.properties as any)));assert.ok('companion' in (tools[4].inputSchema.properties as any))})
test('idle harness never calls a paid model for upstream no-new-events receipts',async()=>{
  const body=bodyStub();const host=hostFixture();let calls=0
  const brain=new NumenHarness(body.mcp,{call:async()=>{calls++;return reply('hi')}},'bot-1',{...AI_DEFAULTS},host.host)
  brain.start();await delay(650);assert.equal(calls,0);assert.ok(host.phases.includes('listening'));await brain.stop();assert.equal(host.phases.at(-1),'stopped')
})
test('harness performs real model/tool/receipt loop, forces selected companion and forwards final speech',async()=>{
  const body=bodyStub();const host=hostFixture();let turns=0;const histories:BrainMessage[][]=[]
  const brain=new NumenHarness(body.mcp,{call:async(_s,history)=>{histories.push(structuredClone(history));return ++turns===1?reply('',[{id:'act-1',name:'lua',arguments:{companion:'wrong-bot',code:'return numen.status.self()'}}]):reply('我已经看过周围了。')}},'bot-1',{...AI_DEFAULTS},host.host)
  brain.start();brain.send('看看周围');await until(()=>body.calls.some(call=>call.name==='say'))
  assert.equal(turns,2);assert.equal(body.calls.find(call=>call.name==='lua')?.args.companion,'bot-1');assert.equal(histories[1].at(-1)?.role,'tool');assert.equal(body.calls.find(call=>call.name==='say')?.args.text,'我已经看过周围了。');await brain.stop()
})
test('events wake the same harness and preserve owner messages without duplicate model loops',async()=>{
  const body=bodyStub(['<query>你好</query>']);const host=hostFixture();let calls=0
  const brain=new NumenHarness(body.mcp,{call:async(_s,history)=>{calls++;assert.ok(history.some(m=>m.text.includes('<query>你好</query>')));return reply('你好！')}},'bot-1',{...AI_DEFAULTS},host.host)
  brain.start();await until(()=>body.calls.some(call=>call.name==='say'));await brain.stop();assert.equal(calls,1)
})
test('stopping cancels pending inference and prevents late tool execution',async()=>{
  const body=bodyStub();const host=hostFixture();let aborted=false
  const brain=new NumenHarness(body.mcp,{call:async(_s,_h,_t,signal)=>{await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'))},{once:true}));return reply('',[{id:'late',name:'lua',arguments:{code:'late'}}])}},'bot-1',{...AI_DEFAULTS},host.host)
  brain.start();brain.send('长任务');await until(()=>host.phases.includes('thinking'));await brain.stop();assert.equal(aborted,true);assert.equal(body.calls.filter(call=>call.name==='lua').length,0);assert.throws(()=>brain.send('after stop'),/停止/)
})
test('interrupted tools replay unknown outcomes, never fabricated success receipts',()=>{
  const history:BrainMessage[]=[{role:'user',text:'build'},{role:'assistant',text:'',calls:[{id:'c1',name:'lua',arguments:{}},{id:'c2',name:'lua',arguments:{}}]},{role:'tool',callId:'c1',text:'done'},{role:'user',text:'resume'}]
  const settled=settleHistory(history);assert.equal(settled[2].text,'done');assert.equal(settled[3].callId,'c2');assert.equal(settled[3].isError,true);assert.match(settled[3].text,/outcome is unknown/);assert.equal(settled[4].role,'user');assert.equal(history.length,4)
})
test('tool round limit pauses the harness instead of spending indefinitely',async()=>{
  const body=bodyStub();const host=hostFixture();let calls=0
  const brain=new NumenHarness(body.mcp,{call:async()=>reply('',[{id:'c'+(++calls),name:'lua',arguments:{code:'return 1'}}])},'bot-1',{...AI_DEFAULTS,maxTurns:2},host.host)
  brain.start();brain.send('任务');await until(()=>host.phases.includes('error'));assert.equal(calls,2);assert.ok(host.logs.some(line=>line.includes('轮次上限')));await brain.stop()
})
