import {it,expect,vi,afterEach} from "vitest";
import fs from "fs/promises";import path from "path";import os from "os";import crypto from "crypto";import {Readable} from "stream";import * as yazl from "yazl";
import {NomadCatalog} from "../nomad_catalog";import {NomadDistribution} from "../nomad_distribution";import {NomadNumenInstallation} from "../nomad_numen_installation";
import {DEFAULT_PROFILE,DEFAULT_RULES,DEFAULT_SERVER} from "../../../../../shared/nomad-catalog";
const owner={id:"owner",name:"Owner",admin:true};
async function zip(files:Record<string,string>){const z=new yazl.ZipFile();for(const [name,data] of Object.entries(files))z.addBuffer(Buffer.from(data),name);const parts:Buffer[]=[];const promise=new Promise<Buffer>((resolve,reject)=>{z.outputStream.on("data",b=>parts.push(b));z.outputStream.on("error",reject);z.outputStream.on("end",()=>resolve(Buffer.concat(parts)));});z.end();return promise;}
afterEach(()=>vi.unstubAllGlobals());
it("publishes coherent client/server Numen files while preserving unrelated mods/config, then binds only the selected save",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"nomad-numen-install-"));let records:any={};const storage:any={load:async(c:string,_ctor:any,id:string)=>records[c+id]?structuredClone(records[c+id]):null,store:async(c:string,id:string,v:any)=>{records[c+id]=structuredClone(v);}};
 const catalog=new NomadCatalog(()=>storage),distribution=new NomadDistribution(()=>storage,catalog,path.join(dir,"NomadDistribution"));
 const base:any={id:"base",format:"modrinth",source:"official",fileName:"official",sha256:"a".repeat(64),size:0,fileCount:0,profile:{...DEFAULT_PROFILE,mcVersion:"1.21.1",loader:"fabric",loaderVersion:"0.19.5"},server:{...DEFAULT_SERVER,type:"fabric",version:"0.19.5",eulaAccepted:true},publishedAt:Date.now(),publishedBy:owner.id};
 try{
 const instance=await catalog.create(owner,{name:"Friends",description:"",profile:base.profile},base);
 const oldNumen=await zip({"fabric.mod.json":JSON.stringify({id:"numen",version:"old"})}),other=await zip({"fabric.mod.json":JSON.stringify({id:"other_mod",version:"1"})}),config=Buffer.from("keep=true");
 const fixtures=[{path:"mods/renamed-companion.jar",bytes:oldNumen},{path:"mods/other.jar",bytes:other},{path:"config/friends.properties",bytes:config}];
 const draft=await distribution.create(owner,instance.id,{expected:{revision:instance.revision,baseReleaseId:base.id},manifest:{schema:1,files:fixtures.map(f=>({path:f.path,size:f.bytes.length,sha256:crypto.createHash("sha256").update(f.bytes).digest("hex"),side:"both",ownership:"managed"}))}});
 for(const f of fixtures)await distribution.chunk(owner,draft.id,crypto.createHash("sha256").update(f.bytes).digest("hex"),0,Readable.from([f.bytes]));
 const release=await distribution.commit(owner,draft.id);const save=await catalog.save(owner,instance.id,null,{name:"World",description:"",rules:DEFAULT_RULES});await catalog.bindRelease(owner,instance.id,save.id,release.id);
 const adapterFile="nomad-numen-adapter-fabric-1.21.1.jar";await fs.writeFile(path.join(dir,adapterFile),await zip({"fabric.mod.json":JSON.stringify({id:"nomad_numen_adapter"})}));
 let fetched=0;const installer=new NomadNumenInstallation(catalog,distribution,dir,async url=>{fetched++;return zip({"fabric.mod.json":JSON.stringify({id:url.includes("fabric-api")?"fabric-api":"numen",version:"0.1.4.1"})});});
 const plan=await installer.plan(owner,instance.id,save.id);
 await expect(installer.install({id:"guest",name:"Guest",admin:false},instance.id,{saveId:save.id,baseReleaseId:release.id,revision:plan.revision,confirm:true})).rejects.toMatchObject({status:403});expect(fetched).toBe(0);
 const result=await installer.install(owner,instance.id,{saveId:save.id,baseReleaseId:release.id,revision:plan.revision,confirm:true});expect(fetched).toBe(2);
 const final=(await catalog.list(owner)).instances[0],published=final.releases!.find(r=>r.id===result.releaseId)!;
 expect(final.saves[0].releaseId).toBe(result.releaseId);expect(published.manifest!.files.map(f=>f.path)).toContain("mods/other.jar");expect(published.manifest!.files.map(f=>f.path)).toContain("config/friends.properties");expect(published.manifest!.files.map(f=>f.path)).not.toContain("mods/renamed-companion.jar");expect(published.manifest!.files.filter(f=>f.path.includes("numen")||f.path.includes("fabric-api")).every(f=>f.side==="both")).toBe(true);expect(final.saves[0].id).toBe(save.id);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
it("does not publish or download when the room is still open",async()=>{
 const release:any={id:"base",profile:{mcVersion:"1.20.1",loader:"forge"},server:{type:"forge"},source:"official",fileCount:0};
 const catalog:any={checkPublish:async()=>{},list:async()=>({instances:[{id:"i",revision:1,releases:[release],saves:[{id:"s",releaseId:"base",room:{desiredState:"open"}}]}]})};
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"nomad-install-block-"));try{await fs.writeFile(path.join(dir,"nomad-numen-adapter-forge-1.20.1.jar"),"adapter");let fetched=false;
 const distro:any={instance:async()=> (await catalog.list()).instances[0]};const installer=new NomadNumenInstallation(catalog,distro,dir,async()=>{fetched=true;return Buffer.from("unused");});
 await expect(installer.install(owner,"i",{saveId:"s",revision:1,baseReleaseId:"base",confirm:true})).rejects.toMatchObject({code:"numen_close_room_first"});expect(fetched).toBe(false);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
