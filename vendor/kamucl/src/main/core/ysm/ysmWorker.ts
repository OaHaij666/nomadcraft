import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
async function decode(){
  const factory=createRequire(__filename)(path.join(__dirname,'ysm-runtime','YSMParser.cjs').replace('app.asar','app.asar.unpacked'))
  const m=await factory({wasmBinary:fs.readFileSync(path.join(__dirname,'ysm-runtime','YSMParser.wasm').replace('app.asar','app.asar.unpacked')),noInitialRun:true,print:()=>{},printErr:()=>{}})
  const bytes=fs.readFileSync(workerData.file);if(bytes.length>128*1024*1024)throw new Error('YSM 模型最大 128 MiB')
  m.FS.mkdir('/input');m.FS.mkdir('/output');m.FS.writeFile('/input/model.ysm',bytes)
  try{m.callMain(['-i','/input','-o','/output'])}catch(e){if(!(e&&typeof e==='object'&&'status' in e&&e.status===0))throw e}
  const files:Record<string,Uint8Array>={};let total=0,count=0
  function collect(dir:string){for(const name of m.FS.readdir(dir)){if(name==='.'||name==='..')continue;const file=dir+'/'+name;if(m.FS.isDir(m.FS.stat(file).mode))collect(file);else{const data=m.FS.readFile(file);total+=data.length;if(total>256*1024*1024||++count>6000)throw new Error('模型解码后资源过多');files[file.slice('/output/'.length)]=data}}}
  collect('/output');if(!count)throw new Error('模型格式不受支持，解析器未产生资源');return files
}
decode().then(files=>parentPort?.postMessage({files})).catch(error=>parentPort?.postMessage({error:error instanceof Error?error.message:String(error)}))
