import {beforeAll,afterAll,describe,it,expect} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import {spawn,type ChildProcess} from "node:child_process";
import {WebSocket} from "ws";
import * as yazl from "yazl";
import {DEFAULT_PROFILE,DEFAULT_RULES,DEFAULT_SERVER} from "../../shared/nomad-catalog";
const panelRoot=path.resolve(__dirname,"..");
let work="",base="",proc:ChildProcess,admin:any,member:any,userId="",instanceId="",saveId="",ticket:any,unusedTicket:any,epoch=0;
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function call(method:string,route:string,body?:unknown,session?:any){await delay(150);const r=await fetch(base+"/api"+route+(session?(route.includes("?")?"&":"?")+"token="+session.token:""),{method,headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest",...(session?{Cookie:session.cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const envelope=await r.json();return {status:r.status,data:envelope.data,response:r};}
async function login(username:string){const r=await call("POST","/auth/login",{username,password:"Hosting.Test123"});expect(r.status).toBe(200);return {token:r.data,cookie:r.response.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ")};}
async function agent(action:string,body?:unknown,t=ticket,e=epoch){const r=await fetch(base+"/api/nomad/hosting/agent/"+t.grantId+"/"+action+"?epoch="+e,{method:body===undefined?"GET":"POST",headers:{Authorization:"Bearer "+t.token,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:r.status===204||!r.headers.get("content-type")?.includes("json")?null:(await r.json()).data,response:r};}
async function zip(files:Record<string,Buffer>){const archive=new yazl.ZipFile(),chunks:Buffer[]=[];const complete=new Promise<Buffer>((resolve,reject)=>{archive.outputStream.on("data",c=>chunks.push(c));archive.outputStream.on("end",()=>resolve(Buffer.concat(chunks)));archive.outputStream.on("error",reject);});for(const[name,bytes]of Object.entries(files))archive.addBuffer(bytes,name);archive.end();return complete;}
async function upload(bytes:Buffer,final=false,t=ticket,e=epoch){const form=new FormData();form.set("world",new Blob([new Uint8Array(bytes)],{type:"application/zip"}),"world.zip");const r=await fetch(base+"/api/nomad/hosting/agent/"+t.grantId+"/checkpoint?epoch="+e+"&final="+final,{method:"POST",headers:{Authorization:"Bearer "+t.token},body:form});return {status:r.status,data:(await r.json()).data};}
const room=()=>"/nomad/catalog/instances/"+instanceId+"/saves/"+saveId+"/room";
const mint=async(session=member)=>(await call("POST","/nomad/hosting/tickets",{instanceId,saveId,nodeName:"HTTP executor"},session));
beforeAll(async()=>{
 work=await fs.mkdtemp(path.join(os.tmpdir(),"nomad-hosting-http-"));const server=net.createServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));base="http://127.0.0.1:"+port;
 await fs.mkdir(path.join(work,"data/SystemConfig"),{recursive:true});await fs.writeFile(path.join(work,"data/SystemConfig/config.json"),JSON.stringify({httpPort:port,httpIp:"127.0.0.1",language:"en_us",loginCheckIp:false}));await fs.copyFile(path.join(panelRoot,"data/market_cache.json"),path.join(work,"data/market_cache.json"));
 proc=spawn(process.execPath,[path.join(panelRoot,"production/app.js")],{cwd:work,windowsHide:true,stdio:"ignore"});let started=false;for(let i=0;i<120;i++){try{if((await fetch(base+"/api/auth/status")).ok){started=true;break;}}catch{}await delay(150);}expect(started).toBe(true);
 expect((await call("POST","/auth/install",{username:"hosting_admin",password:"Hosting.Test123"})).status).toBe(200);admin=await login("hosting_admin");const u=await call("POST","/auth",{username:"hosting_member",password:"Hosting.Test123",permission:1},admin);userId=u.data.uuid;member=await login("hosting_member");
 const created=await call("POST","/nomad/catalog/instances",{name:"HTTP host",description:"",profile:{...DEFAULT_PROFILE,mcVersion:"1.20.1"}},admin);instanceId=created.data.id;
 // Seed a published metadata fixture on the isolated test disk; no network downloads are needed for API fences.
 const statePath=path.join(work,"data/NomadCatalog/catalog.json"),state=JSON.parse(await fs.readFile(statePath,"utf8")),instance=state.instances.find((i:any)=>i.id===instanceId);
 instance.releases=[{id:"fixture-release",format:"modrinth",source:"official",fileName:"server.jar",sha256:"a".repeat(64),size:1,profile:instance.profile,server:{...DEFAULT_SERVER,eulaAccepted:true},serverArtifact:{url:"https://piston-data.mojang.com/server.jar",sha1:"b".repeat(40),fileName:"server.jar",kind:"jar",installArgs:[],launchArgs:["-jar","server.jar","nogui"]},publishedAt:Date.now(),publishedBy:instance.ownerId,fileCount:0}];await fs.writeFile(statePath,JSON.stringify(state));
 const save=await call("POST","/nomad/catalog/instances/"+instanceId+"/saves",{name:"HTTP world",description:"",rules:DEFAULT_RULES},admin);saveId=save.data.id;await call("POST",room(),{name:"HTTP room"},admin);await call("PUT",room(),{name:"HTTP room",desiredState:"open"},admin);
},30000);
afterAll(async()=>{if(proc?.exitCode===null){proc.kill();await delay(500);if(proc.exitCode===null)proc.kill("SIGKILL");}if(work&&path.dirname(path.resolve(work))===path.resolve(os.tmpdir())&&path.basename(work).startsWith("nomad-hosting-http-"))await fs.rm(work,{recursive:true,force:true});});
describe("authenticated hosting HTTP lifecycle",()=>{
 it("requires explicit scoped hosting and rejects invalid bearer before accepting a multipart upload",async()=>{
  expect((await mint()).status).toBe(403);expect((await upload(Buffer.from("bad"),false,{grantId:crypto.randomUUID(),token:"a".repeat(64)},1)).status).toBe(401);
  expect((await call("PUT","/nomad/catalog/instances/"+instanceId+"/grants",{grants:[{userId,scope:saveId,permissions:["save.read"],hosting:true}]},admin)).status).toBe(200);
  ticket=(await mint()).data;const claimed=await agent("claim",{});expect(claimed.status).toBe(200);epoch=claimed.data.lease.epoch;expect(claimed.data.save.players).toEqual([]);
  expect((await agent("claim",{})).status).toBe(409);const competing=(await mint()).data;unusedTicket=competing;expect((await agent("claim",{},competing,epoch)).status).toBe(409);
  expect((await agent("restore")).status).toBe(204);expect((await upload(Buffer.from("bad"),false,ticket,epoch+1)).status).toBe(409);
 });
 it("commits large coherent snapshots, checks archive boundaries and requires a final save",async()=>{
  const bytes=await zip({"world/level.dat":Buffer.from("level"),"world/region/r.0.0.mca":crypto.randomBytes(2*1024*1024)});
  expect((await upload(bytes)).status).toBe(200);expect((await agent("finish",{clean:true})).status).toBe(409);
  const restore=await agent("restore");expect(restore.status).toBe(200);const restored=Buffer.from(await restore.response.arrayBuffer());expect(restored.equals(bytes)).toBe(true);expect(restore.response.headers.get("x-nomad-sha256")).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
  expect((await upload(await zip({"world/level.dat":Buffer.from("level"),"ops.json":Buffer.from("[]")}))).status).toBe(400);
 });
 it("authenticates tunnels, closes them on revoked hosting, and blocks room reopen during shutdown",async()=>{
  expect((await agent("relay",{})).status).toBe(200);
  const premature=await agent("ready",{});expect(premature.status).toBe(409);expect(await premature.response.text()).toContain("hosting_tunnel_not_ready");
  const before=(await call("GET","/nomad/catalog/",undefined,admin)).data.instances.find((i:any)=>i.id===instanceId).saves.find((s:any)=>s.id===saveId);expect(before.hosting.joinAddress).toBeNull();
  const url=base.replace("http:","ws:")+"/api/nomad/hosting/agent/"+ticket.grantId+"/tunnel";
  await new Promise<void>((resolve,reject)=>{const bad=new WebSocket(url,{headers:{Authorization:"Bearer "+"b".repeat(64),"X-Nomad-Epoch":String(epoch)}});bad.on("open",()=>{bad.terminate();reject(new Error("Invalid tunnel accepted"));});bad.on("unexpected-response",(_request,response)=>{expect(response.statusCode).toBe(403);response.resume();bad.terminate();resolve();});bad.on("error",()=>{});});
  const socket=new WebSocket(url,{headers:{Authorization:"Bearer "+ticket.token,"X-Nomad-Epoch":String(epoch)}});await new Promise<void>((r,j)=>{socket.on("open",r);socket.on("error",j);});const closed=new Promise<void>(r=>socket.once("close",()=>r()));
  const ready=await agent("ready",{});expect(ready.status).toBe(200);expect(ready.data.joinAddress).toMatch(/^127\.0\.0\.1:\d+$/);
  await call("PUT","/nomad/catalog/instances/"+instanceId+"/grants",{grants:[]},admin);expect((await agent("heartbeat",{phase:"ready"})).data.stop).toBe(true);await closed;
  await call("PUT",room(),{name:"HTTP room",desiredState:"closed"},admin);expect((await call("PUT",room(),{name:"HTTP room",desiredState:"open"},admin)).status).toBe(409);
  expect((await upload(await zip({"world/level.dat":Buffer.from("final")}),true)).status).toBe(200);expect((await agent("finish",{clean:true})).status).toBe(200);expect((await agent("heartbeat",{phase:"ready"})).status).toBe(401);
  expect((await call("PUT",room(),{name:"HTTP room",desiredState:"open"},admin)).status).toBe(200);const next=(await mint(admin)).data;const claimed=await agent("claim",{},next);expect(claimed.status).toBe(200);expect(claimed.data.lease.epoch).toBe(epoch+1);expect(claimed.data.checkpoint.final).toBe(true);expect((await agent("restore",undefined,next,epoch+1)).status).toBe(200);
 });
 it("pairs server nodes, applies fixed placement and keeps network inspection admin-only",async()=>{
  expect((await call("POST","/nomad/hosting/network/check",{},member)).status).toBe(403);
  const serverNetwork=await call("POST","/nomad/hosting/network/check",{},admin);expect(serverNetwork.status).toBe(200);expect(serverNetwork.data.publicReachability).toBe("unverified");expect(serverNetwork.data.checks.find((c:any)=>c.key==="api").status).toBe("ok");
  const paired=await call("POST","/nomad/hosting/nodes",{name:"Dedicated",kind:"server",memoryBudgetMb:8192,reserveMemoryMb:512,maxTasks:1,priority:10},admin);expect(paired.status).toBe(200);const node=paired.data.node,credential=paired.data.credential;
  expect((await call("POST","/nomad/hosting/nodes",{name:"forged",kind:"server"},member)).status).toBe(403);
  const listing=await call("GET","/nomad/hosting/nodes",undefined,admin);expect(JSON.stringify(listing.data)).not.toContain(credential.token);expect(JSON.stringify(listing.data)).not.toContain("tokenHash");
  const save=await call("POST","/nomad/catalog/instances/"+instanceId+"/saves",{name:"Scheduled",description:"",rules:DEFAULT_RULES},admin);const sid=save.data.id;
  const socket=net.createServer();await new Promise<void>(r=>socket.listen(0,"127.0.0.1",r));const bindPort=(socket.address() as net.AddressInfo).port;await new Promise<void>(r=>socket.close(()=>r()));
  const runtime="/nomad/hosting/runtime/"+instanceId+"/"+sid,network="/nomad/hosting/network/"+instanceId+"/"+sid;
  expect((await call("PUT",runtime,{placement:{mode:"fixed",nodeId:node.id},ingress:{kind:"frp",bindHost:"127.0.0.1",bindPort,publicHost:"127.0.0.1",publicPort:bindPort+1,family:"ipv4",tunnelHost:"localhost",tunnelPort:7000}},admin)).status).toBe(200);
  const frp=await call("GET",network+"/frp",undefined,admin);expect(frp.data.configuration).toContain("serverPort = 7000");expect(frp.data.configuration).toContain("remotePort = "+(bindPort+1));
  expect((await call("POST",network+"/check",{},member)).status).toBe(403);expect((await call("POST",network+"/check",{},admin)).data.publicReachability).toBe("unverified");
  const r="/nomad/catalog/instances/"+instanceId+"/saves/"+sid+"/room";await call("POST",r,{name:"Scheduled"},admin);await call("PUT",r,{name:"Scheduled",desiredState:"open"},admin);
  expect((await call("POST","/nomad/hosting/tickets",{instanceId,saveId:sid,nodeName:"manual bypass"},admin)).status).toBe(409);
  const poll=await fetch(base+"/api/nomad/hosting/nodes/"+node.id+"/poll",{method:"POST",headers:{Authorization:"Bearer "+credential.token,"Content-Type":"application/json"},body:JSON.stringify({metrics:{cpuCores:4,totalMemoryMb:16384,availableMemoryMb:12000},lastError:""})});expect(poll.status).toBe(200);const assigned=(await poll.json()).data.assignment;expect(assigned.saveId).toBe(sid);
  const claimed=await agent("claim",{},assigned,1);expect(claimed.status).toBe(200);expect(claimed.data.lease.nodeName).toBe("Dedicated");expect((await call("PUT","/nomad/hosting/nodes/"+node.id,{enabled:false},admin)).status).toBe(200);expect((await agent("heartbeat",{phase:"ready"},assigned,1)).data.stop).toBe(true);
 },20000);
 it("rejects a deleted executor account before receiving checkpoint content",async()=>{expect((await call("DELETE","/auth",[userId],admin)).status).toBe(200);expect((await upload(Buffer.from("invalid"),false,unusedTicket,epoch+1)).status).toBe(403);});
});
