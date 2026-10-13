import {it,expect} from "vitest";
import fs from "fs/promises";import os from "os";import path from "path";import http from "http";
import {BotCredentialVault,NomadPublicBotRuntime,validatePublicBotConfig} from "../nomad_bot_runtime";
import {NomadBotTransport} from "../nomad_bot_transport";
import type {BotRecord} from "../../../../../shared/nomad-bots";
it("encrypted API values never appear in disk plaintext and authenticated ciphertext rejects tampering",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"nomad-bot-vault-"));try{const vault=new BotCredentialVault(dir),sealed=vault.seal("private-test-api-key");expect(sealed).not.toContain("private-test-api-key");expect(vault.open(sealed)).toBe("private-test-api-key");expect(new BotCredentialVault(dir).open(sealed)).toBe("private-test-api-key");const broken=Buffer.from(sealed,"base64");broken[broken.length-1]^=1;expect(()=>vault.open(broken.toString("base64"))).toThrow();}finally{await fs.rm(dir,{recursive:true,force:true});}
});
it("compute transport fences host epochs and never replays a claimed operation",async()=>{
 const transport=new NomadBotTransport();transport.poll("i","s",1,{ready:true,roster:[]});const result=transport.call("i","s","join",{name:"Bot"});const jobs=transport.poll("i","s",1,{ready:true});expect(jobs).toHaveLength(1);expect(transport.poll("i","s",1,{ready:true})).toHaveLength(0);transport.complete("i","s",1,jobs[0].id,{ok:true,result:{id:"body"}});expect(await result).toEqual({id:"body"});
 const stale=transport.call("i","s","lua",{code:"work()"});const rejection=expect(stale).rejects.toThrow("host_changed");transport.poll("i","s",2,{ready:true});await rejection;expect(()=>transport.complete("i","s",1,jobs[0].id,{ok:true})).toThrow();
});
it("server public Harnesses call models on backend and route bodies separately without sending credentials to compute",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"nomad-public-runtime-")),requests:any[]=[],bodyCalls:any[]=[];
 const llm=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push({key:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks).toString())});res.setHeader("Content-Type","application/json");res.end(JSON.stringify({choices:[{message:{content:"收到。"}}],usage:{}}));});await new Promise<void>(resolve=>llm.listen(0,"127.0.0.1",resolve));
 const transport:any={status:()=>({ready:true}),call:async(_i:string,_s:string,action:string,args:any)=>{bodyCalls.push({action,args});if(action==="join")return{id:args.name==="AlphaBot"?"11111111-1111-4111-8111-111111111111":"22222222-2222-4222-8222-222222222222"};if(action==="get_events")return "(no events)";return "ok";}};
 const vault=new BotCredentialVault(path.join(dir,"keys")),runtime=new NomadPublicBotRuntime(transport,vault,path.join(dir,"history"));
 const config=validatePublicBotConfig({protocol:"openai",baseUrl:"http://127.0.0.1:"+(llm.address() as any).port,model:"fixture",persona:"persona",maxTokens:256,maxTurns:2});const sealed=vault.seal("shared-server-only-secret");
 const make=(name:string):BotRecord=>({id:name,instanceId:"i",saveId:"s",ownerId:"owner",ownerName:"Owner",name,companionId:"",scope:"shared",access:{mode:"all-except",users:[]},admission:"approved",resourceApplications:[],revision:1,createdAt:Date.now()});const a=make("AlphaBot"),b=make("BetaBot");
 try{await runtime.action(a,config,sealed,{action:"message",text:"ALPHA_REQUEST"});await runtime.action(b,config,sealed,{action:"message",text:"BETA_REQUEST"});const until=Date.now()+6000;while(bodyCalls.filter(c=>c.action==="say").length<2&&Date.now()<until)await new Promise(r=>setTimeout(r,20));expect(requests).toHaveLength(2);expect(requests.every(r=>r.key==="Bearer shared-server-only-secret")).toBe(true);expect(JSON.stringify(bodyCalls)).not.toContain("shared-server-only-secret");expect(requests.find(r=>JSON.stringify(r.body).includes("ALPHA_REQUEST")).body.messages[0].content).toContain(a.companionId);await runtime.action(a,config,sealed,{action:"stop-thinking"});expect(runtime.status(a).phase).toBe("stopped");expect(runtime.status(b).phase).not.toBe("stopped");expect(bodyCalls.some(c=>["delete","leave"].includes(c.action))).toBe(false);expect(JSON.stringify(runtime.status(a))).not.toContain("shared-server-only-secret");}finally{await runtime.stop(a.id);await runtime.stop(b.id);await new Promise<void>(resolve=>llm.close(()=>resolve()));await fs.rm(dir,{recursive:true,force:true});}
});

it("a stopped host rejects pending commands immediately and a stale finish cannot invalidate the replacement host",async()=>{
 const transport=new NomadBotTransport();transport.poll("finish-i","finish-s",1,{ready:true});
 const pending=transport.call("finish-i","finish-s","say",{text:"hello"});const rejected=expect(pending).rejects.toThrow("bot_host_offline_outcome_unknown");
 expect(transport.offline("finish-i","finish-s",1)).toBe(true);await rejected;expect(transport.status("finish-i","finish-s").ready).toBe(false);
 transport.poll("finish-i","finish-s",2,{ready:true});expect(transport.offline("finish-i","finish-s",1)).toBe(false);expect(transport.status("finish-i","finish-s").ready).toBe(true);
});
