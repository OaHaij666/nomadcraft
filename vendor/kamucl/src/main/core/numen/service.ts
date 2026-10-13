import { activeLocalCompanions } from './companionRoster'
import { syncApprovedModels } from '../cloudModels'
import { getSettings } from '../settings'
import { cloudClient } from '../nomadCloud'
import type { BotView } from '../../../../../mcsmanager/shared/nomad-bots'
import { ensureCharacterYsm } from './characterYsm'
import { installYsmAsset } from '../ysm/install'
import { getYsmAsset, ysmInstallFiles, importYsmAsset } from '../ysm/library'
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
function localEnableFile():string{return path.join(app.getPath('userData'),'numen-instance-settings.json')}
function localEnabled():boolean {try{return JSON.parse(fs.readFileSync(localEnableFile(),'utf8'))[JSON.stringify(snapshot.target)]===true}catch{return false}}
async function instanceEnabled():Promise<boolean>{if(!snapshot.target)return false;if(cloudBotScope){const data=await cloudClient().json('api/nomad/bots/settings?instanceId='+encodeURIComponent(cloudBotScope.instanceId));return data.enabled===true}return localEnabled()}
let logId = 0
let client: NumenMcpClient | undefined
let harness: NumenHarness | undefined
const brains=new Map<string,NumenHarness>()
const brainKeys=new Map<string,string>()
let cloudBotScope: {instanceId:string;saveId:string;serviceId:string} | undefined
let cloudBotPoll: ReturnType<typeof setInterval> | undefined
let cloudBotPolling = false
let credentialToken = ''
let send: (state: NumenSnapshot) => void = () => {}
let tailer: ReturnType<typeof setInterval> | undefined
let logOffset = 0
let logPartial = ''
let reading = false
let mutating = false
let emitTimer: ReturnType<typeof setTimeout> | undefined
function dormantFile():string{return path.join(app.getPath('userData'),'numen-dormant-companions.json')}
function savedDormant():Record<string,Array<{id:string;name:string}>> {try{return JSON.parse(fs.readFileSync(dormantFile(),'utf8'))}catch{return {}}}
function dormantKey():string{return JSON.stringify(snapshot.target)}
function refreshDormant():void{snapshot.dormantCompanions=savedDormant()[dormantKey()]??[]}
async function localBodyAction(action:string,companion:string):Promise<NumenSnapshot>{
 if(cloudBotScope)throw new Error('云端机器人请使用准入与资源中的加入和退出按钮');
 if(!snapshot.target||!['join','leave'].includes(action))throw new Error('请选择实例与机器人');
 const roster=action==='leave'?visibleCompanions(await requireClient().companions()):snapshot.dormantCompanions??[];const bot=roster.find(b=>b.id===companion);if(!bot)throw new Error('请从机器人列表选择目标');
 if(action==='leave'){const brain=brains.get(companion);if(brain)await brain.stop();brains.delete(companion);brainKeys.delete(companion);if(snapshot.selectedCompanion===companion)harness=undefined;}
 const file=await safePath(snapshot.directory!,'.nomad-numen-adapter.json',true);if(!fs.existsSync(file)||fs.statSync(file).size>4096)throw new Error('退出与恢复本地机器人需要安装 Numen 适配 MOD，重启游戏后生效；不会执行永久删除命令');
 const discovery=JSON.parse(fs.readFileSync(file,'utf8'));if(discovery.protocol!==1||!Number.isInteger(discovery.port)||discovery.port<1||discovery.port>65535||!/^[0-9a-f]{64}$/.test(discovery.token))throw new Error('Numen 适配发现文件无效');
 const response=await fetch('http://127.0.0.1:'+discovery.port+'/nomad/bots',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Nomad-Token':discovery.token},body:JSON.stringify({action,args:{name:bot.name,scope:'private',companion:bot.id},requestId:crypto.randomUUID()}),signal:AbortSignal.timeout(30000)});const result=await response.json();if(!response.ok||!result.ok)throw new Error('本地机器人操作失败，请查看游戏日志');
 const saved=savedDormant(),key=dormantKey();saved[key]=(saved[key]??[]).filter(b=>b.id!==companion);if(action==='leave')saved[key].push(bot);const temporary=dormantFile()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(saved),{mode:0o600});fs.renameSync(temporary,dormantFile());refreshDormant();snapshot.companions=visibleCompanions(await requireClient().companions());snapshot.selectedCompanion=snapshot.companions[0]?.id;harness=snapshot.selectedCompanion?brains.get(snapshot.selectedCompanion):undefined;snapshot.phase=snapshot.selectedCompanion?snapshot.companionPhases?.[snapshot.selectedCompanion]??'ready':'ready';syncCharacter();log('system',action==='leave'?'机器人已退出，背包与存档保留。':'机器人已恢复加入，沿用原来的玩家数据。',companion);return structuredClone(snapshot);
}
function visibleCompanions(roster: NumenSnapshot['companions']): NumenSnapshot['companions'] { return cloudBotScope ? roster : activeLocalCompanions(roster, snapshot.dormantCompanions ?? []) }
function emptySnapshot(): NumenSnapshot { return { installed:false,mcpEnabled:false,quietFallback:false,endpoint:'http://127.0.0.1:8765/mcp',hasToken:false,connected:false,companions:[],tools:[],phase:'disconnected',logs:[],turns:0,inputTokens:0,outputTokens:0 } }
function emit(): void { if(emitTimer)return;emitTimer=setTimeout(()=>{emitTimer=undefined;send(structuredClone(snapshot))},60);emitTimer.unref() }
function secrets(): string[] { let key = ''; try { key = aiCredentials().key } catch {} return [key,credentialToken,...brainKeys.values()] }
function log(kind: NumenLog['kind'],text: unknown,companion=snapshot.selectedCompanion): void {
  const safe = redactAiText(text,secrets()).slice(0,12000)
  snapshot.logs.push({id:++logId,time:Date.now(),kind,text:safe,companion})
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
async function stopBrain(stopBody=false):Promise<void>{
  const current=harness;harness=undefined
  if(current)await current.stop()
  if(snapshot.selectedCompanion){brains.delete(snapshot.selectedCompanion);brainKeys.delete(snapshot.selectedCompanion)}
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
  await Promise.allSettled([...brains.values()].map(brain=>brain.stop()));brains.clear();brainKeys.clear();harness=undefined
  cloudBotScope=undefined;if(cloudBotPoll)clearInterval(cloudBotPoll);cloudBotPoll=undefined
  if(tailer)clearInterval(tailer);tailer=undefined
  client=undefined;snapshot=next;credentialToken=nextToken;log('system','已选择实例，读取 Numen 安装与外接大脑配置。')
  startTail()
  for(const [key,value] of Object.entries(getSettings().cloudInstanceBindings??{})) {
    if(value.localFolder!==target.folder||value.localVersionId!==target.id)continue
    try{const [serviceId,instanceId,saveId]=JSON.parse(key);if(saveId==='instance')throw new Error('请选择云端存档，而不是实例环境');const c=cloudClient();if(c.serviceId!==serviceId)throw new Error('请登录该实例所属的云端');cloudBotScope={serviceId,instanceId,saveId};cloudBotPoll=setInterval(()=>{void pollBotCommands()},2000);cloudBotPoll.unref()}catch(error){snapshot.phase='error';snapshot.error=String(error);emit();throw error}
    break
  }
  snapshot.enabled=await instanceEnabled();refreshDormant();return structuredClone(snapshot)
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
  if(brains.size)throw new Error('请先停止所有同伴的思考，再重新连接')
  const previous=snapshot
  snapshot={...await inspect(snapshot.target),logs:previous.logs}
  snapshot.enabled=await instanceEnabled();refreshDormant();
  if(!snapshot.installed)throw new Error('当前实例未安装 Numen，请先安装对应版本模组')
  if(!snapshot.mcpEnabled)throw new Error('请在游戏里启用外接大脑，或在游戏关闭时点击配置按钮')
  if(snapshot.quietFallback)throw new Error('请关闭 Numen 的“失联后内置大脑接管”，避免模型长时间思考时内外大脑同时控制')
  const next=new NumenMcpClient(snapshot.endpoint,credentialToken)
  try{
    await next.initialize(); const companions=visibleCompanions(await next.companions())
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
  if(!await instanceEnabled())throw new Error('请先启用此实例的 AI 陪玩');
  const mcp=requireClient()
  if(harness){if(snapshot.phase==='error')await stopBrain();else throw new Error('AI 已运行，请先停止当前陪玩')}
  const roster=visibleCompanions(await mcp.companions())
  if(!roster.some(item=>item.id===companion||item.name===companion))throw new Error('该同伴当前不在世界里，请刷新同伴列表')
  if(cloudBotScope&&!((await botList()).some(b=>b.companionId===companion&&b.canManage&&b.admission==='approved')))throw new Error('此私有机器人尚未通过云端接入审核或不属于当前账号')
  const {settings,key}=aiCredentials()
  if(!settings.model)throw new Error('请先填写模型名称并保存 AI 配置')
  if(!key&&!settings.baseUrl.startsWith('http://'))throw new Error('请先填写模型 API Key')
  snapshot.companions=roster;snapshot.selectedCompanion=companion;snapshot.error=undefined;syncCharacter()
  const binding=characters().binding(characterKey())
  const character=binding?characters().get(binding.cardId):undefined
  if(character?.appearance?.ysm)await applyCharacterYsm(companion,character.appearance.ysm)
  if(character)log('system','使用角色卡：'+character.name+' · 本地对话按同伴与角色卡隔离')
  const history=loadHistory(),file=historyFile();brainKeys.set(companion,key)
  const next=new NumenHarness(mcp,new AiModelClient(settings,key),companion,settings,{
    log:(kind,text)=>log(kind,text,companion),
    phase:phase=>{snapshot.companionPhases??={};snapshot.companionPhases[companion]=phase;if(snapshot.selectedCompanion===companion)snapshot.phase=phase;emit()},
    usage:reply=>{snapshot.turns++;snapshot.inputTokens+=reply.inputTokens;snapshot.outputTokens+=reply.outputTokens;emit()},
    save:history=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,redactAiText(JSON.stringify(history),secrets()),{mode:0o600});fs.renameSync(temp,file)}
  },history,character)
  brains.set(companion,next);harness=next;next.start();return structuredClone(snapshot)

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
  install:async id=>{if(cloudBotScope){await syncApprovedModels(cloudClient(),cloudBotScope,context.dir);const apps=await cloudClient().json('api/nomad/bots/models?instanceId='+encodeURIComponent(cloudBotScope.instanceId)+'&saveId='+encodeURIComponent(cloudBotScope.saveId));const pack=ysmInstallFiles(id);const required=Object.entries(pack.files).map(([name,bytes])=>({path:'config/yes_steve_model/custom/'+name,hash:crypto.createHash('sha256').update(bytes).digest('hex')}));if(required.some(f=>!apps.some((a:any)=>a.status==='approved'&&a.manifest.files.some((p:any)=>p.path===f.path&&p.sha256===f.hash))))throw new Error('角色模型尚未经过云端上传审核，请先申请上传并等待批准')}return installYsmAsset(context.dir,id)},query:()=>ysmLook(companion),apply:next=>ysmLook(companion,next),log:message=>log('system',message),
  reload:async()=>{
   const result=await mcp.call('lua',mcp.scriptArgs('numen.mc.run("ysm model reload")\nprint("NCYSM_RELOAD_OK")',companion),AbortSignal.timeout(30000))
   const text=resultText(result);log(result.isError?'error':'tool','重载 YSM 模型\n'+text)
   if(result.isError||!text.includes('NCYSM_RELOAD_OK'))throw new Error(text||'未收到重载成功回执')
  }
 })
}
function requireCloudBinding(serviceId:string,ref:{instanceId:string;saveId:string}):InstanceTarget {
  const binding=getSettings().cloudInstanceBindings?.[JSON.stringify([serviceId,ref.instanceId,ref.saveId])]
  if(!binding?.localVersionId||!binding.localFolder)throw new Error('请先自动准备此云端存档的本地客户端')
  return {id:binding.localVersionId,folder:binding.localFolder}
}
async function botList():Promise<BotView[]> {
  if(!cloudBotScope) return []
  const c=cloudClient(); if(c.serviceId!==cloudBotScope.serviceId)throw new Error('云端服务已切换，请重新绑定机器人控制台')
  return c.json('api/nomad/bots/?instanceId='+encodeURIComponent(cloudBotScope.instanceId)+'&saveId='+encodeURIComponent(cloudBotScope.saveId))
}
async function pollBotCommands():Promise<void> {
  if(cloudBotPolling||mutating||!cloudBotScope||!client||!snapshot.connected)return
  cloudBotPolling=true
  const scope=cloudBotScope,c=cloudClient()
  try {
    if(c.serviceId!==scope.serviceId)return
    if(!await instanceEnabled()){await Promise.allSettled([...brains.values()].map(brain=>brain.stop()));snapshot.enabled=false;emit();return}
    const bots=await botList()
    for(const [id,brain] of brains){if(!bots.some(b=>b.companionId===id&&b.canManage&&b.admission==='approved')){await brain.stop();brains.delete(id);brainKeys.delete(id);if(snapshot.selectedCompanion===id)harness=undefined;}}
    for(const bot of bots.filter(b=>b.scope==='private'&&b.canManage&&snapshot.companions.some(c=>c.id===b.companionId))) {
      if(scope!==cloudBotScope||mutating)break
      await exclusive(async()=>{
        const command=await c.json('api/nomad/bots/'+encodeURIComponent(bot.id)+'/claim',{method:'POST',body:'{}'})
        if(!command||command.empty)return
        let ok=false
        try {
          if(scope!==cloudBotScope||!snapshot.companions.some(c=>c.id===command.companionId))throw new Error('控制台实例或机器人已变化')
          if(command.action==='message') {
            const brain=brains.get(command.companionId);if(!brain||['error','stopped'].includes(snapshot.companionPhases?.[command.companionId]??''))throw new Error('所有者尚未启动此机器人的思考')
            brain.send('['+command.userName+' / '+command.userId+'] '+command.text)
            // Receipt confirms delivery to the harness, not completion of its game task.
            log('system','已接收授权成员 '+command.userName+' 的指令')
          } else if(command.action==='stop-thinking') {const brain=brains.get(command.companionId);if(brain)await brain.stop();brains.delete(command.companionId);brainKeys.delete(command.companionId);if(snapshot.selectedCompanion===command.companionId)harness=undefined;log('system','授权成员 '+command.userName+' 请求停止思考')}
          else if(command.action==='delete') {
            const confirmation=await dialog.showMessageBox({type:'warning',buttons:['取消','永久删除'],defaultId:0,cancelId:0,title:'永久删除机器人',message:'此机器人将永远消散，无法恢复。',detail:'背包、装备和配饰会掉落。确认删除 '+bot.name+'？',noLink:true})
            if(confirmation.response!==1)throw new Error('所有者取消删除')
            const brain=brains.get(command.companionId);if(brain)await brain.stop();brains.delete(command.companionId);brainKeys.delete(command.companionId);if(snapshot.selectedCompanion===command.companionId)harness=undefined
            const result=await requireClient().call('delete_companion',{companion:bot.companionId})
            if(result.isError)throw new Error(resultText(result))
            snapshot.companions=visibleCompanions(await requireClient().companions());snapshot.selectedCompanion=snapshot.companions[0]?.id;harness=snapshot.selectedCompanion?brains.get(snapshot.selectedCompanion):undefined;syncCharacter();emit()
          }
          ok=true
        }catch(error){log('error',error instanceof Error?error.message:String(error))}
        await c.json('api/nomad/bots/'+encodeURIComponent(bot.id)+'/commands/'+encodeURIComponent(command.id)+'/complete',{method:'POST',body:JSON.stringify({ok})})
      })
    }
  }catch(error){await Promise.allSettled([...brains.values()].map(brain=>brain.stop()));brains.clear();brainKeys.clear();harness=undefined;log('error','云端授权检查失败，已停止所有机器人思考：'+String(error));if(cloudBotPoll)clearInterval(cloudBotPoll);cloudBotPoll=undefined}
  finally{cloudBotPolling=false}
}
export function registerNumenIpc(getWin:()=>BrowserWindow|null):void{
  send=state=>getWin()?.webContents.send(NUMEN_EVENT,state)
  const handle=(channel:string,action:(...args:any[])=>unknown)=>ipcMain.handle(channel,async(event,...args)=>{
    const win=getWin();if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('只允许启动器主窗口操作 AI 陪玩')
    try{return await action(...args)}catch(error){throw new Error(redactAiText(error instanceof Error?error.message:error,secrets()))}
  })
  handle('numen:cloudBotsBind',ref=>exclusive(async()=>{
    if(!ref||typeof ref.instanceId!=='string'||typeof ref.saveId!=='string')throw new Error('请选择云端存档')
    const c=cloudClient(), catalog=await c.json('api/nomad/catalog/'),instance=catalog.instances.find((i:any)=>i.id===ref.instanceId)
    if(!instance?.saves?.some((s:any)=>s.id===ref.saveId))throw new Error('没有此云端存档的访问权限')
    const binding=requireCloudBinding(c.serviceId,ref)
    await bind(binding)
    cloudBotScope={instanceId:ref.instanceId,saveId:ref.saveId,serviceId:c.serviceId}
    if(cloudBotPoll)clearInterval(cloudBotPoll);cloudBotPoll=setInterval(()=>{void pollBotCommands()},2000);cloudBotPoll.unref()
    snapshot.enabled=await instanceEnabled();return {snapshot:structuredClone(snapshot),bots:await botList()}
  }))
  handle('numen:cloudInstallSupport',()=>exclusive(async()=>{
    if(!cloudBotScope)throw new Error('请选择云端存档');
    const client=cloudClient(),scope={...cloudBotScope};
    if(client.serviceId!==scope.serviceId)throw new Error('云端服务已切换，请重新绑定机器人控制台。');
    if(snapshot.target)await assertInstanceIdle(centerTarget(snapshot.target).dir);
    try{
      const plan=await client.json('api/nomad/bots/installation?instanceId='+encodeURIComponent(scope.instanceId)+'&saveId='+encodeURIComponent(scope.saveId));
      if(!plan.alreadyInstalled){
        if(plan.needsStop)throw new Error('请先关闭房间并等待存档上传完成，再安装并启用陪玩。');
        const confirmation=await dialog.showMessageBox({type:'question',buttons:['取消','安装并启用'],defaultId:1,cancelId:0,title:'安装云端陪玩环境',message:'将下载上游 Numen 和所需依赖，发布到云端并同步到本地。',detail:'新发布版会用于当前存档。角色卡、存档及其他模组会保留。'});
        if(confirmation.response!==1)return {cancelled:true};
      }
      return await client.json('api/nomad/bots/installation',{method:'POST',timeoutMs:300000,body:JSON.stringify({instanceId:scope.instanceId,saveId:scope.saveId,baseReleaseId:plan.baseReleaseId,revision:plan.revision,confirm:true})});
    }catch(error){const text=error instanceof Error?error.message:String(error);const messages:Record<string,string>={numen_close_room_first:'请先关闭房间并等待存档上传完成。',numen_save_release_not_latest:'当前存档使用较早的发布版，请先在实例中心确认要使用的最新环境。',numen_loader_update_required:'当前加载器版本低于 Numen 的要求，请先发布兼容的加载器版本。',numen_manifest_required:'当前整合包还没有完整文件清单，请先发布完整环境后安装陪玩。',numen_target_unsupported:'陪玩适配支持 1.20.1 Fabric／Forge，以及 1.21.1 Fabric／NeoForge。',publication_base_conflict:'云端环境刚被其他人修改，请刷新实例后重试。',numen_download_failed:'下载上游模组失败，请检查云端服务器的网络。',numen_download_hash_mismatch:'上游模组校验失败，未发布这次修改。',forbidden:'安装并发布陪玩环境需要 MOD 管理和实例修改权限。'};for(const [code,message]of Object.entries(messages))if(text.includes(code))throw new Error(message);throw error;}
  }))
  handle('numen:instanceEnable',enabled=>exclusive(async()=>{
    if(!snapshot.target||typeof enabled!=='boolean')throw new Error('请选择实例');
    if(enabled&&!snapshot.installed)throw new Error('请先一键安装匹配的上游 Numen');
    if(cloudBotScope){await cloudClient().json('api/nomad/bots/settings',{method:'PUT',body:JSON.stringify({instanceId:cloudBotScope.instanceId,enabled})})}
    else{const file=localEnableFile();let settings:Record<string,boolean>={};if(fs.existsSync(file))settings=JSON.parse(fs.readFileSync(file,'utf8'));settings[JSON.stringify(snapshot.target)]=enabled;fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(settings));fs.renameSync(temp,file);}
    if(!enabled)await Promise.allSettled([...brains.values()].map(brain=>brain.stop()));snapshot.enabled=enabled;emit();return structuredClone(snapshot);
  }))
  handle('numen:cloudBots',()=>botList())
  const botScopeQuery=()=>{if(!cloudBotScope)throw new Error('请选择云端存档');return '?instanceId='+encodeURIComponent(cloudBotScope.instanceId)+'&saveId='+encodeURIComponent(cloudBotScope.saveId)};
  handle('numen:cloudBotRoster',()=>cloudClient().json('api/nomad/bots/roster'+botScopeQuery()))
  handle('numen:cloudBotSettings',()=>cloudClient().json('api/nomad/bots/settings'+botScopeQuery()))
  handle('numen:cloudBotEnable',enabled=>{if(!cloudBotScope)throw new Error('请选择云端存档');return cloudClient().json('api/nomad/bots/settings',{method:'PUT',body:JSON.stringify({instanceId:cloudBotScope.instanceId,enabled})})})
  handle('numen:cloudBotLink',()=>{if(!cloudBotScope)throw new Error('请选择云端存档');return cloudClient().json('api/nomad/bots/link',{method:'POST',body:JSON.stringify(cloudBotScope)})})
  handle('numen:cloudBotSkin',async name=>{
    if(typeof name!=='string'||!/^[A-Za-z0-9_]{3,16}$/.test(name))throw new Error('请输入原版皮肤所属的正版玩家名');
    const profile=await fetch('https://api.mojang.com/users/profiles/minecraft/'+encodeURIComponent(name),{redirect:'error',signal:AbortSignal.timeout(20000)});if(!profile.ok)throw new Error('未找到此正版玩家皮肤');const player=await profile.json();if(!/^[0-9a-f]{32}$/i.test(player.id))throw new Error('正版档案返回无效');
    const response=await fetch('https://sessionserver.mojang.com/session/minecraft/profile/'+player.id+'?unsigned=false',{redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('正版皮肤服务暂不可用');const data=await response.json();const texture=data.properties?.find((p:any)=>p.name==='textures'&&typeof p.value==='string'&&typeof p.signature==='string');if(!texture)throw new Error('正版服务没有返回签名皮肤');return{value:texture.value,signature:texture.signature};
  })
  handle('numen:cloudBotAppearance',(id,input)=>cloudClient().json('api/nomad/bots/'+encodeURIComponent(id)+'/appearance',{method:'PUT',body:JSON.stringify(input)}))
  handle('numen:cloudBotRuntime',id=>cloudClient().json('api/nomad/bots/'+encodeURIComponent(id)+'/runtime'))
  handle('numen:cloudBotModel',(id,input)=>cloudClient().json('api/nomad/bots/'+encodeURIComponent(id)+'/model',{method:'PUT',body:JSON.stringify(input)}))
  handle('numen:cloudBotBody',(id,action)=>cloudClient().json('api/nomad/bots/'+encodeURIComponent(id)+'/body',{method:'POST',body:JSON.stringify({action})}))

  handle('numen:cloudBotRegister',input=>exclusive(async()=>{
    if(!cloudBotScope)throw new Error('请先选择云端存档')
    if(!['private','shared'].includes(input?.scope))throw new Error('请选择私有或公有机器人')
    if(typeof input.name!=='string'||!/^[A-Za-z0-9_]{3,16}$/.test(input.name))throw new Error('请输入机器人名字')
    return cloudClient().json('api/nomad/bots/',{method:'POST',body:JSON.stringify({...cloudBotScope,scope:input.scope,name:input.name,access:input.access,model:input.model,skin:input.skin,resourceApplications:input.resourceApplications??[]})})
  }))
  handle('numen:cloudBotReview',(id,input)=>cloudClient().json('api/nomad/bots/'+encodeURIComponent(id)+'/review',{method:'POST',body:JSON.stringify(input)}))
  handle('numen:cloudBotMembers',()=>{if(!cloudBotScope)throw new Error('请选择云端存档');return cloudClient().json('api/nomad/bots/members?instanceId='+encodeURIComponent(cloudBotScope.instanceId)+'&saveId='+encodeURIComponent(cloudBotScope.saveId))})
  handle('numen:cloudModels',()=>{if(!cloudBotScope)throw new Error('请选择云端存档');return cloudClient().json('api/nomad/bots/models?instanceId='+encodeURIComponent(cloudBotScope.instanceId)+'&saveId='+encodeURIComponent(cloudBotScope.saveId))})
  handle('numen:cloudModelPreview',id=>exclusive(async()=>{
    if(!cloudBotScope)throw new Error('请选择云端存档')
    const c=cloudClient(), apps=await c.json('api/nomad/bots/models?instanceId='+encodeURIComponent(cloudBotScope.instanceId)+'&saveId='+encodeURIComponent(cloudBotScope.saveId));
    const application=apps.find((a:any)=>a.id===id);if(!application)throw new Error('没有此上传申请的查看权限')
    const {validateManifest}=await import('../../../../../mcsmanager/shared/nomad-distribution');
    const manifest=validateManifest(application.manifest,256*1024*1024);const dir=path.join(app.getPath('userData'),'cloud-model-reviews',crypto.randomUUID());fs.mkdirSync(dir,{recursive:true})
    const files:Array<{name:string;bytes:Buffer}>=[]
    try{
      for(const file of manifest.files){
        const prefix='config/yes_steve_model/custom/';if(!file.path.startsWith(prefix))throw new Error('模型资源路径无效')
        const response=await c.raw('api/nomad/bots/models/'+encodeURIComponent(id)+'/blobs/'+file.sha256);const reader=response.body?.getReader();if(!reader)throw new Error('模型资源为空');const chunks:Uint8Array[]=[];let size=0
        try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>file.size)throw new Error('模型预览资源超过声明大小');chunks.push(chunk.value)}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
        const bytes=Buffer.concat(chunks);if(size!==file.size||crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('模型预览资源校验失败');files.push({name:file.path.slice(prefix.length),bytes})
      }
      let file:string
      if(files.length===1&&files[0].name.endsWith('.ysm')){file=path.join(dir,'review.ysm');fs.writeFileSync(file,files[0].bytes)}
      else{const {default:AdmZip}=await import('adm-zip');const zip=new AdmZip();for(const entry of files)zip.addFile(entry.name,entry.bytes);file=path.join(dir,'review.zip');zip.writeZip(file)}
      return await importYsmAsset(file)
    }finally{await fs.promises.rm(dir,{recursive:true,force:true})}
  }))
  handle('numen:cloudModelReview',(id,input)=>cloudClient().json('api/nomad/bots/models/'+encodeURIComponent(id)+'/review',{method:'POST',body:JSON.stringify(input)}))
  handle('numen:cloudModelUpload',assetId=>exclusive(async()=>{
    if(!cloudBotScope)throw new Error('请选择云端存档')
    const source=ysmInstallFiles(assetId),c=cloudClient(),scope={...cloudBotScope}
    if(c.serviceId!==scope.serviceId)throw new Error('云端服务已切换')
    const files=Object.entries(source.files).map(([name,bytes])=>({path:'config/yes_steve_model/custom/'+name,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length,side:'both',ownership:'managed'}))
    const application=await c.json('api/nomad/bots/models',{method:'POST',body:JSON.stringify({...scope,name:source.modelId,manifest:{schema:1,files}})})
    const uploaded=new Set<string>()
    for(const [name,bytes] of Object.entries(source.files)){
      const hash=crypto.createHash('sha256').update(bytes).digest('hex');if(uploaded.has(hash))continue
      await c.json('api/nomad/bots/models/'+application.id+'/blobs/'+hash,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:Buffer.from(bytes) as any});uploaded.add(hash)
    }
    return c.json('api/nomad/bots/models/'+application.id+'/commit',{method:'POST',body:'{}'})
  }))
  handle('numen:cloudBotAccess',(id,input)=>cloudClient().json('api/nomad/bots/'+encodeURIComponent(id)+'/access',{method:'PUT',body:JSON.stringify(input)}))
  handle('numen:cloudBotDelete',async id=>{
    const confirmation=await dialog.showMessageBox(getWin()!,{type:'warning',buttons:['取消','永久删除'],defaultId:0,cancelId:0,title:'永久删除机器人',message:'此机器人将永远消散，无法恢复。',detail:'背包、装备和配饰会掉落；指令由所有者客户端执行。确认永久删除？',noLink:true})
    if(confirmation.response!==1)return {cancelled:true}
    return cloudClient().json('api/nomad/bots/'+encodeURIComponent(id)+'/commands',{method:'POST',body:JSON.stringify({action:'delete',confirm:'permanent'})})
  })
  handle('numen:cloudBotCommand',(id,input)=>cloudClient().json('api/nomad/bots/'+encodeURIComponent(id)+'/commands',{method:'POST',body:JSON.stringify(input)}))
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
  handle('numen:saveSettings',input=>{if(brains.size)throw new Error('请先停止所有同伴的思考，再修改模型配置');return saveAiSettings(input)})
  handle('numen:testModel',async()=>{const {settings,key}=aiCredentials();if(!settings.model)throw new Error('请先保存模型名称');const reply=await new AiModelClient(settings,key).call('Reply briefly.',[{role:'user',text:'连接测试，请回复 OK。'}],[],AbortSignal.timeout(30000));log('system','模型连接测试成功：'+reply.text.slice(0,200));return true})
  handle('numen:snapshot',()=>structuredClone(snapshot))
  handle('numen:bind',target=>exclusive(()=>bind(target)))
  handle('numen:enableMcp',()=>exclusive(enableMcp))
  handle('numen:connect',()=>exclusive(connect))
  handle('numen:refresh',()=>exclusive(async()=>{snapshot.companions=visibleCompanions(await requireClient().companions());if(!harness&&!snapshot.companions.some(c=>c.id===snapshot.selectedCompanion))snapshot.selectedCompanion=snapshot.companions[0]?.id;syncCharacter();emit();return structuredClone(snapshot)}))
  handle('numen:select',companion=>exclusive(async()=>{if(!snapshot.companions.some(c=>c.id===companion))throw new Error('同伴不存在');snapshot.selectedCompanion=companion;harness=brains.get(companion);snapshot.phase=snapshot.companionPhases?.[companion]??'ready';syncCharacter();emit();return structuredClone(snapshot)}))
  handle('numen:create',name=>exclusive(async()=>{if(typeof name!=='string'||!/^\w{3,16}$/.test(name)||/[^a-zA-Z0-9_]/.test(name))throw new Error('同伴名字须为 3–16 位英文字母、数字或下划线');let approved:BotView|undefined;if(cloudBotScope){approved=(await botList()).find(b=>b.name===name&&b.canManage&&b.scope==='private'&&b.admission==='approved');if(!approved)throw new Error('请先提交此机器人的接入申请并通过审核');if(snapshot.directory)await syncApprovedModels(cloudClient(),cloudBotScope,snapshot.directory);await cloudClient().json('api/nomad/bots/'+approved.id+'/body',{method:'POST',body:JSON.stringify({action:'join'})});snapshot.companions=visibleCompanions(await requireClient().companions());log('system','服务器已按审核的归属召唤机器人。');return structuredClone(snapshot)}const result=await requireClient().call('create_companion',{name});if(result.isError)throw new Error(resultText(result));log('tool',resultText(result));snapshot.companions=visibleCompanions(await requireClient().companions());if(approved){const companion=snapshot.companions.find(c=>c.name===name);if(!companion)throw new Error('召唤已请求，请等待游戏回报后重新绑定');await cloudClient().json('api/nomad/bots/'+approved.id+'/bind',{method:'POST',body:JSON.stringify({companionId:companion.id})})}return structuredClone(snapshot)}))
  handle('numen:delete',companion=>exclusive(async()=>{
    if(cloudBotScope)throw new Error('云端机器人请从权限与审核栏目提交永久删除，所有者执行后同步云端记录')
    if(typeof companion !== 'string' || !snapshot.companions.some(c => c.id === companion)) throw new Error('请先选择要永久删除的同伴')
    const choice = await dialog.showMessageBox(getWin()!, {type:'warning',buttons:['取消','永久删除'],defaultId:0,cancelId:0,title:'永久删除机器人',message:'此机器人将永远消散，无法恢复。',detail:'游戏中的背包、装备和配饰会掉落。此操作不是停止思考，确认永久删除？',noLink:true})
    if(choice.response !== 1) return structuredClone(snapshot)
    if(snapshot.selectedCompanion === companion) await stopBrain(false)
    const result = await requireClient().call('delete_companion',{companion})
    if(result.isError) throw new Error(resultText(result))
    snapshot.companions = visibleCompanions(await requireClient().companions())
    snapshot.selectedCompanion = snapshot.companions[0]?.id;harness=snapshot.selectedCompanion?brains.get(snapshot.selectedCompanion):undefined;snapshot.phase=snapshot.selectedCompanion?snapshot.companionPhases?.[snapshot.selectedCompanion]??'ready':'ready';syncCharacter()
    log('system','机器人已永久删除，无法恢复。'); return structuredClone(snapshot)
  }))
  handle('numen:start',companion=>exclusive(()=>start(companion)))
  handle('numen:stop',()=>exclusive(async()=>{await stopBrain();return structuredClone(snapshot)}))
  handle('numen:send',text=>{if(!harness||['error','stopped'].includes(snapshot.phase))throw new Error('请先开始陪玩');if(typeof text!=='string'||!text.trim()||text.length>16000)throw new Error('请输入 1–16000 字的任务或消息');harness.send(text.trim());return structuredClone(snapshot)})
  handle('numen:localBody',(action,companion)=>exclusive(()=>localBodyAction(action,companion)))
  handle('numen:installLocalAdapter',()=>exclusive(async()=>{
    if(cloudBotScope)throw new Error('云端适配由游戏主机自动安装');if(!snapshot.target)throw new Error('请选择实例');const context=centerTarget(snapshot.target);await assertInstanceIdle(context.dir);
    const {withGameFolder}=await import('../paths');const {resolveInstanceMetadata}=await import('../instanceMetadata');const {readVersionJson}=await import('../versions');const meta=withGameFolder(context.folder,()=>resolveInstanceMetadata(context.json,id=>{try{return readVersionJson(id)}catch{return undefined}}));const target = `${meta.mcVersion}-${meta.loader}`;if(!['1.20.1-fabric','1.20.1-forge','1.21.1-fabric','1.21.1-neoforge'].includes(target))throw new Error('加入／退出适配支持 1.20.1 Fabric／Forge，以及 1.21.1 Fabric／NeoForge');
    const jars=fs.readdirSync(path.join(context.dir,'mods')).filter(name=>name.endsWith('.jar'));if(!jars.some(name=>{try{const info=parseModFile(path.join(context.dir,'mods',name));return info.id==='numen'&&info.version==='0.1.4.1'}catch{return false}}))throw new Error('请先安装上游 Numen 0.1.4.1');
    const source=path.join(__dirname,`nomad-numen-adapter-${meta.loader}-${meta.mcVersion}.jar`).replace('app.asar','app.asar.unpacked'),destination=await safePath(context.dir,'mods/nomad-numen-adapter.jar',true);const bytes=fs.readFileSync(source);if(fs.existsSync(destination)&&!fs.readFileSync(destination).equals(bytes))throw new Error('已有同名适配文件不同，请先在模组管理器处理');fs.writeFileSync(destination,bytes);return {ok:true};
  }))
  handle('numen:installPlayerBridge',()=>exclusive(async()=>{
    if(!snapshot.target)throw new Error('请选择实例');const context=centerTarget(snapshot.target);await assertInstanceIdle(context.dir);
    const {withGameFolder}=await import('../paths');const bridge=await import('../modBridge');const {assertCloudModsWritable}=await import('../cloudResourceGuard');
    const {resolveInstanceMetadata}=await import('../instanceMetadata');const {readVersionJson}=await import('../versions');const meta=withGameFolder(context.folder,()=>resolveInstanceMetadata(context.json,id=>{try{return readVersionJson(id)}catch{return undefined}}));if(!['1.20.1-fabric','1.20.1-forge','1.21.1-fabric','1.21.1-neoforge'].includes(meta.mcVersion+'-'+meta.loader))throw new Error('玩家命令桥接支持 1.20.1 Fabric／Forge，以及 1.21.1 Fabric／NeoForge');
    await assertCloudModsWritable(path.join(context.dir,'mods'));
    const result=withGameFolder(snapshot.target.folder,()=>bridge.installBridge(snapshot.target!.id));if(!result.ok)throw new Error(result.error);return result;
  }))
  handle('numen:playerCommand',(action,companion,text)=>exclusive(async()=>{
    if(!snapshot.target)throw new Error('请选择实例')
    const roster=cloudBotScope?(await cloudClient().json('api/nomad/bots/roster'+botScopeQuery())).roster:visibleCompanions(await requireClient().companions()),bot=roster.find((b:any)=>b.id===companion&&b.online!==false)
    if(!bot)throw new Error('请从机器人列表选择当前在线的目标')
    if(!/^[A-Za-z0-9_]{3,16}$/.test(bot.name))throw new Error('此机器人名字不适用于快捷命令')
    const commands:Record<string,string>={settings:'numen settings',reset:'numen reset',debug:'numen debug',permission:'numen permission mode '+bot.name,despawn:'numen player despawn '+bot.name}
    if(action==='task'){if(typeof text!=='string'||!text.trim()||text.length>1800||/[\r\n]/.test(text))throw new Error('游戏内任务须为一行 1–1800 字');commands.task='nomad-bot-task '+bot.name+' '+text.trim()}
    const command=commands[action];if(!command)throw new Error('不支持的玩家快捷命令')
    if(action==='despawn'){
      const result=await dialog.showMessageBox(getWin()!,{type:'warning',buttons:['取消','永久删除'],defaultId:0,cancelId:0,title:'永久删除机器人',message:'此机器人将永远消散，无法恢复。',detail:'背包、装备和配饰会掉落。命令以你当前的游戏身份执行，服务器会检查权限。',noLink:true});if(result.response!==1)return structuredClone(snapshot)
    }
    const {withGameFolder}=await import('../paths');const {readDiscovery}=await import('../modBridge');
    const discovery=withGameFolder(snapshot.target.folder,()=>readDiscovery(snapshot.target!.id))
    if(!discovery)throw new Error('玩家身份快捷命令需要安装并启动 KAMUCL 桥接 MOD（支持四种目标组合）；不会改用机器人或服务器身份')
    const response=await fetch('http://127.0.0.1:'+discovery.port+'/kamucl/v1/player-command',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Kamucl-Token':discovery.token},body:JSON.stringify({command}),signal:AbortSignal.timeout(15000)})
    const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'游戏客户端未接受快捷命令，请检查桥接版本')
    log('system','已通过当前玩家的游戏连接发送 /'+command+'；结果与权限拒绝请查看游戏聊天。',bot.id)
    return structuredClone(snapshot)
  }))
  handle('numen:command',kind=>exclusive(()=>command(kind)))
  handle('numen:clearLogs',()=>{snapshot.logs=[];emit();return structuredClone(snapshot)})
  handle('numen:clearHistory',()=>{if(harness)throw new Error('请先停止 AI 再清空记录');if(snapshot.selectedCompanion)fs.rmSync(historyFile(),{force:true});log('system','已清空当前同伴的本地对话记录');return structuredClone(snapshot)})
  handle('numen:exportLogs',async()=>{const result=await dialog.showSaveDialog({title:'导出 AI 陪玩日志',defaultPath:'numen-logs.txt',filters:[{name:'文本文件',extensions:['txt']}]});if(result.canceled||!result.filePath)return null;fs.writeFileSync(result.filePath,snapshot.logs.map(l=>new Date(l.time).toISOString()+' ['+l.kind+'] '+l.text).join('\n'),'utf8');return result.filePath})
  app.on('before-quit',()=>{if(cloudBotPoll)clearInterval(cloudBotPoll);if(emitTimer)clearTimeout(emitTimer);if(tailer)clearInterval(tailer);void Promise.allSettled([...brains.values()].map(brain=>brain.stop()))})
}
