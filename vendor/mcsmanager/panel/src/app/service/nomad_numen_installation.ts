import fs from "fs";
import path from "path";
import crypto from "crypto";
import {Readable} from "stream";
import {modIds} from "./nomad_mod_metadata";
import {CatalogError,NomadCatalog} from "./nomad_catalog";
import {NomadDistribution} from "./nomad_distribution";
import type {CatalogActor} from "../../../../shared/nomad-catalog";
import type {DistributionFile} from "../../../../shared/nomad-distribution";
const targets:Record<string,{hash:string;file:string}>={
 "1.20.1-fabric":{hash:"804ccf75021d0a19825f1fe5cdd8864e4585c9cda5ed8665e7abb267559fddd6",file:"numen-fabric-1.20.1-0.1.4.1.jar"},
 "1.20.1-forge":{hash:"e8b95d53bc524cc5d4326edfcbedc76aa2ce9dee0fa5db2f30a962d4797c5ea4",file:"numen-forge-1.20.1-0.1.4.1-all.jar"},
 "1.21.1-fabric":{hash:"ccc0806fd04cf3404dbc39f7579a4d7c20cd1362d06dce358850f5fdaf711a41",file:"numen-fabric-1.21.1-0.1.4.1.jar"},
 "1.21.1-neoforge":{hash:"ed4a5936aa182b0d9ab685cb993da54f72514eafb0838bb9a64cd69962cb1226",file:"numen-neoforge-1.21.1-0.1.4.1.jar"}
};
const fabricApis:Record<string,{file:string;url:string;hash:string}>={
 "1.20.1":{file:"fabric-api-0.92.12+1.20.1.jar",url:"https://cdn.modrinth.com/data/P7dR8mSH/versions/rvI2dfzR/fabric-api-0.92.12%2B1.20.1.jar",hash:"4197ff4fbdac13cffccd267c1bc59e9fbabb2b5683a9d5f8023f4b5ea16a1c1e"},
 "1.21.1":{file:"fabric-api-0.116.7+1.21.1.jar",url:"https://cdn.modrinth.com/data/P7dR8mSH/versions/m6zu1K31/fabric-api-0.116.7%2B1.21.1.jar",hash:"08018cc48c97415a38016a00dbd5a2c7a460ba6b7a051690a8cb3dbb5e8482a4"}
};
async function download(url:string,hash:string):Promise<Buffer>{
 const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok||!response.body)throw new CatalogError(502,"numen_download_failed");
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of response.body as any){size+=chunk.length;if(size>32*1024*1024)throw new CatalogError(413,"numen_download_too_large");chunks.push(Buffer.from(chunk));}
 const bytes=Buffer.concat(chunks);if(crypto.createHash("sha256").update(bytes).digest("hex")!==hash)throw new CatalogError(422,"numen_download_hash_mismatch");return bytes;
}
/** Publish one immutable, coherent client/server environment. Never edits a running world. */
export class NomadNumenInstallation {
 private locks=new Set<string>();
 constructor(private catalog:NomadCatalog,private distribution:NomadDistribution,private adapterDirectory=__dirname,private fetchArtifact=download){}
 async plan(actor:CatalogActor,instanceId:string,saveId?:string){
  await this.catalog.checkPublish(actor,instanceId);
  const instance=await this.distribution.instance(actor,instanceId),save=saveId?instance.saves.find(s=>s.id===saveId):undefined;
  if(saveId&&!save)throw new CatalogError(403,"save_not_found");
  const release=instance.releases?.slice(-1)[0];if(!release)throw new CatalogError(409,"numen_release_required");
  if(save&&save.releaseId!==release.id)throw new CatalogError(409,"numen_save_release_not_latest");
  const target=`${release.profile.mcVersion}-${release.server?.type}`;
  if(!targets[target]||release.profile.loader!==release.server?.type)throw new CatalogError(409,"numen_target_unsupported");
  const minimum=release.profile.loader==="fabric"?(release.profile.mcVersion==="1.20.1"?"0.15.11":"0.18.1"):release.profile.loader==="neoforge"?"21.1.233":"47.0.0";
  const installedVersion=release.profile.loaderVersion?.replace(/^1\.20\.1-/,"");
  if(installedVersion){const actual=installedVersion.split(".").map(Number),required=minimum.split(".").map(Number);let comparison=0;for(let index=0;index<3;index++){const difference=(actual[index]??0)-required[index];if(difference){comparison=difference;break;}}if(actual.some(n=>!Number.isFinite(n))||comparison<0)throw new CatalogError(409,"numen_loader_update_required");}
  if(!release.manifest&&!(release.source==="official"&&release.fileCount===0))throw new CatalogError(409,"numen_manifest_required");
  const adapterFile=`nomad-numen-adapter-${release.profile.loader}-${release.profile.mcVersion}.jar`;
  if(!fs.existsSync(path.join(this.adapterDirectory,adapterFile)))throw new CatalogError(503,"bot_adapter_package_missing");
  const expectedHashes=[targets[target].hash,crypto.createHash("sha256").update(fs.readFileSync(path.join(this.adapterDirectory,adapterFile))).digest("hex"),...(release.profile.loader==="fabric"?[fabricApis[release.profile.mcVersion].hash]:[])];
  const alreadyInstalled=expectedHashes.every(hash=>release.manifest?.files.some(file=>file.sha256===hash&&file.side==="both"&&file.ownership==="managed"));
  return {alreadyInstalled,target,baseReleaseId:release.id,revision:instance.revision,saveId:save?.id,needsStop:save?.room?.desiredState==="open"||!!save?.hosting&&!['stopped','failed'].includes(save.hosting.phase),files:[targets[target].file,adapterFile,...(release.profile.loader==="fabric"?[fabricApis[release.profile.mcVersion].file]:[])],release};
 }
 async install(actor:CatalogActor,instanceId:string,input:{saveId?:string;revision:number;baseReleaseId:string;confirm?:boolean}){
  if(input.confirm!==true)throw new CatalogError(400,"numen_install_confirmation_required");
  if(this.locks.has(instanceId))throw new CatalogError(409,"numen_install_busy");this.locks.add(instanceId);
  try{
   const plan=await this.plan(actor,instanceId,input.saveId);
   if(plan.revision!==input.revision||plan.baseReleaseId!==input.baseReleaseId)throw new CatalogError(409,"publication_base_conflict");
   if(plan.alreadyInstalled)return {releaseId:plan.baseReleaseId,saveId:plan.saveId,files:plan.files,restartRequired:false};
   if(plan.needsStop)throw new CatalogError(409,"numen_close_room_first");
   const target=targets[plan.target],replacementIds=new Set(["numen","nomad_numen_adapter",...(plan.release.profile.loader==="fabric"?["fabric-api"]:[])]),files:DistributionFile[]=[];
   for(const file of plan.release.manifest?.files??[]){if(file.path.startsWith("mods/")&&file.path.endsWith(".jar")&&(await modIds(this.distribution.blob(file.sha256))).some(id=>replacementIds.has(id)))continue;files.push(file);}
   const additions:Array<{file:string;bytes:Buffer}>=[];
   additions.push({file:target.file,bytes:await this.fetchArtifact(`https://github.com/Dwinovo/minecraft-numen/releases/download/v0.1.4.1-${plan.release.profile.mcVersion}-beta/${target.file}`,target.hash)});
   const adapter=plan.files[1];additions.push({file:adapter,bytes:fs.readFileSync(path.join(this.adapterDirectory,adapter))});
   if(plan.release.profile.loader==="fabric"){const api=fabricApis[plan.release.profile.mcVersion];additions.push({file:api.file,bytes:await this.fetchArtifact(api.url,api.hash)});}
   for(const added of additions)files.push({path:"mods/"+added.file,sha256:crypto.createHash("sha256").update(added.bytes).digest("hex"),size:added.bytes.length,side:"both",ownership:"managed"});
   const draft=await this.distribution.create(actor,instanceId,{expected:{revision:plan.revision,baseReleaseId:plan.baseReleaseId},manifest:{schema:1,files}});
   try{for(const added of additions){const hash=crypto.createHash("sha256").update(added.bytes).digest("hex");for(let offset=0;offset<added.bytes.length;offset+=4*1024*1024)await this.distribution.chunk(actor,draft.id,hash,offset,Readable.from([added.bytes.subarray(offset,offset+4*1024*1024)]));}
    const release=await this.distribution.commit(actor,draft.id);
    if(plan.saveId)await this.catalog.bindRelease(actor,instanceId,plan.saveId,release.id);
    return {releaseId:release.id,saveId:plan.saveId,files:plan.files,restartRequired:true};
   }catch(error){await this.distribution.cancel(actor,draft.id).catch(()=>{});throw error;}
  }finally{this.locks.delete(instanceId);}
 }
}
