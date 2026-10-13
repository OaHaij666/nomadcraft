import {it,expect,vi,afterEach} from "vitest";
import fs from "fs/promises";import path from "path";import os from "os";import crypto from "crypto";import {Readable} from "stream";import * as yauzl from "yauzl";
vi.mock("axios",()=>({default:{get:async()=>({data:Readable.from([Buffer.from("pinned-test-server")])})}}));
vi.mock("../../setting",()=>({systemConfig:{}}));
import * as yazl from "yazl";
import {serverBundle} from "../nomad_server";
import {DEFAULT_PROFILE,DEFAULT_SERVER,DEFAULT_RULES} from "../../../../../shared/nomad-catalog";
async function entries(bytes:Buffer):Promise<Record<string,Buffer>>{return new Promise((resolve,reject)=>yauzl.fromBuffer(bytes,{lazyEntries:true},(error,zip)=>{if(error||!zip){reject(error);return;}const out:Record<string,Buffer>={};zip.on("error",reject);zip.on("end",()=>resolve(out));zip.on("entry",entry=>zip.openReadStream(entry,(error,stream)=>{if(error||!stream){reject(error);return;}const parts:Buffer[]=[];stream.on("data",part=>parts.push(part));stream.on("error",reject);stream.on("end",()=>{out[entry.fileName]=Buffer.concat(parts);zip.readEntry();});}));zip.readEntry();}));}
afterEach(()=>vi.restoreAllMocks());
it("gateway deployment includes hashed server-only forwarding files and keeps player policy intact",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"nomad-gateway-bundle-"));vi.spyOn(process,"cwd").mockReturnValue(dir);
 const bytes=Buffer.from("pinned-test-server"),digest=crypto.createHash("sha256").update(bytes).digest("hex"),release:any={id:"r",profile:{...DEFAULT_PROFILE,mcVersion:"1.21.1",loader:"fabric"},server:{...DEFAULT_SERVER,type:"fabric",eulaAccepted:true,onlineMode:true},serverArtifact:{url:"https://piston-data.mojang.com/gateway-test.jar",fileName:"server.jar",sha256:digest}};
 const save:any={id:"s",rules:DEFAULT_RULES,players:[{uuid:"11111111-1111-4111-8111-111111111111",name:"Allowed",access:"allowed",opLevel:0}]};
 const gateway:any={id:"g",address:"friends.example.com:25565",backendPort:25566,files:[{path:"mods/forward.jar",bytes:Buffer.from("forward")},{path:"config/FabricProxy-Lite.toml",bytes:Buffer.from('secret = "test-secret"\n')}]};
 try{const stream=await serverBundle(release,save,gateway),parts:Buffer[]=[];for await(const bytes of stream)parts.push(Buffer.from(bytes));const zip=await entries(Buffer.concat(parts));
 expect(zip["server.properties"].toString()).toContain("online-mode=false");expect(JSON.parse(zip["ops.json"].toString())).toEqual([]);expect(JSON.parse(zip["whitelist.json"].toString())[0].uuid).toBe(save.players[0].uuid);
 const plan=JSON.parse(zip["nomad-server.json"].toString());expect(plan.gateway.address).toBe(gateway.address);expect(JSON.stringify(plan)).not.toContain("test-secret");
 expect(plan.managedFiles).toHaveLength(2);for(const file of plan.managedFiles){expect(file.side).toBe("server");expect(file.sha256).toBe(crypto.createHash("sha256").update(zip[file.path]).digest("hex"));}
 // A bare Fabric runtime gets the gateway's dependency, but a renamed published API wins.
 const fallback={path:"mods/fabric-api-default.jar",bytes:Buffer.from("fallback-api"),unlessModId:"fabric-api"};gateway.files.push(fallback);
 let stream2=await serverBundle(release,save,gateway),out:Buffer[]=[];for await(const part of stream2)out.push(Buffer.from(part));
 expect((await entries(Buffer.concat(out)))[fallback.path].toString()).toBe("fallback-api");
 const modZip=new yazl.ZipFile();modZip.addBuffer(Buffer.from(JSON.stringify({schemaVersion:1,id:"fabric-api",version:"0.116.7+1.21.1",name:"API"})),"fabric.mod.json");modZip.end();const chunks:Buffer[]=[];for await(const part of modZip.outputStream)chunks.push(Buffer.from(part));const mod=Buffer.concat(chunks),hash=crypto.createHash("sha256").update(mod).digest("hex"),blob=path.join(dir,"data/NomadDistribution/blobs",hash.slice(0,2),hash);await fs.mkdir(path.dirname(blob),{recursive:true});await fs.writeFile(blob,mod);
 release.manifest={files:[{path:"mods/renamed-by-user.jar",sha256:hash,size:mod.length,side:"both",ownership:"managed"}]};
 stream2=await serverBundle(release,save,gateway);out=[];for await(const part of stream2)out.push(Buffer.from(part));const withPublished=await entries(Buffer.concat(out));
 expect(withPublished[fallback.path]).toBeUndefined();expect(withPublished["mods/renamed-by-user.jar"]).toEqual(mod);
 release.manifest.files[0].side="client";stream2=await serverBundle(release,save,gateway);out=[];for await(const part of stream2)out.push(Buffer.from(part));expect((await entries(Buffer.concat(out)))[fallback.path].toString()).toBe("fallback-api");
 // The published logical runtime remains untouched; only this authenticated executor deployment changes.
 expect(release.server.onlineMode).toBe(true);
 release.manifest={files:[{path:"config/FabricProxy-Lite.toml",sha256:"a".repeat(64),size:1,side:"server",ownership:"managed"}]};await expect(serverBundle(release,save,gateway)).rejects.toMatchObject({code:"gateway_release_file_conflict"});
 }finally{vi.restoreAllMocks();await fs.rm(dir,{recursive:true,force:true});}
});

it("vanilla forwarding cannot be prepared from a source without Mojang's pinned SHA1",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"nomad-vanilla-source-required-"));vi.spyOn(process,"cwd").mockReturnValue(dir);
 const bytes=Buffer.from("pinned-test-server"),digest=crypto.createHash("sha256").update(bytes).digest("hex");
 const release:any={id:"vanilla-source",profile:{...DEFAULT_PROFILE,mcVersion:"1.20.1",loader:"vanilla"},server:{...DEFAULT_SERVER,type:"vanilla",eulaAccepted:true},serverArtifact:{url:"https://piston-data.mojang.com/vanilla-source-test.jar",fileName:"server.jar",sha256:digest}};
 const gateway:any={id:"g",address:"friends.example.com:25565",backendPort:25566,files:[],vanillaForwarding:{java:"must-not-run",assets:"must-not-read"}};
 try{await expect(serverBundle(release,undefined,gateway)).rejects.toMatchObject({code:"vanilla_forwarding_source_required"});}finally{vi.restoreAllMocks();await fs.rm(dir,{recursive:true,force:true});}
});
