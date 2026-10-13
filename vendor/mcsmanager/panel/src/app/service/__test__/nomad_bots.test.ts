import { beforeEach, describe, it, expect } from "vitest";
import { NomadBots } from "../nomad_bots";
import { NomadCatalog } from "../nomad_catalog";
import {
  botControlAllowed,
  validateBotAccess,
  type BotRecord
} from "../../../../../shared/nomad-bots";
import {
  DEFAULT_PROFILE,
  DEFAULT_RULES,
  type CatalogActor
} from "../../../../../shared/nomad-catalog";
const owner: CatalogActor = { id: "owner", name: "Owner", admin: true };
const friend: CatalogActor = { id: "friend", name: "Friend", admin: false };
const outsider: CatalogActor = { id: "outsider", name: "Outsider", admin: false };
let catalog: NomadCatalog, bots: NomadBots, instanceId: string, saveId: string;
let records: Record<string, any>;
beforeEach(async () => {
  records = {};
  const storage: any = {
    load: async (c: string, _ctor: any, id: string) =>
      records[c + "/" + id] ? structuredClone(records[c + "/" + id]) : null,
    store: async (c: string, id: string, data: any) => {
      records[c + "/" + id] = structuredClone(data);
    }
  };
  catalog = new NomadCatalog(() => storage);
  bots = new NomadBots(() => storage, catalog);
  const instance = await catalog.create(owner, {
    name: "Friends",
    description: "",
    profile: { ...DEFAULT_PROFILE, mcVersion: "1.21.1" }
  });
  instanceId = instance.id;
  saveId = (
    await catalog.save(owner, instanceId, null, {
      name: "World",
      description: "",
      rules: { ...DEFAULT_RULES }
    })
  ).id;
  await catalog.grants(
    owner,
    instanceId,
    [
      {
        userId: friend.id,
        scope: "instance",
        permissions: ["instance.read", "save.read"],
        hosting: false
      }
    ],
    () => true
  );
});
const create = async (users: string[] = []) => {
  const bot = await bots.create(owner, {
    instanceId,
    saveId,
    scope: "private",
    name: "NomadBot",
    companionId: "11111111-1111-4111-8111-111111111111",
    access: { mode: "whitelist", users }
  });
  return bots.review(owner, bot.id, {
    revision: bot.revision,
    decision: "approve",
    reason: "Reviewed resources"
  });
};
describe("bot ownership, command routing and authorization", () => {
  it("private owner always controls; friends need whitelist and instance access", async () => {
    const bot = await create([friend.id, outsider.id]);
    expect(bot.runner).toBe("owner");
    expect(bot.canControl).toBe(true);
    expect((await bots.list(friend, instanceId, saveId))[0].canControl).toBe(true);
    await expect(bots.list(outsider, instanceId, saveId)).rejects.toMatchObject({ status: 403 });
    await expect(bots.claim(friend, bot.id)).rejects.toMatchObject({ status: 403 });
  });
  it("ordinary member submits an admission request but cannot approve or control it", async () => {
    const bot = await bots.create(friend, {
      instanceId,
      saveId,
      scope: "private",
      name: "FriendBot",
      access: { mode: "whitelist", users: [] }
    });
    expect(bot.admission).toBe("pending");
    expect(bot.canControl).toBe(false);
    await expect(
      bots.review(friend, bot.id, { revision: 1, decision: "approve", reason: "" })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      bots.submit(friend, bot.id, { action: "message", text: "run" })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      bots.bindCompanion(friend, bot.id, "11111111-1111-4111-8111-111111111111")
    ).rejects.toMatchObject({ status: 403 });
  });
  it("non-owner cannot alter private whitelist or delete even when allowed to control", async () => {
    const bot = await create([friend.id]);
    await expect(
      bots.access(friend, bot.id, { revision: 2, access: { mode: "whitelist", users: [] } })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      bots.submit(friend, bot.id, { action: "delete", confirm: "permanent" })
    ).rejects.toMatchObject({ status: 403 });
    await expect(bots.submit(owner, bot.id, { action: "delete" })).rejects.toMatchObject({
      status: 400
    });
  });
  it("revokes queued commands when instance membership changes before delivery", async () => {
    const bot = await create([friend.id]);
    await bots.submit(friend, bot.id, { action: "message", text: "gather wood" });
    await catalog.grants(owner,instanceId,[],()=>true);
    expect(await bots.claim(owner, bot.id)).toBe(null);
    const record = records["NomadBots/bots"].commands[0];
    expect(record.error).toBe("bot_permission_revoked");
  });
  it("one owner claim at a time, authenticated submitter retained, no automatic replay", async () => {
    const bot = await create([friend.id]);
    await bots.submit(friend, bot.id, { action: "message", text: "gather wood" });
    await bots.submit(owner, bot.id, { action: "stop-thinking" });
    const command = await bots.claim(owner, bot.id);
    expect(command?.userId).toBe(friend.id);
    expect(command?.companionId).toBe(bot.companionId);
    expect(await bots.claim(owner, bot.id)).toBe(null);
    await bots.complete(owner, bot.id, command!.id, { ok: true });
    expect((await bots.claim(owner, bot.id))?.action).toBe("stop-thinking");
  });
  it("marks deletion only after confirmed owner execution and does not save credential-bearing error strings", async () => {
    const bot = await create();
    await bots.submit(owner, bot.id, { action: "delete", confirm: "permanent" });
    const command = await bots.claim(owner, bot.id);
    await bots.complete(owner, bot.id, command!.id, { ok: false, error: "secret-api-key" });
    expect(JSON.stringify(records)).not.toContain("secret-api-key");
    expect((await bots.list(owner, instanceId, saveId)).length).toBe(1);
    await bots.submit(owner, bot.id, { action: "delete", confirm: "permanent" });
    const second = await bots.claim(owner, bot.id);
    await bots.complete(owner, bot.id, second!.id, { ok: true });
    expect(await bots.list(owner, instanceId, saveId)).toEqual([]);
  });
  it("uses optimistic revisions; rejects private all-except and routes no command to a fake server runtime", async () => {
    const bot = await create();
    await expect(
      bots.access(owner, bot.id, { revision: 0, access: { mode: "whitelist", users: [] } })
    ).rejects.toMatchObject({ status: 409 });
    expect(() => validateBotAccess("private", { mode: "all-except", users: [] })).toThrow();
    await expect(
      bots.create(owner, {
        instanceId,
        saveId,
        scope: "shared",
        name: "SharedBot",
        access: { mode: "all-except", users: [] }
      })
    ).rejects.toMatchObject({ code: "invalid_public_bot_config" });
  });
  it("public ACL whitelist excludes unlisted creator, all-except blocks even the creator", () => {
    const bot = {
      admission: "approved",
      ownerId: owner.id,
      scope: "shared",
      access: { mode: "whitelist", users: [friend.id] }
    } as BotRecord;
    expect(botControlAllowed(bot, owner.id)).toBe(true);
    expect(botControlAllowed(bot, friend.id)).toBe(true);
    bot.access = { mode: "all-except", users: [owner.id] };
    expect(botControlAllowed(bot, owner.id)).toBe(true);
    expect(botControlAllowed(bot, friend.id)).toBe(true);
  });
});

it("retains enabled state, public encrypted configuration and verified identities with real StorageSubsystem hydration",async()=>{
  const {StorageSubsystem}=await import("mcsmanager-common");
  class Hydration extends StorageSubsystem { hydrate(target:any,data:any){return this.defineAttr(target,data);} }
  const hydrate=new Hydration();const storage:any={load:async(category:string,ctor:any,id:string)=>{const raw=records[category+"/"+id];return raw?hydrate.hydrate(new ctor(),structuredClone(raw)):null;},store:async(category:string,id:string,value:any)=>{records[category+"/"+id]=structuredClone(value);}};
  const service=new NomadBots(()=>storage,catalog);await service.setEnabled(owner,instanceId,true);expect((await service.instanceSettings(owner,instanceId)).enabled).toBe(true);
  const model={protocol:"openai",baseUrl:"https://example.com/v1",model:"fixture",persona:"test",maxTokens:256,maxTurns:2,apiKey:"public-never-returned"};
  const pending=await service.create(owner,{instanceId,saveId,scope:"shared",name:"PublicProof",model});expect(pending.hasApiKey).toBe(true);expect(JSON.stringify(pending)).not.toContain("public-never-returned");
  await service.review(owner,pending.id,{revision:pending.revision,decision:"approve",reason:""});const list=await service.list(owner,instanceId,saveId);expect(list[0].hasApiKey).toBe(true);expect(list[0].model?.model).toBe("fixture");expect(JSON.stringify(list)).not.toContain("public-never-returned");
  const linked=await service.link(owner,instanceId,saveId);await service.hostPolicy(instanceId,saveId,[{code:linked.code,uuid:"11111111-1111-4111-8111-111111111111"}]);expect((await service.hostPolicy(instanceId,saveId)).bots[0].ownerUuid).toBe("11111111-1111-4111-8111-111111111111");
  const changed=await service.sharedConfig(owner,pending.id,{...model,apiKey:undefined,revision:list[0].revision,clearApiKey:true});expect(changed.hasApiKey).toBe(false);expect((await service.list(owner,instanceId,saveId))[0].hasApiKey).toBe(false);await service.setEnabled(owner,instanceId,false);expect((await service.instanceSettings(owner,instanceId)).enabled).toBe(false);
});

it('shared body actions keep native member control but still require instance access and admission',async()=>{
 const storage:any={load:async(category:string,_ctor:any,id:string)=>records[category+'/'+id]?structuredClone(records[category+'/'+id]):null,store:async(category:string,id:string,value:any)=>{records[category+'/'+id]=structuredClone(value)}};
 const actions:string[]=[];const runtime:any={stop:async()=>{},status:()=>({phase:'stopped'}),action:async(bot:any,_settings:any,_sealed:any,input:any)=>{actions.push(input.action);bot.companionId='11111111-1111-4111-8111-111111111111';return{state:input.action==='join'?'running':'left',companionId:bot.companionId}}};
 const service=new NomadBots(()=>storage,catalog,undefined,runtime);await service.setEnabled(owner,instanceId,true);
 const model={protocol:'openai',baseUrl:'https://example.com/v1',model:'fixture',persona:'test',maxTokens:256,maxTurns:2,apiKey:'body-access-fixture-key'};
 const pending=await service.create(owner,{instanceId,saveId,scope:'shared',name:'BodyAccessBot',access:{mode:'whitelist',users:[]},model});
 await expect(service.bodyAction(friend,pending.id,'join')).rejects.toMatchObject({code:'bot_admission_required'});expect(actions).toEqual([]);
 let bot=await service.review(owner,pending.id,{revision:pending.revision,decision:'approve',reason:''});
 await expect(service.bodyAction(outsider,bot.id,'join')).rejects.toMatchObject({status:403});expect(actions).toEqual([]);
 await service.bodyAction(friend,bot.id,'join');expect(actions).toEqual(['join']);
 bot=(await service.list(owner,instanceId,saveId))[0];await service.access(owner,bot.id,{revision:bot.revision,access:{mode:'all-except',users:[friend.id]}});
 await service.bodyAction(friend,bot.id,'leave');expect(actions).toEqual(['join','leave']);
 bot=(await service.list(owner,instanceId,saveId))[0];await expect(service.sharedConfig(friend,bot.id,{...model,revision:bot.revision,apiKey:'must-not-replace-owner-key'})).rejects.toMatchObject({code:'bot_management_forbidden'});
 expect(JSON.stringify(await service.list(friend,instanceId,saveId))).not.toContain('body-access-fixture-key');
});
