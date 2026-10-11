import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import type { CharacterCard } from '../src/shared/characterCard'
import { AI_DEFAULTS } from '../src/shared/numen'
import { normalizeCharacter, pngChunks } from '../src/main/core/numen/characterCodec'
import { skinBytes, normalizeAppearance, luaString, ysmScript, parseYsmOptions } from '../src/main/core/numen/appearance'
import { CharacterStore } from '../src/main/core/numen/characterStore'
import { personaSection } from '../src/main/core/numen/characterPrompt'
import { NumenHarness, composeHarnessPrompt } from '../src/main/core/numen/harness'
import type { NumenMcpClient } from '../src/main/core/numen/mcp'
import type { BrainMessage, ModelReply } from '../src/main/core/numen/model'
import { setTimeout as delay } from 'node:timers/promises'
const card=():CharacterCard=>({id:'12345678-1234-1234-1234-123456789abc',name:'小诺',text:'# 身份\n你是小诺。\n\n# 陪伴方式\n自由正文，不自动拆分。',createdAt:1,updatedAt:1})
function chunk(type:string,data:Buffer){const size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type),data])));return Buffer.concat([size,Buffer.from(type),data,crc])}
function tinyPng(){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,100,120,200,255]))),chunk('IEND',Buffer.alloc(0))])}
function temporary(t:test.TestContext){const root=fs.mkdtempSync(path.join(os.tmpdir(),'kamucl-persona-'));t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('kamucl-persona-'));fs.rmSync(root,{recursive:true,force:true})});return root}
test('roles contain only name and exact free-form text; legacy extras are not saved',()=>{
  const text='  # Identity\n你是谁都由这里决定。\n{{char}} stays literal.  '
  assert.deepEqual(normalizeCharacter({name:' 小诺 ',text,description:'ignored',first_mes:'ignored',character_book:{},post_history_instructions:'ignored'}),{name:'小诺',text})
  for(const value of [{},{name:'x'},{name:'x',text:3},{name:' ',text:'x'},{name:'x',text:'a'.repeat(100001)}])assert.throws(()=>normalizeCharacter(value))
})
test('avatar validation rejects corrupt and truncated PNG files',()=>{assert.ok(pngChunks(tinyPng()).length===3);const broken=Buffer.from(tinyPng());broken[30]^=255;assert.throws(()=>pngChunks(broken),/校验/);assert.throws(()=>pngChunks(tinyPng().subarray(0,-3)))})
test('plain role storage persists avatar and raw text, copies and scopes companion bindings',t=>{
  const root=temporary(t),library=new CharacterStore(root),first=library.save({name:card().name,text:card().text,avatar:'data:image/png;base64,'+tinyPng().toString('base64')}),second=library.duplicate(first.id)
  assert.notEqual(second.id,first.id);assert.equal(second.name,'小诺 副本');assert.equal(second.text,first.text)
  library.bind('a'.repeat(64),{cardId:first.id});library.bind('b'.repeat(64),{cardId:second.id})
  const reload=new CharacterStore(root);assert.equal(reload.get(first.id).avatar,first.avatar);assert.equal(reload.binding('a'.repeat(64))?.cardId,first.id)
  reload.delete(first.id);assert.equal(reload.binding('a'.repeat(64)),undefined);assert.equal(reload.binding('b'.repeat(64))?.cardId,second.id);assert.equal(reload.list().length,1)
  assert.throws(()=>reload.get('../escape'));assert.throws(()=>reload.bind('__proto__',{cardId:second.id}))
  const raw=JSON.parse(fs.readFileSync(path.join(root,second.id+'.json'),'utf8'));assert.deepEqual(Object.keys(raw).sort(),['avatar','createdAt','id','name','text','updatedAt'])
})
test('previous development cards keep existing text but no greeting/lore/post instructions execute',t=>{
  const root=temporary(t),id=card().id
  const raw={id,createdAt:1,updatedAt:2,document:{data:{name:'之前的卡',description:'原描述',personality:'NOT_INCLUDED',first_mes:'NOT_INCLUDED',character_book:{entries:[{content:'NOT_INCLUDED'}]},post_history_instructions:'NOT_INCLUDED',extensions:{'nomadcraft/harness':{version:1,persona:'原自由正文'}}}}}
  const file=path.join(root,id+'.json');fs.writeFileSync(file,JSON.stringify(raw))
  const library=new CharacterStore(root);const existing=library.get(id);assert.equal(existing.text,'原自由正文');assert.equal(existing.name,'之前的卡');assert.equal(JSON.stringify(existing).includes('NOT_INCLUDED'),false)
  library.save({...existing,text:'新正文'});const saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(saved.text,'新正文');assert.equal('document' in saved,false)
})
test('persona follows bound -> global -> built-in fallback with no macro expansion or extra role fields',()=>{
  const text='  ## Anything\n{{user}} and {{char}} are literal text.  '
  assert.equal(personaSection(text,'GLOBAL'),'<persona>\n'+text+'\n</persona>')
  assert.equal(personaSection('', 'GLOBAL'),'<persona>\nGLOBAL\n</persona>');assert.ok(personaSection(' ',' ').includes('easygoing companion'))
  const prompt=composeHarnessPrompt(personaSection(text,'GLOBAL'),'REAL_MCP','bot')
  assert.ok(prompt.startsWith('<persona>'));assert.ok(prompt.includes('REAL_MCP'));assert.ok(prompt.indexOf('REAL_MCP')>prompt.indexOf('</persona>'))
})
test('harness sends exact persona first, no opening speech or injected post-history message',async()=>{
  const c=card(),calls:Array<{name:string;args:any}>=[],history:BrainMessage[][]=[],saved:BrainMessage[][]=[]
  const mcp={instructions:'game rules',tools:[{name:'say',inputSchema:{type:'object',properties:{text:{type:'string'}}}}],async call(name:string,args:any){calls.push({name,args});return{content:[{type:'text',text:name==='get_events'?'(no new events — keep polling; owner words arrive here)':'said'}]}}} as unknown as NumenMcpClient
  let seen=false
  const brain=new NumenHarness(mcp,{call:async(system,messages)=>{assert.ok(system.startsWith('<persona>\n'+c.text+'\n</persona>'));assert.equal(messages.at(-1)?.role,'user');assert.equal(messages.at(-1)?.text,'Hi');history.push(structuredClone(messages));seen=true;return{text:'收到',calls:[],inputTokens:1,outputTokens:1} as ModelReply}},'bot',AI_DEFAULTS,{log:()=>{},phase:()=>{},usage:()=>{},save:h=>saved.push(structuredClone(h))},[],c)
  brain.start();await delay(30);assert.equal(calls.filter(call=>call.name==='say').length,0);assert.equal(history.length,0)
  brain.send('Hi');for(let count=0;count<100&&!seen;count++)await delay(10);assert.equal(seen,true);await brain.stop();assert.equal(calls.filter(call=>call.name==='say').length,1);assert.ok(saved.at(-1)?.some(message=>message.text==='Hi'))
})
test('editor compiles and exposes only a name and free-form prompt without legacy tabs or preview',()=>{
  for(const file of ['src/renderer/src/components/CharacterCards.vue','src/renderer/src/views/AiCompanionView.vue']){
    const source=fs.readFileSync(file,'utf8');const{descriptor,errors}=parse(source);assert.deepEqual(errors,[]);const script=compileScript(descriptor,{id:'persona-test'});assert.deepEqual(compileTemplate({source:descriptor.template!.content,filename:file,id:'persona-test',compilerOptions:{bindingMetadata:script.bindings}}).errors,[])
  }
  const source=fs.readFileSync('src/renderer/src/components/CharacterCards.vue','utf8');assert.match(source,/人设正文/)
  for(const label of ['角色描述与背景','场景设定','开场白','世界书','提示词预览','editor-tabs'])assert.equal(source.includes(label),false)
  assert.equal(fs.readFileSync('src/renderer/src/numenApi.ts','utf8').includes('cardPreview'),false)
})

function skinPng(width=64,height=64){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.alloc((width*4+1)*height))),chunk('IEND',Buffer.alloc(0))])}
test('role appearance survives reload, duplication and JSON import without entering the persona',t=>{
  const library=new CharacterStore(temporary(t)),appearance={skin:{png:'data:image/png;base64,'+skinPng().toString('base64'),variant:'slim' as const},ysm:{model:'抽象鸣潮 菲比.ysm',texture:'白色'}}
  const saved=library.save({...card(),id:undefined,appearance}),copy=library.duplicate(saved.id)
  assert.deepEqual(library.get(saved.id).appearance,appearance);assert.deepEqual(copy.appearance,appearance)
  assert.deepEqual(library.list().find(c=>c.id===saved.id)?.appearance,appearance)
  const imported=library.import(JSON.parse(JSON.stringify({name:saved.name,text:saved.text,appearance})))
  assert.deepEqual(imported.appearance,appearance);assert.equal(personaSection(imported.text,''),personaSection(card().text,''))
  assert.deepEqual(library.save({id:saved.id,name:saved.name,text:'updated'}).appearance,appearance)
  assert.equal(library.save({id:saved.id,name:saved.name,text:'updated',appearance:null}).appearance,undefined)
})
test('skin validation accepts standard/legacy dimensions and refuses arbitrary avatars and invalid variants',()=>{
  const png=(w:number,h:number)=>'data:image/png;base64,'+skinPng(w,h).toString('base64')
  assert.ok(skinBytes(png(64,64)).length);assert.ok(skinBytes(png(64,32)).length)
  assert.throws(()=>skinBytes(png(32,32)),/尺寸/);assert.throws(()=>skinBytes('https://remote/skin.png'))
  assert.throws(()=>normalizeAppearance({skin:{png:png(64,64),variant:'bad'}}),/手臂/)
  assert.throws(()=>normalizeAppearance({ysm:{model:'a\ncommand'}}));assert.throws(()=>normalizeAppearance({ysm:{model:'a',texture:'\0'}}))
})
test('YSM commands safely encode UTF-8 model IDs and parse complete game receipts without accepting truncation',()=>{
  const model='菲比 "\\ ]=] .ysm',texture='白色'
  const quoted=luaString(model);assert.match(quoted,/^"(?:\\\d{3})+"$/)
  assert.equal(Buffer.from([...quoted.matchAll(/\\(\d{3})/g)].map(m=>Number(m[1]))).toString('utf8'),model)
  assert.ok(ysmScript({model,texture}).includes('ysm.model.switch('+quoted+', {texture = '+luaString(texture)+'})'))
  assert.ok(ysmScript().includes('o.current_model'));assert.equal(ysmScript().includes('ysm.model.switch'),false)
  const hex=(s:string)=>Buffer.from(s).toString('hex'),line=(k:string,v:string)=>'NCYSM|'+k+'|'+hex(v)+'|'
  const receipt=['ok · 1 call',line('C',model),line('S',texture),line('M',model),line('T',texture),'NCYSM_END|1|1|'].join('\n')
  assert.deepEqual(parseYsmOptions(receipt),{currentModel:model,currentTexture:texture,models:[model],textures:[texture]})
  assert.throws(()=>parseYsmOptions(receipt.replace('NCYSM_END|1|1|','NCYSM_END|2|1|')),/完整/)
  assert.throws(()=>parseYsmOptions(receipt.slice(0,receipt.indexOf('NCYSM_END'))),/完整/)
})
