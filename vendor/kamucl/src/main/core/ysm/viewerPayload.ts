import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { app } from 'electron'
import type { YsmViewerPayload } from '../../../shared/ysm'
const pending=new Map<string,Promise<YsmViewerPayload>>()
export function viewerPayload(dir:string):Promise<YsmViewerPayload>{
 const existing=pending.get(dir);if(existing)return existing
 const task=build(dir).finally(()=>pending.delete(dir));pending.set(dir,task);return task
}
async function build(dir:string):Promise<YsmViewerPayload>{
 const output=path.join(dir,'viewer-ysmviewer-1.json')
 const load=()=>{if(fs.statSync(output).size>96*1024*1024)throw new Error('YSM 预览数据过大');const data=JSON.parse(fs.readFileSync(output,'utf8'));if(data.engine!=='ysmviewer-1')throw new Error('YSM 预览版本无效');return data as YsmViewerPayload}
 if(fs.existsSync(output))return load()
 if(process.platform!=='win32'||process.arch!=='x64')throw new Error('当前 YSMViewer 预览运行库暂仅支持 Windows x64')
 let helper=path.join(__dirname,'ysm-runtime','viewer','NomadYsm.exe')
 if(app.isPackaged)helper=helper.replace('app.asar'+path.sep,'app.asar.unpacked'+path.sep)
 if(!fs.existsSync(helper))throw new Error('缺少本地 YSMViewer 解析运行库，请重新构建客户端')
 const temporary=output+'.tmp'
 try{
 await new Promise<void>((resolve,reject)=>execFile(helper,[path.join(dir,'source.bin'),temporary],{windowsHide:true,timeout:45000,maxBuffer:1024*1024},(error,_stdout,stderr)=>error?reject(new Error('YSMViewer 解析失败：'+(stderr.trim()||error.message))):resolve()))
 if(fs.statSync(temporary).size>96*1024*1024)throw new Error('YSM 预览数据过大')
 fs.renameSync(temporary,output);return load()
 }finally{fs.rmSync(temporary,{force:true})}
}
