import {DEFAULT_PLACEMENT,NODE_ONLINE_MS,type ComputeNode,type ComputeNodeView} from "../../../../shared/nomad-compute";
import type {HostingWillingness} from "../../../../shared/nomad-hosting-preference";
import {selectComputeNode,type Candidate} from "./nomad_placement";
import {validateIngress} from "./nomad_ingress";
import crypto from "crypto";
import { HOST_LEASE_MS, HOST_FENCE_GRACE_MS, HOST_FINAL_SAVE_MS, type ExecutorGrant, type HostLease, type HostingState, type WorldCheckpoint } from "../../../../shared/nomad-hosting";
import { v4 as uuid } from "uuid";
import type { IStorage } from "../common/storage/storage_interface";
import {
  CATALOG_PERMISSIONS,
  DEFAULT_RULES,
  DEFAULT_LAUNCH,
  SERVER_LOADERS,
  type AccessGrant,
  type CatalogActor,
  type CatalogPermission,
  type CatalogResponse,
  type CatalogSave,
  type InstanceView,
  type LogicalInstance,
  type ModEntry,
  type PlayerRule,
  type PublishedRelease,
  type RuntimeProfile,
  type WorldRules
} from "../../../../shared/nomad-catalog";

export class CatalogError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}
class CatalogState {
  schema = 1;
  creatorIds: string[] = [];
  instances: LogicalInstance[] = [];
  hosting: HostingState = {grants: [], leases: [], nodes:[]};
}
const fail = (status: number, code: string): never => {
  throw new CatalogError(status, code);
};
function text(value: unknown, max = 120, required = false): string {
  if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    return fail(400, "invalid_text");
  const result = value.trim();
  if (required && !result) return fail(400, "required_field");
  return result;
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    return fail(400, "invalid_number");
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") return fail(400, "invalid_boolean");
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) return fail(400, "invalid_choice");
  return value as T;
}
function hash(value: unknown): string {
  const result = text(value, 64);
  if (result && !/^[a-f0-9]{64}$/i.test(result)) return fail(400, "invalid_hash");
  return result.toLowerCase();
}
function array(value: unknown, max: number): any[] {
  if (!Array.isArray(value) || value.length > max) return fail(400, "invalid_list");
  return value;
}
function entries<T>(items: Array<[string, T]>): Record<string, T> {
  const result: Record<string, T> = Object.create(null);
  for (const [key, value] of items) result[key] = value;
  return result;
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail(400, "invalid_object");
  return value as Record<string, any>;
}
export function validateProfile(input: unknown): RuntimeProfile {
  const p = object(input);
  return {
    launch: validateLaunch(p.launch),
    mcVersion: text(p.mcVersion, 40, true),
    loader: choice(p.loader, SERVER_LOADERS),
    loaderVersion: text(p.loaderVersion, 80),
    packName: text(p.packName, 120),
    packRevision: text(p.packRevision, 80),
    javaMajor: number(p.javaMajor, 8, 99),
    memoryMb: number(p.memoryMb, 512, 262144),
    artifact: text(p.artifact, 240),
    artifactSha256: hash(p.artifactSha256)
  };
}
export function validateLaunch(input: unknown) {
  const p = {...DEFAULT_LAUNCH, ...(input === undefined ? {} : object(input))};
  const jvmArgs = text(p.jvmArgs, 4000), gameArgs = text(p.gameArgs, 4000);
  if (/-javaagent|-agentlib|-agentpath|-classpath|(?:^|\s)-cp(?:\s|$)|-jar|@|[\r\n]/i.test(jvmArgs) || /--accessToken|--username|--uuid|--gameDir|--assetsDir|@|[\r\n]/i.test(gameArgs)) fail(400, "unsafe_launch_arguments");
  const autoJoin = text(p.autoJoin, 255);
  if (autoJoin && !/^[a-z0-9.\-\[\]:]+$/i.test(autoJoin)) fail(400, "invalid_server_address");
  return {windowTitle: text(p.windowTitle, 100), launcherInfo: text(p.launcherInfo, 100), windowMode: choice(p.windowMode, ["default", "windowed", "maximized", "fullscreen"]), width: number(p.width, 320, 16384), height: number(p.height, 240, 16384), memoryMode: choice(p.memoryMode, ["auto", "manual"]), memoryOptimization: bool(p.memoryOptimization), javaRange: text(p.javaRange, 80), jvmArgs, gameArgs, gc: choice(p.gc, ["default", "serial", "parallel", "g1", "zgc"]), autoJoin, downloadSource: choice(p.downloadSource, ["auto", "official", "mirror"]), assets: choice(p.assets, ["default", "verify"]), disableJLW: bool(p.disableJLW), disableLUA: bool(p.disableLUA)};
}
export function validateRules(input: unknown): WorldRules {
  const p = object(input);
  return {
    seed: text(p.seed, 128),
    gameMode: choice(p.gameMode, ["survival", "creative", "adventure", "spectator"]),
    difficulty: choice(p.difficulty, ["peaceful", "easy", "normal", "hard"]),
    maxPlayers: number(p.maxPlayers, 1, 1000),
    viewDistance: number(p.viewDistance, 3, 32),
    simulationDistance: number(p.simulationDistance, 3, 32),
    pvp: bool(p.pvp),
    hardcore: bool(p.hardcore),
    whitelist: bool(p.whitelist)
  };
}
export function permissionsFor(
  instance: LogicalInstance,
  actor: CatalogActor,
  saveId?: string
): CatalogPermission[] {
  if (actor.admin || actor.id === instance.ownerId) return [...CATALOG_PERMISSIONS];
  const permissions = new Set<CatalogPermission>();
  for (const grant of instance.grants)
    if (grant.userId === actor.id && (grant.scope === "instance" || grant.scope === saveId))
      grant.permissions.forEach((p) => permissions.add(p));
  return [...permissions];
}
function requirePermission(
  instance: LogicalInstance,
  actor: CatalogActor,
  permission: CatalogPermission,
  saveId?: string
) {
  if (!permissionsFor(instance, actor, saveId).includes(permission)) fail(403, "forbidden");
}
function requireOwner(instance: LogicalInstance, actor: CatalogActor) {
  if (!actor.admin && actor.id !== instance.ownerId) fail(403, "owner_required");
}
function findInstance(state: CatalogState, id: string) {
  const result = state.instances.find((i) => i.id === id);
  if (!result) return fail(404, "instance_not_found");
  return result;
}
function findSave(instance: LogicalInstance, id: string) {
  const result = instance.saves.find((s) => s.id === id);
  if (!result) return fail(404, "save_not_found");
  return result;
}
function log(
  instance: LogicalInstance,
  actor: CatalogActor,
  action: string,
  saveId: string | null = null
) {
  instance.updatedAt = Date.now();
  instance.revision++;
  instance.events.unshift({
    id: uuid(),
    at: Date.now(),
    actor: actor.name,
    actorId: actor.id,
    action,
    saveId
  });
  instance.events = instance.events.slice(0, 200);
}
export class NomadCatalog {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private storage: () => IStorage) {}
  private async load(): Promise<CatalogState> {
    return (
      (await this.storage().load("NomadCatalog", CatalogState, "catalog")) ?? new CatalogState()
    );
  }
  private mutate<T>(fn: (state: CatalogState) => T): Promise<T> {
    const work = this.queue.then(async () => {
      const state = await this.load();
      const result = fn(state);
      await this.storage().store("NomadCatalog", "catalog", state);
      return structuredClone(result);
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  async list(actor: CatalogActor): Promise<CatalogResponse> {
    await this.queue;
    const state = await this.load();
    const instances: InstanceView[] = [];
    for (const instance of state.instances) {
      const permissions = permissionsFor(instance, actor);
      const savePermissions = entries(
        instance.saves.map((save) => [save.id, permissionsFor(instance, actor, save.id)])
      );
      const saves = instance.saves.filter((save) => savePermissions[save.id].includes("save.read"));
      if (!permissions.includes("instance.read") && !saves.length) continue;
      const owner = actor.admin || actor.id === instance.ownerId;
      instances.push({
        ...structuredClone(instance),
        saves: saves.map(save => {
          const lease = state.hosting?.leases.find(l => l.instanceId === instance.id && l.saveId === save.id);
          const hosting = lease ? {phase: lease.leaseExpiresAt < Date.now() && !["stopped", "failed"].includes(lease.phase) ? "failed" as const : lease.phase, epoch:lease.epoch,nodeName:lease.nodeName,holderName:lease.holderName,leaseExpiresAt:lease.leaseExpiresAt,joinAddress:["ready","checkpointing"].includes(lease.phase) && lease.leaseExpiresAt > Date.now() && save.room?.desiredState === "open" ? lease.joinAddress : null,checkpoint:lease.checkpoint,error:lease.error,...(lease.handover?{handover:structuredClone(lease.handover)}:{})} : null;
          return {...structuredClone(save), hosting, hostingAllowed:this.allowedHost(instance,actor,save.id)};
        }),
        releases: structuredClone((instance.releases ?? []).filter(r => permissions.includes("instance.read") || saves.some(s => s.releaseId === r.id))),
        permissions,
        savePermissions: entries(saves.map((save) => [save.id, savePermissions[save.id]])),
        grants: owner
          ? structuredClone(instance.grants)
          : instance.grants.filter((g) => g.userId === actor.id),
        events: instance.events.filter(
          (e) =>
            owner ||
            (e.saveId !== null && saves.some((s) => s.id === e.saveId)) ||
            (e.actorId === actor.id && e.saveId === null)
        ),
        hostingScopes: instance.grants
          .filter(
            (g) =>
              g.userId === actor.id &&
              g.hosting &&
              (g.scope === "instance" || saves.some((s) => s.id === g.scope))
          )
          .map((g) => g.scope)
      });
    }
    return {
      instances,
      canCreate: actor.admin || state.creatorIds.includes(actor.id),
      ...(actor.admin ? { creatorIds: [...state.creatorIds] } : {})
    };
  }
  private requireHostStopped(state:CatalogState,instanceId:string,saveId?:string){
    const busy=state.hosting?.leases.some(l=>l.instanceId===instanceId && (!saveId||l.saveId===saveId) && !["stopped","failed"].includes(l.phase) && l.leaseExpiresAt+HOST_FENCE_GRACE_MS>Date.now());
    if(busy)fail(409,"host_must_stop_first");
  }
  private hostState(state: CatalogState): HostingState {
    return state.hosting ?? (state.hosting = {grants:[],leases:[],nodes:[]});
  }
  private allowedHost(instance: LogicalInstance, actor: CatalogActor, saveId: string) {
    return actor.admin || actor.id === instance.ownerId || (permissionsFor(instance, actor, saveId).includes("save.read") && instance.grants.some(g => g.userId === actor.id && g.hosting && (g.scope === "instance" || g.scope === saveId)));
  }
  async issueExecutor(actor: CatalogActor, instanceId: string, saveId: string, nodeName: unknown) {
    return this.mutate(state => {
      const instance = findInstance(state,instanceId), save = findSave(instance,saveId);
      if(!this.allowedHost(instance,actor,saveId)) fail(403,"hosting_forbidden");
      if((save.placement??DEFAULT_PLACEMENT).mode!=="manual")fail(409,"automatic_placement_enabled");
      if(!save.room || save.room.desiredState !== "open") fail(409,"room_not_open");
      const release = instance.releases?.find(r => r.id === save.releaseId);
      if(!release?.server || !release.serverArtifact || !["vanilla","fabric","forge","neoforge","paper"].includes(release.server.type) || !release.server.eulaAccepted) fail(409,"supported_server_required");
      const hosting = this.hostState(state), now = Date.now();
      hosting.grants = hosting.grants.filter(g => g.expiresAt > now || hosting.leases.some(l => l.grantId === g.id && l.leaseExpiresAt + HOST_FENCE_GRACE_MS > now));
      if(hosting.grants.length >= 500) fail(429,"executor_limit");
      const token = crypto.randomBytes(32).toString("hex");
      const grant:ExecutorGrant = {id:uuid(),tokenHash:crypto.createHash("sha256").update(token).digest("hex"),actor:{...actor},instanceId,saveId,nodeName:text(nodeName,80,true),expiresAt:now+300000};
      hosting.grants.push(grant);
      log(instance,actor,"hosting.ticket",saveId);
      return {grantId:grant.id,token,expiresAt:grant.expiresAt,instanceId,saveId};
    });
  }
  async executor(id:string, token:string) {
    await this.queue; const state=await this.load();
    const grant=state.hosting?.grants.find(g => g.id === id);
    const supplied=crypto.createHash("sha256").update(token).digest("hex");
    if(!grant || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(grant.tokenHash))) return fail(401,"executor_authentication_required");
    const lease=state.hosting?.leases.find(l=>l.grantId===grant.id);
    if(grant.expiresAt < Date.now() && (!lease || lease.leaseExpiresAt+HOST_FENCE_GRACE_MS < Date.now() || ["stopped","failed"].includes(lease.phase))) return fail(401,"executor_expired");
    return structuredClone(grant);
  }
  private currentLease(state:CatalogState, grant:ExecutorGrant, epoch:unknown) {
    const lease=this.hostState(state).leases.find(l=>l.instanceId===grant.instanceId && l.saveId===grant.saveId);
    if(!lease || lease.grantId!==grant.id || lease.epoch!==epoch || lease.leaseExpiresAt+HOST_FENCE_GRACE_MS<Date.now() || ["stopped","failed"].includes(lease.phase)) return fail(409,"stale_host_epoch");
    return lease;
  }
  private handoverRestorable(lease:HostLease,now=Date.now()) {
    const handover=lease.handover;
    if(!handover||handover.phase!=="restoring"||lease.checkpoint?.final!==true||lease.checkpoint.epoch!==(handover.checkpointEpoch??handover.sourceEpoch))return false;
    return lease.phase==="stopped" || lease.phase==="starting"&&lease.leaseExpiresAt+HOST_FENCE_GRACE_MS<now;
  }
  async claimExecutor(grant:ExecutorGrant, actor:CatalogActor) {
    return this.mutate(state=>{
      const instance=findInstance(state,grant.instanceId),save=findSave(instance,grant.saveId);
      if(!this.allowedHost(instance,actor,save.id)) fail(403,"hosting_forbidden");
      if(save.room?.desiredState!=="open") fail(409,"room_not_open");
      if((save.placement??DEFAULT_PLACEMENT).mode!=="manual"&&!grant.nodeId)fail(409,"automatic_placement_enabled");
      const pending=this.hostState(state).leases.find(l=>l.instanceId===instance.id&&l.saveId===save.id);
      const handoverTarget=pending?.handover?.phase==="restoring"?pending.handover.targetNodeId:undefined;
      if(grant.nodeId){const n=this.computeNodes(state).find(n=>n.id===grant.nodeId);if(!n||!n.enabled||n.lastSeenAt+NODE_ONLINE_MS<Date.now()||n.ownerId!==actor.id||!this.nodeAllowed(n,instance.id)||(handoverTarget?handoverTarget!==n.id:save.placement?.mode==="fixed"&&save.placement.nodeId!==n.id))fail(403,"node_not_authorized");const load=this.nodeLoad(state,n!.id,grant.id);if(load.tasks>=n!.maxTasks||load.memory+512+(instance.releases?.find(r=>r.id===save.releaseId)?.server?.memoryMb??0)>n!.memoryBudgetMb)fail(409,"node_capacity_exceeded");}
      const release=instance.releases?.find(r=>r.id===save.releaseId);
      if(!release?.server || !["vanilla","fabric","forge","neoforge","paper"].includes(release.server.type)) return fail(409,"supported_server_required");
      const hosting=this.hostState(state),previous=hosting.leases.find(l=>l.instanceId===instance.id && l.saveId===save.id),now=Date.now();
      if(previous && !["stopped","failed"].includes(previous.phase) && previous.leaseExpiresAt+HOST_FENCE_GRACE_MS>now) fail(409,"host_busy");
      if(previous?.handover && previous.handover.phase!=="completed") {
        if(!this.handoverRestorable(previous,now))fail(409,"handover_final_checkpoint_required");
        if(grant.nodeId!==previous.handover.targetNodeId)fail(403,"handover_target_required");
      }
      if(grant.expiresAt<now) fail(401,"executor_expired");
      const lease:HostLease={instanceId:instance.id,saveId:save.id,grantId:grant.id,phase:"starting",epoch:(previous?.epoch??0)+1,nodeName:grant.nodeName,holderName:actor.name,leaseExpiresAt:now+HOST_LEASE_MS,joinAddress:null,checkpoint:previous?.checkpoint??null,error:"",...(previous?.handover?.phase==="restoring"?{handover:previous.handover}:{})};
      const storedGrant=hosting.grants.find(g=>g.id===grant.id);if(storedGrant)storedGrant.expiresAt=0;
      hosting.leases=hosting.leases.filter(l=>!(l.instanceId===instance.id && l.saveId===save.id)); hosting.leases.push(lease);
      log(instance,actor,"hosting.claim",save.id);
      return {lease,release,save:{...save,hosting:undefined},checkpoint:lease.checkpoint};
    });
  }
  async executorPlan(grant:ExecutorGrant,epoch:number) {
    await this.queue;const state=await this.load();const lease=this.currentLease(state,grant,epoch),instance=findInstance(state,grant.instanceId),save=findSave(instance,grant.saveId),release=instance.releases?.find(r=>r.id===save.releaseId);
    if(!release) return fail(404,"release_not_found");
    return structuredClone({lease,release,save,checkpoint:lease.checkpoint});
  }
  async requestHandover(actor:CatalogActor,id:string,saveId:string,targetNodeId:string,lookup:(id:string)=>(CatalogActor & {willingness?:HostingWillingness})|null) {
    return this.mutate(state=>{
      const instance=findInstance(state,id),save=findSave(instance,saveId);
      requirePermission(instance,actor,"room.manage",saveId);
      const lease=this.hostState(state).leases.find(l=>l.instanceId===id&&l.saveId===saveId);
      if(!lease||lease.phase!=="ready"||lease.leaseExpiresAt<=Date.now()||save.room?.desiredState!=="open")fail(409,"handover_host_not_ready");
      if(lease!.handover&&lease!.handover.phase!=="completed")fail(409,"handover_in_progress");
      const current=this.hostState(state).grants.find(g=>g.id===lease!.grantId);
      if(current?.nodeId===targetNodeId)fail(400,"handover_same_node");
      const target=this.computeNodes(state).find(n=>n.id===targetNodeId),owner=target?lookup(target.ownerId):null;
      if(!target||!target.enabled||target.lastSeenAt+NODE_ONLINE_MS<Date.now()||!owner||!this.nodeAllowed(target,id)||!this.allowedHost(instance,owner,saveId))fail(403,"handover_target_unavailable");
      if(target!.kind==="player"&&owner!.willingness==="none")fail(403,"handover_target_unavailable");
      const release=instance.releases?.find(r=>r.id===save.releaseId),load=this.nodeLoad(state,target!.id);
      if(!target!.metrics||target!.metrics.cpuCores<1)fail(403,"handover_target_unavailable");
      if(target!.metrics!.availableMemoryMb<(release?.server?.memoryMb??0)+512+target!.reserveMemoryMb)fail(409,"node_capacity_exceeded");
      if(load.tasks>=target!.maxTasks||load.memory+512+(release?.server?.memoryMb??0)>target!.memoryBudgetMb)fail(409,"node_capacity_exceeded");
      lease!.handover={id:uuid(),targetNodeId,requestedAt:Date.now(),requestedBy:actor.id,phase:"saving",sourceEpoch:lease!.epoch};
      log(instance,actor,"hosting.handover.request",saveId);
      return lease!.handover;
    });
  }
  async executorHeartbeat(grant:ExecutorGrant,actor:CatalogActor,epoch:number,input:any) {
    return this.mutate(state=>{
      const lease=this.currentLease(state,grant,epoch),instance=findInstance(state,grant.instanceId),save=findSave(instance,grant.saveId);
      const node=grant.nodeId?this.computeNodes(state).find(n=>n.id===grant.nodeId):undefined;
      const stop=lease.handover?.phase==="saving" || save.room?.desiredState!=="open" || !this.allowedHost(instance,actor,save.id) || !!grant.nodeId&&(!node||!node.enabled||!this.nodeAllowed(node,instance.id));
      if(stop){const now=Date.now();lease.stopDeadlineAt??=now+HOST_FINAL_SAVE_MS;lease.leaseExpiresAt=Math.min(now+HOST_LEASE_MS,lease.stopDeadlineAt);lease.phase="stopping";lease.joinAddress=null;return {stop:true,leaseExpiresAt:lease.leaseExpiresAt,phase:lease.phase,handover:lease.handover};}
      lease.leaseExpiresAt=Date.now()+HOST_LEASE_MS;
      if(["starting","checkpointing","stopping"].includes(input.phase) || (input.phase === "ready" && lease.joinAddress && lease.phase !== "stopping")) lease.phase=input.phase;
      return {stop:false,leaseExpiresAt:lease.leaseExpiresAt,phase:lease.phase,joinAddress:lease.joinAddress};
    });
  }
  async executorReady(grant:ExecutorGrant,actor:CatalogActor,epoch:number,address:string) {
    return this.mutate(state=>{const lease=this.currentLease(state,grant,epoch),instance=findInstance(state,grant.instanceId),save=findSave(instance,grant.saveId);if(save.room?.desiredState!=="open" || !this.allowedHost(instance,actor,save.id))fail(403,"hosting_forbidden");lease.phase="ready";if(lease.handover?.phase==="restoring")lease.handover.phase="completed";lease.joinAddress=address;lease.leaseExpiresAt=Date.now()+HOST_LEASE_MS;log(instance,actor,"hosting.ready",save.id);return {joinAddress:address,leaseExpiresAt:lease.leaseExpiresAt};});
  }
  async commitWorld(grant:ExecutorGrant,epoch:number,checkpoint:WorldCheckpoint) {
    return this.mutate(state=>{const lease=this.currentLease(state,grant,epoch);lease.checkpoint=checkpoint;const instance=findInstance(state,grant.instanceId);log(instance,grant.actor,"hosting.checkpoint",grant.saveId);return checkpoint;});
  }
  async finishExecutor(grant:ExecutorGrant,epoch:number,input:any) {
    return this.mutate(state=>{const lease=this.currentLease(state,grant,epoch);if(input.clean!==true || !lease.checkpoint || lease.checkpoint.epoch!==epoch || lease.checkpoint.final!==true)fail(409,"final_checkpoint_required");lease.phase="stopped";if(lease.handover&&lease.handover.phase!=="completed"){lease.handover.phase="restoring";lease.handover.checkpointEpoch=epoch;}lease.joinAddress=null;lease.error="";lease.leaseExpiresAt=Date.now();const instance=findInstance(state,grant.instanceId);log(instance,grant.actor,"hosting.finish",grant.saveId);return {stopped:true,checkpoint:lease.checkpoint};});
  }
  async pendingHandover(instanceId:string,saveId:string) {
    await this.queue;const state=await this.load(),instance=state.instances.find(i=>i.id===instanceId),save=instance?.saves.find(s=>s.id===saveId);
    const lease=this.hostState(state).leases.find(l=>l.instanceId===instanceId&&l.saveId===saveId);
    return save?.room?.desiredState==="open" && !!lease?.handover && lease.handover.phase!=="completed";
  }
  async relayAllowed(grant:ExecutorGrant,epoch:number,actor?:CatalogActor,allowHandoverDrain=false) {
    const plan=await this.executorPlan(grant,epoch);
    if(grant.nodeId){const node=this.computeNodes(await this.load()).find(n=>n.id===grant.nodeId);if(!node||!node.enabled||!this.nodeAllowed(node,grant.instanceId))return false;}
    if(actor){const instance=(await this.load()).instances.find(i=>i.id===grant.instanceId);if(!instance || !this.allowedHost(instance,actor,grant.saveId))return false;}
    const phaseAllowed=["starting","ready","checkpointing"].includes(plan.lease.phase) || allowHandoverDrain && plan.lease.phase==="stopping" && plan.lease.handover?.phase==="saving";
    return plan.lease.leaseExpiresAt>Date.now() && phaseAllowed && plan.save.room?.desiredState==="open";
  }

  private computeNodes(state:CatalogState):ComputeNode[] {const hosting=this.hostState(state);return hosting.nodes??(hosting.nodes=[]);}
  private nodeView(state:CatalogState,node:ComputeNode):ComputeNodeView {const {tokenHash,...visible}=node;return {...visible,online:node.enabled&&node.lastSeenAt+NODE_ONLINE_MS>Date.now(),activeTasks:this.nodeLoad(state,node.id).tasks};}
  private nodeLoad(state:CatalogState,nodeId:string,excludeGrant?:string){const now=Date.now(),hosting=this.hostState(state);const live=hosting.leases.filter(l=>!["stopped","failed"].includes(l.phase)&&l.leaseExpiresAt+HOST_FENCE_GRACE_MS>now);const grants=hosting.grants.filter(g=>g.nodeId===nodeId&&g.id!==excludeGrant&&(g.expiresAt>now||live.some(l=>l.grantId===g.id)));let memory=0;for(const g of grants){const i=state.instances.find(i=>i.id===g.instanceId),s=i?.saves.find(s=>s.id===g.saveId),r=i?.releases?.find(r=>r.id===s?.releaseId);memory+=(r?.server?.memoryMb??0)+512;}return {tasks:grants.length,memory};}
  private nodeAllowed(node:ComputeNode,instanceId:string){return node.allowAllInstances||node.allowedInstanceIds.includes(instanceId);}
  async computeNode(id:string,token:string){await this.queue;const state=await this.load(),node=this.computeNodes(state).find(n=>n.id===id);if(!node||typeof token!=="string"||!/^[a-f0-9]{64}$/.test(token)||!crypto.timingSafeEqual(Buffer.from(crypto.createHash("sha256").update(token).digest("hex")),Buffer.from(node.tokenHash)))fail(401,"node_authentication_required");return structuredClone(node!);}
  async listComputeNodes(actor:CatalogActor,instanceId?:string){await this.queue;const state=await this.load();let instance:LogicalInstance|undefined;if(instanceId){instance=findInstance(state,instanceId);if(!permissionsFor(instance,actor).includes("instance.read")&&!instance.saves.some(s=>permissionsFor(instance!,actor,s.id).includes("save.read")))fail(403,"forbidden");}return this.computeNodes(state).filter(n=>actor.admin||n.ownerId===actor.id||!!instance&&this.nodeAllowed(n,instance.id)&&(n.kind==="server"||permissionsFor(instance,actor).includes("room.manage")||instance.saves.some(s=>permissionsFor(instance!,actor,s.id).includes("room.manage")))).map(n=>this.nodeView(state,n));}
  async createComputeNode(actor:CatalogActor,input:unknown){return this.mutate(state=>{const p=object(input),kind=choice(p.kind,["server","player"]);if(kind==="server"&&!actor.admin)fail(403,"forbidden");if(!actor.admin&&p.priority!==undefined&&p.priority!==0)fail(403,"forbidden");if(this.computeNodes(state).filter(n=>n.ownerId===actor.id).length>=50)fail(429,"node_limit");const token=crypto.randomBytes(32).toString("hex");const node:ComputeNode={id:uuid(),name:text(p.name,80,true),kind,ownerId:actor.id,ownerName:actor.name,enabled:true,priority:actor.admin?number(p.priority??0,-100,100):0,memoryBudgetMb:number(p.memoryBudgetMb??4096,512,1048576),reserveMemoryMb:number(p.reserveMemoryMb??512,0,1048576),maxTasks:number(p.maxTasks??1,1,16),allowAllInstances:bool(p.allowAllInstances??true),allowedInstanceIds:array(p.allowedInstanceIds??[],500).map(id=>text(id,64,true)),lastSeenAt:0,metrics:null,lastError:"",tokenHash:crypto.createHash("sha256").update(token).digest("hex")};this.computeNodes(state).push(node);return {node:this.nodeView(state,node),credential:{nodeId:node.id,token}};});}
  async updateComputeNode(actor:CatalogActor,id:string,input:unknown){return this.mutate(state=>{const node=this.computeNodes(state).find(n=>n.id===id);if(!node)fail(404,"node_not_found");if(!actor.admin&&(node!.ownerId!==actor.id||node!.kind==="server"))fail(403,"forbidden");const p=object(input);for(const key of Object.keys(p))if(!["name","enabled","priority","memoryBudgetMb","reserveMemoryMb","maxTasks","allowAllInstances","allowedInstanceIds"].includes(key))fail(400,"invalid_node_config");if(p.name!==undefined)node!.name=text(p.name,80,true);if(p.enabled!==undefined)node!.enabled=bool(p.enabled);if(p.priority!==undefined){if(!actor.admin)fail(403,"forbidden");node!.priority=number(p.priority,-100,100);}if(p.memoryBudgetMb!==undefined)node!.memoryBudgetMb=number(p.memoryBudgetMb,512,1048576);if(p.reserveMemoryMb!==undefined)node!.reserveMemoryMb=number(p.reserveMemoryMb,0,1048576);if(p.maxTasks!==undefined)node!.maxTasks=number(p.maxTasks,1,16);if(p.allowAllInstances!==undefined)node!.allowAllInstances=bool(p.allowAllInstances);if(p.allowedInstanceIds!==undefined)node!.allowedInstanceIds=array(p.allowedInstanceIds,500).map(id=>text(id,64,true));return this.nodeView(state,node!);});}
  async runtimeSettings(actor:CatalogActor,id:string,saveId:string,input:unknown){
    return this.mutate(state=>{
      const instance=findInstance(state,id),save=findSave(instance,saveId);
      requirePermission(instance,actor,"room.manage",saveId);
      if(save.room?.desiredState==="open")fail(409,"close_rooms_first");
      this.requireHostStopped(state,id,saveId);
      const p=object(input);
      if(p.placement!==undefined){
        const q=object(p.placement),mode=choice(q.mode,["manual","fixed","auto","fallback"]),nodeId=q.nodeId?text(q.nodeId,64,true):null;
        if(mode==="fixed"&&!nodeId)fail(400,"fixed_node_required");
        if(nodeId){const node=this.computeNodes(state).find(n=>n.id===nodeId);if(!node||!this.nodeAllowed(node,id))fail(403,"node_not_authorized");if(mode==="fallback"&&node!.kind!=="server")fail(400,"server_fallback_required");}
        save.placement={mode,nodeId};
      }
      if(p.ingress!==undefined||p.gateway!==undefined){
        if(!actor.admin)fail(403,"forbidden");
        const ingress=p.ingress===undefined?save.ingress:p.ingress===null?undefined:validateIngress(p.ingress);
        const gateway=p.gateway===undefined?save.gateway:p.gateway===null?{enabled:false,backendPort:save.gateway?.backendPort??25566}:(()=>{const config=object(p.gateway);return{enabled:bool(config.enabled),backendPort:number(config.backendPort,1,65535)};})();
        if(gateway?.enabled){
          if(!ingress)fail(400,"gateway_ingress_required");
          if(gateway.backendPort===ingress!.bindPort)fail(400,"gateway_port_conflict");
          const release=instance.releases?.find(r=>r.id===save.releaseId)??instance.releases?.slice(-1)[0];
          const profile=release?.profile??instance.profile;
          if(!["1.20.1-vanilla","1.21.1-vanilla","1.20.1-fabric","1.20.1-forge","1.21.1-fabric","1.21.1-neoforge"].includes(profile.mcVersion+"-"+profile.loader))fail(409,"gateway_loader_unsupported");
        }
        const ports=[...(ingress?[ingress.bindPort]:[]),...(gateway?.enabled?[gateway.backendPort]:[])];
        if(state.instances.some(i=>i.saves.some(s=>!(i.id===id&&s.id===saveId)&&[s.ingress?.bindPort,...(s.gateway?.enabled?[s.gateway.backendPort]:[])].some(port=>port!==undefined&&ports.includes(port)))))fail(409,"network_port_reserved");
        save.ingress=ingress;save.gateway=gateway;
      }
      save.updatedAt=Date.now();log(instance,actor,"room.runtime",saveId);return save;
    });
  }
  async dispatchComputeNode(id:string,input:unknown,lookup:(id:string)=>{actor:CatalogActor;willingness:HostingWillingness}|null){return this.mutate(state=>{const node=this.computeNodes(state).find(n=>n.id===id);if(!node)fail(404,"node_not_found");const owner=lookup(node!.ownerId);if(!owner)fail(403,"node_owner_unavailable");const p=object(input),m=object(p.metrics);node!.lastSeenAt=Date.now();node!.metrics={cpuCores:number(m.cpuCores,1,65536),totalMemoryMb:number(m.totalMemoryMb,1,16777216),availableMemoryMb:number(m.availableMemoryMb,0,16777216)};node!.lastError=text(p.lastError??"",500);if(!node!.enabled)return {enabled:false,assignment:null};const now=Date.now(),hosting=this.hostState(state);hosting.grants=hosting.grants.filter(g=>g.expiresAt>now||hosting.leases.some(l=>l.grantId===g.id&&!["stopped","failed"].includes(l.phase)&&l.leaseExpiresAt+HOST_FENCE_GRACE_MS>now));for(const instance of state.instances){for(const save of instance.saves){const lease=hosting.leases.find(l=>l.instanceId===instance.id&&l.saveId===save.id);const handover=lease?.handover&&lease.handover.phase!=="completed"?lease.handover:undefined;if(handover&&!this.handoverRestorable(lease!,now))continue;const policy=handover?{mode:"fixed" as const,nodeId:handover.targetNodeId}:save.placement??DEFAULT_PLACEMENT;if(save.room?.desiredState!=="open"||policy.mode==="manual")continue;if(lease&&!["stopped","failed"].includes(lease.phase)&&lease.leaseExpiresAt+HOST_FENCE_GRACE_MS>now)continue;if(hosting.grants.some(g=>g.instanceId===instance.id&&g.saveId===save.id&&g.nodeId&&g.expiresAt>now))continue;const release=instance.releases?.find(r=>r.id===save.releaseId);if(!release?.server || !["vanilla","fabric","forge","neoforge","paper"].includes(release.server.type)||!release.server.eulaAccepted||!release.serverArtifact)continue;const candidates:Candidate[]=this.computeNodes(state).map(n=>{const who=lookup(n.ownerId),load=this.nodeLoad(state,n.id);return {node:n,willingness:who?.willingness??"none",busyMemoryMb:load.memory,activeTasks:load.tasks,authorized:!!who&&this.nodeAllowed(n,instance.id)&&this.allowedHost(instance,who.actor,save.id)};});const chosen=selectComputeNode(policy,candidates,release.server.memoryMb,now);if(chosen?.id!==id)continue;if(hosting.grants.length>=500)fail(429,"executor_limit");const token=crypto.randomBytes(32).toString("hex"),grant:ExecutorGrant={id:uuid(),tokenHash:crypto.createHash("sha256").update(token).digest("hex"),actor:owner!.actor,instanceId:instance.id,saveId:save.id,nodeName:node!.name,nodeId:node!.id,expiresAt:now+30000};hosting.grants.push(grant);log(instance,owner!.actor,"hosting.scheduled",save.id);return {enabled:true,assignment:{grantId:grant.id,token,instanceId:instance.id,saveId:save.id}};}}return {enabled:true,assignment:null};});}

  async creators(actor: CatalogActor, ids: unknown, exists: (id: string) => boolean) {
    if (!actor.admin) fail(403, "forbidden");
    return this.mutate((state) => {
      state.creatorIds = [...new Set(array(ids, 500).map((id) => text(id, 64, true)))];
      if (state.creatorIds.some((id) => !exists(id))) fail(400, "unknown_user");
      return { creatorIds: state.creatorIds };
    });
  }
  async create(actor: CatalogActor, input: unknown, release?: PublishedRelease) {
    return this.mutate((state) => {
      if (!actor.admin && !state.creatorIds.includes(actor.id)) fail(403, "create_forbidden");
      const p = object(input);
      const now = Date.now();
      const instance: LogicalInstance = {
        id: uuid(),
        name: text(p.name, 120, true),
        description: text(p.description, 2000),
        ownerId: actor.id,
        ownerName: actor.name,
        profile: validateProfile(p.profile),
        releases: release ? [structuredClone(release)] : [],
        mods: [],
        grants: [],
        saves: [],
        events: [],
        createdAt: now,
        updatedAt: now,
        revision: 0
      };
      log(instance, actor, "instance.create");
      state.instances.push(instance);
      return instance;
    });
  }
  async checkPublish(actor: CatalogActor, id?: string) {
    await this.queue;
    const state = await this.load();
    if (!id) {
      if (!actor.admin && !state.creatorIds.includes(actor.id)) fail(403, "create_forbidden");
    } else {
      const instance = findInstance(state, id);
      requirePermission(instance, actor, "mods.manage");
      requirePermission(instance, actor, "instance.update");
    }
  }
  async publish(actor: CatalogActor, id: string, release: PublishedRelease, expected?: {revision:number;baseReleaseId:string|null}) {
    return this.mutate(state => {
      const instance = findInstance(state, id);
      requirePermission(instance, actor, "mods.manage");
      requirePermission(instance, actor, "instance.update");
      const existing=instance.releases?.find(r=>r.id===release.id);if(existing){if(existing.manifestDigest!==release.manifestDigest)fail(409,'release_identity_conflict');return existing;}
      if(expected&&(instance.revision!==expected.revision||(instance.releases?.slice(-1)[0]?.id??null)!==expected.baseReleaseId))fail(409,'publication_base_conflict');
      const p = release.profile, base = instance.profile;
      if (instance.saves.length && (p.mcVersion !== base.mcVersion || p.loader !== base.loader)) fail(409, "version_locked");
      if ((instance.releases?.length ?? 0) >= 100) fail(409, "release_limit");
      instance.releases = [...(instance.releases ?? []), structuredClone(release)];
      if (!instance.saves.length) instance.profile = validateProfile(release.profile);
      log(instance, actor, "release.publish");
      return release;
    });
  }
  async bindRelease(actor: CatalogActor, id: string, saveId: string, releaseId: unknown) {
    return this.mutate(state => {
      const instance = findInstance(state, id);
      requirePermission(instance, actor, "instance.read");
      requirePermission(instance, actor, "save.update", saveId);
      const save = findSave(instance, saveId);
      this.requireHostStopped(state,instance.id,saveId);
      if (save.room?.desiredState === "open") fail(409, "close_rooms_first");
      const release = instance.releases?.find(r => r.id === releaseId);
      if (!release) return fail(404, "release_not_found");
      save.releaseId = release.id;
      save.updatedAt = Date.now();
      log(instance, actor, "release.bind", saveId);
      return save;
    });
  }
  async release(actor: CatalogActor, id: string, releaseId: string) {
    const instance = (await this.list(actor)).instances.find(i => i.id === id);
    if (!instance) return fail(403, "forbidden");
    const release = instance.releases?.find(r => r.id === releaseId);
    if (!release) return fail(404, "release_not_found");
    return release;
  }
  async update(actor: CatalogActor, id: string, input: unknown) {
    return this.mutate((state) => {
      const instance = findInstance(state, id);
      requirePermission(instance, actor, "instance.update");
      const p = object(input);
      this.requireHostStopped(state,instance.id);
      const profile = validateProfile(p.profile);
      const identity = (v: RuntimeProfile) =>
        JSON.stringify([
          v.mcVersion,
          v.loader,
          v.loaderVersion,
          v.packName,
          v.packRevision,
          v.artifact,
          v.artifactSha256
        ]);
      if (instance.saves.length && identity(profile) !== identity(instance.profile))
        fail(409, "version_locked");
      if (instance.saves.some((s) => s.room?.desiredState === "open"))
        fail(409, "close_rooms_first");
      instance.name = text(p.name, 120, true);
      instance.description = text(p.description, 2000);
      instance.profile = profile;
      log(instance, actor, "instance.update");
      return instance;
    });
  }
  async clone(actor: CatalogActor, id: string) {
    return this.mutate((state) => {
      const source = findInstance(state, id);
      requirePermission(source, actor, "instance.read");
      if (!actor.admin && !state.creatorIds.includes(actor.id)) fail(403, "create_forbidden");
      const instance = structuredClone(source);
      instance.id = uuid();
      instance.name += " (copy)";
      instance.ownerId = actor.id;
      instance.ownerName = actor.name;
      instance.saves = [];
      instance.grants = [];
      instance.events = [];
      instance.createdAt = Date.now();
      instance.revision = 0;
      log(instance, actor, "instance.clone");
      state.instances.push(instance);
      return instance;
    });
  }
  async delete(actor: CatalogActor, id: string) {
    return this.mutate((state) => {
      const instance = findInstance(state, id);
      requireOwner(instance, actor);
      if (instance.saves.length) fail(409, "instance_has_saves");
      state.instances = state.instances.filter((i) => i.id !== id);
      return { deleted: true };
    });
  }
  async save(actor: CatalogActor, id: string, saveId: string | null, input: unknown) {
    return this.mutate((state) => {
      const instance = findInstance(state, id);
      requirePermission(
        instance,
        actor,
        saveId ? "save.update" : "save.create",
        saveId ?? undefined
      );
      const p = object(input);
      const rules = validateRules(p.rules ?? DEFAULT_RULES);
      const name = text(p.name, 120, true);
      const description = text(p.description, 2000);
      const now = Date.now();
      let save: CatalogSave;
      if (saveId) {
        save = findSave(instance, saveId);
        this.requireHostStopped(state,instance.id,saveId);
        if (save.room?.desiredState === "open") fail(409, "close_rooms_first");
        if (save.rules.seed !== rules.seed) fail(409, "seed_locked");
        save.name = name;
        save.description = description;
        save.rules = rules;
        save.updatedAt = now;
      } else {
        if (instance.saves.length >= 500) fail(409, "save_limit");
        save = {
          id: uuid(),
          releaseId: instance.releases?.slice(-1)[0]?.id ?? null,
          name,
          description,
          rules,
          players: [],
          room: null,
          createdAt: now,
          updatedAt: now
        };
        instance.saves.push(save);
      }
      log(instance, actor, saveId ? "save.update" : "save.create", save.id);
      return save;
    });
  }
  async deleteSave(actor: CatalogActor, id: string, saveId: string) {
    return this.mutate((state) => {
      const instance = findInstance(state, id);
      requirePermission(instance, actor, "save.delete", saveId);
      const save = findSave(instance, saveId);
      if (save.room?.desiredState === "open") fail(409, "close_rooms_first");
      this.requireHostStopped(state,id,saveId);
      instance.saves = instance.saves.filter((s) => s.id !== saveId);
      instance.grants = instance.grants.filter((g) => g.scope !== saveId);
      log(instance, actor, "save.delete", saveId);
      return { deleted: true };
    });
  }
  async room(actor: CatalogActor, id: string, saveId: string, input: unknown, create: boolean) {
    return this.mutate((state) => {
      const instance = findInstance(state, id);
      requirePermission(instance, actor, "room.manage", saveId);
      const save = findSave(instance, saveId);
      const p = object(input);
      if (create) {
        if (save.room) fail(409, "room_exists");
        save.room = {
          id: uuid(),
          name: text(p.name, 120, true),
          desiredState: "closed",
          createdAt: Date.now()
        };
      } else {
        if (!save.room) return fail(404, "room_not_found");
        save.room.name = text(p.name, 120, true);
        if(p.desiredState === "open" && save.room.desiredState === "closed")this.requireHostStopped(state,instance.id,saveId);
        save.room.desiredState = choice(p.desiredState, ["open", "closed"]);
        if(save.room.desiredState === "closed"){const lease=state.hosting?.leases.find(l=>l.instanceId===instance.id && l.saveId===save.id && !["stopped","failed"].includes(l.phase));if(lease){lease.phase="stopping";lease.joinAddress=null;}}
      }
      save.updatedAt = Date.now();
      log(
        instance,
        actor,
        create ? "room.create" : save.room!.desiredState === "open" ? "room.open" : "room.close",
        saveId
      );
      return save.room;
    });
  }
  async grants(actor: CatalogActor, id: string, input: unknown, exists: (id: string) => boolean) {
    return this.mutate((state) => {
      const instance = findInstance(state, id);
      requireOwner(instance, actor);
      const keys = new Set<string>();
      const grants: AccessGrant[] = array(input, 1000).map((raw) => {
        const p = object(raw);
        const userId = text(p.userId, 64, true);
        const scope = text(p.scope, 64, true);
        if (!exists(userId)) fail(400, "unknown_user");
        if (userId === instance.ownerId) fail(400, "owner_grant");
        if (scope !== "instance" && !instance.saves.some((s) => s.id === scope))
          fail(400, "unknown_scope");
        const key = userId + ":" + scope;
        if (keys.has(key)) fail(400, "duplicate_grant");
        keys.add(key);
        const permissions = [
          ...new Set(array(p.permissions, 20).map((v) => choice(v, CATALOG_PERMISSIONS)))
        ];
        if (
          scope !== "instance" &&
          permissions.some((v) =>
            ["instance.update", "save.create", "members.manage", "mods.manage"].includes(v)
          )
        )
          fail(400, "invalid_scope");
        if (permissions.some((v) => ["members.manage", "players.manage"].includes(v)))
          fail(400, "owner_only_permission");
        if (permissions.length && !permissions.includes("save.read"))
          fail(400, "read_permission_required");
        return { userId, scope, permissions, hosting: bool(p.hosting) };
      });
      instance.grants = grants;
      log(instance, actor, "members.update");
      return grants;
    });
  }
  async mods(actor: CatalogActor, id: string, input: unknown) {
    return this.mutate((state) => {
      const instance = findInstance(state, id);
      requirePermission(instance, actor, "mods.manage");
      if (instance.saves.some((s) => s.room?.desiredState === "open"))
        fail(409, "close_rooms_first");
      const names = new Set<string>();
      const mods: ModEntry[] = array(input, 1000).map((raw) => {
        const p = object(raw);
        const file = text(p.file, 240, true);
        if (/[\/\\]/.test(file) || !file.endsWith(".jar") || names.has(file))
          fail(400, "invalid_mod_file");
        names.add(file);
        return {
          name: text(p.name, 120, true),
          version: text(p.version, 80),
          file,
          sha256: hash(p.sha256),
          side: choice(p.side, ["server", "both"])
        };
      });
      instance.mods = mods;
      log(instance, actor, "mods.update");
      return mods;
    });
  }
  async players(actor: CatalogActor, id: string, saveId: string, input: unknown) {
    return this.mutate((state) => {
      const instance = findInstance(state, id);
      requireOwner(instance, actor);
      const save = findSave(instance, saveId);
      if (save.room?.desiredState === "open") fail(409, "close_rooms_first");
      const ids = new Set<string>();
      const players: PlayerRule[] = array(input, 1000).map((raw) => {
        const p = object(raw);
        const id = text(p.uuid, 36, true).toLowerCase();
        if (
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) ||
          ids.has(id)
        )
          fail(400, "invalid_player_uuid");
        ids.add(id);
        const access = choice(p.access, ["allowed", "banned"]);
        const opLevel = number(p.opLevel, 0, 4);
        if (access === "banned" && opLevel > 0) fail(400, "banned_operator");
        return { uuid: id, name: text(p.name, 16, true), access, opLevel };
      });
      save.players = players;
      save.updatedAt = Date.now();
      log(instance, actor, "players.update", saveId);
      return players;
    });
  }
}
