import fs from 'node:fs'
import path from 'node:path'
import { writeYsmFiles } from './installFiles'
import { parseModFile } from '../modinfo'
import { getDefaultYsm, ysmInstallFiles } from './library'
export function hasYsm(gameDir:string):boolean{const mods=path.join(gameDir,'mods');return fs.existsSync(mods)&&fs.readdirSync(mods).filter(n=>n.endsWith('.jar')).some(name=>{try{return ['yes_steve_model','ysm'].includes(parseModFile(path.join(mods,name)).id)}catch{return false}})}
export async function installYsmAsset(gameDir:string,id:string):Promise<{count:number;modelId:string}>{
  if(!hasYsm(gameDir))throw new Error('所选实例未安装 YSM 模组，请先安装对应 Minecraft 版本的 YSM')
  const pack=ysmInstallFiles(id)
  const count=await writeYsmFiles(gameDir,pack.files)
  return{count,modelId:pack.modelId}
}
export async function syncDefaultYsm(gameDir:string):Promise<{count:number;modelId?:string;skipped?:string}>{const state=getDefaultYsm();if(!state.enabled||!state.assetId)return{count:0};if(!hasYsm(gameDir))return{count:0,skipped:'未安装 YSM，跳过默认模型同步'};return installYsmAsset(gameDir,state.assetId)}
