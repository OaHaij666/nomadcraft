import {it,expect,vi,afterEach} from "vitest";
import http from "http";import net from "net";import {WebSocket} from "ws";
const state=vi.hoisted(()=>({epoch:1,pending:true,allowed:true,grant:{id:"11111111-1111-4111-8111-111111111111",actor:{id:"owner"},instanceId:"relay-instance",saveId:"relay-save"}}));
vi.mock("../catalog_system",()=>({nomadCatalog:{executorPlan:async(_grant:any,epoch:number)=>{if(epoch!==state.epoch)throw Error("stale");return{save:{}};},executor:async()=>state.grant,relayAllowed:async(_g:any,epoch:number)=>epoch===state.epoch&&state.allowed,pendingHandover:async()=>state.pending}}));
vi.mock("../user_service",()=>({default:{getInstance:()=>({uuid:"owner",userName:"Owner",permission:10})}}));
vi.mock("../../setting",()=>({systemConfig:{prefix:"",nomadRelayPublicHost:"127.0.0.1",nomadRelayBindIp:"127.0.0.1"}}));
import {prepareHostRelay,closeHostRelay,initHostRelay,hostRelayStatus} from "../nomad_host_relay";
it("retains the backend listener across handover while evicting old sockets and routes new connections only to the next epoch",async()=>{
 const api=http.createServer();initHostRelay(api);await new Promise<void>(r=>api.listen(0,"127.0.0.1",r));const apiPort=(api.address() as net.AddressInfo).port;let old:WebSocket|undefined,next:WebSocket|undefined,player:net.Socket|undefined;
 const connect=(epoch:number)=>new Promise<WebSocket>((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${apiPort}/api/nomad/hosting/agent/${state.grant.id}/tunnel`,{headers:{Authorization:"Bearer token","X-Nomad-Epoch":String(epoch)}});ws.on("error",reject);ws.on("open",()=>resolve(ws));});
 try{
 const originalGrant={...state.grant};
 const address=await prepareHostRelay(state.grant as any,1),port=Number(address.split(":").pop());old=await connect(1);expect(hostRelayStatus("relay-instance","relay-save").ready).toBe(true);
 const closed=new Promise(r=>old!.once("close",r));closeHostRelay(state.grant as any,true);await closed;expect(hostRelayStatus("relay-instance","relay-save").holding).toBe(true);
 state.epoch=2;state.grant={...state.grant,id:"22222222-2222-4222-8222-222222222222"};const reused=await prepareHostRelay(state.grant as any,2);expect(reused).toBe(address);expect(hostRelayStatus("relay-instance","relay-save").holding).toBe(false);
 closeHostRelay(originalGrant as any);expect(hostRelayStatus("relay-instance","relay-save").active).toBe(true);
 closeHostRelay(state.grant as any,false,1);expect(hostRelayStatus("relay-instance","relay-save").active).toBe(true);
 next=await connect(2);next.on("message",(data,binary)=>{if(binary)next!.send(data,{binary:true});});player=net.connect(port,"127.0.0.1");await new Promise(r=>player!.once("connect",r));const answer=new Promise<Buffer>(r=>player!.once("data",r));player.write("new-epoch-only");expect((await answer).toString()).toBe("new-epoch-only");
 const expired=new Promise<void>(r=>next!.once("close",()=>r()));state.allowed=false;await expired;
 expect(hostRelayStatus("relay-instance","relay-save").active).toBe(true);expect(hostRelayStatus("relay-instance","relay-save").holding).toBe(true);
 closeHostRelay(state.grant as any);expect(hostRelayStatus("relay-instance","relay-save").active).toBe(false);
 }finally{player?.destroy();old?.terminate();next?.terminate();closeHostRelay(state.grant as any);await new Promise<void>(r=>api.close(()=>r()));}
});
