import {gatewaySystem} from "../service/nomad_gateways";
import crypto from "crypto";
import path from "path";
import { nomadBots } from "../service/nomad_bots_system";
import { nomadBotTransport } from "../service/nomad_bot_transport";
import { nomadModels } from "../service/nomad_models_system";
import { inspectNetwork, inspectServerNetwork } from "../service/nomad_network";
import { frpConfiguration } from "../service/nomad_ingress";
import { uploadPolicy } from "../service/nomad_policy";
import Router from "@koa/router";
import fs from "fs";
import { nomadCatalog as catalog } from "../service/catalog_system";
import { CatalogError } from "../service/nomad_catalog";
import { NomadWorlds } from "../service/nomad_worlds";
import { serverBundle } from "../service/nomad_server";
import { prepareHostRelay, closeHostRelay, hostRelayStatus } from "../service/nomad_host_relay";
import permission from "../middleware/permission";
import userSystem from "../service/user_service";
import { getUserUuid } from "../service/passport_service";
import { ROLE } from "../entity/user";
import type { ExecutorGrant } from "../../../../shared/nomad-hosting";
const router = new Router({ prefix: "/nomad/hosting" }),
  worlds = new NomadWorlds(),
  activeChecks = new Set<string>();
router.use(async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    ctx.body = error.code;
    ctx.status = error.status;
  }
});
router.post("/tickets", permission({ level: ROLE.USER }), async (ctx) => {
  const user = userSystem.getInstance(getUserUuid(ctx));
  if (!user) throw new CatalogError(401, "authentication_required");
  const body = ctx.request.body;
  ctx.body = await catalog.issueExecutor(
    { id: user.uuid, name: user.userName, admin: user.permission === ROLE.ADMIN },
    body.instanceId,
    body.saveId,
    body.nodeName,
  );
});

const actor = (ctx: any) => {
  const user = userSystem.getInstance(getUserUuid(ctx));
  if (!user || user.permission < ROLE.USER) throw new CatalogError(401, "authentication_required");
  return { id: user.uuid, name: user.userName, admin: user.permission === ROLE.ADMIN };
};
router.get("/nodes", permission({ level: ROLE.USER, speedLimit: false }), async (ctx) => {
  ctx.body = await catalog.listComputeNodes(
    actor(ctx),
    typeof ctx.query.instanceId === "string" ? ctx.query.instanceId : undefined,
  );
});
router.post("/nodes", permission({ level: ROLE.USER }), async (ctx) => {
  ctx.body = await catalog.createComputeNode(actor(ctx), ctx.request.body);
  ctx.set("Cache-Control", "no-store");
});
router.put("/nodes/:id", permission({ level: ROLE.USER }), async (ctx) => {
  ctx.body = await catalog.updateComputeNode(actor(ctx), ctx.params.id, ctx.request.body);
});
router.put("/runtime/:instanceId/:saveId", permission({ level: ROLE.USER }), async (ctx) => {
  ctx.body = await catalog.runtimeSettings(
    actor(ctx),
    ctx.params.instanceId,
    ctx.params.saveId,
    ctx.request.body,
  );
});
router.post("/runtime/:instanceId/:saveId/handover", permission({level:ROLE.USER}), async ctx=>{
  // The public handover operation promises to keep the player connection alive.
  // Direct byte forwarding cannot satisfy that promise.
  if(!gatewaySystem().enabled(ctx.params.instanceId,ctx.params.saveId))throw new CatalogError(409,"handover_gateway_required");
  if(gatewaySystem().status(ctx.params.instanceId,ctx.params.saveId).state!=="ready")throw new CatalogError(409,"handover_gateway_not_ready");
  ctx.body=await catalog.requestHandover(actor(ctx),ctx.params.instanceId,ctx.params.saveId,String(ctx.request.body?.targetNodeId??""),id=>{
    const user=userSystem.getInstance(id);
    return user&&user.permission>=ROLE.USER?{id:user.uuid,name:user.userName,admin:user.permission===ROLE.ADMIN,willingness:user.hostingWillingness}:null;
  });
});
router.post("/nodes/:id/poll", async (ctx) => {
  const node = await catalog.computeNode(
    ctx.params.id,
    ctx.get("Authorization").replace(/^Bearer /, ""),
  );
  const owner = userSystem.getInstance(node.ownerId);
  if (!owner || owner.permission < ROLE.USER) throw new CatalogError(403, "node_owner_unavailable");
  ctx.body = await catalog.dispatchComputeNode(node.id, ctx.request.body, (id) => {
    const u = userSystem.getInstance(id);
    return u && u.permission >= ROLE.USER
      ? {
          actor: { id: u.uuid, name: u.userName, admin: u.permission === ROLE.ADMIN },
          willingness: u.hostingWillingness,
        }
      : null;
  });
});
router.post("/network/check", permission({ level: ROLE.ADMIN }), async (ctx) => {
  if (activeChecks.has("center") || activeChecks.size >= 2)
    throw new CatalogError(429, "network_check_busy");
  activeChecks.add("center");
  try {
    ctx.body = await inspectServerNetwork();
  } finally {
    activeChecks.delete("center");
  }
});
router.post(
  "/network/:instanceId/:saveId/check",
  permission({ level: ROLE.ADMIN }),
  async (ctx) => {
    const identity = actor(ctx),
      view = await catalog.list(identity),
      instance = view.instances.find((i) => i.id === ctx.params.instanceId),
      save = instance?.saves.find((s) => s.id === ctx.params.saveId);
    if (!save) throw new CatalogError(404, "save_not_found");
    const key = ctx.params.instanceId + "/" + ctx.params.saveId;
    if (activeChecks.has(key) || activeChecks.size >= 2)
      throw new CatalogError(429, "network_check_busy");
    activeChecks.add(key);
    try {
      ctx.body = await inspectNetwork(
        save.ingress,
        hostRelayStatus(ctx.params.instanceId, ctx.params.saveId),
      );
    } finally {
      activeChecks.delete(key);
    }
  },
);
router.get("/network/:instanceId/:saveId/frp", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const view = await catalog.list(actor(ctx)),
    save = view.instances
      .find((i) => i.id === ctx.params.instanceId)
      ?.saves.find((s) => s.id === ctx.params.saveId);
  if (!save?.ingress) throw new CatalogError(404, "network_profile_missing");
  ctx.body = { configuration: frpConfiguration(save.ingress, "nomad-" + save.id) };
});

router.use("/agent/:id", async (ctx, next) => {
  const token = String(ctx.get("Authorization")).replace(/^Bearer /, ""),
    grant = await catalog.executor(ctx.params.id, token);
  const user = userSystem.getInstance(grant.actor.id);
  if (!user || user.permission < ROLE.USER) throw new CatalogError(403, "hosting_forbidden");
  ctx.state.executorGrant = grant;
  ctx.state.executorActor = {
    id: user.uuid,
    name: user.userName,
    admin: user.permission === ROLE.ADMIN,
  };
  await next();
});
const grant = (ctx: any) => ctx.state.executorGrant as ExecutorGrant;
const epoch = (ctx: any) => {
  const value = Number(ctx.query.epoch ?? ctx.request.body?.epoch);
  if (!Number.isSafeInteger(value) || value < 1) throw new CatalogError(400, "invalid_host_epoch");
  return value;
};
router.post("/agent/:id/claim", async (ctx) => {
  ctx.body = {
    ...(await catalog.claimExecutor(grant(ctx), ctx.state.executorActor)),
    worldLimits: uploadPolicy(),
  };
});
async function modelLease(ctx: any) {
  const g = grant(ctx);
  const lease = await catalog.executorHeartbeat(g, ctx.state.executorActor, epoch(ctx), {});
  if (lease.stop) throw new CatalogError(409, "hosting_stopping");
  return g;
}
router.get("/agent/:id/bots/adapter", async (ctx) => {
  const g = await modelLease(ctx);
  const policy = await nomadBots.hostPolicy(g.instanceId, g.saveId);
  if (!policy.enabled) {
    ctx.status = 204;
    return;
  }
  const plan = await catalog.executorPlan(g, epoch(ctx));
  const target = `${plan.release.profile.mcVersion}-${plan.release.server?.type}`;
  if (ctx.query.target && ctx.query.target !== target) throw new CatalogError(409, "bot_adapter_target_mismatch");
  if (!["1.20.1-fabric", "1.20.1-forge", "1.21.1-fabric", "1.21.1-neoforge"].includes(target))
    throw new CatalogError(409, "bot_adapter_target_unsupported");
  const file = path.join(__dirname, `nomad-numen-adapter-${plan.release.server!.type}-${plan.release.profile.mcVersion}.jar`);
  if (!fs.existsSync(file)) throw new CatalogError(503, "bot_adapter_package_missing");
  const bytes = fs.readFileSync(file);
  ctx.set("X-Nomad-Sha256", crypto.createHash("sha256").update(bytes).digest("hex"));
  ctx.type = "application/java-archive";
  ctx.body = bytes;
});
router.post("/agent/:id/bots/poll", async (ctx) => {
  const g = await modelLease(ctx);
  const report = ctx.request.body ?? {};
  if (JSON.stringify(report).length > 1024 * 1024)
    throw new CatalogError(413, "bot_report_too_large");
  ctx.body = {
    policy: await nomadBots.hostPolicy(
      g.instanceId,
      g.saveId,
      Array.isArray(report.links) ? report.links : [],
    ),
    jobs: nomadBotTransport.poll(g.instanceId, g.saveId, epoch(ctx), report),
  };
  void nomadBots.reconcilePublic(g.instanceId, g.saveId).catch(() => {});
});
router.post("/agent/:id/bots/:jobId/receipt", async (ctx) => {
  const g = await modelLease(ctx);
  ctx.body = nomadBotTransport.complete(
    g.instanceId,
    g.saveId,
    epoch(ctx),
    ctx.params.jobId,
    ctx.request.body,
  );
});
router.post("/agent/:id/models", async (ctx) => {
  const g = await modelLease(ctx);
  ctx.body = await nomadModels.approved(g.instanceId, g.saveId);
});
router.get("/agent/:id/models/:applicationId/:hash", async (ctx) => {
  const g = await modelLease(ctx);
  const file = await nomadModels.approvedBlob(
    g.instanceId,
    g.saveId,
    ctx.params.applicationId,
    ctx.params.hash,
  );
  ctx.set("X-Nomad-Sha256", ctx.params.hash);
  ctx.body = fs.createReadStream(file);
});
router.post("/agent/:id/models/:applicationId/receipt", async (ctx) => {
  const g = await modelLease(ctx);
  const state = ctx.request.body.state;
  if (!["reload-requested", "failed"].includes(state))
    throw new CatalogError(400, "invalid_model_receipt");
  ctx.body = await nomadModels.deployment(
    g.instanceId,
    g.saveId,
    ctx.params.applicationId,
    epoch(ctx),
    state,
  );
});
router.post("/agent/:id/heartbeat", async (ctx) => {
  ctx.body = await catalog.executorHeartbeat(
    grant(ctx),
    ctx.state.executorActor,
    epoch(ctx),
    ctx.request.body,
  );
  // A graceful handover must deliver the native server shutdown packet through the old tunnel.
  if (ctx.body.stop && !await catalog.pendingHandover(grant(ctx).instanceId,grant(ctx).saveId)) closeHostRelay(grant(ctx),false,epoch(ctx));
});
router.post("/agent/:id/relay", async ctx=>{
  const g=grant(ctx),e=epoch(ctx);
  ctx.body={address:await prepareHostRelay(g,e)};
});
router.post("/agent/:id/ready", async (ctx) => {
  const g = grant(ctx),
    e = epoch(ctx);
  const address = await prepareHostRelay(g, e);
  if(!hostRelayStatus(g.instanceId,g.saveId).ready)throw new CatalogError(409,"hosting_tunnel_not_ready");
  try {
    ctx.body = await catalog.executorReady(g, ctx.state.executorActor, e, address);
  } catch (error) {
    closeHostRelay(g,false,e);
    throw error;
  }
});
router.get("/agent/:id/package", async (ctx) => {
  const plan = await catalog.executorPlan(grant(ctx), epoch(ctx));
  ctx.body = await serverBundle(plan.release, plan.save,await gatewaySystem().prepare(grant(ctx).instanceId,grant(ctx).saveId,plan.release,plan.save));
  ctx.type = "application/zip";
  ctx.set("Cache-Control", "private, no-store");
});
router.get("/agent/:id/restore", async (ctx) => {
  const plan = await catalog.executorPlan(grant(ctx), epoch(ctx));
  if (!plan.checkpoint) {
    ctx.status = 204;
    return;
  }
  const file = worlds.path(plan.checkpoint.sha256);
  if (!(await fs.promises.stat(file).catch(() => null)))
    throw new CatalogError(404, "world_snapshot_missing");
  ctx.type = "application/zip";
  ctx.set("X-Nomad-SHA256", plan.checkpoint.sha256);
  ctx.set("Cache-Control", "private, no-store");
  ctx.body = fs.createReadStream(file);
});
router.post("/agent/:id/checkpoint", async (ctx) => {
  const files = (ctx.request as any).files?.world,
    all = Object.values((ctx.request as any).files ?? {}).reduce(
      (items: any[], v: any) => items.concat(Array.isArray(v) ? v : [v]),
      [],
    );
  try {
    if (!files || Array.isArray(files) || all.length !== 1)
      throw new CatalogError(400, "invalid_world_archive");
    const g = grant(ctx),
      e = epoch(ctx);
    await catalog.executorPlan(g, e);
    const snap = await worlds.store(files.filepath);
    ctx.body = await catalog.commitWorld(g, e, {
      ...snap,
      at: Date.now(),
      epoch: e,
      final: ctx.query.final === "true",
    });
  } finally {
    await Promise.all(
      all.map((file: any) => fs.promises.unlink(file.filepath).catch(() => undefined)),
    );
  }
});
router.post("/agent/:id/finish", async (ctx) => {
  const g = grant(ctx);
  ctx.body = await catalog.finishExecutor(g, epoch(ctx), ctx.request.body);
  closeHostRelay(g,await catalog.pendingHandover(g.instanceId,g.saveId),epoch(ctx));
  await nomadBots.hostStopped(g.instanceId, g.saveId, epoch(ctx));
});
export default router;
