// Build unmodified upstream VanillaCord and Bridge sources into an isolated cache.
// No Minecraft artifacts are downloaded or distributed by this build step.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const sources=[{name:'Bridge',commit:'cac7ab1cf177f68be28637200b7abe4e75c7a408',sha256:'fb31e3ba3af4baa2ab9a8a166d973bc3d1a5efac7c6d5b576e6b9a4aecc641c1'},{name:'VanillaCord',commit:'8d4493ac76052ff6ba68ce498f2bd5d7f5dae859',sha256:'8e14f6b30b41e2ef3fc090cb54c8777d23f8cc10ae88b75c8f96b0bf2dafefd9'}];
const arg=(name,fallback)=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3)||fallback;
async function run(command,args,options={}){await new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'inherit',windowsHide:true,...options});child.on('error',reject).on('exit',code=>code===0?resolve():reject(Error(command+' exited '+code)));});}
async function main(){
 const directory=path.resolve(arg('cache',path.join(root,'.nomad/cache/vanillacord-build'))),maven=path.resolve(arg('maven',''));assert(process.argv.some(v=>v.startsWith('--maven=')),'Pass --maven=<Maven mvn.cmd or mvn>');
 const javaHome=arg('java-home',process.env.JAVA_HOME);assert(javaHome,'Pass --java-home or set JAVA_HOME');
 let dispatcher;const proxy=arg('proxy','');if(proxy)dispatcher=new(require(path.join(root,'vendor/kamucl/node_modules/undici')).ProxyAgent)(proxy);
 const fetcher=dispatcher?require(path.join(root,'vendor/kamucl/node_modules/undici')).fetch:fetch;
 await fs.mkdir(directory,{recursive:true});
 try{
 for(const source of sources){const archive=path.join(directory,source.name+'.tar.gz');let bytes=await fs.readFile(archive).catch(()=>undefined);if(!bytes){const response=await fetcher('https://codeload.github.com/ME1312/'+source.name+'/tar.gz/'+source.commit,{dispatcher,signal:AbortSignal.timeout(120000)});assert(response.ok,'Upstream source download failed: '+response.status);bytes=Buffer.from(await response.arrayBuffer());await fs.writeFile(archive,bytes,{flag:'wx'});}assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),source.sha256,'Fixed source archive checksum mismatch');await run('tar',['-xzf',archive,'-C',directory]);}
 const bridge=path.join(directory,'Bridge-'+sources[0].commit),vanilla=path.join(directory,'VanillaCord-'+sources[1].commit);
 async function resolveVersions(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await resolveVersions(file);else if(entry.name==='pom.xml'){const pom=await fs.readFile(file,'utf8');await fs.writeFile(file,pom.replaceAll('-PLACEHOLDER','24w25a'));}}}
 await resolveVersions(bridge);const pom=path.join(vanilla,'pom.xml');await fs.writeFile(pom,(await fs.readFile(pom,'utf8')).replace('<version>-PLACEHOLDER</version>','<version>2.0</version>'));
 const settings=arg('settings','');const common=['-B',...(settings?['-s',path.resolve(settings)]:[]),'-Dmaven.repo.local='+path.join(directory,'repository'),'-DskipTests','-Dproject.build.sourceEncoding=UTF-8'];
 const env={...process.env,JAVA_HOME:javaHome};
 async function mvn(args){if(process.platform==='win32'){const all=[maven,...args];assert(all.every(value=>![34,37,10,13].some(code=>value.includes(String.fromCharCode(code)))),'Unsafe Maven argument');const command=all.map(value=>'"'+value+'"').join(' ');await run(process.env.ComSpec||'cmd.exe',['/d','/s','/c','"'+command+'"'],{env,windowsVerbatimArguments:true});}else await run(maven,args,{env});}
 await mvn([...common,'-f',path.join(bridge,'pom.xml'),'-pl','bridge,bridge-asm,bridge-plugin','-am','install']);await mvn([...common,'-f',pom,'package']);
 const artifact=path.join(vanilla,'artifacts/VanillaCord.jar'),bytes=await fs.readFile(artifact),output=path.join(root,'apps/gateway/.cache/vanillacord-2.0.jar');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,bytes);
 await fs.writeFile(output+'.json',JSON.stringify({schema:1,sources,javaSourceModified:false,pomChanges:['Resolved Bridge version to 24w25a','Resolved VanillaCord version to 2.0'],sha256:crypto.createHash('sha256').update(bytes).digest('hex')},null,2));
 console.log('Built original VanillaCord: '+output);
 }finally{if(dispatcher)await dispatcher.close();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1});
module.exports={sources};
