const {execFileSync}=require('node:child_process')
const path=require('node:path')
const fs=require('node:fs')
const root=path.resolve(__dirname,'..')
const rid=process.platform==='win32'&&process.arch==='x64'?'win-x64':null
if(!rid){console.warn('YSMViewer preview runtime is currently available on Windows x64 only');process.exit(0)}
const exe=path.join(root,'ysm-runtime/viewer/NomadYsm.exe')
function newest(dir){return Math.max(...fs.readdirSync(dir,{withFileTypes:true}).filter(e=>!['bin','obj'].includes(e.name)).map(e=>e.isDirectory()?newest(path.join(dir,e.name)):fs.statSync(path.join(dir,e.name)).mtimeMs),0)}
if(fs.existsSync(exe)&&fs.statSync(exe).mtimeMs>=newest(path.join(root,'ysm-engine')))process.exit(0)
execFileSync('dotnet',['publish',path.join(root,'ysm-engine/NomadYsm.csproj'),'-c','Release','-r',rid,'--self-contained','true','-o',path.join(root,'ysm-runtime/viewer')],{stdio:'inherit',windowsHide:true})
