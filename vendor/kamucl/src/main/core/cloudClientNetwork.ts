import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import network from '../../../bridge/client-network.json'
import AdmZip from 'adm-zip'
import { parseModArchive } from './modMetadata'
import { confinedFile } from './cloudSyncFiles'

/** Client-only handshake support; never installed into the compute server. */
export async function ensureCloudClientNetwork(directory:string,profile:{mcVersion?:string;loader?:string},signal:AbortSignal|undefined, runtime:{assertIdle:(directory:string)=>Promise<void>;bundledDirectory:string}){
 if(profile.mcVersion!=='1.20.1'||profile.loader!=='forge')return
 const artifact=network.forge1201
 signal?.throwIfAborted()
 await runtime.assertIdle(directory)
 const destination=await confinedFile(directory,'mods/'+artifact.file)
 await fs.mkdir(path.dirname(destination),{recursive:true})
 const digest=(bytes:Buffer)=>crypto.createHash('sha256').update(bytes).digest('hex')
 for(const file of await fs.readdir(path.dirname(destination))){
  if(!file.toLowerCase().endsWith('.jar'))continue
  const candidate=await confinedFile(directory,'mods/'+file)
  let id='';try{id=parseModArchive(new AdmZip(candidate),candidate,file).id}catch{}
  if(id!==artifact.id)continue
  if(digest(await fs.readFile(candidate))===artifact.sha256)return
  throw new Error('云端 Forge 联机需要匹配的客户端握手重置组件，已有组件与固定版本不一致，请在模组管理器处理：'+file)
 }
 const source=path.join(runtime.bundledDirectory,artifact.file).replace('app.asar','app.asar.unpacked')
 const bytes=await fs.readFile(source)
 if(digest(bytes)!==artifact.sha256)throw new Error('内置 Forge 联机组件校验失败，请重新安装启动器')
 signal?.throwIfAborted()
 await runtime.assertIdle(directory)
 try{await fs.writeFile(destination,bytes,{flag:'wx'})}catch(error){
  if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('联机组件存在同名文件，已保留，请在模组管理器处理：'+artifact.file)
  throw error
 }
}
