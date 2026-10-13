// Isolated SSH compute node for the real HTTP/Rust/game verifier. Never logs host passwords or tickets.
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),os=require('node:os'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
function localProxyPort(value){if(!value)return undefined;const proxy=new URL(value);assert.equal(proxy.protocol,'http:','Diagnostic proxy must use HTTP');assert(['127.0.0.1','localhost'].includes(proxy.hostname),'Shared diagnostic proxy must be local');assert(!proxy.username&&!proxy.password&&!proxy.search&&!proxy.hash&&proxy.pathname==='/','Unexpected proxy URL components');const port=Number(proxy.port||80);assert(Number.isInteger(port)&&port>0&&port<=65535,'Invalid proxy port');return port;}
async function createRemoteCompute({host,modulePath,base,work,root,target,gameJavaMajor,seedInstallerCache,proxy}) {
 const downloadProxyPort=localProxyPort(proxy);
 const {Client}=require(modulePath||'ssh2');
 const config=JSON.parse(await fs.readFile(path.join(os.homedir(),'.mcp-remote-ssh/config.json'),'utf8'));
 const selected=config.hosts?.[host];assert(selected,'Unknown configured SSH host');
 const ssh=new Client();try { await new Promise((resolve,reject)=>ssh.once('ready',resolve).once('error',reject).connect({host:selected.host,port:selected.port||22,username:selected.username,...(selected.password?{password:selected.password}:{privateKey:require('node:fs').readFileSync(selected.privateKey.replace(/^~/,os.homedir()))}),readyTimeout:20000,keepaliveInterval:15000}));
 const channels=new Set();let closed=false;const forwarding=new Map();
 ssh.on('tcp connection',(details,accept,reject)=>{const localPort=forwarding.get(details.destPort);if(!localPort)return reject();const channel=accept();const socket=net.connect({host:'127.0.0.1',port:Number(localPort)});channels.add(channel);channel.on('close',()=>{channels.delete(channel);socket.destroy()});socket.on('error',()=>channel.destroy());channel.on('error',()=>socket.destroy());channel.pipe(socket).pipe(channel);});
 const exec=command=>new Promise((resolve,reject)=>ssh.exec(command,(error,channel)=>{if(error)return reject(error);let out='',err='';channel.on('data',bytes=>out+=bytes);channel.stderr.on('data',bytes=>err+=bytes);channel.on('close',code=>code===0?resolve(out):reject(Error('Remote command failed ('+code+'): '+err.slice(-2000))))}));
 const sftp=await new Promise((resolve,reject)=>ssh.sftp((err,result)=>err?reject(err):resolve(result)));
 const call=(method,...args)=>new Promise((resolve,reject)=>sftp[method](...args,(err,result)=>err?reject(err):resolve(result)));
 const write=async(file,data)=>{await new Promise((resolve,reject)=>{const stream=sftp.createWriteStream(file,{mode:0o600});stream.on('close',resolve).on('error',reject);stream.end(data)});};
 const home=await call('realpath','.');assert(home.startsWith('/home/'));
 const remoteRoot=home+'/nomadcraft-integration',directory=remoteRoot+'/runs/'+path.basename(work)+'-target',credentialFile=directory+'/credential.json',stopFile=directory+'/stop';
 await exec('mkdir -p '+quote(directory));
 const panelPort=await new Promise((resolve,reject)=>ssh.forwardIn('127.0.0.1',0,(err,port)=>err?reject(err):resolve(port)));forwarding.set(panelPort,Number(new URL(base).port));
 const remoteProxyPort=downloadProxyPort?await new Promise((resolve,reject)=>ssh.forwardIn('127.0.0.1',0,(err,port)=>err?reject(err):resolve(port))):undefined;if(remoteProxyPort)forwarding.set(remoteProxyPort,downloadProxyPort);
 const remoteJava=remoteRoot+'/runtime/java'+gameJavaMajor+'/bin/java',remoteAgent=remoteRoot+'/source/target/debug/nomad-agent';
 await exec('test -x '+quote(remoteJava)+' && test -x '+quote(remoteAgent));
 if(seedInstallerCache){
  const archive=path.join(work,'remote-installer-cache.tar.gz');await new Promise((resolve,reject)=>{const child=spawn('tar',['-czf',archive,'-C',path.join(root,'.nomad/diagnostics/numen-matrix',target),'libraries'],{stdio:'ignore',windowsHide:true});child.on('error',reject).on('exit',code=>code===0?resolve():reject(Error('Cannot archive immutable installer cache')))});
  await call('fastPut',archive,directory+'/installer-cache.tar.gz');await exec('mkdir -p '+quote(directory+'/installer-home/.minecraft')+' && tar -xzf '+quote(directory+'/installer-cache.tar.gz')+' -C '+quote(directory+'/installer-home/.minecraft'));
 }
 return {
  host,directory,stopFile,
  async launch(credential){
   await write(credentialFile,JSON.stringify({...credential,panel:'http://127.0.0.1:'+panelPort}));
   const options='-XX:ActiveProcessorCount=4 -Duser.home='+directory+'/installer-home -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8'+(remoteProxyPort?' -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort='+remoteProxyPort+' -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort='+remoteProxyPort+' -Dhttp.nonProxyHosts=localhost|127.0.0.1':'');
   const command='cd '+quote(directory)+' && export JAVA_TOOL_OPTIONS='+quote(options)+' && exec '+quote(remoteAgent)+' panel-node --credential-file '+quote(credentialFile)+' --data-dir '+quote(directory+'/data')+' --java '+quote(remoteJava)+' --checkpoint-seconds 15 --stop-file '+quote(stopFile);
   const channel=await new Promise((resolve,reject)=>ssh.exec(command,(err,result)=>err?reject(err):resolve(result)));
   channel.exitCode=null;channel.stdout=channel;channel.on('exit',(code,signal)=>{channel.exitCode=code??(signal?1:0)});channel.on('close',()=>{if(channel.exitCode===null)channel.exitCode=1});channel.kill=()=>channel.signal('TERM');return channel;
  },
  async serverDir(epoch){
   const entries=await call('readdir',directory+'/data/sessions');const session=entries.find(entry=>entry.filename.endsWith('-'+epoch));assert(session,'Remote host session directory');
   const remote=directory+'/data/sessions/'+session.filename+'/server',local=path.join(work,'remote-evidence',String(epoch));await fs.mkdir(local,{recursive:true});
   async function copyDir(relative){await fs.mkdir(path.join(local,relative),{recursive:true});for(const entry of await call('readdir',remote+'/'+relative)){assert(!entry.filename.includes('/')&&!entry.filename.includes('..'));const next=relative+'/'+entry.filename;if(entry.attrs.isDirectory())await copyDir(next);else if(entry.attrs.isFile())await call('fastGet',remote+'/'+next,path.join(local,next));}}
   const configStat=await call('stat',remote+'/config').catch(error=>{if(error.code===2)return null;throw error;});if(configStat)await copyDir('config');await copyDir('world/playerdata');await fs.mkdir(path.join(local,'world'),{recursive:true});await call('fastGet',remote+'/world/nomad-proof.txt',path.join(local,'world/nomad-proof.txt'));await call('fastGet',remote+'/ops.json',path.join(local,'ops.json'));return local;
  },
  async stop(){await write(stopFile,'stop')},
  async close(){if(closed)return;closed=true;await call('unlink',credentialFile).catch(()=>{});for(const channel of channels)channel.destroy();await Promise.all([...forwarding.keys()].map(port=>new Promise(resolve=>ssh.unforwardIn('127.0.0.1',port,()=>resolve()))));sftp.end();ssh.end();}
 };
 } catch(error) { ssh.end(); throw error; }
}
module.exports={createRemoteCompute,localProxyPort};
