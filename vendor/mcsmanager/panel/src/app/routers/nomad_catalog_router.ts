import Router from "@koa/router";
import { componentVersions, minecraftVersions, resolveServer } from "../service/nomad_install";
import { publishRecipe } from "../service/nomad_recipe";
import { validateProfile } from "../service/nomad_catalog";
import { serverBundle } from "../service/nomad_server";
import { uploadPolicy } from "../service/nomad_policy";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuid } from "uuid";
import { inspectPackage, NomadPackages, officialVersions, makeOfficialPackage } from "../service/nomad_packages";
import type Koa from "koa";
import { nomadCatalog as catalog } from "../service/catalog_system";
import { ROLE } from "../entity/user";
import permission from "../middleware/permission";
import { getUserUuid } from "../service/passport_service";
import userSystem from "../service/user_service";
import { CatalogError } from "../service/nomad_catalog";
import type { CatalogActor } from "../../../../shared/nomad-catalog";

const packages = new NomadPackages();
const router = new Router({ prefix: "/nomad/catalog" });
router.use(permission({ level: ROLE.USER }));
function actor(ctx: Koa.ParameterizedContext): CatalogActor {
  const user = userSystem.getInstance(getUserUuid(ctx));
  if (!user || user.permission < ROLE.USER) throw new CatalogError(401, "authentication_required");
  return { id: user.uuid, name: user.userName, admin: user.permission === ROLE.ADMIN };
}
router.use(async (ctx, next) => {
  try {
    ctx.state.catalogActor = actor(ctx);
    await next();
  } catch (error) {
    if (error instanceof CatalogError) {
      ctx.body = error.code;
      ctx.status = error.status;
      return;
    }
    throw error;
  }
});
const current = (ctx: Koa.ParameterizedContext) => ctx.state.catalogActor as CatalogActor;
const exists = (id: string) => Number(userSystem.getInstance(id)?.permission ?? 0) >= ROLE.USER;
router.get("/", async (ctx) => {
  ctx.body = await catalog.list(current(ctx));
});
router.get("/users", async (ctx) => {
  const a = current(ctx);
  const listing = await catalog.list(a);
  if (!a.admin && !listing.instances.some((i) => i.ownerId === a.id))
    throw new CatalogError(403, "forbidden");
  ctx.body = Array.from(userSystem.objects.values())
    .filter((u) => u.permission >= ROLE.USER)
    .map((u) => ({ id: u.uuid, name: u.userName }));
});
router.put("/creators", async (ctx) => {
  ctx.body = await catalog.creators(current(ctx), ctx.request.body.userIds, exists);
});
router.post("/instances", async (ctx) => {
  const result = await catalog.create(current(ctx), ctx.request.body);
  ctx.body = { id: result.id };
});
router.put("/instances/:id", async (ctx) => {
  const result = await catalog.update(current(ctx), ctx.params.id, ctx.request.body);
  ctx.body = { id: result.id };
});
router.post("/instances/:id/clone", async (ctx) => {
  const result = await catalog.clone(current(ctx), ctx.params.id);
  ctx.body = { id: result.id };
});
router.delete("/instances/:id", async (ctx) => {
  ctx.body = await catalog.delete(current(ctx), ctx.params.id);
});
router.post("/instances/:id/saves", async (ctx) => {
  ctx.body = await catalog.save(current(ctx), ctx.params.id, null, ctx.request.body);
});
router.put("/instances/:id/saves/:saveId", async (ctx) => {
  ctx.body = await catalog.save(current(ctx), ctx.params.id, ctx.params.saveId, ctx.request.body);
});
router.delete("/instances/:id/saves/:saveId", async (ctx) => {
  ctx.body = await catalog.deleteSave(current(ctx), ctx.params.id, ctx.params.saveId);
});
router.post("/instances/:id/saves/:saveId/room", async (ctx) => {
  ctx.body = await catalog.room(
    current(ctx),
    ctx.params.id,
    ctx.params.saveId,
    ctx.request.body,
    true
  );
});
router.put("/instances/:id/saves/:saveId/room", async (ctx) => {
  ctx.body = await catalog.room(
    current(ctx),
    ctx.params.id,
    ctx.params.saveId,
    ctx.request.body,
    false
  );
});
router.put("/instances/:id/grants", async (ctx) => {
  ctx.body = await catalog.grants(current(ctx), ctx.params.id, ctx.request.body.grants, exists);
});
router.put("/instances/:id/mods", async (ctx) => {
  ctx.body = await catalog.mods(current(ctx), ctx.params.id, ctx.request.body.mods);
});
router.put("/instances/:id/saves/:saveId/players", async (ctx) => {
  ctx.body = await catalog.players(
    current(ctx),
    ctx.params.id,
    ctx.params.saveId,
    ctx.request.body.players
  );
});
router.get("/policy", ctx => { ctx.body = uploadPolicy(); });
router.get("/official-versions", async ctx => { ctx.body = await minecraftVersions(); });
router.post("/import", async ctx => {
  const a = current(ctx), body = ctx.request.body, instanceId = typeof body.instanceId === "string" && body.instanceId ? body.instanceId : undefined;
  const files = (ctx.request as any).files?.package;
  const allFiles = Object.values((ctx.request as any).files ?? {}).reduce((list: any[], item: any) => list.concat(Array.isArray(item) ? item : [item]), []);
  try {
    if (instanceId !== (typeof ctx.query.instanceId === "string" ? ctx.query.instanceId : undefined)) throw new CatalogError(400, "invalid_scope");
    await catalog.checkPublish(a, instanceId);
    if (!files || Array.isArray(files) || allFiles.length !== 1) throw new CatalogError(400, "unsupported_package");
    const inspection = await inspectPackage(files.filepath, ctx.state.nomadUploadPolicy);
    const release = await packages.store(files.filepath, inspection, a.id, "upload", ctx.state.nomadUploadPolicy.maxBytes);
    if (body.profile) {let runtime: any; try {runtime = JSON.parse(body.profile);} catch {throw new CatalogError(400, "invalid_object");} release.profile = validateProfile({...release.profile, javaMajor: runtime.javaMajor > 0 ? runtime.javaMajor : release.profile.javaMajor, memoryMb: runtime.memoryMb ?? release.profile.memoryMb, launch: runtime.launch, packRevision: runtime.packRevision || release.profile.packRevision});}
    if (body.server) {let server: any; try {server = JSON.parse(body.server);} catch {throw new CatalogError(400, "invalid_object");} const resolved = await resolveServer(release.profile.mcVersion, server); release.server = resolved.settings; release.serverArtifact = resolved.artifact;}
    if (instanceId) { ctx.body = await catalog.publish(a, instanceId, release); }
    else { const result = await catalog.create(a, {name: body.name || release.profile.packName, description: body.description || "", profile: release.profile}, release); ctx.body = {id: result.id}; }
  } finally {
    await Promise.all(allFiles.map((f: any) => fs.promises.unlink(f.filepath).catch(() => undefined)));
  }
});
router.get("/components/:component", async ctx => { ctx.body = await componentVersions(ctx.params.component, ctx.query.minecraft); });
router.post("/official", async ctx => {
  const a = current(ctx), body = ctx.request.body, instanceId = typeof body.instanceId === "string" && body.instanceId ? body.instanceId : undefined;
  await catalog.checkPublish(a, instanceId);
  const file = path.join(os.tmpdir(), "nomad-" + uuid() + ".mrpack");
  try {
    const release = await publishRecipe(body.install ?? {minecraft: body.version}, body.profile, file, packages, a.id);
    if (body.server) {const resolved = await resolveServer(release.profile.mcVersion, body.server); release.server = resolved.settings; release.serverArtifact = resolved.artifact;}
    if (instanceId) ctx.body = await catalog.publish(a, instanceId, release);
    else { const result = await catalog.create(a, {name: body.name || release.profile.packName, description: body.description || "", profile: release.profile}, release); ctx.body = {id: result.id}; }
  } finally { await fs.promises.unlink(file).catch(() => undefined); }
});
router.post("/instances/:id/releases/:releaseId/configure", async ctx => {
  const a = current(ctx); await catalog.checkPublish(a, ctx.params.id);
  const source = await catalog.release(a, ctx.params.id, ctx.params.releaseId);
  const body = ctx.request.body, runtime = body.profile ?? {};
  const release = {...structuredClone(source), id: uuid(), publishedAt: Date.now(), publishedBy: a.id, profile: validateProfile({...source.profile, packRevision: runtime.packRevision || source.profile.packRevision, javaMajor: runtime.javaMajor > 0 ? runtime.javaMajor : source.profile.javaMajor, memoryMb: runtime.memoryMb ?? source.profile.memoryMb, launch: runtime.launch ?? source.profile.launch})};
  if (body.server) {const result = await resolveServer(source.profile.mcVersion, body.server); release.server = result.settings; release.serverArtifact = result.artifact;}
  ctx.body = await catalog.publish(a, ctx.params.id, release);
});
router.get("/instances/:id/releases/:releaseId/package", async ctx => {
  const release = await catalog.release(current(ctx), ctx.params.id, ctx.params.releaseId);
  const file = packages.path(release.sha256);
  if (!(await fs.promises.stat(file).catch(() => null))) throw new CatalogError(404, "package_not_found");
  ctx.type = "application/octet-stream";
  ctx.set("Cache-Control", "private, no-store");
  ctx.set("X-Nomad-SHA256", release.sha256);
  ctx.attachment(release.fileName);
  ctx.body = fs.createReadStream(file);
});
router.get("/instances/:id/releases/:releaseId/server", async ctx => {
  const a = current(ctx), release = await catalog.release(a, ctx.params.id, ctx.params.releaseId);
  const listing = await catalog.list(a), instance = listing.instances.find(i => i.id === ctx.params.id)!;
  const saveId = typeof ctx.query.saveId === "string" ? ctx.query.saveId : undefined;
  const save = saveId ? instance.saves.find(s => s.id === saveId && s.releaseId === release.id) : undefined;
  if ((saveId && !save) || (!saveId && !instance.permissions.includes("instance.read"))) throw new CatalogError(403, "forbidden");
  ctx.body = await serverBundle(release, save); ctx.type = "application/zip";
  ctx.set("Cache-Control", "private, no-store"); ctx.attachment("nomad-server-" + release.id + ".zip");
});
router.put("/instances/:id/saves/:saveId/release", async ctx => {
  ctx.body = await catalog.bindRelease(current(ctx), ctx.params.id, ctx.params.saveId, ctx.request.body.releaseId);
});
export default router;
