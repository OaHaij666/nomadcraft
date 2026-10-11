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
    body.nodeName
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
    typeof ctx.query.instanceId === "string" ? ctx.query.instanceId : undefined
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
    ctx.request.body
  );
});
router.post("/nodes/:id/poll", async (ctx) => {
  const node = await catalog.computeNode(
    ctx.params.id,
    ctx.get("Authorization").replace(/^Bearer /, "")
  );
  const owner = userSystem.getInstance(node.ownerId);
  if (!owner || owner.permission < ROLE.USER) throw new CatalogError(403, "node_owner_unavailable");
  ctx.body = await catalog.dispatchComputeNode(node.id, ctx.request.body, (id) => {
    const u = userSystem.getInstance(id);
    return u && u.permission >= ROLE.USER
      ? {
          actor: { id: u.uuid, name: u.userName, admin: u.permission === ROLE.ADMIN },
          willingness: u.hostingWillingness
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
        hostRelayStatus(ctx.params.instanceId, ctx.params.saveId)
      );
    } finally {
      activeChecks.delete(key);
    }
  }
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
    admin: user.permission === ROLE.ADMIN
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
    worldLimits: uploadPolicy()
  };
});
router.post("/agent/:id/heartbeat", async (ctx) => {
  ctx.body = await catalog.executorHeartbeat(
    grant(ctx),
    ctx.state.executorActor,
    epoch(ctx),
    ctx.request.body
  );
  if (ctx.body.stop) closeHostRelay(grant(ctx));
});
router.post("/agent/:id/ready", async (ctx) => {
  const g = grant(ctx),
    e = epoch(ctx);
  const address = await prepareHostRelay(g, e);
  try {
    ctx.body = await catalog.executorReady(g, ctx.state.executorActor, e, address);
  } catch (error) {
    closeHostRelay(g);
    throw error;
  }
});
router.get("/agent/:id/package", async (ctx) => {
  const plan = await catalog.executorPlan(grant(ctx), epoch(ctx));
  ctx.body = await serverBundle(plan.release, plan.save);
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
      []
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
      final: ctx.query.final === "true"
    });
  } finally {
    await Promise.all(
      all.map((file: any) => fs.promises.unlink(file.filepath).catch(() => undefined))
    );
  }
});
router.post("/agent/:id/finish", async (ctx) => {
  const g = grant(ctx);
  ctx.body = await catalog.finishExecutor(g, epoch(ctx), ctx.request.body);
  closeHostRelay(g);
});
export default router;
