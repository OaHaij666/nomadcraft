import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import zlib from "node:zlib";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const panelRoot=path.join(root,"vendor/mcsmanager/panel");
const work=await fs.mkdtemp(path.join(os.tmpdir(),"nomad-real-vanilla-"));
const server=net.createServer();await new Promise(r=>server.listen(0,"127.0.0.1",r));const port=server.address().port;await new Promise(r=>server.close(r));
const base="http://127.0.0.1:"+port,password="Vanilla.Test"+crypto.randomBytes(8).toString("hex");
let proc,session,hostA,hostB;let failures=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(300);}throw new Error("Timed out: "+label);}
async function api(method,route,body,auth=true){await sleep(150);const url=base+"/api"+route+(auth?(route.includes("?")?"&":"?")+"token="+session.token:"");const r=await fetch(url,{method,headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest",...(auth?{Cookie:session.cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let result;try{result=JSON.parse(text);}catch{throw new Error(method+" "+route+" returned "+r.status+" "+text.slice(0,300));}if(r.status!==200||result.status!==200)throw new Error(method+" "+route+" refused "+r.status+" "+result.data);return {data:result.data,response:r};}
const check=(ok,label)=>{if(!ok)throw new Error(label);};
async function mint(instanceId,saveId,name){return(await api("POST","/nomad/hosting/tickets",{instanceId,saveId,nodeName:name})).data;}
async function agent(ticket,label){const dir=path.join(work,label),ticketFile=path.join(work,label+".json");await fs.writeFile(ticketFile,JSON.stringify({...ticket,panel:base}));const binary=path.join(root,"target/debug/nomad-agent.exe");const child=spawn(binary,["panel-host","--ticket-file",ticketFile,"--data-dir",dir,"--java",process.env.NOMAD_TEST_JAVA??"java","--checkpoint-seconds","15","--stop-file",path.join(work,label+".stop")],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,NO_PROXY:"127.0.0.1,localhost"}});let output="",gamePid;const stopFile=path.join(work,label+".stop");child.stdout.on("data",d=>{output=(output+d).slice(-30000);const pid=output.match(/NOMAD_GAME_PID (\d+)/);if(pid)gamePid=Number(pid[1]);if(/NOMAD_|Done \(/.test(d.toString()))console.log(d.toString().split("\n").filter(l=>/NOMAD_|Done \(/.test(l)).join("\n"));});child.stderr.on("data",d=>output=(output+d).slice(-30000));const result={child,dir,ticket,stopFile,gamePid:()=>gamePid,read:()=>output};child.on("error",error=>failures.push(error.message));return result;}
function varint(v){const out=[];do{let b=v&127;v>>>=7;if(v)b|=128;out.push(b);}while(v);return Buffer.from(out);}
function vint(bytes,offset=0){let value=0;for(let i=0;i<5;i++){if(offset+i>=bytes.length)return null;const byte=bytes[offset+i];value|=(byte&127)<<(7*i);if(!(byte&128))return {value,size:i+1};}throw new Error("Invalid varint");}
const str=s=>{const bytes=Buffer.from(s);return Buffer.concat([varint(bytes.length),bytes]);};
const packet=(id,body=Buffer.alloc(0))=>{const data=Buffer.concat([varint(id),body]);return Buffer.concat([varint(data.length),data]);};
function handshake(host,port,intent){const p=Buffer.alloc(2);p.writeUInt16BE(port);return packet(0,Buffer.concat([varint(763),str(host),p,varint(intent)]));}
async function connectProbe(address,intent,name="NomadProbe"){
 const[host,port]=address.split(":");const socket=net.connect(Number(port),host);let buffer=Buffer.alloc(0),compression=false;
 const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.destroy();reject(new Error("Minecraft probe timed out"));},15000);socket.on("error",reject);socket.on("connect",()=>{socket.write(handshake(host,Number(port),intent));if(intent===1)socket.write(packet(0));else socket.write(packet(0,Buffer.concat([str(name),Buffer.from([0])])));});socket.on("data",bytes=>{try{buffer=Buffer.concat([buffer,bytes]);while(true){const frame=vint(buffer);if(!frame||buffer.length<frame.size+frame.value)break;let data=buffer.subarray(frame.size,frame.size+frame.value);buffer=buffer.subarray(frame.size+frame.value);if(compression){const len=vint(data);data=len.value?zlib.inflateSync(data.subarray(len.size)):data.subarray(len.size);}const id=vint(data);if(intent===1&&id.value===0){const length=vint(data,id.size);const status=JSON.parse(data.subarray(id.size+length.size,id.size+length.size+length.value).toString());clearTimeout(timer);socket.destroy();resolve(status);return;}if(intent===2){if(id.value===3){compression=true;continue;}if(id.value===0){clearTimeout(timer);socket.destroy();reject(new Error("Minecraft rejected login: "+data.subarray(id.size).toString()));return;}if(id.value===2){clearTimeout(timer);socket.destroy();resolve({loginSuccess:true});return;}}}}catch(error){clearTimeout(timer);socket.destroy();reject(error);}});socket.on("close",()=>{clearTimeout(timer);reject(new Error("Minecraft connection closed before proof"));});});return result;
}
async function hostDone(host){await until(()=>host.child.exitCode!==null,"executor stopped",120000);check(host.child.exitCode===0,host.read());check(host.read().includes("NOMAD_STOPPED"),"final checkpoint marker missing");}
try{
 await fs.cp(path.join(root,".nomad/vanilla-artifact-cache"),path.join(work,"data/NomadServerArtifacts"),{recursive:true}).catch(()=>{});
 await fs.mkdir(path.join(work,"data/SystemConfig"),{recursive:true});await fs.writeFile(path.join(work,"data/SystemConfig/config.json"),JSON.stringify({httpPort:port,httpIp:"127.0.0.1",language:"en_us",loginCheckIp:false}));await fs.copyFile(path.join(panelRoot,"data/market_cache.json"),path.join(work,"data/market_cache.json"));
 proc=spawn(process.execPath,[path.join(panelRoot,"production/app.js")],{cwd:work,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,NO_PROXY:"127.0.0.1,localhost"}});
 proc.stdout.on("data",d=>fs.appendFile(path.join(work,"panel.log"),d).catch(()=>{}));proc.stderr.on("data",d=>fs.appendFile(path.join(work,"panel.log"),d).catch(()=>{}));
 await until(async()=>{try{return(await fetch(base+"/api/auth/status")).ok;}catch{return false;}},"isolated panel",30000);
 await api("POST","/auth/install",{username:"vanilla_proof",password},false);
 const login=await api("POST","/auth/login",{username:"vanilla_proof",password},false);session={token:login.data,cookie:login.response.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ")};
 const created=await api("POST","/nomad/catalog/official",{name:"Vanilla hosting proof",version:"1.20.1",install:{minecraft:"1.20.1"},profile:{javaMajor:21,memoryMb:1024,packRevision:"proof-1"},server:{type:"vanilla",version:"",javaMajor:21,memoryMb:1024,jvmArgs:"",port:25565,onlineMode:false,eulaAccepted:true,motd:"Nomad real hosting proof",allowFlight:false,enableCommandBlock:false}});
 const instanceId=created.data.id;
 const save=(await api("POST","/nomad/catalog/instances/"+instanceId+"/saves",{name:"Canonical world",description:"Isolated real-Java development test",rules:{seed:"12345",gameMode:"survival",difficulty:"easy",maxPlayers:2,viewDistance:3,simulationDistance:3,pvp:true,hardcore:false,whitelist:true}})).data;
 const hash=crypto.createHash("md5").update("OfflinePlayer:NomadProbe").digest();hash[6]=(hash[6]&15)|48;hash[8]=(hash[8]&63)|128;const hex=hash.toString("hex"),uuid=hex.slice(0,8)+"-"+hex.slice(8,12)+"-"+hex.slice(12,16)+"-"+hex.slice(16,20)+"-"+hex.slice(20);
 await api("PUT","/nomad/catalog/instances/"+instanceId+"/saves/"+save.id+"/players",{players:[{uuid,name:"NomadProbe",access:"allowed",opLevel:0}]});
 const room="/nomad/catalog/instances/"+instanceId+"/saves/"+save.id+"/room";await api("POST",room,{name:"Proof room"});await api("PUT",room,{name:"Proof room",desiredState:"open"});
 hostA=await agent(await mint(instanceId,save.id,"PC-A"),"host-a");
 const getSave=async()=>{const list=(await api("GET","/nomad/catalog/")).data;return list.instances.find(i=>i.id===instanceId).saves.find(s=>s.id===save.id);};
 const readyA=await until(async()=>{if(hostA.child.exitCode!==null)throw new Error(hostA.read());const s=await getSave();return s.hosting?.phase==="ready"&&s.hosting.joinAddress?s:false;},"first Java server ready");
 await sleep(1000);
 const statusA=await connectProbe(readyA.hosting.joinAddress,1);check(statusA.version.protocol===763,"Wrong Minecraft protocol");
 const logged=await connectProbe(readyA.hosting.joinAddress,2);check(logged.loginSuccess,"Native Minecraft login did not succeed");
 console.log("PASS real vanilla status and allowlisted native login through center relay");
 const epochA=readyA.hosting.epoch,serverA=path.join(hostA.dir,"sessions",hostA.ticket.grantId+"-"+epochA,"server");
 check(JSON.parse(await fs.readFile(path.join(serverA,"ops.json"),"utf8")).length===0,"Host acquired game OP");
 await fs.writeFile(path.join(serverA,"world/nomad-proof.txt"),"canonical-save-return-proof");
 await until(async()=>{const s=await getSave();return s.hosting?.checkpoint?.epoch===epochA;} ,"periodic coherent checkpoint",90000);
 console.log("PASS periodic checkpoint committed while real game was running");
 const competing=await mint(instanceId,save.id,"Competing PC");const busy=await fetch(base+"/api/nomad/hosting/agent/"+competing.grantId+"/claim",{method:"POST",headers:{Authorization:"Bearer "+competing.token,"Content-Type":"application/json"},body:"{}"});check(busy.status===409,"Second host was allowed to overlap");
 await api("PUT",room,{name:"Proof room",desiredState:"closed"});await hostDone(hostA);const stopped=await getSave();check(stopped.hosting.phase==="stopped"&&stopped.hosting.checkpoint,"No final canonical world");
 console.log("PASS graceful stop, final save return and exclusive host lease");
 await api("PUT",room,{name:"Proof room",desiredState:"open"});hostB=await agent(await mint(instanceId,save.id,"PC-B"),"host-b");
 const readyB=await until(async()=>{if(hostB.child.exitCode!==null)throw new Error(hostB.read());const s=await getSave();return s.hosting?.phase==="ready"&&s.hosting.epoch>epochA?s:false;},"second executor restored and ready");
 const serverB=path.join(hostB.dir,"sessions",hostB.ticket.grantId+"-"+readyB.hosting.epoch,"server");check(await fs.readFile(path.join(serverB,"world/nomad-proof.txt"),"utf8")==="canonical-save-return-proof","New host did not restore committed world");check(hostB.read().includes("NOMAD_WORLD_RESTORED"),"Restore did not run");
 await sleep(1000);check((await connectProbe(readyB.hosting.joinAddress,1)).version.protocol===763,"Restored room not reachable");
 await api("PUT",room,{name:"Proof room",desiredState:"closed"});await hostDone(hostB);
 const report={at:new Date().toISOString(),minecraft:"1.20.1",java:21,firstEpoch:epochA,secondEpoch:readyB.hosting.epoch,checks:["real vanilla process","center outbound WebSocket relay","server status","native allowlisted login (isolated offline test)","no implicit OP","exclusive host lease","periodic consistent checkpoint","graceful stop and final commit","fresh executor canonical-world restore","restored room reachable"],onlineMicrosoftLoginTested:false};
 await fs.mkdir(path.join(root,"docs/proofs"),{recursive:true});await fs.writeFile(path.join(root,"docs/proofs/vanilla-hosting-2026-10-10.json"),JSON.stringify(report,null,2)+"\n");console.log("PASS real vanilla two-host lifecycle; report saved in docs/proofs");
}catch(error){console.error("FAIL",error.message);for(const host of [hostA,hostB])if(host)console.error(host.read().slice(-7000));process.exitCode=1;}
finally{await fs.cp(path.join(work,"data/NomadServerArtifacts"),path.join(root,".nomad/vanilla-artifact-cache"),{recursive:true}).catch(()=>{});for(const host of [hostA,hostB])if(host?.child.exitCode===null){await fs.writeFile(host.stopFile,"stop");await until(()=>host.child.exitCode!==null,"cleanup graceful stop",30000).catch(()=>{});if(host.child.exitCode===null){if(process.platform==="win32")await new Promise(resolve=>spawn("taskkill",["/PID",String(host.child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"}).on("exit",resolve));else host.child.kill();}}for(const host of [hostA,hostB])if(host?.gamePid()){try{process.kill(host.gamePid());}catch{}}if(proc?.exitCode===null)proc.kill();await sleep(1000);if(process.exitCode){console.error("Failed proof diagnostics retained at",work);console.error((await fs.readFile(path.join(work,"panel.log"),"utf8").catch(()=>"" )).slice(-5000));}else if(path.dirname(path.resolve(work))===path.resolve(os.tmpdir())&&path.basename(work).startsWith("nomad-real-vanilla-"))await fs.rm(work,{recursive:true,force:true}).catch(()=>{});}
