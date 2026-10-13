import Router from "@koa/router";
import fs from "fs";
import Storage from "../common/storage/sys_storage";
import { nomadCatalog } from "../service/catalog_system";
import { NomadDistribution } from "../service/nomad_distribution";
import { NomadFederation } from "../service/nomad_federation";
import { CatalogError } from "../service/nomad_catalog";
import permission from "../middleware/permission";
import userSystem from "../service/user_service";
import { getUserUuid } from "../service/passport_service";
import { ROLE } from "../entity/user";
import {distribution,federation} from "../service/nomad_distribution_system";
export {distribution,federation};
const router = new Router({ prefix: "/nomad/distribution" });
const lookup = (id: string) => {
  const u = userSystem.getInstance(id);
  return u && u.permission >= ROLE.USER
    ? { id: u.uuid, name: u.userName, admin: u.permission === ROLE.ADMIN }
    : null;
};
const actor = (ctx: any) => {
  const a = lookup(getUserUuid(ctx));
  if (!a) throw new CatalogError(401, "authentication_required");
  return a!;
};
const token = (ctx: any) => ctx.get("Authorization").replace(/^Bearer /, "");
router.use(async (ctx, next) => {
  try {
    ctx.set("Cache-Control", "private, no-store");
    await next();
  } catch (error) {
    if (error instanceof CatalogError) {
      ctx.status = error.status;
      ctx.body = error.code;
      return;
    }
    if (
      error instanceof Error &&
      /^(unsafe_|invalid_distribution|distribution_quota|duplicate_distribution|unsupported_distribution|private_distribution)/.test(
        error.message
      )
    ) {
      ctx.status = 400;
      ctx.body = error.message;
      return;
    }
    throw error;
  }
});
router.get("/identity", async (ctx) => {
  ctx.body = await distribution.identity();
});
router.post("/receive", async (ctx) => {
  ctx.body = await federation.receive(token(ctx), ctx.request.body, lookup);
});
router.put("/receive/:id/blobs/:hash", async (ctx) => {
  const a = await federation.scoped(token(ctx), ctx.params.id, lookup);
  ctx.body = await distribution.chunk(
    a,
    ctx.params.id,
    ctx.params.hash,
    Number(ctx.query.offset),
    ctx.req
  );
});
router.post("/receive/:id/commit", async (ctx) => {
  const a = await federation.scoped(token(ctx), ctx.params.id, lookup);
  const r = await distribution.commit(a, ctx.params.id);
  const d = await distribution.status(a, ctx.params.id);
  ctx.body = { instanceId: d.instanceId, releaseId: r.id, digest: r.manifestDigest };
});
router.use(permission({ level: ROLE.USER, speedLimit: false }));
router.post("/instances/:id/publications", async (ctx) => {
  ctx.body = await distribution.create(actor(ctx), ctx.params.id, ctx.request.body);
});
router.get("/publications/:id", async (ctx) => {
  ctx.body = await distribution.status(actor(ctx), ctx.params.id);
});
router.delete("/publications/:id", async (ctx) => {
  ctx.body = await distribution.cancel(actor(ctx), ctx.params.id);
});
router.put("/publications/:id/blobs/:hash", async (ctx) => {
  ctx.body = await distribution.chunk(
    actor(ctx),
    ctx.params.id,
    ctx.params.hash,
    Number(ctx.query.offset),
    ctx.req
  );
});
router.post("/publications/:id/commit", async (ctx) => {
  ctx.body = await distribution.commit(actor(ctx), ctx.params.id);
});
router.get("/instances/:id/releases/:releaseId", async (ctx) => {
  ctx.body = await distribution.release(actor(ctx), ctx.params.id, ctx.params.releaseId);
});
router.get("/instances/:id/releases/:releaseId/blobs/:hash", async (ctx) => {
  const file = await distribution.authorizedBlob(
    actor(ctx),
    ctx.params.id,
    ctx.params.releaseId,
    ctx.params.hash
  );
  ctx.type = "application/octet-stream";
  ctx.set("X-Nomad-SHA256", ctx.params.hash);
  ctx.body = fs.createReadStream(file);
});
router.get("/peers", async (ctx) => {
  ctx.body = await federation.peers(actor(ctx));
});
router.post("/peers", async (ctx) => {
  ctx.body = await federation.configure(actor(ctx), ctx.request.body);
});
router.post("/acceptances", async (ctx) => {
  ctx.body = await federation.acceptance(actor(ctx), ctx.request.body);
});
router.delete("/acceptances/:id", async (ctx) => {
  ctx.body = await federation.revoke(actor(ctx), ctx.params.id);
});
router.post("/push", async (ctx) => {
  ctx.body = await federation.push(actor(ctx), ctx.request.body, true);
});
router.get("/jobs", async (ctx) => {
  ctx.body = await federation.jobs(actor(ctx));
});
router.delete("/jobs/:id",async ctx=>{ctx.body=await federation.cancel(actor(ctx),ctx.params.id)});
export default router;
