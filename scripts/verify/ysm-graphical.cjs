// Actual YSM resource admission and graphical scene for the isolated handover verifier.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function setupYsm({root,work,api,raw,instanceId,saveId}){
 const jar=await fs.readFile(path.join(root,'.nomad/diagnostics/numen-live/mods/ysm-2.6.5-fabric+mc1.21.1-release.jar'));
 const catalog=await api('GET','/nomad/catalog/'),instance=catalog.instances.find(i=>i.id===instanceId),previous=instance.releases.at(-1);
 const release=await api('GET','/nomad/distribution/instances/'+instanceId+'/releases/'+previous.id);
 assert(release.manifest,'Existing Numen release manifest required');
 const entry={path:'mods/ysm-2.6.5-fabric+mc1.21.1-release.jar',size:jar.length,sha256:sha(jar),side:'both',ownership:'managed'};
 const draft=await api('POST','/nomad/distribution/instances/'+instanceId+'/publications',{expected:{revision:instance.revision,baseReleaseId:previous.id},manifest:{schema:1,files:[...release.manifest.files,entry]}});
 for(let offset=0;offset<jar.length;offset+=4*1024*1024)await raw('PUT','/nomad/distribution/publications/'+draft.id+'/blobs/'+entry.sha256+'?offset='+offset,jar.subarray(offset,offset+4*1024*1024));
 const published=await api('POST','/nomad/distribution/publications/'+draft.id+'/commit',{});
 await api('PUT','/nomad/catalog/instances/'+instanceId+'/saves/'+saveId+'/release',{releaseId:published.id});
 const yauzl=require(path.join(root,'vendor/kamucl/node_modules/yauzl'));
 const contents=await new Promise((resolve,reject)=>yauzl.open(path.join(root,'.nomad/cache/fixtures/ysm-default.zip'),{lazyEntries:true},(error,zip)=>{if(error)return reject(error);const rows=[];zip.on('error',reject);zip.on('end',()=>resolve(rows));zip.on('entry',entry=>{if(entry.fileName.endsWith('/'))return zip.readEntry();zip.openReadStream(entry,(error,stream)=>{if(error)return reject(error);const chunks=[];stream.on('error',reject);stream.on('data',b=>chunks.push(b));stream.on('end',()=>{rows.push({path:'config/yes_steve_model/custom/nc-proof/'+entry.fileName,bytes:Buffer.concat(chunks)});zip.readEntry()})})});zip.readEntry()}));
 const manifest={schema:1,files:contents.map(file=>({path:file.path,size:file.bytes.length,sha256:sha(file.bytes),side:'both',ownership:'managed'}))};
 const application=await api('POST','/nomad/bots/models',{instanceId,saveId,name:'nc-proof',manifest});
 for(const file of contents)await raw('PUT','/nomad/bots/models/'+application.id+'/blobs/'+sha(file.bytes),file.bytes);
 const pending=await api('POST','/nomad/bots/models/'+application.id+'/commit',{});assert.equal(pending.status,'pending');
 await fs.writeFile(path.join(work,'ysm-resource-admission.json'),JSON.stringify({jar:entry,modelApplicationId:application.id,manifest,status:pending.status},null,2));
 return {id:application.id,revision:pending.revision,manifest};
}
async function approveYsm({api,application,instanceId,saveId,until,epoch}){
 await api('POST','/nomad/bots/models/'+application.id+'/review',{revision:application.revision,decision:'approve',reason:'Isolated actual multiplayer rendering verification'});
 await until(async()=>{const list=await api('GET','/nomad/bots/models?instanceId='+instanceId+'&saveId='+saveId);const current=list.find(m=>m.id===application.id);if(current?.deployment?.state==='failed')throw Error('Actual YSM model deployment failed');return current?.deployment?.epoch===epoch&&current.deployment.state==='reload-requested'},'actual approved YSM deployment and hot reload',120000);
}
async function scene({gfx,label,work}){
 await new Promise(r=>setTimeout(r,5000));gfx.check();await gfx.capture('ysm-'+label);assert((await fs.stat(path.join(work,'graphical-ysm-'+label+'.png'))).size>1000,'Actual game screenshot missing or empty');
}
module.exports={setupYsm,approveYsm,scene};
