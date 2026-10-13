import {it,expect} from "vitest";
import fs from "fs/promises";import path from "path";import os from "os";import crypto from "crypto";
import {NomadGateways,type GatewayRoomConfiguration} from "../nomad_gateways";
const room:GatewayRoomConfiguration={instanceId:"i",saveId:"s",bindHost:"127.0.0.1",port:25565,backendPort:25566,publicHost:"friends.example.com",publicPort:25565,hostname:"friends.example.com"};
it("rejects duplicate gateway/internal ports and wildcard public addresses before starting any JVM",()=>{
 expect(()=>new NomadGateways("unused","unused","java",[{...room,backendPort:room.port}])).toThrow("gateway_port_conflict");
 expect(()=>new NomadGateways("unused","unused","java",[{...room,publicHost:"0.0.0.0"}])).toThrow("invalid_gateway_public_address");
 expect(()=>new NomadGateways("unused","unused","java",[room,{...room,instanceId:"other"}])).toThrow("gateway_port_conflict");
});
it("operator gateway configuration supplies signed forwarding only to matching supported server deployment",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"nomad-panel-gateway-")),assets=path.resolve(__dirname,"../../../../../../../apps/gateway");let starts=0,last:any,stops=0;
 const engine:any={start:async(id:string,profile:any)=>{starts++;last=profile;await fs.mkdir(path.join(dir,id),{recursive:true});await fs.writeFile(path.join(dir,id,"forwarding.secret"),"a".repeat(64));return{state:"ready"};},stop:async()=>{stops++;},status:()=>({state:"ready"}),close:async()=>{}};
 const service=new NomadGateways(dir,assets,"java",[room],()=>engine);
 try{
 expect(await service.prepare("unconfigured","s",{} as any)).toBeUndefined();expect(starts).toBe(0);
 await expect(service.prepare("i","s",{profile:{mcVersion:"1.19.4",loader:"vanilla"},server:{type:"vanilla"}} as any)).rejects.toMatchObject({code:"gateway_loader_unsupported"});expect(starts).toBe(0);
 const vanilla=await service.prepare("i","s",{profile:{mcVersion:"1.21.1",loader:"vanilla"},server:{type:"vanilla"}} as any);
 expect(vanilla!.vanillaForwarding?.assets).toBe(assets);expect(vanilla!.files).toHaveLength(1);expect(vanilla!.files[0].path).toBe("vanillacord.txt");expect(vanilla!.files[0].bytes.toString()).toContain("forwarding = velocity");expect(vanilla!.files[0].bytes.toString()).toContain("seecret = "+"a".repeat(64));
 const deployment=await service.prepare("i","s",{profile:{mcVersion:"1.21.1",loader:"fabric"},server:{type:"fabric"}} as any);
 expect(deployment!.address).toBe("friends.example.com:25565");expect(deployment!.backendPort).toBe(25566);expect(last.isolatedOffline).toBeUndefined();expect(last.rooms[0].backendHost).toBe("127.0.0.1");
 expect(deployment!.files.find(f=>f.path.endsWith("toml"))!.bytes.toString()).toContain('secret = "'+"a".repeat(64)+'"');
 expect(JSON.stringify(service.status("i","s"))).not.toContain("a".repeat(64));expect(deployment!.files[0].bytes.length).toBeGreaterThan(1000);
 await service.stop("i","s");expect(stops).toBe(1);
 }finally{await service.close();await fs.rm(dir,{recursive:true,force:true});}
});

it("stops a started gateway when its executor forwarding artifact cannot be prepared",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"nomad-gateway-failed-deploy-")),assets=path.join(dir,"assets");let stopped=0;
 await fs.mkdir(assets);await fs.copyFile(path.resolve(__dirname,"../../../../../../../apps/gateway/backend.cjs"),path.join(assets,"backend.cjs"));
 const engine:any={start:async(id:string)=>{await fs.mkdir(path.join(dir,id),{recursive:true});await fs.writeFile(path.join(dir,id,"forwarding.secret"),"a".repeat(64));},stop:async()=>{stopped++;},status:()=>({state:"ready"}),close:async()=>{}};
 const service=new NomadGateways(dir,assets,"java",[room],()=>engine);
 try{await expect(service.prepare("i","s",{profile:{mcVersion:"1.21.1",loader:"fabric"},server:{type:"fabric"}} as any)).rejects.toMatchObject({code:"ENOENT"});expect(stopped).toBe(1);}
 finally{await service.close();await fs.rm(dir,{recursive:true,force:true});}
});

it("hydrates and disables persisted room gateway settings without requiring an operator config file",async()=>{
 const service=new NomadGateways("unused","unused","java",[]);
 const save:any={id:"saved",gateway:{enabled:true,backendPort:25566},ingress:{bindHost:"::1",bindPort:25565,publicHost:"::1",publicPort:25565}};
 await service.configureSaved("cloud",save);expect(service.enabled("cloud","saved")).toBe(true);
 await service.configureSaved("cloud",{...save,gateway:{enabled:false,backendPort:25566}});expect(service.enabled("cloud","saved")).toBe(false);
});
