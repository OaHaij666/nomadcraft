import {beforeEach,describe,expect,it,vi,afterEach} from "vitest";
import {NomadCatalog} from "../nomad_catalog";
import {DEFAULT_PROFILE,DEFAULT_RULES,DEFAULT_SERVER,type CatalogActor,type PublishedRelease} from "../../../../../shared/nomad-catalog";
const owner:CatalogActor={id:"owner",name:"Owner",admin:false},member:CatalogActor={id:"member",name:"Member",admin:false},admin:CatalogActor={id:"admin",name:"Admin",admin:true};
let data:any,catalog:NomadCatalog,id:string,saveId:string;
beforeEach(async()=>{data=null;catalog=new NomadCatalog(()=>({load:async()=>data?structuredClone(data):null,store:async(_category,_id,value)=>{data=structuredClone(value);},list:async()=>[],delete:async()=>{}}));await catalog.creators(admin,[owner.id],()=>true);const release:PublishedRelease={id:"release",format:"modrinth",source:"upload",fileName:"pack.mrpack",sha256:"a".repeat(64),size:1,profile:{...DEFAULT_PROFILE,mcVersion:"1.20.1"},server:{...DEFAULT_SERVER,eulaAccepted:true},serverArtifact:{url:"https://piston-data.mojang.com/server.jar",sha1:"b".repeat(40),fileName:"server.jar",kind:"jar",installArgs:[],launchArgs:["-jar","server.jar","nogui"]},publishedAt:1,publishedBy:owner.id,fileCount:0};const instance=await catalog.create(owner,{name:"Room",description:"",profile:release.profile},release);id=instance.id;saveId=(await catalog.save(owner,id,null,{name:"World",description:"",rules:DEFAULT_RULES})).id;await catalog.room(owner,id,saveId,{name:"Room"},true);await catalog.room(owner,id,saveId,{name:"Room",desiredState:"open"},false);});
afterEach(()=>vi.restoreAllMocks());
const ticket=async(actor=owner)=>{const t=await catalog.issueExecutor(actor,id,saveId,"PC");return {...t,grant:await catalog.executor(t.grantId,t.token)};};
describe("authorized catalog hosting and world fences",()=>{
 it("requires scoped hosting permission and does not grant OP or publishing",async()=>{await expect(ticket(member)).rejects.toMatchObject({code:"hosting_forbidden"});await catalog.grants(owner,id,[{userId:member.id,scope:saveId,permissions:["save.read"],hosting:true}],()=>true);const t=await ticket(member);expect((await catalog.claimExecutor(t.grant,member)).lease.epoch).toBe(1);const view=(await catalog.list(member)).instances[0];expect(view.permissions).not.toContain("mods.manage");expect(view.saves[0].players).toEqual([]);expect(view.saves[0].hostingAllowed).toBe(true);expect(JSON.stringify(view)).not.toContain(t.token);expect(JSON.stringify(view)).not.toContain("tokenHash");});
 it("serializes competing hosts and pins the release without leaking private tokens",async()=>{const a=await ticket(),b=await ticket();const results=await Promise.allSettled([catalog.claimExecutor(a.grant,owner),catalog.claimExecutor(b.grant,owner)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"host_busy"}});expect(data.hosting.grants.find((g:any)=>g.id===a.grantId)?.tokenHash).not.toBe(a.token);});
 it("requires a final checkpoint before releasing the host",async()=>{const t=await ticket(),plan=await catalog.claimExecutor(t.grant,owner);await expect(catalog.finishExecutor(t.grant,plan.lease.epoch,{clean:true})).rejects.toMatchObject({code:"final_checkpoint_required"});await catalog.commitWorld(t.grant,1,{sha256:"c".repeat(64),size:50,at:Date.now(),epoch:1});await expect(catalog.finishExecutor(t.grant,1,{clean:true})).rejects.toMatchObject({code:"final_checkpoint_required"});await catalog.commitWorld(t.grant,1,{sha256:"c".repeat(64),size:50,at:Date.now(),epoch:1,final:true});await catalog.finishExecutor(t.grant,1,{clean:true});await expect(catalog.executor(t.grantId,t.token)).rejects.toMatchObject({code:"executor_expired"});const next=await ticket();expect((await catalog.claimExecutor(next.grant,owner)).checkpoint?.sha256).toBe("c".repeat(64));});
 it("stops revoked hosts and keeps a bounded final-upload path for the same epoch",async()=>{await catalog.grants(owner,id,[{userId:member.id,scope:saveId,permissions:["save.read"],hosting:true}],()=>true);const t=await ticket(member);await catalog.claimExecutor(t.grant,member);await catalog.grants(owner,id,[],()=>true);expect((await catalog.executorHeartbeat(t.grant,member,1,{phase:"ready"})).stop).toBe(true);expect(await catalog.relayAllowed(t.grant,1,member)).toBe(false);expect(await catalog.relayAllowed(t.grant,1,member,true)).toBe(false);await catalog.commitWorld(t.grant,1,{sha256:"d".repeat(64),size:50,at:Date.now(),epoch:1});});
 it("blocks changes and re-open while the old process is stopping",async()=>{const t=await ticket();await catalog.claimExecutor(t.grant,owner);await catalog.room(owner,id,saveId,{name:"Room",desiredState:"closed"},false);await expect(catalog.bindRelease(owner,id,saveId,"release")).rejects.toMatchObject({code:"host_must_stop_first"});await expect(catalog.room(owner,id,saveId,{name:"Room",desiredState:"open"},false)).rejects.toMatchObject({code:"host_must_stop_first"});expect((await catalog.executorHeartbeat(t.grant,owner,1,{phase:"ready"})).stop).toBe(true);});
 it("renews only a bounded stopping window while the final world uploads",async()=>{const t=await ticket();await catalog.claimExecutor(t.grant,owner);await catalog.room(owner,id,saveId,{name:"Room",desiredState:"closed"},false);const now=Date.now();const clock=vi.spyOn(Date,"now").mockReturnValue(now);expect((await catalog.executorHeartbeat(t.grant,owner,1,{phase:"stopping"})).stop).toBe(true);const deadline=data.hosting.leases[0].stopDeadlineAt;for(let step=1;step<=6;step++){clock.mockReturnValue(now+step*60000);await catalog.executorHeartbeat(t.grant,owner,1,{phase:"stopping"});}expect(data.hosting.leases[0].stopDeadlineAt).toBe(deadline);expect(data.hosting.leases[0].leaseExpiresAt).toBe(now+360000+90000);clock.mockReturnValue(deadline+20001);await expect(catalog.commitWorld(t.grant,1,{sha256:"e".repeat(64),size:1,at:Date.now(),epoch:1,final:true})).rejects.toMatchObject({code:"stale_host_epoch"});});
 it("fences expired epochs before granting a new host",async()=>{const t=await ticket();const plan=await catalog.claimExecutor(t.grant,owner);const until=plan.lease.leaseExpiresAt+20001;vi.spyOn(Date,"now").mockReturnValue(until);const next=await ticket();expect((await catalog.claimExecutor(next.grant,owner)).lease.epoch).toBe(2);await expect(catalog.commitWorld(t.grant,1,{sha256:"e".repeat(64),size:50,at:until,epoch:1})).rejects.toMatchObject({code:"stale_host_epoch"});});
 it("requires actual task credentials and an open vanilla room",async()=>{const t=await ticket();await expect(catalog.executor(t.grantId,"f".repeat(64))).rejects.toMatchObject({status:401});await catalog.room(owner,id,saveId,{name:"Room",desiredState:"closed"},false);await expect(catalog.claimExecutor(t.grant,owner)).rejects.toMatchObject({code:"room_not_open"});});
});

it("hands a room only to the requested node after clean final commit, and finishes the handover on readiness",async()=>{
 const source=await ticket();await catalog.claimExecutor(source.grant,owner);await catalog.executorReady(source.grant,owner,1,"127.0.0.1:25565");
 const target=await catalog.createComputeNode(admin,{name:"Target",kind:"server",memoryBudgetMb:8192});
 const poll={metrics:{cpuCores:4,totalMemoryMb:8192,availableMemoryMb:8192}};
 const lookup=(userId:string)=>userId===admin.id?{actor:admin,willingness:"medium" as any}:null;
 await catalog.dispatchComputeNode(target.node.id,poll,lookup);
 await expect(catalog.requestHandover(member,id,saveId,target.node.id,()=>admin)).rejects.toMatchObject({status:403});
 const handover=await catalog.requestHandover(owner,id,saveId,target.node.id,()=>admin);expect(handover.phase).toBe("saving");
 expect((await catalog.executorHeartbeat(source.grant,owner,1,{phase:"ready"})).stop).toBe(true);
 expect(await catalog.relayAllowed(source.grant,1,owner)).toBe(false);
 expect(await catalog.relayAllowed(source.grant,1,owner,true)).toBe(true);
 expect((await catalog.dispatchComputeNode(target.node.id,poll,lookup)).assignment).toBeNull();
 await catalog.commitWorld(source.grant,1,{sha256:"f".repeat(64),size:1,epoch:1,at:Date.now(),final:true});await catalog.finishExecutor(source.grant,1,{clean:true});
 const scheduled=await catalog.dispatchComputeNode(target.node.id,poll,lookup);expect(scheduled.assignment?.nodeId).toBeUndefined();expect(scheduled.assignment).not.toBeNull();
 const grant=await catalog.executor(scheduled.assignment!.grantId,scheduled.assignment!.token);const plan=await catalog.claimExecutor(grant,admin);expect(plan.lease.handover?.phase).toBe("restoring");expect(plan.checkpoint?.sha256).toBe("f".repeat(64));
 await catalog.executorReady(grant,admin,2,"127.0.0.1:25565");expect((await catalog.executorPlan(grant,2)).lease.handover?.phase).toBe("completed");
});

it("never starts a handover target after source expiry without its final world",async()=>{
 const source=await ticket();await catalog.claimExecutor(source.grant,owner);await catalog.executorReady(source.grant,owner,1,"127.0.0.1:25565");
 const target=await catalog.createComputeNode(admin,{name:"Target",kind:"server",memoryBudgetMb:8192});const poll={metrics:{cpuCores:4,totalMemoryMb:8192,availableMemoryMb:8192}},lookup=()=>({actor:admin,willingness:"medium" as any});
 await catalog.dispatchComputeNode(target.node.id,poll,lookup);await catalog.requestHandover(owner,id,saveId,target.node.id,()=>admin);
 const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+200000);
 expect((await catalog.dispatchComputeNode(target.node.id,poll,lookup)).assignment).toBeNull();
 const stray=await ticket();await expect(catalog.claimExecutor(stray.grant,owner)).rejects.toMatchObject({code:"handover_final_checkpoint_required"});
});

it("rejects a player who opted out before stopping the current host",async()=>{
 const source=await ticket();await catalog.claimExecutor(source.grant,owner);await catalog.executorReady(source.grant,owner,1,"127.0.0.1:25565");
 const target=await catalog.createComputeNode(owner,{name:"OptedOut",kind:"player",memoryBudgetMb:8192});
 await catalog.dispatchComputeNode(target.node.id,{metrics:{cpuCores:4,totalMemoryMb:8192,availableMemoryMb:8192}},()=>({actor:owner,willingness:"none"}));
 await expect(catalog.requestHandover(owner,id,saveId,target.node.id,()=>({...owner,willingness:"none"}))).rejects.toMatchObject({code:"handover_target_unavailable"});
 const lease=(await catalog.executorPlan(source.grant,1)).lease;expect(lease.phase).toBe("ready");expect(lease.handover).toBeUndefined();
});

async function preparedFixedHandover(){
 await catalog.room(owner,id,saveId,{name:"Room",desiredState:"closed"},false);
 const source=await catalog.createComputeNode(admin,{name:"Original fixed host",kind:"server",memoryBudgetMb:8192});
 const target=await catalog.createComputeNode(admin,{name:"Handover host",kind:"server",memoryBudgetMb:8192});
 await catalog.runtimeSettings(owner,id,saveId,{placement:{mode:"fixed",nodeId:source.node.id}});
 await catalog.room(owner,id,saveId,{name:"Room",desiredState:"open"},false);
 const poll={metrics:{cpuCores:4,totalMemoryMb:8192,availableMemoryMb:8192}},lookup=()=>({actor:admin,willingness:"medium" as any});
 const assigned=(await catalog.dispatchComputeNode(source.node.id,poll,lookup)).assignment!;
 const grant=await catalog.executor(assigned.grantId,assigned.token);await catalog.claimExecutor(grant,admin);await catalog.executorReady(grant,admin,1,"127.0.0.1:25565");
 await catalog.dispatchComputeNode(target.node.id,poll,lookup);
 await catalog.requestHandover(owner,id,saveId,target.node.id,()=>admin);
 expect((await catalog.executorHeartbeat(grant,admin,1,{phase:"ready"})).stop).toBe(true);
 await catalog.commitWorld(grant,1,{sha256:"a".repeat(64),size:1,epoch:1,at:Date.now(),final:true});await catalog.finishExecutor(grant,1,{clean:true});
 return{source,target,poll,lookup};
}
it("explicit handover overrides the fixed-node constraint for the selected target only",async()=>{
 const {source,target,poll,lookup}=await preparedFixedHandover();
 expect((await catalog.dispatchComputeNode(source.node.id,poll,lookup)).assignment).toBeNull();
 const assigned=(await catalog.dispatchComputeNode(target.node.id,poll,lookup)).assignment!;expect(assigned).toBeTruthy();
 const grant=await catalog.executor(assigned.grantId,assigned.token),claimed=await catalog.claimExecutor(grant,admin);
 expect(claimed.lease.epoch).toBe(2);expect(claimed.lease.handover?.phase).toBe("restoring");expect(claimed.checkpoint?.epoch).toBe(1);
 const view=(await catalog.list(owner)).instances[0].saves.find(s=>s.id===saveId)!;expect(view.hosting?.handover?.phase).toBe("restoring");expect(view.hosting?.handover?.targetNodeId).toBe(target.node.id);expect(JSON.stringify(view.hosting)).not.toContain("grantId");expect(JSON.stringify(view.hosting)).not.toContain("tokenHash");
 expect(claimed.save.placement?.nodeId).toBe(source.node.id); // The next normal opening still follows the saved placement policy.
});
it("retries a failed target startup only after fencing the old attempt, without replacing the source final snapshot",async()=>{
 const {target,poll,lookup}=await preparedFixedHandover();const assigned=(await catalog.dispatchComputeNode(target.node.id,poll,lookup)).assignment!;
 const original=await catalog.executor(assigned.grantId,assigned.token),first=await catalog.claimExecutor(original,admin);
 expect((await catalog.dispatchComputeNode(target.node.id,poll,lookup)).assignment).toBeNull();
 const now=first.lease.leaseExpiresAt+20001;vi.spyOn(Date,"now").mockReturnValue(now);
 const retry=(await catalog.dispatchComputeNode(target.node.id,poll,lookup)).assignment!;expect(retry).toBeTruthy();
 const grant=await catalog.executor(retry.grantId,retry.token),plan=await catalog.claimExecutor(grant,admin);
 expect(plan.lease.epoch).toBe(3);expect(plan.checkpoint?.sha256).toBe("a".repeat(64));expect(plan.checkpoint?.epoch).toBe(1);expect(plan.lease.handover?.sourceEpoch).toBe(1);
 await expect(catalog.executorReady(original,admin,2,"127.0.0.1:25565")).rejects.toMatchObject({code:"stale_host_epoch"});
 await catalog.executorReady(grant,admin,3,"127.0.0.1:25565");expect((await catalog.executorPlan(grant,3)).lease.handover?.phase).toBe("completed");
});
it("uses a target's clean final snapshot if startup is interrupted before publication",async()=>{
 const {target,poll,lookup}=await preparedFixedHandover();const assigned=(await catalog.dispatchComputeNode(target.node.id,poll,lookup)).assignment!;
 const grant=await catalog.executor(assigned.grantId,assigned.token);await catalog.claimExecutor(grant,admin);
 await catalog.commitWorld(grant,2,{sha256:"b".repeat(64),size:1,epoch:2,at:Date.now(),final:true});await catalog.finishExecutor(grant,2,{clean:true});
 const retry=(await catalog.dispatchComputeNode(target.node.id,poll,lookup)).assignment!;expect(retry).toBeTruthy();
 const next=await catalog.executor(retry.grantId,retry.token),plan=await catalog.claimExecutor(next,admin);
 expect(plan.checkpoint?.sha256).toBe("b".repeat(64));expect(plan.lease.handover?.sourceEpoch).toBe(1);expect(plan.lease.handover?.checkpointEpoch).toBe(2);
});
