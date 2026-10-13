// Genuine cloud-synchronized graphical player for the HTTP/Rust host-handover verifier.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{execFile}=require('node:child_process');
const {verifyTcpRetention}=require('./tcp-retention.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function seedImmutableCache(from,to){
 const stat=await fs.lstat(from);assert(!stat.isSymbolicLink(),'Diagnostic runtime cache must not redirect elsewhere');
 if(stat.isDirectory()){await fs.mkdir(to,{recursive:true});for(const entry of await fs.readdir(from))await seedImmutableCache(path.join(from,entry),path.join(to,entry));}
 else if(stat.isFile()){await fs.mkdir(path.dirname(to),{recursive:true});try{await fs.link(from,to)}catch(error){if(error.code!=='EXDEV')throw error;await fs.copyFile(from,to)}}
}
async function createGraphicalPlayer({root,target,address,work,playwrightModule,cloud,signedSession,closeOwnedWindow=false}){
 const vanilla=target.endsWith('-vanilla');
 const cached=JSON.parse(await fs.readFile(path.join(root,'.nomad/diagnostics/reports/modded-client-runtime-'+target+'.json'),'utf8'));
 const cachedRoot=path.resolve(root,'.nomad/diagnostics','modded-client-'+target);
 assert.equal(path.resolve(cached.work),cachedRoot);assert.equal(path.resolve(cached.entry),path.join(cachedRoot,'desktop.cjs'));assert(path.resolve(cached.instance).startsWith(cachedRoot+path.sep));
 assert(path.resolve(work).startsWith(path.resolve(root,'.nomad/diagnostics')+path.sep));
 const clientWork=path.join(work,'client'),game=path.join(clientWork,'game'),profile=path.join(clientWork,'profile'),entry=path.join(clientWork,'desktop.cjs');
 await fs.mkdir(profile,{recursive:true});await fs.mkdir(path.join(clientWork,'appdata'),{recursive:true});
 // Only immutable libraries/assets are shared by hard link. No account, world, config or prior sync journal is copied.
 for(const top of['libraries','assets'])await seedImmutableCache(path.join(cached.game,top),path.join(game,top));
 for(const version of await fs.readdir(path.join(cached.game,'versions'))){const from=path.join(cached.game,'versions',version);if(!(await fs.stat(from)).isDirectory())continue;for(const file of await fs.readdir(from))if(file===version+'.json'||file===version+'.jar'){await fs.mkdir(path.join(game,'versions',version),{recursive:true});await fs.copyFile(path.join(from,file),path.join(game,'versions',version,file));}}
 const runtime={...cached,work:clientWork,game,profile,entry,instance:path.join(game,'versions',cached.instanceId)};
 await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({folders:[{id:'proof',name:'Isolated live cloud client',path:game,isDefault:true}],gameDir:game,activeFolder:game,defaultIsolation:true,startupAnimation:false,autoUpdate:false,javaPath:cached.java,memoryAuto:false,memoryMB:768,jvmArgs:'-Xms128M -XX:ActiveProcessorCount=4 -XX:G1PeriodicGCInterval=1000',mirror:'official',closeAfterLaunch:false,resolution:{width:854,height:480,mode:'windowed',fullscreen:false}}));
 await fs.writeFile(entry,'const {app,session}=require("electron");process.chdir('+JSON.stringify(clientWork)+');app.setPath("appData",'+JSON.stringify(path.join(clientWork,'appdata'))+');app.setPath("userData",'+JSON.stringify(profile)+');process.env.JAVA_TOOL_OPTIONS="-XX:ActiveProcessorCount=4 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7897 -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=7897 -Dhttp.nonProxyHosts=localhost|127.0.0.1 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8";app.whenReady().then(()=>session.defaultSession.setProxy({proxyRules:"http=127.0.0.1:7897;https=127.0.0.1:7897",proxyBypassRules:"<local>"}));require('+JSON.stringify(path.join(root,'vendor/kamucl/out/main/index.js'))+');');
 const {_electron}=require(playwrightModule);let electron,page,gamePage,registeredSignedFolder=false,discovery,originalSocket,watch,failure,started=Date.now(),closing=false;
 async function until(fn,label,timeout=180000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(failure)throw failure;const result=await fn();if(result)return result;await delay(200)}throw Error('Timed out '+label)}
 async function frontendClosed(){const directory=path.join(work,'data/NomadGateways'),username=signedSession?.identity.username||'NCProxyPlayer';for(const id of await fs.readdir(directory)){const text=await fs.readFile(path.join(directory,id,'logs/latest.log'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error});if(text.split(/\r?\n/).some(line=>line.includes('[connected player] '+username+' (')&&line.includes('has disconnected')))return true;}return false;}
 async function verifyRetained(){return verifyTcpRetention({expected:originalSocket,read:socket,frontendClosed});}
 async function socket(){
  if(!discovery)return;
  const stdout=await new Promise((r,j)=>execFile('netstat.exe',['-ano','-p','tcp'],{windowsHide:true,timeout:5000,maxBuffer:2*1024*1024},(error,out)=>error?j(error):r(out)));
  const gatewayPort=address.slice(address.lastIndexOf(':')+1);
  const rows=String(stdout).split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(p=>p[0]==='TCP'&&p[4]===String(discovery.pid));const tuple=rows.find(p=>p[2]==='127.0.0.1:'+gatewayPort&&p[3]==='ESTABLISHED')?.slice(1,3).join(' -> ');await fs.appendFile(path.join(work,'graphical-tcp-samples.jsonl'),JSON.stringify({at:Date.now(),pid:discovery.pid,expected:originalSocket,tuple,rows})+'\n');return tuple;
 }
 async function command(value){
  const response=await fetch('http://127.0.0.1:'+discovery.port+'/kamucl/v1/player-command',{method:'POST',headers:{'X-Kamucl-Token':discovery.token,'Content-Type':'application/json'},body:JSON.stringify({command:value}),signal:AbortSignal.timeout(15000)});
  const receipt=await response.json();assert.equal(response.status,200,JSON.stringify(receipt));assert.equal(receipt.identity,'current-player');return receipt;
 }
 async function close(){
  closing=true;clearInterval(watch);failure=undefined;
  if(gamePage&&!gamePage.isClosed()){await fs.writeFile(path.join(work,'graphical-player-log.json'),JSON.stringify(await gamePage.evaluate(()=>({states:window.proofLaunchStates,lines:window.proofGameLog})),null,2)).catch(()=>{});if(!signedSession&&!closeOwnedWindow)await gamePage.evaluate(()=>window.kamucl.invoke('game:kill')).catch(()=>{});else if(discovery)await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/verify/close-owned-game.ps1'),'-GamePid',String(discovery.pid),'-GameDirectory',runtime.instance],{windowsHide:true,timeout:10000},error=>error?reject(Error('Owned diagnostic game window refused the close request')):resolve()));}
  if(discovery){const exited=until(()=>{try{process.kill(discovery.pid,0);return false}catch{return true}},'owned graphical game exit',45000);if(signedSession||closeOwnedWindow)await exited;else await exited.catch(()=>{});}
  if(signedSession&&gamePage&&!gamePage.isClosed()){await gamePage.evaluate(()=>{window.proofObserverCleanup?.();delete window.proofObserverCleanup}).catch(()=>{});if(registeredSignedFolder)await gamePage.evaluate(folder=>window.kamucl.invoke('folders:remove',folder),runtime.game).catch(()=>{});}
  if(electron)await electron.close().catch(()=>{});
 }
 try{
  electron=await _electron.launch({executablePath:path.join(root,'vendor/kamucl/node_modules/electron/dist/electron.exe'),args:[entry],timeout:30000});
  electron.process().stderr?.on('data',bytes=>fs.appendFile(path.join(work,'graphical-launcher.log'),bytes).catch(()=>{}));
  page=await electron.firstWindow();await page.getByRole('button',{name:'开始游戏',exact:true}).waitFor({timeout:45000});await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
  gamePage=signedSession?.page||page;
  await gamePage.evaluate(({id,folder})=>{window.proofLaunchStates=[];window.proofGameLog=[];const stateOff=window.kamucl.on('event:launchState',state=>{if(state.versionId===id&&state.folder===folder)window.proofLaunchStates.push(state)});const logOff=window.kamucl.on('event:launchLog',line=>window.proofGameLog=window.proofGameLog.concat(line).slice(-4000));window.proofObserverCleanup=()=>{stateOff();logOff()}},{id:runtime.instanceId,folder:runtime.game});
  await page.evaluate(async({id,signed})=>{await window.kamucl.invoke('versions:installed',true);await window.kamucl.invoke('versions:setIsolation',id,true);if(!signed){const account=await window.kamucl.invoke('accounts:addOffline','NCProxyPlayer');await window.kamucl.invoke('accounts:select',account.id)}},{id:runtime.instanceId,signed:!!signedSession});
  assert(cloud,'Combined verifier requires an actual cloud service login');const storage=path.join(clientWork,'cloud');await fs.mkdir(storage,{recursive:true});
  const prepared=await page.evaluate(async({cloud,storage,target,vanilla})=>{await window.kamucl.invoke('nomad:setStorage',storage);await window.kamucl.invoke('nomad:login',cloud.address,cloud.username,cloud.password);const ref={instanceId:cloud.instanceId,saveId:cloud.saveId};await window.kamucl.invoke('nomad:distribution:bind',ref,target);const prepared=await window.kamucl.invoke('nomad:distribution:prepare',ref);if(!vanilla){const bridge=await window.kamucl.invoke('bridge:install',prepared.target.id);if(!bridge.ok)throw Error(bridge.error);}const join=await window.kamucl.invoke('nomad:distribution:join',ref);return {...prepared,join}}, {cloud,storage,vanilla,target:{id:runtime.instanceId,folder:runtime.game}});
  if(vanilla){const clientMods=await fs.readdir(path.join(runtime.instance,'mods')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});assert(!clientMods.some(file=>file.endsWith('.jar')),'Vanilla graphical proof must not install client MODs');}
  assert.equal(prepared.state,'ready');assert.equal(prepared.address,address);assert.equal(prepared.join.address,address);assert.equal(prepared.target.id,runtime.instanceId);assert.equal(path.resolve(prepared.target.folder),path.resolve(runtime.game));
  const parentToken=await page.evaluate(async()=>((await window.kamucl.invoke('nomad:webToken')).token));assert.equal(typeof parentToken,'string');
  await fs.writeFile(path.join(work,'graphical-cloud-preparation.json'),JSON.stringify({target:prepared.target,state:prepared.state,releaseId:prepared.releaseId,address:prepared.address},null,2));
  if(signedSession){await page.evaluate(({id,folder,java})=>window.kamucl.invoke('versions:setJava',id,java,false,folder),{id:runtime.instanceId,folder:runtime.game,java:runtime.java});await page.evaluate(({id,folder})=>window.kamucl.invoke('versions:setResolution',id,{width:854,height:480,mode:'windowed',fullscreen:false},folder),{id:runtime.instanceId,folder:runtime.game});const selected=await gamePage.evaluate(async()=>{const account=await window.kamucl.invoke('accounts:selected');return account?{type:account.type,username:account.username,uuid:account.uuid}:null});assert.deepEqual(require('./signed-session.cjs').microsoftIdentity(selected),signedSession.identity,'Selected Microsoft identity changed during preparation');const existing=await gamePage.evaluate(()=>window.kamucl.invoke('folders:list'));registeredSignedFolder=!existing.folders.some(folder=>path.resolve(folder.path).toLowerCase()===path.resolve(runtime.game).toLowerCase());if(registeredSignedFolder)await gamePage.evaluate(folder=>window.kamucl.invoke('folders:add',folder),runtime.game);}
  await gamePage.evaluate(({id,address,folder})=>window.kamucl.invoke('game:launch',id,address,folder),{id:runtime.instanceId,address,folder:runtime.game});
  await until(async()=>{const error=await gamePage.evaluate(()=>window.proofLaunchStates.find(s=>s.status==='error'));if(error)throw Error(error.text);try{const record=JSON.parse(await fs.readFile(vanilla?path.join(signedSession?.profile||profile,'running-game.json'):path.join(runtime.instance,'.kamucl-bridge.json'),'utf8'));if((vanilla?Date.parse(record.startedAt):Number(record.startedAt))<started)return false;process.kill(record.pid,0);discovery=record;return true}catch{return false}},'fresh graphical bridge');
  return {
   username:signedSession?.identity.username||'NCProxyPlayer',runtime,parentToken,command,close,
   check(){if(failure)throw failure;},
   chatContains:async marker=>(await gamePage.evaluate(()=>window.proofGameLog)).some(line=>String(line).includes(marker)),
   async connected(){originalSocket=await until(async()=>{const candidate=await socket();if(!candidate)return;await delay(150);return await socket()===candidate?candidate:undefined},'stable graphical player gateway socket');let checking=false;watch=setInterval(async()=>{if(checking)return;checking=true;try{if(!closing)await verifyRetained()}catch(error){if(!closing)failure=error}finally{checking=false}},500);return originalSocket;},
   async assertRetained(){if(failure)throw failure;await verifyRetained();return originalSocket;},
   async capture(label){await new Promise(r=>execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/verify/capture-owned-game.ps1'),'-GamePid',String(discovery.pid),'-OutputPath',path.join(work,'graphical-'+label+'.png')],{windowsHide:true,timeout:10000},error=>{if(error)console.log('CAPTURE unavailable: '+label);r()}));}
  };
 }catch(error){await close();throw error;}
}
module.exports={createGraphicalPlayer,seedImmutableCache};
