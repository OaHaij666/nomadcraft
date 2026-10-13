// Actual upstream download/hash checks and publication services. No game or HTTP identity claim.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
// Imported panel services own housekeeping timers; this isolated one-shot runner does not need them to retain the process.
const nativeInterval=global.setInterval;global.setInterval=(...args)=>{const timer=nativeInterval(...args);timer.unref();return timer};
const root=path.resolve(__dirname,'../..');
const testProxy=process.env.NC_TEST_PROXY||process.argv.find(arg=>arg.startsWith('--proxy='))?.slice(8);let proxy;if(testProxy){proxy=new(require(path.join(root,'vendor/kamucl/node_modules/undici')).ProxyAgent)(testProxy);const nativeFetch=global.fetch;global.fetch=(url,options)=>nativeFetch(url,{...options,dispatcher:proxy})}

const Module=require('node:module'),nativeResolve=Module._resolveFilename;Module._resolveFilename=function(request,...args){return nativeResolve.call(this,request.startsWith('@languages/')?path.join(root,'vendor/mcsmanager/languages',request.slice(11)):request,...args)};
const syncFs=require('node:fs');syncFs.mkdirSync(path.join(root,'.nomad/diagnostics'),{recursive:true});process.chdir(syncFs.mkdtempSync(path.join(root,'.nomad/diagnostics/numen-installation-real-')));
require(path.join(root,'vendor/kamucl/node_modules/tsx/dist/cjs/index.cjs'));
const {NomadCatalog}=require(path.join(root,'vendor/mcsmanager/panel/src/app/service/nomad_catalog.ts'));
const {NomadDistribution}=require(path.join(root,'vendor/mcsmanager/panel/src/app/service/nomad_distribution.ts'));
const {NomadNumenInstallation}=require(path.join(root,'vendor/mcsmanager/panel/src/app/service/nomad_numen_installation.ts'));
const {DEFAULT_PROFILE,DEFAULT_SERVER,DEFAULT_RULES}=require(path.join(root,'vendor/mcsmanager/shared/nomad-catalog.ts'));
const owner={id:'installation-proof',name:'Installation proof',admin:true},checks=[];
(async()=>{
await fs.mkdir(path.join(root,'.nomad/diagnostics'),{recursive:true});const work=process.cwd();
let records={};const storage={load:async(c,_ctor,id)=>records[c+id]?structuredClone(records[c+id]):null,store:async(c,id,value)=>{records[c+id]=structuredClone(value);await fs.writeFile(path.join(work,'records.json'),JSON.stringify(records))}};
const catalog=new NomadCatalog(()=>storage),distribution=new NomadDistribution(()=>storage,catalog,path.join(work,'distribution'));
const installer=new NomadNumenInstallation(catalog,distribution,path.join(root,'apps/numen-adapter/dist'));
for(const [minecraft,loader,version] of [['1.20.1','fabric','0.19.5'],['1.20.1','forge','47.4.10'],['1.21.1','fabric','0.19.5'],['1.21.1','neoforge','21.1.233']]){
 const target=minecraft+'-'+loader,release={id:'base-'+target,format:'modrinth',source:'official',fileName:'empty-proof-runtime.mrpack',sha256:'a'.repeat(64),size:0,fileCount:0,profile:{...DEFAULT_PROFILE,mcVersion:minecraft,loader,loaderVersion:version},server:{...DEFAULT_SERVER,type:loader,version,eulaAccepted:true},publishedAt:Date.now(),publishedBy:owner.id};
 const instance=await catalog.create(owner,{name:target,description:'Isolated actual artifact publication proof',profile:release.profile},release),save=await catalog.save(owner,instance.id,null,{name:'Proof world',description:'',rules:DEFAULT_RULES});
 const plan=await installer.plan(owner,instance.id,save.id);const result=await installer.install(owner,instance.id,{saveId:save.id,revision:plan.revision,baseReleaseId:plan.baseReleaseId,confirm:true});
 const view=(await catalog.list(owner)).instances.find(i=>i.id===instance.id),published=view.releases.find(r=>r.id===result.releaseId);assert.equal(view.saves[0].releaseId,result.releaseId);assert(published.manifest.files.length>=2);
 for(const file of published.manifest.files){const bytes=await fs.readFile(distribution.blob(file.sha256));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),file.sha256);assert.equal(file.side,'both')}
 const installed=await installer.plan(owner,instance.id,save.id);assert.equal(installed.alreadyInstalled,true);const again=await installer.install(owner,instance.id,{saveId:save.id,revision:installed.revision,baseReleaseId:installed.baseReleaseId,confirm:true});assert.equal(again.releaseId,result.releaseId);assert.equal(again.restartRequired,false);
 checks.push({target,files:published.manifest.files.map(f=>({path:f.path,sha256:f.sha256,size:f.size})),passed:true});console.log('PASS '+target+' real upstream Numen/dependency download, fixed hashes, save binding and idempotent publication');
}
await fs.mkdir(path.join(root,'.nomad/diagnostics/reports'),{recursive:true});await fs.writeFile(path.join(root,'.nomad/diagnostics/reports/numen-installation-real-proof.json'),JSON.stringify({at:new Date().toISOString(),work,checks,classification:'Actual publication/catalog/distribution services and unmodified upstream downloads with fixed hash checks for four targets. Isolated persisted test storage and minimal empty base release fixtures. Does not launch Minecraft or validate HTTP/Microsoft login.'},null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(proxy)await proxy.destroy()});
