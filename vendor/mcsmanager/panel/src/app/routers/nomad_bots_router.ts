import {NomadNumenInstallation} from "../service/nomad_numen_installation";
import {distribution} from "../service/nomad_distribution_system";
import { nomadModels } from "../service/nomad_models_system";
import { createReadStream } from "fs";
import Router from "@koa/router";
import Storage from "../common/storage/sys_storage";
import { nomadCatalog } from "../service/catalog_system";
import { nomadBots } from "../service/nomad_bots_system";
import { CatalogError } from "../service/nomad_catalog";
import permission from "../middleware/permission";
import userSystem from "../service/user_service";
import { getUserUuid } from "../service/passport_service";
import { ROLE } from "../entity/user";
const bots = nomadBots;
const installation = new NomadNumenInstallation(nomadCatalog,distribution);
const router = new Router({ prefix: "/nomad/bots" });
router.use(permission({ level: ROLE.USER }));
router.use(async (ctx, next) => {
  try {
    ctx.set("Cache-Control", "private, no-store");
    const user = userSystem.getInstance(getUserUuid(ctx));
    if (!user || user.permission < ROLE.USER)
      throw new CatalogError(401, "authentication_required");
    ctx.state.botActor = {
      id: user.uuid,
      name: user.userName,
      admin: user.permission === ROLE.ADMIN,
    };
    await next();
  } catch (error) {
    if (error instanceof CatalogError) {
      ctx.status = error.status;
      ctx.body = error.code;
      return;
    }
    if (error instanceof Error && error.message === "invalid_bot_access") {
      ctx.status = 400;
      ctx.body = error.message;
      return;
    }
    throw error;
  }
});
router.get("/installation",async ctx=>{ctx.body=await installation.plan(ctx.state.botActor,String(ctx.query.instanceId??""),typeof ctx.query.saveId==="string"?ctx.query.saveId:undefined);});
router.post("/installation",async ctx=>{
 const result=await installation.install(ctx.state.botActor,String(ctx.request.body.instanceId??""),ctx.request.body);
 await bots.setEnabled(ctx.state.botActor,ctx.request.body.instanceId,true);
 ctx.body=result;
});
router.get("/roster", async (ctx) => {
  ctx.body = await bots.roster(
    ctx.state.botActor,
    String(ctx.query.instanceId ?? ""),
    String(ctx.query.saveId ?? ""),
  );
});
router.post("/:id/body", async (ctx) => {
  ctx.body = await bots.bodyAction(ctx.state.botActor, ctx.params.id, ctx.request.body.action);
});
router.get("/settings", async (ctx) => {
  ctx.body = await bots.instanceSettings(ctx.state.botActor, String(ctx.query.instanceId ?? ""));
});
router.put("/settings", async (ctx) => {
  ctx.body = await bots.setEnabled(
    ctx.state.botActor,
    ctx.request.body.instanceId,
    ctx.request.body.enabled,
  );
});
router.post("/link", async (ctx) => {
  ctx.body = await bots.link(
    ctx.state.botActor,
    ctx.request.body.instanceId,
    ctx.request.body.saveId,
  );
});
router.put("/:id/appearance", async (ctx) => {
  ctx.body = await bots.appearance(ctx.state.botActor, ctx.params.id, ctx.request.body);
});
router.put("/:id/model", async (ctx) => {
  ctx.body = await bots.sharedConfig(ctx.state.botActor, ctx.params.id, ctx.request.body);
});
router.get("/:id/runtime", async (ctx) => {
  ctx.body = await bots.runtime(ctx.state.botActor, ctx.params.id);
});
router.get("/members", async (ctx) => {
  const instanceId = String(ctx.query.instanceId ?? ""),
    saveId = String(ctx.query.saveId ?? "");
  await bots.list(ctx.state.botActor, instanceId, saveId);
  const members = [];
  for (const user of Array.from(userSystem.objects.values()).slice(0, 1000)) {
    if (user.permission < ROLE.USER) continue;
    const actor = { id: user.uuid, name: user.userName, admin: user.permission === ROLE.ADMIN };
    const view = await nomadCatalog.list(actor);
    if (view.instances.some((i) => i.id === instanceId && i.saves.some((s) => s.id === saveId)))
      members.push({ id: user.uuid, name: user.userName });
  }
  ctx.body = members;
});
router.get("/models", async (ctx) => {
  ctx.body = await nomadModels.list(
    ctx.state.botActor,
    String(ctx.query.instanceId ?? ""),
    String(ctx.query.saveId ?? ""),
  );
});
router.post("/models", async (ctx) => {
  ctx.body = await nomadModels.create(ctx.state.botActor, ctx.request.body);
});
router.put("/models/:id/blobs/:hash", async (ctx) => {
  ctx.req.setTimeout(60000, () => ctx.req.destroy());
  ctx.body = await nomadModels.blob(ctx.state.botActor, ctx.params.id, ctx.params.hash, ctx.req);
});
router.get("/models/:id/blobs/:hash", async (ctx) => {
  ctx.body = createReadStream(
    await nomadModels.read(ctx.state.botActor, ctx.params.id, ctx.params.hash),
  );
});
router.post("/models/:id/commit", async (ctx) => {
  ctx.body = await nomadModels.commit(ctx.state.botActor, ctx.params.id);
});
router.post("/models/:id/review", async (ctx) => {
  ctx.body = await nomadModels.review(ctx.state.botActor, ctx.params.id, ctx.request.body);
});
router.get("/", async (ctx) => {
  ctx.body = await bots.list(
    ctx.state.botActor,
    String(ctx.query.instanceId ?? ""),
    String(ctx.query.saveId ?? ""),
  );
});
router.post("/", async (ctx) => {
  ctx.body = await bots.create(ctx.state.botActor, ctx.request.body);
});
router.post("/:id/review", async (ctx) => {
  ctx.body = await bots.review(ctx.state.botActor, ctx.params.id, ctx.request.body);
});
router.post("/:id/bind", async (ctx) => {
  ctx.body = await bots.bindCompanion(
    ctx.state.botActor,
    ctx.params.id,
    ctx.request.body.companionId,
  );
});
router.put("/:id/access", async (ctx) => {
  ctx.body = await bots.access(ctx.state.botActor, ctx.params.id, ctx.request.body);
});
router.post("/:id/commands", async (ctx) => {
  ctx.body = await bots.submit(ctx.state.botActor, ctx.params.id, ctx.request.body);
});
router.post("/:id/claim", async (ctx) => {
  ctx.body = (await bots.claim(ctx.state.botActor, ctx.params.id)) ?? { empty: true };
});
router.post("/:id/commands/:commandId/complete", async (ctx) => {
  ctx.body = await bots.complete(
    ctx.state.botActor,
    ctx.params.id,
    ctx.params.commandId,
    ctx.request.body,
  );
});
export default router;
