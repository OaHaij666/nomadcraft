const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {prepare}=require('./prepare.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Own only gateway processes created by this manager; no global Java process discovery. */
class GatewayManager{
 constructor({directory,java='java',cache,lifecycleJar,log=()=>{}}){this.directory=path.resolve(directory);this.java=java;this.cache=cache;this.lifecycleJar=lifecycleJar;this.log=log;this.runs=new Map();}
 status(id){const run=this.runs.get(id);return run?{id,state:run.state,pid:run.child?.pid,port:run.profile.port,error:run.error??'',logs:run.logs.slice(-100)}:{id,state:'stopped',logs:[]};}
 async start(id,profile){
  if(!/^[a-z0-9_-]{1,100}$/.test(id))throw Error('Invalid gateway identity');
  const previous=this.runs.get(id),fingerprint=JSON.stringify(profile);
  if(previous&&['starting','ready','stopping'].includes(previous.state)){if(previous.fingerprint!==fingerprint)throw Error('Stop the current gateway before changing its network profile');if(previous.state==='stopping')throw Error('Gateway is stopping');return previous.ready;}
  const directory=path.join(this.directory,id),run={id,profile,fingerprint,state:'starting',logs:[],child:undefined,ready:undefined,error:''};
  this.runs.set(id,run);
  run.ready=(async()=>{
   try{
    const result=await prepare(directory,profile,{cache:this.cache,lifecycleJar:this.lifecycleJar});
    const child=spawn(this.java,result.javaArgs,{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});run.child=child;let output='',launchError;
    child.on('error',error=>{launchError=error;});
    const streamLog=bytes=>{const text=bytes.toString();output+=text;for(const line of text.split(/\r?\n/).filter(Boolean)){run.logs.push(line.slice(0,2000));if(run.logs.length>100)run.logs.shift();this.log(id,line);}if(output.length>1024*1024)output=output.slice(-512*1024);};
    child.stdout.on('data',streamLog);child.stderr.on('data',streamLog);child.on('exit',(code)=>{run.state=run.state==='stopping'?'stopped':'failed';if(run.state==='failed')run.error='Gateway exited '+code;});
    const deadline=Date.now()+60000;
    while(Date.now()<deadline){if(launchError)throw launchError;if(child.exitCode!==null)throw Error('Gateway exited during startup');if(/Can.t create (?:plugin|module)|Couldn.t pass ProxyInitializeEvent|Could not load plugin/.test(output))throw Error('Gateway plugin initialization failed');if(/Done \(|Done in/.test(output)){run.state='ready';return this.status(id);}await pause(100);}
    throw Error('Gateway readiness timed out');
   }catch(error){run.error=error.message;run.state='failed';if(run.child?.pid&&run.child.exitCode===null){run.state='stopping';run.child.stdin.write('shutdown\n');const deadline=Date.now()+10000;while(run.child.exitCode===null&&Date.now()<deadline)await pause(100);if(run.child.exitCode===null)run.child.kill();run.state='failed';}throw error;}
  })();
  return run.ready;
 }
 async stop(id){const run=this.runs.get(id);if(!run)return this.status(id);if(run.state==='starting'){await run.ready.catch(()=>{});}if(!run.child?.pid||run.child.exitCode!==null){run.state='stopped';return this.status(id);}run.state='stopping';run.child.stdin.write('shutdown\n');const deadline=Date.now()+30000;while(run.child.exitCode===null&&Date.now()<deadline)await pause(100);if(run.child.exitCode===null){run.child.kill();run.error='Gateway did not stop cleanly';}run.state='stopped';return this.status(id);}
 async close(){await Promise.all([...this.runs.keys()].map(id=>this.stop(id)));}
}
module.exports={GatewayManager};
