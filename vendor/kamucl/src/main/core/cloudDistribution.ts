import { logScope } from './launcherLog';
import { CloudResourceCache, type ResourceLocation } from './cloudResourceCache';
import { downloadFile } from './download';
import { resourceSource, publicResourcePath, type ResourceSource } from '../../../../mcsmanager/shared/nomad-resource-sources';
import { cloudInstanceFiles as files } from './cloudInstanceFiles';
import { ensureCloudClientNetwork } from './cloudClientNetwork';
import { syncApprovedModels } from "./cloudModels";
import { attachLocalStatus } from "./cloudLocalStatus";
import { ipcMain, app, type BrowserWindow } from "electron";
import { IPC_EVENT, type ProgressEvent } from "../../shared/types";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cloudClient, storage, registerCloudCatalogStatus } from "./nomadCloud";
import { centerTarget, centerOverview, assertInstanceIdle } from "./instanceCenter";
import { getSettings, saveSettings } from "./settings";
import { withFileJob } from "./fileJobs";
import { registerTask, finishTask, waitIfTaskPaused } from "./tasks";
import {
  fileDigest,
  inventory,
  baseline,
  applyFiles,
  rollbackFiles,
  confinedFile,
  assertSyncSettled,
  atomicRecord,
} from "./cloudSyncFiles";
import {
  validateManifest,
  manifestDigest,
  diffManifest,
  distributionPath,
  type DistributionManifest,
  type DistributionFile,
} from "../../../../mcsmanager/shared/nomad-distribution";
import { cloudPreparePlan, cloudPreparedRoom, clientRelease } from "./cloudPreparePlan";
import { installCloudVersion, scanInstalledFolder, listAllInstalled } from "./versions";
import { addGameFolder } from "./gameFolders";
import type { InstanceTarget } from "../../shared/instanceCenter";
const resourceLog = logScope('cloud-resources');
export interface CloudRef {
  instanceId: string;
  saveId?: string;
}
async function assertCompatibleLocal(target: InstanceTarget, profile: any) {
  const overview = await centerOverview(target);
  const loader = profile?.loader === "paper" || profile?.loader === "vanilla" ? undefined : profile?.loader;
  if (overview.mcVersion !== profile?.mcVersion || overview.loader !== loader || (loader && profile.loaderVersion && overview.loaderVersion !== profile.loaderVersion))
    throw new Error("本地客户端的 Minecraft、加载器或加载器版本与云端发布版不一致，请绑定匹配的实例");
}
async function context(ref: CloudRef, client = cloudClient(), signal?: AbortSignal) {
  if (!storage().valid) throw new Error("请先设置有效的云端实例存放目录");
  const key = JSON.stringify([
    client.serviceId,
    ref.instanceId,
    ref.saveId || "instance",
  ]);
  const binding = getSettings().cloudInstanceBindings?.[key];
  if (!binding?.localVersionId || !binding.localFolder)
    throw new Error("请先绑定此云端实例的本地客户端");
  const target = centerTarget({
    id: binding.localVersionId,
    folder: binding.localFolder,
  });
  if (!target.state.isolated)
    throw new Error("云端同步需要独立游戏目录，请先在版本设置开启隔离");
  const catalog = await client.json("api/nomad/catalog/", {signal});
  const instance = catalog.instances.find((v: any) => v.id === ref.instanceId);
  if (!instance) throw new Error("当前账号没有实例访问权限");
  const save = ref.saveId
    ? instance.saves.find((v: any) => v.id === ref.saveId)
    : undefined;
  if (ref.saveId && !save) throw new Error("当前账号没有存档访问权限");
  const release = clientRelease(ref.saveId
    ? instance.releases?.find((v: any) => v.id === save.releaseId)
    : instance.releases?.slice(-1)[0]);
  await assertCompatibleLocal(target.target, release?.profile ?? instance.profile);
  return { client, key, binding, target, instance, save, release, ref };
}
async function inspect(ref: CloudRef, frozen?: Awaited<ReturnType<typeof context>>) {
  const c = frozen ?? await context(ref);
  await assertInstanceIdle(c.target.dir);
  await assertSyncSettled(c.target.dir);
  const local = await files(c.target.dir, path.join(app.getPath("userData"), "cloud-resource-cache")),
    old = await baseline(c.target.dir);
  const remote = c.release?.manifest as DistributionManifest | undefined;
  const merged: DistributionManifest = {
    schema: 1,
    files: [
      ...new Map(
        [...(old?.manifest.files ?? []), ...(remote?.files ?? [])].map((f) => [
          f.path,
          f,
        ]),
      ).values(),
    ],
  };
  const observed = await inventory(c.target.dir, merged);
  const diff = remote ? diffManifest(old?.manifest, remote, observed) : [];
  let state = "checking";
  if (remote) {
    state = diff.some((d) => d.conflict)
      ? "conflict"
      : old?.releaseId !== c.release.id
        ? "cloud-ahead"
        : diff.some((d) => d.operation !== "same")
          ? "local-ahead"
          : "synced";
  }
  return {
    instance: c.instance,
    save: c.save,
    release: c.release,
    local,
    baseline: old,
    diff,
    state,
    directory: c.target.dir,
    serviceId: c.client.serviceId,
    target: c.target.target,
  };
}
export function registerCloudDistributionIpc(getWin: () => BrowserWindow | null) {
  const prepareKeys = new Map<string, string>();
  const progress = (task: ReturnType<typeof registerTask>, done: number, total: number, text: string) =>
    getWin()?.webContents.send(IPC_EVENT.progress, { taskId: task.id, taskTitle: task.title, stage: "download", progress: total ? Math.min(1, done / total) : 0, overall: total ? Math.min(1, done / total) : 0, cloudPrepareKey: prepareKeys.get(task.id), text } satisfies ProgressEvent);
  const done = (task: ReturnType<typeof registerTask>, ok: boolean) => getWin()?.webContents.send(IPC_EVENT.taskDone, {taskId: task.id, ok, cancelled: task.controller.signal.aborted});
  ipcMain.handle("nomad:distribution:unbind",(_e,ref:CloudRef)=>{const client=cloudClient(),key=JSON.stringify([client.serviceId,ref.instanceId,ref.saveId||"instance"]);const next={...getSettings().cloudInstanceBindings};delete next[key];return saveSettings({cloudInstanceBindings:next})});
  ipcMain.handle("nomad:distribution:cancelPush",(_e,id:string)=>cloudClient().json("api/nomad/distribution/jobs/"+encodeURIComponent(id),{method:"DELETE"}));
  ipcMain.handle("nomad:distribution:revoke",(_e,id:string)=>cloudClient().json("api/nomad/distribution/acceptances/"+encodeURIComponent(id),{method:"DELETE"}));
  registerCloudCatalogStatus(attachLocalStatus);
  ipcMain.handle("nomad:distribution:inspect", (_e, ref: CloudRef) =>
    inspect(ref),
  );
  ipcMain.handle(
    "nomad:distribution:bind",
    async (_e, ref: CloudRef, target: InstanceTarget) => {
      if (!storage().valid) throw new Error("请先设置本地存放目录");
      const client = cloudClient(),
        local = centerTarget(target);
      if (!local.state.isolated) throw new Error("云端实例需要独立游戏目录");
      const catalog = await client.json("api/nomad/catalog/");
      const instance = catalog.instances.find((v: any) => v.id === ref.instanceId);
      if (!instance) throw new Error("实例不可访问");
      const save = ref.saveId ? instance.saves.find((s: any) => s.id === ref.saveId) : undefined;
      if (ref.saveId && !save) throw new Error("存档不可访问");
      const release = save ? instance.releases.find((r: any) => r.id === save.releaseId) : instance.releases?.slice(-1)[0];
      await assertCompatibleLocal(local.target, release?.profile ?? instance.profile);
      const key = JSON.stringify([
        client.serviceId,
        ref.instanceId,
        ref.saveId || "instance",
      ]);
      return saveSettings({
        cloudInstanceBindings: {
          ...getSettings().cloudInstanceBindings,
          [key]: {
            localFolder: local.folder,
            localVersionId: target.id,
            serviceId: client.serviceId,
            instanceId: ref.instanceId,
            saveId: ref.saveId,
          },
        },
      });
    },
  );
  ipcMain.handle(
    "nomad:distribution:publish",
    async (_e, ref: CloudRef, selected: DistributionFile[]) => {
      const c = await context(ref);
      return withFileJob(c.target.dir, undefined, () =>
        withFileJob(path.join(c.target.dir, "mods"), undefined, async () => {
          await assertInstanceIdle(c.target.dir);
          const manifest = validateManifest({ schema: 1, files: selected }, Number.MAX_SAFE_INTEGER);
          if (
            !c.instance.permissions?.includes("mods.manage") ||
            !c.instance.permissions?.includes("instance.update")
          )
            throw new Error("发布需要实例 MOD 管理和实例编辑权限");
          const task = registerTask("发布云端实例", "download");
          let success = false;
          const total = manifest.files.reduce((sum, f) => sum + f.size, 0);
          let transferred = 0;
          progress(task, 0, total, "准备发布文件清单…");
          try {
            const checkpoint = path.join(
              app.getPath("userData"),
              "cloud-publications",
              c.client.serviceId + "-" + ref.instanceId + ".json",
            );
            let previous: any;
            try {
              previous = JSON.parse(await fs.readFile(checkpoint, "utf8"));
            } catch {}
            let draft: any;
            if (previous?.digest === manifestDigest(manifest)) {
              try {
                draft = await c.client.json(
                  "api/nomad/distribution/publications/" + previous.id,
                );
              } catch {}
            }
            if (
              !draft ||
              draft.cancelled ||
              draft.expected?.revision !== c.instance.revision
            )
              draft = await c.client.json(
                "api/nomad/distribution/instances/" +
                  encodeURIComponent(ref.instanceId) +
                  "/publications",
                {
                  method: "POST",
                  body: JSON.stringify({
                    manifest,
                    expected: {
                      revision: c.instance.revision,
                      baseReleaseId:
                        c.instance.releases?.slice(-1)[0]?.id ?? null,
                    },
                  }),
                  signal: task.controller.signal,
                },
              );
            await atomicRecord(checkpoint, {
              id: draft.id,
              digest: manifestDigest(manifest),
            });
            const status = await c.client.json(
              "api/nomad/distribution/publications/" + draft.id,
            );
            for (const missing of status.missing) {
              const f = manifest.files.find(
                (f) => f.sha256 === missing.sha256,
              )!;
              const file = await confinedFile(c.target.dir, f.path);
              if ((await fileDigest(file)) !== f.sha256)
                throw new Error("文件已变化，请重新预览：" + f.path);
              const handle = await fs.open(file, "r");
              try {
                let offset = missing.offset;
                do {
                  await waitIfTaskPaused(task.controller.signal);
                  task.controller.signal.throwIfAborted();
                  const buffer = Buffer.alloc(
                    Math.min(4 * 1024 ** 2, f.size - offset),
                  );
                  const { bytesRead } = await handle.read(
                    buffer,
                    0,
                    buffer.length,
                    offset,
                  );
                  if (bytesRead !== buffer.length)
                    throw new Error("上传期间文件大小改变");
                  const response = await c.client.json(
                    "api/nomad/distribution/publications/" +
                      draft.id +
                      "/blobs/" +
                      f.sha256 +
                      "?offset=" +
                      offset,
                    {
                      method: "PUT",
                      headers: { "Content-Type": "application/octet-stream" },
                      body: buffer as unknown as BodyInit,
                      signal: task.controller.signal,
                    },
                  );
                  transferred += response.offset - offset;
                  offset = response.offset;
                  progress(task, transferred, total, f.path);
                } while (offset < f.size);
              } finally {
                await handle.close();
              }
              if ((await fileDigest(file)) !== f.sha256)
                throw new Error("上传期间文件发生修改，请重新预览");
            }
            await assertInstanceIdle(c.target.dir);
            for (const f of manifest.files)
              if (
                (await fileDigest(await confinedFile(c.target.dir, f.path))) !==
                f.sha256
              )
                throw new Error("提交前文件发生修改");
            const release = await c.client.json(
              "api/nomad/distribution/publications/" + draft.id + "/commit",
              { method: "POST", body: "{}", signal: task.controller.signal },
            );
            await fs.unlink(checkpoint).catch(() => {});
            success = true;
            progress(task, total, total, "发布完成");
            return release;
          } finally {
            done(task, success);
            finishTask(task.id);
          }
        }),
      );
    },
  );
  async function pullFiles(c: Awaited<ReturnType<typeof context>>, accepted: string[], parentTask?: ReturnType<typeof registerTask>) {
    const ref = c.ref;
    if (!c.release?.manifest) throw new Error("此发布版尚未提供文件清单，请管理员发布完整环境后再准备客户端");
    const syncProgress = (task: ReturnType<typeof registerTask>, value: number, total: number, text: string) => progress(task, parentTask ? 65 + (total ? value / total : 0) * 30 : value, parentTask ? 100 : total, text);
      return withFileJob(c.target.dir, parentTask?.controller.signal, () =>
        withFileJob(path.join(c.target.dir, "mods"), parentTask?.controller.signal, async () => {
          await assertInstanceIdle(c.target.dir);
          await assertSyncSettled(c.target.dir);
          const task = parentTask ?? registerTask("同步云端实例", "download");
          let success = false;
          const cache = new CloudResourceCache(path.join(app.getPath('userData'), 'cloud-resource-cache'), async () =>
            listAllInstalled().map(v => v.gameDirectory).filter((dir): dir is string => !!dir && dir !== c.target.dir));
          const total = validateManifest(c.release.manifest, Number.MAX_SAFE_INTEGER).files.filter(f => f.side !== "server").reduce((sum, f) => sum + f.size, 0);
          let downloaded = 0;
          syncProgress(task, 0, total, "校验本地文件…");
          try {
            const preview=await inspect(ref, c);if(preview.diff.some(d=>d.conflict&&!accepted.includes(d.path)))throw new Error('请先逐项确认文件冲突，再开始同步');
          const manifest = validateManifest(c.release.manifest, Number.MAX_SAFE_INTEGER),
              staged: Record<string, string> = {};
            const temp = path.join(
              app.getPath("userData"),
              "cloud-downloads",
              c.client.serviceId,
              c.release.manifestDigest,
            );
            const sourceResults: Record<string, ResourceSource[]> = {};
            const changedPaths = new Set(preview.diff.filter(d => d.operation !== 'same').map(d => d.path));
            const sourcePending = manifest.files.filter(f => f.side !== 'server' && publicResourcePath(f.path) && changedPaths.has(f.path));
            const getSources = async (file: DistributionFile) => {
              const supplied = (file.sources ?? []).map(resourceSource).filter((s): s is ResourceSource => !!s);
              if (supplied.length) return supplied;
              if (!publicResourcePath(file.path)) return [];
              if (!(file.sha256 in sourceResults)) {
                const hashes = [...new Set([file.sha256, ...sourcePending.filter(f => !(f.sha256 in sourceResults)).map(f => f.sha256)])].slice(0, 100);
                hashes.forEach(hash => { sourceResults[hash] = []; });
                syncProgress(task, downloaded, total, '正在自动识别资源下载来源…');
                try {
                  const result = await c.client.json('api/nomad/distribution/instances/' + encodeURIComponent(ref.instanceId)
                    + '/releases/' + encodeURIComponent(c.release.id) + '/sources', {
                    method: 'POST', body: JSON.stringify({ hashes }), signal: task.controller.signal,
                  });
                  for (const hash of hashes) {
                    sourceResults[hash] = Array.isArray(result?.[hash]) ? result[hash].map(resourceSource).filter((s: ResourceSource | undefined): s is ResourceSource => !!s) : [];
                  }
                } catch { task.controller.signal.throwIfAborted(); /* Older/offline servers retain cloud download compatibility. */ }
              }
              return sourceResults[file.sha256];
            };
            for (const f of manifest.files.filter((f) => f.side !== 'server')) {
              await waitIfTaskPaused(task.controller.signal);
              const names: Record<ResourceLocation, string> = { instance: '本地已有', cache: '复用缓存', local: '复用本地资源', upstream: '从上游下载', cloud: '从云端下载' };
              const obtained = await cache.obtain(f, {
                instance: c.target.dir, legacy: path.join(temp, f.sha256), signal: task.controller.signal,
                sources: () => getSources(f),
                progress: location => syncProgress(task, downloaded, total, names[location] + '：' + f.path),
                upstream: (dest, sources) => downloadFile(sources[0].url, dest,
                  value => syncProgress(task, downloaded + Math.min(value, f.size), total, '从上游下载：' + f.path),
                  undefined, getSettings().mirror, task.controller.signal, sources.slice(1).map(s => s.url),
                  { sha256: f.sha256, size: f.size, maxAttempts: 2 }),
                cloud: async dest => {
                  const response = await c.client.raw('api/nomad/distribution/instances/' + encodeURIComponent(ref.instanceId)
                    + '/releases/' + encodeURIComponent(c.release.id) + '/blobs/' + f.sha256, { signal: task.controller.signal });
                  if (!response.body) throw new Error('云端文件为空：' + f.path);
                  let count = 0;
                  await pipeline(Readable.fromWeb(response.body as any), async function* (source) {
                    for await (const chunk of source) {
                      await waitIfTaskPaused(task.controller.signal);
                      count += chunk.length;
                      if (count > f.size) throw new Error('云端文件超过声明大小：' + f.path);
                      syncProgress(task, downloaded + count, total, '从云端下载：' + f.path);
                      yield chunk;
                    }
                  }, (await import('node:fs')).createWriteStream(dest), { signal: task.controller.signal });
                  if (count !== f.size) throw new Error('云端文件大小不符：' + f.path);
                },
              }).catch(error => {
                task.controller.signal.throwIfAborted();
                throw new Error('资源准备失败：' + f.path + '；' + (error instanceof Error ? error.message : String(error)), { cause: error });
              });
              if (obtained.file) staged[f.path] = obtained.file;
              downloaded += f.size;
              syncProgress(task, downloaded, total, names[obtained.location] + '：' + f.path);
            }
            task.controller.signal.throwIfAborted();
            const result = await applyFiles(
              c.target.dir,
              {
                serviceId: c.client.serviceId,
                instanceId: ref.instanceId,
                saveId: ref.saveId,
                releaseId: c.release.id,
                digest: manifestDigest(manifest),
                manifest,
                verifiedAt: Date.now(),
              },
              staged,
              Array.isArray(accepted) ? accepted : [],
              async () => { task.controller.signal.throwIfAborted(); await assertInstanceIdle(c.target.dir); },
            );
            saveSettings({
              cloudInstanceBindings: {
                ...getSettings().cloudInstanceBindings,
                [c.key]: {
                  ...c.binding,
                  baseReleaseId: c.release.id,
                  baseManifestDigest: result.baseline.digest,
                  manifest,
                  verifiedAt: Date.now(),
                },
              },
            });
            success = true;
            return result;
          } finally {
            await cache.close().catch(error => resourceLog.warn("资源缓存清理失败", error));
            if (!parentTask) { done(task, success); finishTask(task.id); }
          }
        }),
      );
  }
  ipcMain.handle("nomad:distribution:pull", async (_e, ref: CloudRef, accepted: string[]) => pullFiles(await context(ref), accepted));
  const preparing = new Set<string>();
  ipcMain.handle("nomad:distribution:prepare", async (_e, input: CloudRef) => {
    const ref = {instanceId: input.instanceId, saveId: input.saveId};
    const root = storage();
    if (!root.valid) throw new Error("请先选择云端实例的本地存放目录");
    const client = cloudClient();
    const key = JSON.stringify([client.serviceId, ref.instanceId, ref.saveId || "instance"]);
    if (preparing.has(key)) throw new Error("此云端实例正在准备，请在任务中心查看进度");
    preparing.add(key);
    const task = registerTask("准备云端实例", "version");
    prepareKeys.set(task.id, key);
    let success = false;
    let failure: string | undefined;
    try {
      progress(task, 0, 100, "读取云端固定发布版…");
      const plan = cloudPreparePlan(await client.json("api/nomad/catalog/", {signal: task.controller.signal}), ref, client.serviceId);
      await waitIfTaskPaused(task.controller.signal);
      const binding = getSettings().cloudInstanceBindings?.[key];
      let target: InstanceTarget | undefined;
      if (binding?.localVersionId && binding.localFolder && await fs.stat(path.join(binding.localFolder, "versions", binding.localVersionId, binding.localVersionId + ".json")).catch(() => null)) {
        const existing = centerTarget({id: binding.localVersionId, folder: binding.localFolder});
        await assertInstanceIdle(existing.dir);
        await assertSyncSettled(existing.dir);
        const installed = scanInstalledFolder(binding.localFolder, binding.localVersionId).versions.find(v => v.id === binding.localVersionId);
        if (installed && !installed.failed && !installed.incomplete && existing.state.isolated) {
          try { await assertCompatibleLocal(existing.target, plan.release.profile); target = existing.target; }
          catch { /* A new runtime gets its own folder. Keep the old client intact. */ }
        }
      }
      if (!target) {
        const folder = path.join(await fs.realpath(root.path), "clients", plan.scope.slice(0, 24), plan.runtime.slice(0, 24));
        const ownerFile = path.join(folder, ".nomadcraft-client.json");
        // Refuse pre-existing folders unless their ownership marker matches exactly.
        let segmentPath = await fs.realpath(root.path);
        for (const segment of ["clients", plan.scope.slice(0, 24), plan.runtime.slice(0, 24), ".nomadcraft-client.json"]) {
          segmentPath = path.join(segmentPath, segment);
          const entry = await fs.lstat(segmentPath).catch((error: any) => { if (error.code === "ENOENT") return null; throw error; });
          if (entry?.isSymbolicLink()) throw new Error("云端客户端路径不能包含符号链接或目录联接");
        }
        await fs.mkdir(path.dirname(folder), {recursive: true});
        let created = false;
        try { await fs.mkdir(folder); created = true; } catch (error: any) { if (error.code !== "EEXIST") throw error; }
        const owner = {schema: 1, serviceId: client.serviceId, instanceId: ref.instanceId, saveId: ref.saveId ?? null, runtime: plan.runtime, name: plan.name};
        if (created) await atomicRecord(ownerFile, owner);
        else {
          const found = JSON.parse(await fs.readFile(ownerFile, "utf8").catch(() => {throw new Error("目标目录不属于此云端实例，请更换存放位置")}));
          if (JSON.stringify(found) !== JSON.stringify(owner)) throw new Error("目标目录归属不匹配，已停止安装");
        }
        // All ancestors must be ordinary directories, not redirects outside the selected root.
        const resolved = await fs.realpath(folder);
        if (path.relative(await fs.realpath(root.path), resolved).startsWith("..") || path.resolve(folder).toLowerCase() !== resolved.toLowerCase()) throw new Error("云端客户端目录不能是符号链接或目录联接");
        for (const relative of ["versions", "versions/" + plan.name, "versions/" + plan.name + "/" + plan.name + ".json"]) {
          const entry = await fs.lstat(path.join(folder, relative)).catch((error: any) => {if(error.code === "ENOENT") return null; throw error});
          if (entry?.isSymbolicLink()) throw new Error("客户端安装路径不能包含符号链接或目录联接");
        }
        await assertInstanceIdle(path.join(folder, "versions", plan.name));
        addGameFolder(folder);
        target = {id: plan.name, folder};
        const installed = scanInstalledFolder(folder, plan.name).versions.find(v => v.id === plan.name);
        let ready = false;
        if (installed && !installed.failed && !installed.incomplete) {
          await assertCompatibleLocal(target, plan.release.profile);
          const local = centerTarget(target); await assertInstanceIdle(local.dir); await assertSyncSettled(local.dir);
          ready = local.state.isolated;
        }
        if (!ready) {
          progress(task, 5, 100, "安装匹配的 Minecraft 与加载器…");
          const id = await installCloudVersion(folder, plan.release.profile.mcVersion, plan.options, event => {
            if (event.stage !== 'done') getWin()?.webContents.send(IPC_EVENT.progress, {...event, cloudPrepareKey: key, taskId: task.id, taskTitle: task.title, progress: 0.05 + 0.55 * (Math.max(0, Math.min(1, event.overall ?? event.progress))), overall: 0.05 + 0.55 * (Math.max(0, Math.min(1, event.overall ?? event.progress)))});
          }, task.controller.signal);
          target = {id, folder};
          await assertCompatibleLocal(target, plan.release.profile);
        }
        task.controller.signal.throwIfAborted();
        saveSettings({cloudInstanceBindings: {...getSettings().cloudInstanceBindings, [key]: {localFolder: target.folder, localVersionId: target.id, serviceId: client.serviceId, instanceId: ref.instanceId, saveId: ref.saveId}}});
      }
      await waitIfTaskPaused(task.controller.signal);
      const c = await context(ref, client, task.controller.signal);
      if (c.target.target.id !== target.id || c.target.target.folder !== target.folder) throw new Error("准备期间本地绑定已改变，请重试");
      if (c.release?.id !== plan.release.id || c.release?.manifestDigest !== plan.release.manifestDigest) throw new Error("准备期间云端固定发布版已改变，请重试");
      progress(task, 65, 100, "同步云端文件…");
      await pullFiles(c, [], task);
      progress(task,96,100,"同步已审核的 YSM 模型资源…");
      await syncApprovedModels(client,ref,c.target.dir,task.controller.signal);
      await withFileJob(path.join(c.target.dir,"mods"),task.controller.signal,()=>ensureCloudClientNetwork(c.target.dir,c.release.profile,task.controller.signal,{assertIdle:assertInstanceIdle,bundledDirectory:__dirname}));
      const latest = await context(ref, client, task.controller.signal);
      if (latest.target.target.id !== target.id || latest.target.target.folder !== target.folder) throw new Error("同步期间本地绑定已改变，请重试");
      if (latest.release?.id !== plan.release.id || latest.release?.manifestDigest !== plan.release.manifestDigest) throw new Error("同步期间云端固定发布版已改变，请重新准备");
      const verified = await inspect(ref, latest);
      if (verified.state !== "synced") throw new Error("同步后校验未通过，请打开同步管理检查差异");
      task.controller.signal.throwIfAborted();
      const {state, message, address} = cloudPreparedRoom(latest.save);
      progress(task, 100, 100, message);
      success = true;
      return {state, message, address, target: latest.target.target, releaseId: plan.release.id, serviceId: client.serviceId};
    } catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
    finally { getWin()?.webContents.send(IPC_EVENT.taskDone, {taskId: task.id, ok: success, error: failure, cancelled: task.controller.signal.aborted}); finishTask(task.id); prepareKeys.delete(task.id); preparing.delete(key); }
  });
  ipcMain.handle("nomad:distribution:rollback", async (_e, ref: CloudRef) => {
    const c = await context(ref);
    return withFileJob(c.target.dir, undefined, async () => {
      await assertInstanceIdle(c.target.dir);
      const old = await rollbackFiles(c.target.dir);
      saveSettings({
        cloudInstanceBindings: {
          ...getSettings().cloudInstanceBindings,
          [c.key]: {
            ...c.binding,
            baseReleaseId: old?.releaseId,
            baseManifestDigest: old?.digest,
            manifest: old?.manifest,
            verifiedAt: old?.verifiedAt,
          },
        },
      });
      return old;
    });
  });
  ipcMain.handle("nomad:distribution:join", async (_e, ref: CloudRef) => {
    const c = await context(ref);
    if (!c.save?.hosting?.joinAddress)
      throw new Error("房间尚未准备就绪，请稍后刷新");
    const result = await inspect(ref);
    if (result.state !== "synced")
      throw new Error("请先同步当前存档的固定发布版");
    await withFileJob(path.join(c.target.dir,"mods"),undefined,()=>ensureCloudClientNetwork(c.target.dir,c.release.profile,undefined,{assertIdle:assertInstanceIdle,bundledDirectory:__dirname}));
    return { target: c.target.target, address: c.save.hosting.joinAddress };
  });
  ipcMain.handle("nomad:distribution:recover", async (_e, ref: CloudRef) => {
    const c = await context(ref);
    await assertInstanceIdle(c.target.dir);
    return rollbackFiles(c.target.dir);
  });
  for (const [name, route] of [
    ["peers", "peers"],
    ["jobs", "jobs"],
  ] as const)
    ipcMain.handle("nomad:distribution:" + name, () =>
      cloudClient().json("api/nomad/distribution/" + route),
    );
  for (const [name, route] of [
    ["peerAdd", "peers"],
    ["accept", "acceptances"],
    ["push", "push"],
  ] as const)
    ipcMain.handle("nomad:distribution:" + name, (_e, input: any) =>
      cloudClient().json("api/nomad/distribution/" + route, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  ipcMain.handle(
    "nomad:distribution:bindRelease",
    (_e, ref: CloudRef, id: string) =>
      cloudClient().json(
        "api/nomad/catalog/instances/" +
          encodeURIComponent(ref.instanceId) +
          "/saves/" +
          encodeURIComponent(ref.saveId ?? "") +
          "/release",
        { method: "PUT", body: JSON.stringify({ releaseId: id }) },
      ),
  );
}
