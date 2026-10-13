const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'.nomad/diagnostics/startup-feedback'),exe=path.join(root,'vendor/kamucl/out/main/StartupFeedback.exe');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+5000;while(Date.now()<end){if(await fn())return;await sleep(50)}throw Error('Timed out: '+label)}
(async()=>{await fs.mkdir(dir,{recursive:true});for(const mode of ['disabled','enabled']){
 const signal=path.join(dir,mode+'-'+Date.now()+'.signal');await fs.writeFile(signal,'');
 const child=cp.spawn(exe,[signal,String(process.pid)],{windowsHide:true,stdio:'ignore'});let exited=false;child.on('exit',()=>exited=true);child.on('error',e=>{throw e});
 try{await sleep(700);assert.equal(exited,false);assert.equal(await fs.stat(signal+'.visible').catch(()=>null),null,'empty signal must not render fragments');
 if(mode==='enabled'){await fs.writeFile(signal,'loading\n正在启动…');await until(async()=>!!await fs.stat(signal+'.visible').catch(()=>null),'authorized frame');}
 await fs.writeFile(signal,'closed');await until(()=>exited,'helper exit');console.log('PASS '+mode+': hidden until authorized, explicit close exits');
 }finally{if(!exited)child.kill()}
} })().catch(e=>{console.error(e);process.exitCode=1});
