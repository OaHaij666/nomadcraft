import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { viewerPayload } from './viewerPayload'
import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import { modelPath, prepareYsmPreview, unzipYsm, type YsmFiles } from './archive'
import type { DefaultYsm, YsmAsset, YsmPreview } from '../../../shared/ysm'
const root=()=>path.join(app.getPath('userData'),'ysm-models')
const ID=/^[a-f0-9]{64}$/
function assetDir(id:string):string{if(!ID.test(id))throw new Error('YSM 模型标识无效');return path.join(root(),id)}
function atomic(file:string,value:unknown){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(value));fs.renameSync(file+'.tmp',file)}
function decode(file:string):Promise<YsmFiles>{return new Promise((resolve,reject)=>{const worker=new Worker(path.join(__dirname,'ysmWorker.cjs'),{workerData:{file},resourceLimits:{maxOldGenerationSizeMb:384}});let finished=false;const finish=(error?:Error,files?:YsmFiles)=>{if(finished)return;finished=true;clearTimeout(timer);void worker.terminate();if(error)reject(error);else resolve(files!)};const timer=setTimeout(()=>finish(new Error('YSM 解码超时，请检查模型是否受支持')),45000);worker.on('message',value=>finish(value.error?new Error(value.error):undefined,value.files));worker.on('error',error=>finish(error));worker.on('exit',code=>{if(!finished)finish(new Error('YSM 解析线程提前退出（'+code+'）'))})})}
interface AssetRecord { asset:YsmAsset; extension:'.ysm'|'.zip'; rootPrefix:string }
function record(id:string):AssetRecord{const file=path.join(assetDir(id),'asset.json');if(fs.statSync(file).size>128*1024)throw new Error('模型元数据异常');return JSON.parse(fs.readFileSync(file,'utf8'))}
export function getYsmAsset(id:string):YsmAsset{return record(id).asset}
export function listYsmAssets():YsmAsset[]{if(!fs.existsSync(root()))return[];return fs.readdirSync(root()).filter(id=>ID.test(id)&&fs.existsSync(path.join(root(),id,'asset.json'))).map(id=>record(id).asset).sort((a,b)=>b.createdAt-a.createdAt)}
export async function ysmPreview(id:string):Promise<YsmPreview>{const file=path.join(assetDir(id),'preview.json');if(fs.statSync(file).size>48*1024*1024)throw new Error('模型预览过大');const preview=JSON.parse(fs.readFileSync(file,'utf8')) as YsmPreview;preview.viewer=await viewerPayload(assetDir(id));return preview}
let importing=false
export async function importYsmAsset(file:string):Promise<YsmAsset>{
  if(importing)throw new Error('正在导入另一个 YSM 模型，请稍候');importing=true
  try{
    const extension=path.extname(file).toLowerCase();if(extension!=='.ysm'&&extension!=='.zip')throw new Error('请选择 .ysm 或模型 ZIP')
    const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024*1024)throw new Error('模型须为普通文件，最大 128 MiB')
    const source=fs.readFileSync(file),id=crypto.createHash('sha256').update(source).digest('hex'),dir=assetDir(id)
    if(fs.existsSync(path.join(dir,'asset.json')))return record(id).asset
    const files=extension==='.zip'?unzipYsm(source):await decode(file)
    if(!crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').startsWith(id))throw new Error('导入过程中模型文件发生变化，请重试')
    const filename=path.basename(file),modelId=extension==='.ysm'?filename:path.basename(file,extension)
    if(/[\x00-\x1f<>:"/\\|?*]/.test(modelId)||!modelId.trim()||modelId.length>180)throw new Error('请给模型文件使用有效的文件名')
    const preview=prepareYsmPreview(files,{id,modelId,createdAt:Date.now()})
    const manifest=Object.keys(files).find(n=>path.posix.basename(n)==='ysm.json'),rootPrefix=manifest?path.posix.dirname(manifest):'.'
    fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'source.bin'),source)
    atomic(path.join(dir,'preview.json'),preview);atomic(path.join(dir,'asset.json'),{asset:preview.asset,extension,rootPrefix} satisfies AssetRecord)
    return preview.asset
  }finally{importing=false}
}
const defaultsFile=()=>path.join(root(),'defaults.json')
export function getDefaultYsm():DefaultYsm{if(!fs.existsSync(defaultsFile()))return{enabled:false,previewOnHome:true};const state=JSON.parse(fs.readFileSync(defaultsFile(),'utf8'));return{enabled:state.enabled===true,previewOnHome:state.previewOnHome!==false,assetId:typeof state.assetId==='string'&&ID.test(state.assetId)?state.assetId:undefined,texture:typeof state.texture==='string'?state.texture:undefined,animation:typeof state.animation==='string'&&state.animation.length<=512?state.animation:undefined}}
export function setDefaultYsm(input:DefaultYsm):DefaultYsm{
  if(!input||typeof input.enabled!=='boolean'||typeof input.previewOnHome!=='boolean')throw new Error('默认 YSM 设置无效')
  const asset=input.assetId?record(input.assetId).asset:undefined;if(input.enabled&&!asset)throw new Error('请先选择默认 YSM 模型')
  if(input.texture&&(!asset||!asset.textures.includes(input.texture)))throw new Error('请选择模型包含的贴图')
  if(input.animation){if(!asset||typeof input.animation!=='string'||input.animation.length>512)throw new Error('默认 YSM 动作无效');const preview=JSON.parse(fs.readFileSync(path.join(assetDir(asset.id),'preview.json'),'utf8')) as YsmPreview;if(!preview.animations.some(text=>Object.hasOwn(JSON.parse(text).animations??{},input.animation!)))throw new Error('模型中没有这个动作')}
  const state:DefaultYsm={enabled:input.enabled,previewOnHome:input.previewOnHome,assetId:asset?.id,texture:input.texture||asset?.textures[0],animation:input.animation||undefined};atomic(defaultsFile(),state);return state
}
/** Copy resources only. YSM persists the player's chosen appearance on the server. */
export function ysmInstallFiles(id:string):{modelId:string;files:YsmFiles}{
  const data=record(id),bytes=fs.readFileSync(path.join(assetDir(id),'source.bin'))
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==id)throw new Error('模型源文件校验失败，请重新导入')
  if(data.extension==='.ysm')return{modelId:data.asset.modelId,files:{[data.asset.modelId]:bytes}}
  const unpacked=unzipYsm(bytes),files:YsmFiles=Object.create(null),prefix=data.rootPrefix==='.'?'':data.rootPrefix+'/'
  for(const[name,content]of Object.entries(unpacked)){if(prefix&&!name.startsWith(prefix))continue;files[modelPath(data.asset.modelId+'/'+name.slice(prefix.length))]=content}
  return{modelId:data.asset.modelId,files}
}
