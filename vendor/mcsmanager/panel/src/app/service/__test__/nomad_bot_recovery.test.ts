import { it, expect } from "vitest";
import { NomadBots } from "../nomad_bots";
import { nomadBotTransport } from "../nomad_bot_transport";

it("restores desired public brains after backend restart and host epoch change, but never restores an explicitly stopped brain", async () => {
  const instanceId = "recovery-instance", saveId = "recovery-save", owner = {id:"owner",name:"Owner",admin:true};
  let state:any = {bots:[{id:"public",instanceId,saveId,ownerId:"owner",ownerName:"Owner",name:"PublicBot",scope:"shared",admission:"approved",companionId:"",revision:1,resourceApplications:[],access:{mode:"all-except",users:[]}}],commands:[],configEntries:[["public",{settings:{model:"fixture"},sealed:"encrypted"}]],identityEntries:[],enabledEntries:[[instanceId,true]],runningPublic:["public"]};
  const storage:any={load:async()=>structuredClone(state),store:async(_c:any,_id:any,value:any)=>{state=structuredClone(value);}};
  const catalog:any={list:async()=>({instances:[{id:instanceId,saves:[{id:saveId}],permissions:["mods.manage","instance.read"]}]})};
  let phase="stopped",epoch:number|undefined,starts=0;
  const runtime:any={status:()=>({phase,epoch}),stop:async()=>{phase="stopped";},action:async(bot:any,_settings:any,_sealed:any,input:any)=>{if(["stop-thinking","leave"].includes(input.action)){phase="stopped";return{state:"stopped"};} starts++;phase="listening";epoch=(nomadBotTransport.status(instanceId,saveId) as any).epoch;bot.companionId="11111111-1111-4111-8111-111111111111";return{state:"running"};}};
  const bots=new NomadBots(()=>storage,catalog,undefined,runtime);
  nomadBotTransport.poll(instanceId,saveId,1,{ready:true});
  await bots.reconcilePublic(instanceId,saveId);expect(starts).toBe(1);expect(state.bots[0].companionId).toContain("11111111");
  await bots.reconcilePublic(instanceId,saveId);expect(starts).toBe(1);
  state.commands.push({id:"in-flight",botId:"public",createdAt:Date.now()});
  await bots.hostStopped(instanceId,saveId,1);expect(phase).toBe("stopped");expect(state.runningPublic).toEqual(["public"]);
  state.commands=[];
  nomadBotTransport.poll(instanceId,saveId,2,{ready:true});await bots.reconcilePublic(instanceId,saveId);expect(starts).toBe(2);
  await bots.hostStopped(instanceId,saveId,1);expect(phase).toBe("listening");expect((nomadBotTransport.status(instanceId,saveId) as any).epoch).toBe(2);
  await bots.bodyAction(owner,"public","leave");expect(state.runningPublic).toEqual([]);
  nomadBotTransport.poll(instanceId,saveId,3,{ready:true});await bots.reconcilePublic(instanceId,saveId);expect(starts).toBe(2);
  // A fresh backend object reads the durable intent; explicitly stopped remains stopped.
  await new NomadBots(()=>storage,catalog,undefined,runtime).reconcilePublic(instanceId,saveId);expect(starts).toBe(2);
});

it("disabling an instance clears public-brain resume intent",async()=>{
 let state:any={bots:[{id:"disabled-bot",instanceId:"disabled-instance",saveId:"s",ownerId:"o",ownerName:"O",scope:"shared",admission:"approved",revision:1}],commands:[],configEntries:[],identityEntries:[],enabledEntries:[["disabled-instance",true]],runningPublic:["disabled-bot"]};
 const storage:any={load:async()=>structuredClone(state),store:async(_c:any,_id:any,value:any)=>{state=structuredClone(value);}};
 const catalog:any={list:async()=>({instances:[{id:"disabled-instance",saves:[{id:"s"}],permissions:["mods.manage"]}]})};let stopped=0;
 const runtime:any={stop:async()=>{stopped++;}};const bots=new NomadBots(()=>storage,catalog,undefined,runtime);
 await bots.setEnabled({id:"o",name:"O",admin:true},"disabled-instance",false);expect(state.runningPublic).toEqual([]);expect(stopped).toBe(1);
});
