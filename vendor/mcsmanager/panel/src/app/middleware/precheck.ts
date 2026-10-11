import { Context } from "koa";
import userSystem from "../service/user_service";
import { uploadPolicy } from "../service/nomad_policy";
import { ROLE } from "../entity/user";
import permission from "./permission";
import { CatalogError } from "../service/nomad_catalog";
import { nomadCatalog } from "../service/catalog_system";
import { systemConfig } from "../setting";
import { getUserFromCtx } from "../service/passport_service";

export function isUploadRequest(ctx: Context) {
  const headers = ctx.request?.headers;
  const contentType = headers?.["content-type"] ?? "";
  return contentType.toLowerCase().includes("multipart");
}

/**
 * Prevent users from performing unrestricted file uploads using koa-body,
 * occupying machine disk space.
 */
const activeCloudUploads = new Set<string>();
export async function preCheckMiddleware(ctx: Context, next: () => Promise<void>) {
  const prefix = (systemConfig?.prefix ?? "").replace(/\/$/, "");
  const checkpointMatch = new RegExp("^"+prefix.replace(/[.*+?^$()|[\]\\]/g, match => "\\" + match)+"/api/nomad/hosting/agent/([a-f0-9-]+)/checkpoint$").exec(ctx.path);
  if(isUploadRequest(ctx) && ctx.method==="POST" && checkpointMatch){
    try{
      const grant=await nomadCatalog.executor(checkpointMatch[1],ctx.get("Authorization").replace(/^Bearer /,""));
      const executorUser=userSystem.getInstance(grant.actor.id);
      if(!executorUser||executorUser.permission<ROLE.USER)throw new CatalogError(403,"hosting_forbidden");
      const epoch=Number(ctx.query.epoch);if(!Number.isSafeInteger(epoch)||epoch<1)throw new CatalogError(400,"invalid_host_epoch");
      await nomadCatalog.executorPlan(grant,epoch);
      if(activeCloudUploads.has(grant.id)||activeCloudUploads.size>=2)throw new CatalogError(429,"upload_busy");
      activeCloudUploads.add(grant.id);ctx.state.nomadUploadPolicy=uploadPolicy();
      try{await next();}finally{activeCloudUploads.delete(grant.id);}
    }catch(error){if(!(error instanceof CatalogError))throw error;ctx.status=error.status;ctx.type="application/json";ctx.body=JSON.stringify({status:error.status,data:error.code,time:Date.now()});}
    return;
  }
  if (isUploadRequest(ctx) && ctx.method === "POST" && ctx.path === prefix + "/api/nomad/catalog/import") {
    return permission({level: ROLE.USER, speedLimit: false})(ctx, async () => {
      const user = getUserFromCtx(ctx);
      if (!user) return;
      try {
        const instanceId = typeof ctx.query.instanceId === "string" && ctx.query.instanceId ? ctx.query.instanceId : undefined;
        await nomadCatalog.checkPublish({id: user.uuid, name: user.userName, admin: user.permission === ROLE.ADMIN}, instanceId);
        if (activeCloudUploads.has(user.uuid) || activeCloudUploads.size >= 2) throw new CatalogError(429, "upload_busy");
        ctx.state.nomadUploadPolicy = uploadPolicy();
        activeCloudUploads.add(user.uuid);
        try { await next(); } finally { activeCloudUploads.delete(user.uuid); }
      } catch (error) {
        if (!(error instanceof CatalogError)) throw error;
        ctx.status = error.status; ctx.type = "application/json";
        ctx.body = JSON.stringify({status: error.status, data: error.code, time: Date.now()});
      }
    });
  }
  if (isUploadRequest(ctx)) {
    const user = getUserFromCtx(ctx);
    const isAdmin = user?.permission === ROLE.ADMIN;
    if (!isAdmin) throw new Error("Access denied: Invalid multipart/form-data request!");
  }
  return await next();
}
