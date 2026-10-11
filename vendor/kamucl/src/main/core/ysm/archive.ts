import path from 'node:path'
import AdmZip from 'adm-zip'
import { pngChunks } from '../numen/characterCodec'
import type { YsmPreview, YsmAsset } from '../../../shared/ysm'
export type YsmFiles=Record<string,Uint8Array>
export function modelPath(input:string):string {
  const name=input.replaceAll('\\','/')
  if(!name||name.startsWith('/')||/^[a-z]:/i.test(name)||name.split('/').some(p=>p==='..'||p==='.'||!p)||/[\x00-\x1f\x7f]/.test(name))throw new Error('模型资源路径无效')
  return name
}
export function unzipYsm(bytes:Buffer):YsmFiles {
  const entries=new AdmZip(bytes).getEntries(),files:YsmFiles=Object.create(null);let size=0
  if(entries.length>6000)throw new Error('模型 ZIP 文件数量过多')
  for(const entry of entries){if(entry.isDirectory)continue;const name=modelPath(entry.entryName);if(files[name])throw new Error('模型 ZIP 包含重复资源');size+=entry.header.size;if(size>256*1024*1024||entry.header.size>64*1024*1024)throw new Error('模型 ZIP 解压后过大');files[name]=entry.getData()}
  return files
}
export function prepareYsmPreview(files:YsmFiles,asset:Omit<YsmAsset,'textures'|'animationCount'|'name'>):YsmPreview {
  const names=Object.keys(files);if(names.length>6000)throw new Error('模型资源过多');for(const name of names)modelPath(name)
  const json=(name:string)=>{const data=files[name];if(!data||data.length>12*1024*1024)throw new Error('模型 JSON 缺失或过大');return JSON.parse(Buffer.from(data).toString('utf8').replace(/^\uFEFF/,''))}
  const manifestName=names.find(n=>path.posix.basename(n)==='ysm.json'),manifest=manifestName?json(manifestName):{},base=manifestName?path.posix.dirname(manifestName):'.'
  const resolve=(name:string)=>{const full=path.posix.join(base,modelPath(name));return files[full]?full:names.find(n=>n.endsWith('/'+name)||n===name)}
  const player=manifest.files?.player??{},modelRefs=player.model??manifest.files?.model??{}
  let geometryFile=typeof modelRefs.main==='string'?resolve(modelRefs.main):undefined
  if(!geometryFile)geometryFile=names.filter(n=>/\.json$/i.test(n)&&!/(animation|controller|avatar|lang)/i.test(n)).find(n=>{try{const j=json(n);return !!j['minecraft:geometry']||Object.keys(j).some(k=>k.startsWith('geometry.'))}catch{return false}})
  if(!geometryFile)throw new Error('模型包里没有可预览的 Minecraft 几何模型')
  const geometry=json(geometryFile),groups=geometry['minecraft:geometry']??Object.entries(geometry).filter(([key])=>key.startsWith('geometry.')).map(([,value])=>value)
  if(!Array.isArray(groups)||!groups.length)throw new Error('YSM 几何数据无效')
  let boneCount=0,cubeCount=0
  for(const group of groups){if(!Array.isArray(group.bones))throw new Error('YSM 骨骼数据无效');boneCount+=group.bones.length;const parents=new Map<string,string>();for(const bone of group.bones){if(typeof bone.name!=='string')throw new Error('YSM 骨骼名称无效');parents.set(bone.name,bone.parent??'');cubeCount+=(bone.cubes??[]).length}for(const name of parents.keys()){const seen=new Set<string>();let key=name;while(parents.has(key)){if(seen.has(key))throw new Error('YSM 骨骼存在循环引用');seen.add(key);key=parents.get(key)!}}}
  if(boneCount>6000||cubeCount>60000)throw new Error('模型过于复杂，超出预览限制')
  const textureRefs=Array.isArray(player.texture)?player.texture:[]
  const textureFiles=textureRefs.length?textureRefs.filter((n:unknown)=>typeof n==='string').map(resolve).filter(Boolean):names.filter(n=>/textures\/.*\.png$/i.test(n)&&!/(avatar|\/gui\/)/i.test(n))
  let textureBytes=0
  const textures:Array<{name:string;png:string}>=textureFiles.map((file:string)=>{const data=Buffer.from(files[file]);textureBytes+=data.length;if(textureBytes>24*1024*1024)throw new Error('预览贴图总量最大 24 MiB');pngChunks(data);return{name:path.posix.basename(file,'.png'),png:'data:image/png;base64,'+data.toString('base64')}})
  if(!textures.length)throw new Error('模型包里没有 PNG 贴图')
  const animationRefs=player.animation&&typeof player.animation==='object'?Object.values(player.animation):[]
  const animationFiles=animationRefs.length?animationRefs.filter((n):n is string=>typeof n==='string').map(resolve).filter((n):n is string=>!!n):names.filter(n=>/\.animation\.json$/i.test(n))
  const animations=animationFiles.map(n=>JSON.stringify(json(n)));const animationCount=new Set(animations.flatMap(text=>Object.keys(JSON.parse(text).animations??{}))).size
  const controllers=names.filter(n=>/animation_controllers?\.json$/i.test(n)).map(n=>JSON.stringify(json(n)))
  const name=typeof manifest.metadata?.name==='string'?manifest.metadata.name:asset.modelId
  return{asset:{...asset,name:name.slice(0,120),textures:textures.map(t=>t.name),animationCount},geometry:JSON.stringify(geometry),textures,animations,controllers,defaultAnimation:typeof manifest.properties?.preview_animation==='string'?manifest.properties.preview_animation:undefined}
}
