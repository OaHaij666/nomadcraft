import net from "net";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import type {PublishedRelease,CatalogSave} from "../../../../shared/nomad-catalog";
import {CatalogError} from "./nomad_catalog";
import {endpointHost,formatEndpoint} from "./nomad_ingress";
export interface GatewayRoomConfiguration {instanceId:string;saveId:string;bindHost:string;port:number;publicHost:string;publicPort:number;backendPort:number;hostname:string;}
export interface GatewayDeployment {files:Array<{path:string;bytes:Buffer;unlessModId?:string}>;backendPort:number;address:string;id:string;vanillaForwarding?:{java:string;assets:string};}
interface GatewayEngine {start(id:string,profile:any):Promise<any>;stop(id:string):Promise<any>;status(id:string):any;close():Promise<any>;}
/** Host configuration is read by the backend operator, never accepted from a regular user's request. */
export class NomadGateways {
 private engine?:GatewayEngine;
 private stopping=new Map<string,Promise<unknown>>();
 private configured=new Map<string,GatewayRoomConfiguration>();
 constructor(private directory:string,private assets:string,private java:string,rooms:GatewayRoomConfiguration[],private factory?:()=>GatewayEngine){
  for(const input of rooms){if(this.configured.has(this.key(input.instanceId,input.saveId)))throw new CatalogError(400,"duplicate_gateway_room");this.register(input);}
 }
 private register(input:GatewayRoomConfiguration){
  if(typeof input.instanceId!=="string"||typeof input.saveId!=="string"||!/^[a-zA-Z0-9_-]{1,80}$/.test(input.instanceId)||!/^[a-zA-Z0-9_-]{1,80}$/.test(input.saveId))throw new CatalogError(400,"invalid_gateway_room");
  const room={...input,bindHost:endpointHost(input.bindHost),publicHost:endpointHost(input.publicHost),hostname:endpointHost(input.hostname)};
  if(room.bindHost!=="localhost"&&!net.isIP(room.bindHost))throw new CatalogError(400,"invalid_gateway_bind");
  if(!Number.isInteger(room.publicPort)||room.publicPort<1||room.publicPort>65535||["0.0.0.0","::"].includes(room.publicHost))throw new CatalogError(400,"invalid_gateway_public_address");
  const key=this.key(room.instanceId,room.saveId),ports=new Set([...this.configured.entries()].filter(([id])=>id!==key).flatMap(([,r])=>[r.port,r.backendPort]));
  for(const port of[room.port,room.backendPort]){if(!Number.isInteger(port)||port<1||port>65535||ports.has(port))throw new CatalogError(400,"gateway_port_conflict");ports.add(port);}
  this.configured.set(key,room);
 }
 async configureSaved(instanceId:string,save:CatalogSave){
  if(save.gateway===undefined)return; // Existing operator-file configuration remains valid until explicitly changed.
  if(!save.gateway.enabled){await this.stop(instanceId,save.id);this.configured.delete(this.key(instanceId,save.id));return;}
  if(!save.ingress)throw new CatalogError(409,"gateway_ingress_required");
  const ingress=save.ingress;
  this.register({instanceId,saveId:save.id,bindHost:ingress.bindHost,port:ingress.bindPort,publicHost:ingress.publicHost,publicPort:ingress.publicPort,backendPort:save.gateway.backendPort,hostname:ingress.publicHost.includes(":")?"room.nomad.invalid":ingress.publicHost});
 }
 private key(instanceId:string,saveId:string){return instanceId+"/"+saveId;}
 private id(instanceId:string,saveId:string){return crypto.createHash("sha256").update(this.key(instanceId,saveId)).digest("hex").slice(0,32);}
 private runtime(){if(!this.engine){if(this.factory)this.engine=this.factory();else{
   const nativeRequire=eval("require") as NodeRequire;
   const {GatewayManager}=nativeRequire(path.join(this.assets,"runtime.cjs"));
   this.engine=new GatewayManager({directory:this.directory,java:this.java,cache:path.join(this.assets,"dist/dependencies"),lifecycleJar:path.join(this.assets,"dist/nomad-gateway.jar")});
  }}return this.engine!;}
 enabled(instanceId:string,saveId:string){return this.configured.has(this.key(instanceId,saveId));}
 async prepare(instanceId:string,saveId:string,release:PublishedRelease,save?:CatalogSave):Promise<GatewayDeployment|undefined>{
  if(save)await this.configureSaved(instanceId,save);
  const room=this.configured.get(this.key(instanceId,saveId));if(!room)return;
  const target=release.profile.mcVersion+"-"+release.server?.type;
  if(!["1.20.1-vanilla","1.21.1-vanilla","1.20.1-fabric","1.20.1-forge","1.21.1-fabric","1.21.1-neoforge"].includes(target)||release.profile.loader!==release.server?.type)throw new CatalogError(409,"gateway_loader_unsupported");
  const id=this.id(instanceId,saveId);await this.stopping.get(id);const engine=this.runtime();
  await engine.start(id,{bindHost:room.bindHost,port:room.port,rooms:[{id:"room",hostname:room.hostname,backendHost:"127.0.0.1",backendPort:room.backendPort,loader:release.server!.type}]});
  try {
  const secretFile=path.join(this.directory,id,"forwarding.secret"),stat=await fs.promises.lstat(secretFile);
  if(stat.isSymbolicLink()||stat.size>100)throw new CatalogError(500,"invalid_gateway_secret");
  const secret=(await fs.promises.readFile(secretFile,"utf8")).trim();
  if(release.server!.type==="vanilla")return{id,backendPort:room.backendPort,address:formatEndpoint(room.publicHost,room.publicPort),files:[{path:"vanillacord.txt",bytes:Buffer.from("version = 2.0\nforwarding = velocity\nseecret = "+secret+"\n")}],vanillaForwarding:{java:this.java,assets:this.assets}};
  const nativeRequire=eval("require") as NodeRequire;
  const backend=nativeRequire(path.join(this.assets,"backend.cjs")),config=backend.forwardingConfig(release.server!.type,secret),artifact=release.server!.type==="fabric"?backend.files[target]:backend.files.forge;
  const bytes=await fs.promises.readFile(path.join(this.assets,"dist/dependencies",artifact.cache));
  if(crypto.createHash("sha256").update(bytes).digest("hex")!==artifact.sha256)throw new CatalogError(500,"gateway_adapter_checksum_failed");
  const files:GatewayDeployment["files"]=[{path:"mods/"+artifact.file,bytes},{path:config.file,bytes:Buffer.from(config.text)}];
  if(target==="1.21.1-fabric"){
   const dependency=backend.files.fabricApi121,api=await fs.promises.readFile(path.join(this.assets,"dist/dependencies",dependency.cache));
   if(crypto.createHash("sha256").update(api).digest("hex")!==dependency.sha256)throw new CatalogError(500,"gateway_adapter_checksum_failed");
   files.push({path:"mods/"+dependency.file,bytes:api,unlessModId:"fabric-api"});
  }
  return{id,backendPort:room.backendPort,address:formatEndpoint(room.publicHost,room.publicPort),files};
  } catch(error) {await this.stop(instanceId,saveId).catch(()=>{});throw error;}

 }
 status(instanceId:string,saveId:string){return this.engine?.status(this.id(instanceId,saveId))??{state:"stopped"};}
 async stop(instanceId:string,saveId:string){
  const id=this.id(instanceId,saveId);if(this.stopping.has(id))return this.stopping.get(id);
  if(this.engine){const job=this.engine.stop(id);this.stopping.set(id,job);try{await job;}finally{if(this.stopping.get(id)===job)this.stopping.delete(id);}}
 }
 async close(){if(this.engine)await this.engine.close();}
}
let singleton:NomadGateways|undefined;
export function gatewaySystem(){
 if(!singleton){const configFile=process.env.NC_GATEWAY_CONFIG;let config:any={rooms:[]};if(configFile){const stat=fs.statSync(configFile);if(stat.size>1024*1024)throw new CatalogError(400,"gateway_configuration_too_large");config=JSON.parse(fs.readFileSync(configFile,"utf8"));if(!Array.isArray(config.rooms)||config.rooms.length>100)throw new CatalogError(400,"invalid_gateway_configuration");}
 singleton=new NomadGateways(path.resolve("data/NomadGateways"),path.join(__dirname,"gateway"),process.env.NC_GATEWAY_JAVA||"java",config.rooms);
 }return singleton;
}
