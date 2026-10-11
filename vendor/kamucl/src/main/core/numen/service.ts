import { ensureCharacterYsm } from './characterYsm'
import { installYsmAsset } from '../ysm/install'
import { getYsmAsset } from '../ysm/library'
import { CharacterStore } from './characterStore'
import { normalizeCharacter, pngChunks } from './characterCodec'
import { normalizeAppearance, skinBytes, ysmScript, parseYsmOptions } from './appearance'
import type { CharacterYsm, YsmOptions } from '../../../shared/characterCard'

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { app, dialog, ipcMain, nativeImage, type BrowserWindow } from 'electron'
import { centerTarget, assertInstanceIdle } from '../instanceCenter'
import { safePath } from '../backupStore'
import { parseModFile } from '../modinfo'
import type { InstanceTarget } from '../../../shared/instanceCenter'
import { NUMEN_EVENT, type NumenCommand, type NumenSnapshot, type NumenLog } from '../../../shared/numen'
import { aiCredentials, aiSettings, saveAiSettings, redactAiText } from './settings'
import { AiModelClient, type BrainMessage } from './model'
import { NumenMcpClient, resultText, localMcpEndpoint } from './mcp'
import { NumenHarness } from './harness'
let snapshot: NumenSnapshot = emptySnapshot()
let logId = 0
let client: NumenMcpClient | undefined
let harness: NumenHarness | undefined
let credentialToken = ''
let send: (state: NumenSnapshot) => void = () => {}
let tailer: ReturnType<typeof setInterval> | undefined
let logOffset = 0
let logPartial = ''
let reading = false
let mutating = false
let emitTimer: ReturnType<typeof setTimeout> | undefined
function emptySnapshot(): NumenSnapshot { return { installed:false,mcpEnabled:false,quietFallback:false,endpoint:'http://127.0.0.1:8765/mcp',hasToken:false,connected:false,companions:[],tools:[],phase:'disconnected',logs:[],turns:0,inputTokens:0,outputTokens:0 } }
function emit(): void { if(emitTimer)return;emitTimer=setTimeout(()=>{emitTimer=undefined;send(structuredClone(snapshot))},60);emitTimer.unref() }
function secrets(): string[] { let key = ''; try { key = aiCredentials().key } catch {} return [key,credentialToken] }
function log(kind: NumenLog['kind'],text: unknown): void {
  const safe = redactAiText(text,secrets()).slice(0,12000)
  snapshot.logs.push({id:++logId,time:Date.now(),kind,text:safe,companion:snapshot.selectedCompanion})
  if(snapshot.logs.length>600)snapshot.logs.splice(0,snapshot.logs.length-600)
  if(kind==='error') snapshot.error=safe
  emit()
}
let characterLibrary: CharacterStore | undefined
function characters():CharacterStore{return characterLibrary??=(new CharacterStore(path.join(app.getPath('userData'),'character-cards')))}
function characterKey():string {return crypto.createHash('sha256').update(JSON.stringify([snapshot.directory,snapshot.selectedCompanion])).digest('hex')}
function syncCharacter():void {
  const binding=snapshot.selectedCompanion?characters().binding(characterKey()):undefined
  snapshot.characterId=binding?.cardId
  snapshot.characterName=binding?characters().get(binding.cardId).name:undefined
}
function thumbnail(bytes:Buffer):string {
  pngChunks(bytes)
  const image=nativeImage.createFromBuffer(bytes);if(image.isEmpty())throw new Error('PNG 头像无法解码')
  const size=image.getSize(),scale=Math.min(1,512/Math.max(size.width,size.height))
  return image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale)),quality:'best'}).toDataURL()
}
function historyFile(): string {
  const identity=JSON.stringify(snapshot.characterId?[snapshot.directory,snapshot.selectedCompanion,snapshot.characterId]:[snapshot.directory,snapshot.selectedCompanion])
  return path.join(app.getPath('userData'),'numen-sessions',crypto.createHash('sha256').update(identity).digest('hex')+'.json')
}
function saveHistory(history:BrainMessage[]):void {
  const file=historyFile(); fs.mkdirSync(path.dirname(file),{recursive:true})
  const temp=file+'.tmp'; fs.writeFileSync(temp,redactAiText(JSON.stringify(history),secrets()),{mode:0o600});fs.renameSync(temp,file)
}
function loadHistory():BrainMessage[] {
  const file=historyFile();if(!fs.existsSync(file))return []
  if(fs.statSync(file).size>4*1024*1024)throw new Error('历史记录过大，请先清空对话记录')
  const value=JSON.parse(fs.readFileSync(file,'utf8'))
  if(!Array.isArray(value))throw new Error('对话记录格式无效，请先清空记录')
  return value
}
async function inspect(target:InstanceTarget):Promise<NumenSnapshot> {
  const c=centerTarget(target)
  const installed=fs.existsSync(path.join(c.dir,'mods')) && fs.readdirSync(path.join(c.dir,'mods')).filter(name=>name.endsWith('.jar')).some(name=>{try{return parseModFile(path.join(c.dir,'mods',name)).id==='numen'}catch{return false}})
  const file=await safePath(c.dir,'config/numen/mcp_server.json',true)
  let config:any={}
  if(fs.existsSync(file)){
    if(fs.statSync(file).size>128*1024)throw new Error('Numen MCP 配置过大')
    config=JSON.parse(fs.readFileSync(file,'utf8'))
  }
  const host=config.host==='0.0.0.0'||config.host==='::'?'127.0.0.1':config.host||'127.0.0.1'
  const port=config.port??8765
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Numen MCP 端口配置无效')
  const endpoint=localMcpEndpoint('http://'+(host==='::1'?'[::1]':host)+':'+port+'/mcp')
  credentialToken=typeof config.token==='string'?config.token:''
  return {...emptySnapshot(),target:c.target,directory:c.dir,installed,mcpEnabled:config.enabled===true,quietFallback:config.quiet_fallback===true,endpoint,hasToken:!!credentialToken}
}
async function exclusive<T>(fn:()=>Promise<T>):Promise<T>{
  if(mutating)throw new Error('正在处理上一个操作，请稍后再试')
  mutating=true;try{return await fn()}finally{mutating=false}
}
async function stopBrain(stopBody=true):Promise<void>{
  const current=harness;harness=undefined
  if(current)await current.stop()
  if(stopBody&&client&&snapshot.selectedCompanion){
    try {
      const result=await client.call('lua',client.scriptArgs('return numen.task.stop()',snapshot.selectedCompanion),AbortSignal.timeout(12000))
      if(result.isError)throw new Error(resultText(result))
      log('tool','已向游戏确认停止当前任务：'+resultText(result))
    }catch(error){log('error','AI 推理已停止，但无法确认游戏任务已结束：'+String(error))}
  }
  if(snapshot.connected&&snapshot.phase!=='error')snapshot.phase='stopped'
  emit()
}
async function bind(target:InstanceTarget):Promise<NumenSnapshot>{
  const oldToken=credentialToken
  let next:NumenSnapshot
  try{next=await inspect(target)}catch(error){credentialToken=oldToken;throw error}
  const nextToken=credentialToken;credentialToken=oldToken
  await stopBrain(!!harness)
  if(tailer)clearInterval(tailer);tailer=undefined
  client=undefined;snapshot=next;credentialToken=nextToken;log('system','已选择实例，读取 Numen 安装与外接大脑配置。')
  startTail()
  return structuredClone(snapshot)
}
function startTail():void{
  logOffset=0;logPartial=''
  tailer=setInterval(()=>{void tailGameLog()},1500);tailer.unref()
}
async function tailGameLog():Promise<void>{
  if(reading||!snapshot.directory)return;reading=true
  const directory=snapshot.directory
  try{
    const file=await safePath(directory,'logs/latest.log',true)
    if(!fs.existsSync(file))return
    const handle=await fs.promises.open(file,'r')
    try{
      const stat=await handle.stat()
      if(stat.size<logOffset){logOffset=0;logPartial=''}
      const start=logOffset===0?Math.max(0,stat.size-32768):logOffset
      const size=Math.min(65536,stat.size-start)
      if(size<=0)return
      const bytes=Buffer.alloc(size);const read=await handle.read(bytes,0,size,start)
      if(directory!==snapshot.directory)return
      logOffset=start+read.bytesRead
      const lines=(logPartial+bytes.subarray(0,read.bytesRead).toString('utf8')).split(/\r?\n/)
      logPartial=lines.pop()??''
      for(const line of lines)if(/\[numen|numen-mcp|numen-task|numen-entity/i.test(line))log('game',line)
    }finally{await handle.close()}
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){if(tailer)clearInterval(tailer);tailer=undefined;log('error','读取游戏日志失败：'+String(error))}}
  finally{reading=false}
}
async function connect():Promise<NumenSnapshot>{
  if(!snapshot.target)throw new Error('请先选择一个本地实例，云端实例需要先绑定本地客户端')
  if(harness)throw new Error('请先停止陪玩，再重新连接')
  const previous=snapshot
  snapshot={...await inspect(snapshot.target),logs:previous.logs}
  if(!snapshot.installed)throw new Error('当前实例未安装 Numen，请先安装对应版本模组')
  if(!snapshot.mcpEnabled)throw new Error('请在游戏里启用外接大脑，或在游戏关闭时点击配置按钮')
  if(snapshot.quietFallback)throw new Error('请关闭 Numen 的“失联后内置大脑接管”，避免模型长时间思考时内外大脑同时控制')
  const next=new NumenMcpClient(snapshot.endpoint,credentialToken)
  try{
    await next.initialize(); const companions=await next.companions()
    client=next;snapshot.connected=true;snapshot.phase='ready';snapshot.error=undefined;snapshot.companions=companions;snapshot.tools=next.tools.map(tool=>tool.name);snapshot.selectedCompanion=companions[0]?.id;syncCharacter()
    log('system','已连接 Numen MCP · '+companions.length+' 位同伴 · '+next.tools.length+' 个工具')
  }catch(error){snapshot.connected=false;snapshot.phase='error';client=undefined;log('error','连接失败：'+String(error));throw error}
  return structuredClone(snapshot)
}
async function enableMcp():Promise<NumenSnapshot>{
  if(!snapshot.target)throw new Error('请先选择实例')
  const c=centerTarget(snapshot.target);await assertInstanceIdle(c.dir)
  if(!snapshot.installed)throw new Error('请先安装 Numen 模组')
  const file=await safePath(c.dir,'config/numen/mcp_server.json',true)
  const old=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{}
  const token=typeof old.token==='string'&&old.token.length>=16?old.token:'numen-'+crypto.randomBytes(24).toString('hex')
  const next={...old,enabled:true,host:'127.0.0.1',port:old.port??8765,token,call_timeout_seconds:old.call_timeout_seconds??300,hidden_tools:Array.isArray(old.hidden_tools)?old.hidden_tools:[],quiet_fallback:false}
  localMcpEndpoint('http://127.0.0.1:'+next.port+'/mcp')
  fs.mkdirSync(path.dirname(file),{recursive:true})
  await assertInstanceIdle(c.dir)
  if(fs.existsSync(file))fs.copyFileSync(file,file+'.kamucl-backup')
  fs.writeFileSync(file,JSON.stringify(next,null,2),{mode:0o600})
  const target=snapshot.target;await bind(target)
  log('system','已配置本机外接大脑并关闭失联回退；下次启动游戏后生效。')
  return structuredClone(snapshot)
}
function requireClient():NumenMcpClient{if(!client||!snapshot.connected)throw new Error('请先连接游戏里的 Numen');return client}
async function start(companion:string):Promise<NumenSnapshot>{
  const mcp=requireClient()
  if(harness){if(snapshot.phase==='error')await stopBrain();else throw new Error('AI 已运行，请先停止当前陪玩')}
  const roster=await mcp.companions()
  if(!roster.some(item=>item.id===companion||item.name===companion))throw new Error('该同伴当前不在世界里，请刷新同伴列表')
  const {settings,key}=aiCredentials()
  if(!settings.model)throw new Error('请先填写模型名称并保存 AI 配置')
  if(!key&&!settings.baseUrl.startsWith('http://'))throw new Error('请先填写模型 API Key')
  snapshot.companions=roster;snapshot.selectedCompanion=companion;snapshot.error=undefined;syncCharacter()
  const binding=characters().binding(characterKey())
  const character=binding?characters().get(binding.cardId):undefined
  if(character?.appearance?.ysm)await applyCharacterYsm(companion,character.appearance.ysm)
  if(character)log('system','使用角色卡：'+character.name+' · 本地对话按同伴与角色卡隔离')
  const next=new NumenHarness(mcp,new AiModelClient(settings,key),companion,settings,{
    log,phase:phase=>{snapshot.phase=phase;emit()},usage:reply=>{snapshot.turns++;snapshot.inputTokens+=reply.inputTokens;snapshot.outputTokens+=reply.outputTokens;emit()},save:saveHistory
  },loadHistory(),character)
  harness=next;next.start();return structuredClone(snapshot)
}
const requests:Partial<Record<NumenCommand,string>>={follow:'请跟随你的主人。先观察周围找到主人，使用工具提供的跟随能力。',come:'请走到你的主人身边，先观察周围确认位置。','gather-wood':'请采集 16 个原木，保留玩家的建筑与箱子，完成后告诉我。','gather-stone':'请采集 16 个圆石，先确认工具和安全路线，完成后告诉我。',protect:'请在主人身边陪伴，遇到威胁时保护主人，保持安全。'}
async function command(kind:NumenCommand):Promise<NumenSnapshot>{
  if(kind==='stop'){await stopBrain();return structuredClone(snapshot)}
  const mcp=requireClient(),companion=snapshot.selectedCompanion
  if(!companion)throw new Error('请先选择同伴')
  if(requests[kind]){if(!harness||['error','stopped'].includes(snapshot.phase))throw new Error('请先开始陪玩');harness.send(requests[kind]!);return structuredClone(snapshot)}
  if(harness&&['thinking','acting'].includes(snapshot.phase))throw new Error('AI 正在执行任务，请稍后查询，或先点击停止')
  const code=kind==='status'||kind==='inventory'?'return numen.status.self()':kind==='look'?'return numen.scan.entities({radius = 16})':undefined
  if(!code)throw new Error('未知的快捷操作')
  const result=await mcp.call('lua',mcp.scriptArgs(code,companion))
  log(result.isError?'error':'tool',kind+'\n'+resultText(result))
  return structuredClone(snapshot)
}
async function ysmLook(companion:string,look?:CharacterYsm):Promise<YsmOptions>{
  if(harness)throw new Error('请先停止陪玩，再查询或更换 YSM 外观')
  if(!companion||companion!==snapshot.selectedCompanion)throw new Error('所选同伴已变化，请返回控制台确认同伴')
  const mcp=requireClient(),result=await mcp.call('lua',mcp.scriptArgs(ysmScript(look),companion),AbortSignal.timeout(30000))
  const text=resultText(result)
  log(result.isError?'error':'tool',(look?'更换 YSM 外观':'查询 YSM 外观')+'\n'+text)
  if(result.isError)throw new Error(text)
  const options=parseYsmOptions(text)
  if(look&&(options.currentModel!==look.model||(look.texture&&options.currentTexture!==look.texture)))throw new Error('游戏回读的外观与所选外观不一致，请检查游戏日志')
  return options
}
async function applyCharacterYsm(companion:string,look:CharacterYsm):Promise<YsmOptions>{
 if(harness)throw new Error('请先停止陪玩，再更换角色外观')
 if(companion!==snapshot.selectedCompanion)throw new Error('所选同伴已变化，请重新选择')
 const mcp=requireClient()
 if(!snapshot.target||!snapshot.directory)throw new Error('请先绑定此游戏的本地实例目录')
 const context=centerTarget(snapshot.target)
 if(context.dir!==snapshot.directory)throw new Error('实例目录已变化，请重新选择实例后连接游戏')
 // Check identity before touching the target instance. Missing library sources must fail explicitly.
 if(look.assetId&&getYsmAsset(look.assetId).modelId!==look.model)throw new Error('角色卡模型 ID 与独立模型库不一致，请重新选择关联模型')
 return ensureCharacterYsm(look,{
  install:id=>installYsmAsset(context.dir,id),query:()=>ysmLook(companion),apply:next=>ysmLook(companion,next),log:message=>log('system',message),
  reload:async()=>{
   const result=await mcp.call('lua',mcp.scriptArgs('numen.mc.run("ysm model reload")\nprint("NCYSM_RELOAD_OK")',companion),AbortSignal.timeout(30000))
   const text=resultText(result);log(result.isError?'error':'tool','重载 YSM 模型\n'+text)
   if(result.isError||!text.includes('NCYSM_RELOAD_OK'))throw new Error(text||'未收到重载成功回执')
  }
 })
}
export function registerNumenIpc(getWin:()=>BrowserWindow|null):void{
  send=state=>getWin()?.webContents.send(NUMEN_EVENT,state)
  const handle=(channel:string,action:(...args:any[])=>unknown)=>ipcMain.handle(channel,async(event,...args)=>{
    const win=getWin();if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('只允许启动器主窗口操作 AI 陪玩')
    try{return await action(...args)}catch(error){throw new Error(redactAiText(error instanceof Error?error.message:error,secrets()))}
  })
  handle('numen:cards',()=>characters().list())
  handle('numen:cardGet',id=>characters().get(id))
  handle('numen:cardSave',input=>{if(harness&&input.id===snapshot.characterId)throw new Error('请先停止陪玩再修改当前角色卡');const card=characters().save(input);syncCharacter();emit();return card})
  handle('numen:cardDuplicate',id=>characters().duplicate(id))
  handle('numen:cardDelete',id=>{if(harness&&id===snapshot.characterId)throw new Error('请先停止陪玩再删除当前角色卡');characters().delete(id);syncCharacter();emit();return characters().list()})
  handle('numen:cardAvatar',async()=>{const picked=await dialog.showOpenDialog(getWin()!,{title:'选择角色头像',properties:['openFile'],filters:[{name:'PNG 图片',extensions:['png']}]});if(picked.canceled||!picked.filePaths[0])return null;const file=picked.filePaths[0];if(fs.statSync(file).size>16*1024*1024)throw new Error('头像图片最大 16 MiB');return thumbnail(fs.readFileSync(file))})
  handle('numen:cardSkin',async()=>{
    const picked=await dialog.showOpenDialog(getWin()!,{title:'选择角色皮肤',properties:['openFile'],filters:[{name:'Minecraft 皮肤 PNG',extensions:['png']}]})
    if(picked.canceled||!picked.filePaths[0])return null
    const file=picked.filePaths[0];if(fs.statSync(file).size>1024*1024)throw new Error('皮肤图片最大 1 MiB')
    const png='data:image/png;base64,'+fs.readFileSync(file).toString('base64');skinBytes(png)
    if(nativeImage.createFromBuffer(skinBytes(png)).isEmpty())throw new Error('皮肤 PNG 无法解码')
    return png
  })
  handle('numen:cardSkinExport',async(id)=>{
    const card=characters().get(id);if(!card.appearance?.skin)throw new Error('此角色还没有皮肤')
    const picked=await dialog.showSaveDialog(getWin()!,{title:'导出角色皮肤',defaultPath:'character-skin.png',filters:[{name:'PNG 图片',extensions:['png']}]})
    if(picked.canceled||!picked.filePath)return null
    fs.writeFileSync(picked.filePath,skinBytes(card.appearance.skin.png));return picked.filePath
  })
  handle('numen:ysmOptions',companion=>exclusive(()=>ysmLook(companion)))
  handle('numen:cardYsmApply',(id,companion)=>exclusive(()=>{
    const look=characters().get(id).appearance?.ysm;if(!look)throw new Error('请先在角色卡中保存 YSM 外观')
    return applyCharacterYsm(companion,look)
  }))
  handle('numen:cardImport',async()=>{
    const picked=await dialog.showOpenDialog(getWin()!,{title:'导入人设',properties:['openFile'],filters:[{name:'人设 Markdown / JSON',extensions:['md','txt','json']}]})
    if(picked.canceled||!picked.filePaths[0])return null
    const file=picked.filePaths[0];if(fs.statSync(file).size>5*1024*1024)throw new Error('角色文件最大 5 MiB')
    const content=fs.readFileSync(file,'utf8').replace(/^﻿/,'');const extension=path.extname(file).toLowerCase()
    if(extension==='.md'||extension==='.txt')return characters().import(normalizeCharacter({name:path.basename(file,extension),text:content}))
    const value=JSON.parse(content);const document=normalizeCharacter(value)
    return characters().import({...document,avatar:typeof value.avatar==='string'?value.avatar:undefined,appearance:normalizeAppearance(value.appearance)})
  })
  handle('numen:cardExport',async(id,format)=>{
    if(!['md','json'].includes(format))throw new Error('请选择 Markdown 或 JSON 格式')
    const card=characters().get(id),name=card.name.replace(/[/:*?"<>|\x00-\x1f]/g,'_').replaceAll(String.fromCharCode(92),'_').slice(0,80)||'character'
    const picked=await dialog.showSaveDialog(getWin()!,{title:'导出人设',defaultPath:name+'.'+format,filters:[{name:format==='md'?'Markdown':'JSON',extensions:[format]}]})
    if(picked.canceled||!picked.filePath)return null
    const content=format==='md'?card.text:JSON.stringify({name:card.name,text:card.text,...(card.avatar?{avatar:card.avatar}:{}),...(card.appearance?{appearance:card.appearance}:{})},null,2)
    fs.writeFileSync(picked.filePath,content,'utf8');return picked.filePath
  })
  handle('numen:cardBind',input=>exclusive(async()=>{if(harness)throw new Error('请先停止当前陪玩再切换角色');if(!snapshot.selectedCompanion)throw new Error('请先选择游戏里的同伴');if(input){const card=characters().get(input.cardId);if(card.appearance?.ysm)await applyCharacterYsm(snapshot.selectedCompanion,card.appearance.ysm)}characters().bind(characterKey(),input??undefined);syncCharacter();emit();return structuredClone(snapshot)}))
  handle('numen:settings',()=>aiSettings())
  handle('numen:saveSettings',input=>{if(harness)throw new Error('请先停止 AI 再修改模型配置');return saveAiSettings(input)})
  handle('numen:testModel',async()=>{const {settings,key}=aiCredentials();if(!settings.model)throw new Error('请先保存模型名称');const reply=await new AiModelClient(settings,key).call('Reply briefly.',[{role:'user',text:'连接测试，请回复 OK。'}],[],AbortSignal.timeout(30000));log('system','模型连接测试成功：'+reply.text.slice(0,200));return true})
  handle('numen:snapshot',()=>structuredClone(snapshot))
  handle('numen:bind',target=>exclusive(()=>bind(target)))
  handle('numen:enableMcp',()=>exclusive(enableMcp))
  handle('numen:connect',()=>exclusive(connect))
  handle('numen:refresh',()=>exclusive(async()=>{snapshot.companions=await requireClient().companions();if(!harness&&!snapshot.companions.some(c=>c.id===snapshot.selectedCompanion))snapshot.selectedCompanion=snapshot.companions[0]?.id;syncCharacter();emit();return structuredClone(snapshot)}))
  handle('numen:select',companion=>exclusive(async()=>{if(harness)throw new Error('请先停止当前同伴');if(!snapshot.companions.some(c=>c.id===companion))throw new Error('同伴不存在');snapshot.selectedCompanion=companion;syncCharacter();emit();return structuredClone(snapshot)}))
  handle('numen:create',name=>exclusive(async()=>{if(typeof name!=='string'||!/^\w{3,16}$/.test(name)||/[^a-zA-Z0-9_]/.test(name))throw new Error('同伴名字须为 3–16 位英文字母、数字或下划线');const result=await requireClient().call('create_companion',{name});if(result.isError)throw new Error(resultText(result));log('tool',resultText(result));return structuredClone(snapshot)}))
  handle('numen:start',companion=>exclusive(()=>start(companion)))
  handle('numen:stop',()=>exclusive(async()=>{await stopBrain();return structuredClone(snapshot)}))
  handle('numen:send',text=>{if(!harness||['error','stopped'].includes(snapshot.phase))throw new Error('请先开始陪玩');if(typeof text!=='string'||!text.trim()||text.length>16000)throw new Error('请输入 1–16000 字的任务或消息');harness.send(text.trim());return structuredClone(snapshot)})
  handle('numen:command',kind=>exclusive(()=>command(kind)))
  handle('numen:clearLogs',()=>{snapshot.logs=[];emit();return structuredClone(snapshot)})
  handle('numen:clearHistory',()=>{if(harness)throw new Error('请先停止 AI 再清空记录');if(snapshot.selectedCompanion)fs.rmSync(historyFile(),{force:true});log('system','已清空当前同伴的本地对话记录');return structuredClone(snapshot)})
  handle('numen:exportLogs',async()=>{const result=await dialog.showSaveDialog({title:'导出 AI 陪玩日志',defaultPath:'numen-logs.txt',filters:[{name:'文本文件',extensions:['txt']}]});if(result.canceled||!result.filePath)return null;fs.writeFileSync(result.filePath,snapshot.logs.map(l=>new Date(l.time).toISOString()+' ['+l.kind+'] '+l.text).join('\n'),'utf8');return result.filePath})
  app.on('before-quit',()=>{if(emitTimer)clearTimeout(emitTimer);if(tailer)clearInterval(tailer);void stopBrain().catch(()=>{})})
}
